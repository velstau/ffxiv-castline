// タイムラインを進める処理。画面の読み取り結果（観測）を受け取り、いまどのフェーズの何秒目かを決める。
// DOM を使わない（node でテストする）。時刻はすべて観測したフレームが届いた時刻 at（Date.now() と同じ ms）で扱い、
// 表示する側の現在時刻とは混ぜない。
//
// タイムラインファイルの形式は README の「タイムラインファイル」を参照。要点:
//   entries[].t        … 詠唱が始まる時刻（フェーズ開始からの秒）。画面の詠唱バーに技名が出る瞬間なので、同期の基準になる
//   entries[].duration … 詠唱の長さ（秒）。t + duration が技の発動。詠唱の無い技は 0
//   entries[].name     … ゲーム内の技名（詠唱バーの表記）。sync が false でなければ、詠唱バーで読めたときに同期する
//   phases[].next      … フェーズの移り方。上から順に見て、最初に満たしたものに移る
//                        when: { cast: 技名 } / { hp: 50 }（以下になったら）/ { time: 180 }（フェーズ内の秒）/
//                              { hpLost: 3 }（HP が 3 秒以上読めない＝ボスが消えた）
//                        at: 移った瞬間の、移り先フェーズでの秒（既定 0）

export const DEFAULT_SYNC_WINDOW = [10, 10]; // 予定の何秒前から何秒後まで、詠唱で同期してよいか
const COUNTDOWN_CONSISTENT_MS = 1000; // 「戦闘開始！」の時刻と予想がこれ以内なら、早いほうを開始とする
// カウントダウンの予想は、ほかの予想とこれ以内で合うものだけを信じる（秒数の読み違いを除く）。
// 吹き出しは重なりなどで 1〜3 秒遅れて読めることがある（2026-10-20 実測）ので、遅れた予想どうしも合うよう広めに取る
const COUNTDOWN_SUPPORT_MS = 1500;
const EARLY_PULL_MS = 1000; // 予想より早く敵対リストが出たら、カウントダウン前に殴ったとみなす
const COUNTDOWN_GIVE_UP_MS = 5000; // 予想時刻を過ぎても敵対リストが出なければ、カウントダウンは取り消されたとみなす
// 敵対リストがこれ以上続けて出ていたら「出た」とみなす（戦闘の後に 0.5 秒ほど出たり消えたりすることがある。2026-10-20 実測）
export const ENMITY_ON_MIN_MS = 1000;
export const ENMITY_OFF_END_MS = 3000; // 戦闘中に敵対リストがこれ以上消えていたら、戦闘終了（全滅・討伐）とみなす

/** タイムラインファイルの中身を確かめる。問題があれば日本語の説明の配列を返す（空なら問題なし） */
export function validateTimeline(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
        return ['JSON のオブジェクトではありません'];
    }
    if (data.format !== 'castline/1') {
        errors.push('format が "castline/1" ではありません');
    }
    if (typeof data.content !== 'string' || data.content === '') {
        errors.push('content（コンテンツ名）がありません');
    }
    if (!Array.isArray(data.phases) || data.phases.length === 0) {
        errors.push('phases（フェーズ）がありません');
        return errors;
    }
    const ids = new Set(data.phases.map((p) => p.id));
    data.phases.forEach((phase, i) => {
        const where = `phases[${i}]（${phase.id ?? 'id なし'}）`;
        if (typeof phase.id !== 'string') {
            errors.push(`${where}: id がありません`);
        }
        if (!Array.isArray(phase.entries)) {
            errors.push(`${where}: entries がありません`);
        } else {
            phase.entries.forEach((e, j) => {
                if (typeof e.t !== 'number' || typeof e.name !== 'string') {
                    errors.push(`${where}.entries[${j}]: t（秒）と name（技名）が必要です`);
                }
            });
        }
        for (const rule of phase.next ?? []) {
            if (!ids.has(rule.to)) {
                errors.push(`${where}.next: 移り先 "${rule.to}" のフェーズがありません`);
            }
            const keys = Object.keys(rule.when ?? {});
            if (keys.length !== 1 || !['cast', 'hp', 'time', 'hpLost'].includes(keys[0])) {
                errors.push(`${where}.next: when は cast・hp・time・hpLost のどれか 1 つにしてください`);
            }
        }
    });
    return errors;
}

export class TimelineEngine {
    /**
     * @param {object} timeline validateTimeline を通ったもの
     * @param {{hasEnmity?: boolean, log?: (at:number, message:string) => void}} [options]
     *        hasEnmity: 敵対リストの範囲を読んでいるか（読んでいなければ、取り消し・終了の判定はしない）
     */
    constructor(timeline, options = {}) {
        this.timeline = timeline;
        this.phases = new Map(timeline.phases.map((p) => [p.id, p]));
        this.syncWindow = timeline.syncWindow ?? DEFAULT_SYNC_WINDOW;
        this.hasEnmity = options.hasEnmity ?? false;
        this.log = options.log ?? (() => {});
        this.reset();
    }

    reset() {
        this.state = 'idle'; // idle → countdown → combat → ended
        this.countdownSamples = new Map(); // 残り秒数 → 最初に見えた時刻
        this.startAt = null;
        this.phase = null;
        this.phaseStartAt = null;
        this.synced = new Set(); // 同期に使った予定（同じ予定で何度も合わせ直さない）
        this.enmityShown = false;
        this.enmityOnSince = null;
        this.enmityOffSince = null;
        this.lastHpAt = null;
        this.hp = null;
    }

    // ── 観測 ──

    /** カウントダウンの吹き出し「戦闘開始まで N 秒！」を読んだ */
    countdown(at, seconds) {
        if (this.state === 'combat') {
            return;
        }
        if (this.state !== 'countdown') {
            this.reset();
            this.state = 'countdown';
        }
        // 吹き出しは 2 秒ほど出たままなので、各秒数は最初に見えた時刻だけを使う（後の時刻ほど予想が遅れる）
        if (!this.countdownSamples.has(seconds)) {
            this.countdownSamples.set(seconds, at);
            this.log(at, `カウントダウン 残り ${seconds} 秒 → 開始予想 ${fmt(this.predictedStart())}`);
        }
    }

    /** 吹き出し「戦闘開始！」を読んだ */
    started(at) {
        if (this.state === 'combat') {
            return;
        }
        this.beginCombat(this.bestStart(at), '戦闘開始の表示');
    }

    /** 敵対リストが出ている（shown = true）か消えている。開始の判定は advance（続けて出ていた時間を見る） */
    enmity(at, shown) {
        this.enmityShown = shown;
        if (shown) {
            this.enmityOffSince = null;
            this.enmityOnSince ??= at;
        } else {
            this.enmityOnSince = null;
            this.enmityOffSince ??= at;
        }
        this.advance(at);
    }

    /** ボスの HP（%）。読めなければ null */
    hpPercent(at, value) {
        if (value === null) {
            this.advance(at);
            return;
        }
        this.hp = value;
        this.lastHpAt = at;
        if (this.state === 'combat') {
            const rule = this.findRule((w) => w.hp !== undefined && value <= w.hp);
            if (rule) {
                this.transition(rule, at, `HP ${value}%`);
            }
        }
        this.advance(at);
    }

    /** 詠唱バーで技名が決まった（同じ詠唱が続く間は 1 回だけ渡すこと） */
    cast(at, name) {
        this.advance(at);
        if (this.state !== 'combat') {
            return;
        }
        const rule = this.findRule((w) => w.cast === name);
        if (rule) {
            this.transition(rule, at, `詠唱 ${name}`);
            return;
        }
        const now = this.phaseTime(at);
        const entry = this.syncTarget(name, now);
        if (entry) {
            this.synced.add(entry);
            const before = this.phaseStartAt;
            this.phaseStartAt = at - entry.t * 1000;
            this.log(at, `同期 ${name}: ${this.phase.id} の ${now.toFixed(1)} 秒 → ${entry.t} 秒（${((before - this.phaseStartAt) / 1000).toFixed(1)} 秒ずらす）`);
        }
    }

    // ── 状態 ──

    /** 時刻 at の状態。時間で決まる変化（予想時刻の到来・時間での移行・戦闘終了）もここで反映する */
    status(at) {
        this.advance(at);
        return {
            state: this.state,
            predictedStart: this.state === 'countdown' ? this.predictedStart() : null,
            phase: this.phase,
            phaseTime: this.state === 'combat' ? this.phaseTime(at) : null,
            combatTime: this.startAt !== null && this.state === 'combat' ? (at - this.startAt) / 1000 : null,
        };
    }

    /**
     * これから来る予定（戦闘前は最初のフェーズの頭から）。castIn は詠唱開始まで、hitIn は発動までの秒。
     * 発動から keepSeconds 秒たつまでは残す。
     */
    upcoming(at, count = 8, keepSeconds = 2) {
        this.advance(at);
        const phase = this.phase ?? this.timeline.phases[0];
        const now = this.state === 'combat' ? this.phaseTime(at) : this.countdownTime(at);
        return phase.entries
            .map((e) => ({
                entry: e,
                castIn: e.t - now,
                hitIn: e.t + (e.duration ?? 0) - now,
            }))
            .filter((u) => u.hitIn >= -keepSeconds)
            .sort((a, b) => a.hitIn - b.hitIn)
            .slice(0, count);
    }

    /** いま詠唱バーで照合すべき技名（同期の窓に入っている予定と、フェーズの移り方の技名だけに絞る） */
    castCandidates(at) {
        this.advance(at);
        const phase = this.phase ?? this.timeline.phases[0];
        const now = this.state === 'combat' ? this.phaseTime(at) : 0;
        const names = new Set();
        for (const e of phase.entries) {
            const [before, after] = e.window ?? this.syncWindow;
            if (e.sync !== false && !this.synced.has(e) && now >= e.t - before && now <= e.t + after) {
                names.add(e.name);
            }
        }
        for (const rule of phase.next ?? []) {
            if (rule.when.cast) {
                names.add(rule.when.cast);
            }
        }
        return [...names];
    }

    // ── 内部 ──

    phaseTime(at) {
        return (at - this.phaseStartAt) / 1000;
    }

    // 戦闘前の表示用: 開始予想までの残りを負の秒で返す（予想が無ければ 0）
    countdownTime(at) {
        const predicted = this.state === 'countdown' ? this.predictedStart() : null;
        return predicted === null ? 0 : Math.min(0, (at - predicted) / 1000);
    }

    // カウントダウンの各秒数から予想した開始時刻。吹き出しは出た瞬間ではなく後で読めるので、予想は実際より遅れることはあっても
    // 早まることはない。そこで、ほかの予想と合う（読み違いではない）予想のうち最も早いものを採る。
    // どの予想も合わない（1 つしかない、またはばらばら）ときは中央値（2 つなら早いほう）
    predictedStart() {
        const sorted = [...this.countdownSamples].map(([seconds, at]) => at + seconds * 1000).sort((a, b) => a - b);
        if (sorted.length === 0) {
            return null;
        }
        const supported = sorted.filter((p, i) => sorted.some((q, j) => j !== i && Math.abs(p - q) <= COUNTDOWN_SUPPORT_MS));
        return supported[0] ?? sorted[Math.floor((sorted.length - 1) / 2)];
    }

    // 「戦闘開始！」を読んだ時刻と、カウントダウンからの予想のうち早いほう（どちらも実際より遅れて見えるため）
    bestStart(at) {
        const predicted = this.predictedStart();
        if (predicted !== null && Math.abs(predicted - at) <= COUNTDOWN_CONSISTENT_MS) {
            return Math.min(predicted, at);
        }
        return at;
    }

    beginCombat(startAt, reason) {
        this.startAt = startAt;
        this.state = 'combat';
        this.phase = this.timeline.phases[0];
        this.phaseStartAt = startAt;
        this.synced = new Set();
        this.enmityOffSince = this.enmityShown ? null : this.enmityOffSince;
        this.log(startAt, `戦闘開始（${reason}）`);
    }

    findRule(test) {
        return (this.phase?.next ?? []).find((rule) => test(rule.when));
    }

    transition(rule, at, reason) {
        const from = this.phase.id;
        this.phase = this.phases.get(rule.to);
        this.phaseStartAt = at - (rule.at ?? 0) * 1000;
        this.synced = new Set();
        this.log(at, `フェーズ ${from} → ${rule.to}（${reason}）`);
    }

    // 名前が一致し、同期の窓に入っている予定のうち、いまの秒に最も近いもの
    syncTarget(name, now) {
        let best = null;
        for (const e of this.phase.entries) {
            const [before, after] = e.window ?? this.syncWindow;
            if (e.name !== name || e.sync === false || this.synced.has(e) || now < e.t - before || now > e.t + after) {
                continue;
            }
            if (!best || Math.abs(e.t - now) < Math.abs(best.t - now)) {
                best = e;
            }
        }
        return best;
    }

    // 時間で決まる変化を反映する
    advance(at) {
        // 敵対リストは ENMITY_ON_MIN_MS 続いてから「出た」とみなし、開始は出始めた時刻にさかのぼる
        const steady = this.enmityShown && at - this.enmityOnSince >= ENMITY_ON_MIN_MS;
        if (steady && (this.state === 'idle' || this.state === 'ended')) {
            this.beginCombat(this.enmityOnSince, '敵対リスト（カウントダウンなし）');
        } else if (steady && this.state === 'countdown') {
            const predicted = this.predictedStart();
            if (predicted === null || this.enmityOnSince < predicted - EARLY_PULL_MS) {
                this.beginCombat(this.enmityOnSince, '敵対リスト（カウントダウン前に開始）');
            }
        }
        if (this.state === 'countdown') {
            const predicted = this.predictedStart();
            if (predicted !== null && at >= predicted) {
                if (!this.hasEnmity) {
                    this.beginCombat(predicted, 'カウントダウンの予想時刻');
                } else if (steady) {
                    this.beginCombat(predicted, 'カウントダウンの予想時刻と敵対リスト');
                } else if (at >= predicted + COUNTDOWN_GIVE_UP_MS) {
                    this.log(at, 'カウントダウンの後に敵対リストが出ないので、取り消しとみなす');
                    this.reset();
                }
            }
        }
        if (this.state !== 'combat') {
            return;
        }
        if (this.hasEnmity && this.enmityOffSince !== null && at - this.enmityOffSince >= ENMITY_OFF_END_MS) {
            this.state = 'ended';
            this.log(at, `戦闘終了（敵対リストが ${ENMITY_OFF_END_MS / 1000} 秒以上消えた）`);
            return;
        }
        // 時間で移るフェーズは、何度でも続けて移れる（長く止まっていた場合）
        for (let guard = 0; guard < 20; guard++) {
            const now = this.phaseTime(at);
            // HP が読めない時間は、このフェーズに入ってから数える（前のフェーズの分は数えない）
            const hpSeenAt = Math.max(this.lastHpAt ?? -Infinity, this.phaseStartAt);
            const rule = this.findRule((w) => (w.time !== undefined && now >= w.time)
                || (w.hpLost !== undefined && at - hpSeenAt >= w.hpLost * 1000));
            if (!rule) {
                break;
            }
            const happenedAt = rule.when.time !== undefined ? this.phaseStartAt + rule.when.time * 1000 : at;
            this.transition(rule, happenedAt, rule.when.time !== undefined ? `時間 ${rule.when.time} 秒` : `HP が ${rule.when.hpLost} 秒読めない`);
        }
    }
}

function fmt(ms) {
    if (ms === null) {
        return '—';
    }
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}
