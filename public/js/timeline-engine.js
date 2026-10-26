// タイムラインを進める処理。画面の読み取り結果（観測）を受け取り、いまどのフェーズの何秒目かを決める。
// DOM を使わない（node でテストする）。時刻はすべて観測したフレームが届いた時刻 at（Date.now() と同じ ms）で扱い、
// 表示する側の現在時刻とは混ぜない。
//
// タイムラインファイルの形式は README の「タイムラインファイル」を参照。要点:
//   entries[].t        … 詠唱が始まる時刻（フェーズ開始からの秒）。画面の詠唱バーに技名が出る瞬間なので、同期の基準になる
//   entries[].duration … 詠唱の長さ（秒）。t + duration が技の発動。詠唱の無い技は 0
//   entries[].name     … ゲーム内の技名（詠唱バーの表記）。sync が false でなければ、詠唱バーで読めたときに同期する。
//                        毎回どれかが出る技は「A|B」と書く（どちらが読めても同期する）
//   phases[].next      … フェーズの移り方。上から順に見て、最初に満たしたものに移る
//                        when: { cast: 技名（A|B も可） } / { hp: 50 }（以下になったら）/ { time: 180 }（フェーズ内の秒）/
//                              { hpLost: 3 }（HP が 3 秒以上読めない＝ボスが消えた）
//                        at: 移った瞬間の、移り先フェーズでの秒（既定 0）
//   phases[].start     … ボスの戦闘の始まりのフェーズ（ダンジョン・アライアンスのように 1 つのコンテンツにボスが何体もいるとき）。
//                        2 つ以上あると、戦闘が始まってもどのボスかは決めず、最初に読めた技が入っている start のフェーズに決める。
//                        決まらないまま終わった戦闘（道中）では何も出さない。start が無いか 1 つなら phases[0] から始める

/** 技名の欄（「A|B」）を、照合する名前の配列にする */
export function castNames(name) {
    return String(name).split('|').map((n) => n.trim()).filter(Boolean);
}

export const DEFAULT_SYNC_WINDOW = [10, 10]; // 予定の何秒前から何秒後まで、詠唱で同期してよいか
const COUNTDOWN_CONSISTENT_MS = 1000; // 「戦闘開始！」の時刻と予想がこれ以内なら、早いほうを開始とする
// カウントダウンの予想は、ほかの予想とこれ以内で合うものだけを信じる（秒数の読み違いを除く）。
// 吹き出しは重なりなどで 1〜3 秒遅れて読めることがある（2026-10-20 実測）ので、遅れた予想どうしも合うよう広めに取る
const COUNTDOWN_SUPPORT_MS = 1500;
const STARTED_EARLY_MAX_MS = 3000; // 「戦闘開始！」が開始の予想よりこれ以上早く読めたら、読み違いとみなす
// 同じ技名がこれより短い間を空けて読めたら、同じ詠唱の続きとみなす（読み取りは 1 秒に数回。読み逃しで少し途切れても続きとする）
const CAST_REPEAT_GAP_MS = 3000;
// 直前の同期から t 秒たったとき、ずらしてよいのは SYNC_SHIFT_MIN_S + SYNC_SHIFT_PER_S × t 秒まで。実際の戦闘の時刻は、合わせた直後に
// 何秒も跳ばない（討伐ごとの違いは少しずつ積もる）ので、それより大きいずれは読み違いを疑って保留する（2026-10-21 の動画:
// ハードコアの 1 秒後に「ヴァンプストンプ」と読み違えて 9 秒先へ進んだ）。戦闘・フェーズの最初の同期は開始時刻があいまいなので制限しない
const SYNC_SHIFT_MIN_S = 2;
const SYNC_SHIFT_PER_S = 0.1;
// 保留した同期は、これ以内に別の技で同じずれ（SYNC_AGREE_MS 以内）が確かめられたら合わせる
const SYNC_CONFIRM_MS = 30000;
const SYNC_AGREE_MS = 1500;
const EARLY_PULL_MS = 1000; // 予想より早く敵対リストが出たら、カウントダウン前に殴ったとみなす
const COUNTDOWN_GIVE_UP_MS = 5000; // 予想時刻を過ぎても敵対リストが出なければ、カウントダウンは取り消されたとみなす
// 敵対リストがこれ以上続けて出ていたら「出た」とみなす（戦闘の後に 0.5 秒ほど出たり消えたりすることがある。2026-10-20 実測）
export const ENMITY_ON_MIN_MS = 1000;
// 始めから文字がある敵対リストの範囲は、これだけ続けて空になってから開始に使う（一瞬読めなかっただけで「消えた」としない。
// 2026-10-21 クルーザー級2 の動画: カウントダウン中に一瞬消えて、敵対リストで早すぎる開始になった）
export const ENMITY_SEEN_OFF_MS = 2000;
// 戦闘の終わり（2026-10-21 のユーザーの確認）: 全滅すると画面が暗転し、HUD も消える（「全滅」の表示は出ない）。
// 一方、フェーズの移り変わりでも敵対リスト・HP・詠唱バーが消えるコンテンツがある（絶もうひとつの未来）ので、敵が消えただけでは終わらせない
// 暗転は明けた時点で長さを見て決める（2026-10-26 の録画: 全滅の真っ黒は 7 回とも 2.2〜2.4 秒。極永遠の闇は戦闘の途中の
// エリア転換で 5 秒暗転する）。この範囲なら全滅、長ければエリア転換として戦闘を続ける。短いものは演出の一瞬の暗転。
// 長さは「黒かったコマの数 × 読み取りの間隔」なので、間隔（0.5〜1 秒）の分ずれる。どちらの間隔でも、一瞬の暗転（1 秒）・
// 全滅（2.2〜2.4 秒）・エリア転換（5 秒）が分かれるように決めた
export const BLACKOUT_WIPE_MIN_MS = 1700;
export const BLACKOUT_WIPE_MAX_MS = 3500;
const BLACKOUT_GAP_MAX_MS = 1500; // 暗転が明けたコマまでの間隔として使う上限（読み取りが止まっていた分は数えない）
export const BOSS_NAME_MIN = 4; // ボスを決める技名の最短の文字数（短い技名は、雑魚の技名の一部に当たりやすい）
export const ENMITY_OFF_END_MS = 3000; // 最後のフェーズで HP が KILL_HP 以下になった後、敵対リストがこれ以上消えたら討伐とみなす
// 敵対リストがこれ以上消えたままなら、終わったとみなす（フェーズの移り変わりより十分長く。2026-10-26 の録画で最長 57〜76 秒）
export const ENEMY_GONE_END_MS = 120000;
const KILL_HP = 3; // 読み取りの間隔があるので、0% を読めなくても討伐とみなす HP

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
        if (phase.start !== undefined && typeof phase.start !== 'boolean') {
            errors.push(`${where}: start は true か false にしてください`);
        }
        if (!Array.isArray(phase.entries)) {
            errors.push(`${where}: entries がありません`);
        } else {
            phase.entries.forEach((e, j) => {
                if (typeof e.t !== 'number' || typeof e.name !== 'string') {
                    errors.push(`${where}.entries[${j}]: t（秒）と castname（技名）が必要です`);
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
        const starts = timeline.phases.filter((p) => p.start);
        this.starts = starts.length > 0 ? starts : [timeline.phases[0]]; // 戦闘の始まりのフェーズ（2 つ以上ならボスを技で決める）
        this.syncWindow = timeline.syncWindow ?? DEFAULT_SYNC_WINDOW;
        this.hasEnmity = options.hasEnmity ?? false;
        this.log = options.log ?? (() => {});
        // 新しい戦闘を始めてよいか。再生画面は、コンテンツ名を読めている間だけ true にする（街で始めない。reset では戻さない）
        this.startAllowed = true;
        // 敵対リストの範囲が一度でも空だったか。始めから文字がある（範囲が別の表示にかかっている、止めた動画の画面など）うちは、
        // 敵対リストでは始めない。敵対リストは「出てきた」ときが開始（2026-10-21、止めた動画の画面で勝手に始まった）
        this.enmitySeenOff = false;
        this.enmityEmptySince = null; // 敵対リストの範囲が空になった時刻（enmitySeenOff を決めるため。reset では消さない）
        this.enmityStaleLogged = false;
        this.reset();
    }

    reset() {
        this.state = 'idle'; // idle → countdown → combat → ended
        this.countdownSamples = new Map(); // 残り秒数 → 最初に見えた時刻
        this.countdownSince = null; // カウントダウンが最初に見えた時刻
        this.startAt = null;
        this.phase = null;
        this.phaseStartAt = null;
        this.synced = new Set(); // 同期に使った予定（同じ予定で何度も合わせ直さない）
        this.lastSyncAt = null; // このフェーズで最後に同期した時刻（null ならまだ。最初の同期はずらす量を制限しない）
        this.pendingSync = null; // ずれが大きくて保留した同期 {start, at}
        this.castSeenAt = new Map(); // 技名 → 最後に読めた時刻（同じ詠唱の続きを見分ける）
        this.enmityShown = false;
        this.enmityObservedAt = null;
        this.enmityOnSince = null;
        this.enmityOffSince = null;
        this.holdUntilEnmityOff = false; // 手動で止めた後、敵対リストが一度消えるまで敵対リストでは始めない
        this.lastHpAt = null;
        this.hp = null;
        this.blackSince = null;
        this.blackLastAt = null; // 最後に黒かったコマの時刻
        this.haltedStart = null;
    }

    // ── 観測 ──

    /** カウントダウンの吹き出し「戦闘開始まで N 秒！」を読んだ */
    countdown(at, seconds) {
        if (this.state === 'combat') {
            // 敵が見えないときのカウントダウンは、全滅の後の次の戦闘（暗転を読み逃しても数え直す）
            if (this.enmityShown) {
                return;
            }
            this.log(at, '戦闘中に敵が見えないままカウントダウンが出たので、次の戦闘として数え直す');
            this.reset();
        }
        if (this.holdUntilEnmityOff && this.haltedStart !== null && Math.abs(at + seconds * 1000 - this.haltedStart) <= 2 * COUNTDOWN_SUPPORT_MS) {
            return; // 手で止めたカウントダウンの続き
        }
        if (this.state !== 'countdown') {
            // 敵対リストの見え方は画面の観察なので、数え直しても残す（消すと、前から出ていた文字が「カウントダウン中に出た」に見える。
            // 2026-10-21 クルーザー級2: 文字の残った敵対リストの範囲で、カウントダウンが出るたびに「カウントダウン前に開始」になった）
            const { enmityShown, enmityOnSince } = this;
            this.reset();
            Object.assign(this, { enmityShown, enmityOnSince });
            this.state = 'countdown';
            this.countdownSince = at;
        }
        // 吹き出しは 2 秒ほど出たままなので、各秒数は最初に見えた時刻だけを使う（後の時刻ほど予想が遅れる）
        if (!this.countdownSamples.has(seconds)) {
            this.countdownSamples.set(seconds, at);
            this.log(at, `カウントダウン 残り ${seconds} 秒 → 開始予想 ${fmt(this.predictedStart())}`);
        }
    }

    /** 利用者が手で止めた。次のカウントダウンか、敵対リストが一度消えてからまた出たとき、また始まる */
    halt(at) {
        if (this.state === 'idle') {
            return;
        }
        const predicted = this.state === 'countdown' ? this.predictedStart() : null;
        this.reset();
        this.state = 'ended';
        this.holdUntilEnmityOff = true;
        this.haltedStart = predicted; // カウントダウン中に止めたら、その続きの吹き出しでは数え直さない
        this.log(at, '手で止めた');
    }

    /** 吹き出し「戦闘開始！」を読んだ */
    started(at) {
        // 手で止めた後は、次のカウントダウン（reset で止めた状態が解ける）が出るまで「戦闘開始！」でも始めない
        if (this.state === 'combat' || this.holdUntilEnmityOff || !this.startAllowed) {
            return;
        }
        // 「戦闘開始！」はカウントダウンの終わりにしか出ないので、予想より大きく早いものは読み違い（行の一部だけを読んだなど）
        const predicted = this.state === 'countdown' ? this.predictedStart() : null;
        if (predicted !== null && predicted - at > STARTED_EARLY_MAX_MS) {
            this.log(at, `「戦闘開始」と読めたが、開始の予想まで ${((predicted - at) / 1000).toFixed(1)} 秒あるので読み違いとみなす`);
            return;
        }
        this.beginCombat(this.bestStart(at), '戦闘開始の表示');
    }

    /** 敵対リストが出ている（shown = true）か消えている。開始の判定は advance（続けて出ていた時間を見る） */
    enmity(at, shown) {
        this.enmityObservedAt = at;
        this.enmityShown = shown;
        // 空だった長さ（また出た時刻で測る。空のままの間は advance で測る）
        if (!shown) {
            this.enmityEmptySince ??= at;
        } else {
            this.noteEnmityEmpty(at);
            this.enmityEmptySince = null;
        }
        if (shown && !this.enmitySeenOff && !this.enmityStaleLogged) {
            this.enmityStaleLogged = true;
            this.log(at, '敵対リストの範囲に始めから文字があるので、一度消えるまで敵対リストでは始めない（戦闘前に文字が出ている場合は、範囲がずれています）');
        }
        const shownLongEnough = shown && this.enmityOnSince !== null
            && at - this.enmityOnSince >= ENMITY_ON_MIN_MS;
        if (shownLongEnough && this.state === 'combat' && !this.phase && this.enmityOffSince !== null && at - this.enmityOffSince >= ENMITY_OFF_END_MS) {
            // ボスが決まらないまま（道中）敵対リストが消えて、また出た: 次のプル。ボスを決めるときの秒を、ここから数え直す
            // （道中の戦闘は討伐で終えないので、ボスのプルまで同じ戦闘が続くことがある）
            this.startAt = at;
            this.phaseStartAt = at;
            this.hp = null;
            this.lastHpAt = null;
            this.log(at, 'ボスが決まらないまま敵対リストがまた出たので、ここから次のプルとして数える');
        }
        if (shown) {
            // During combat, a single OCR hit must not reset a long absence.
            if (this.state !== 'combat' || shownLongEnough) { this.enmityOffSince = null; }
            this.enmityOnSince ??= at;
        } else {
            this.enmityOnSince = null;
            this.enmityOffSince ??= at;
            this.holdUntilEnmityOff = false;
        }
        this.advance(at);
    }

    /** 画面全体が暗転している（black = true）か。全滅かどうかは、暗転が明けたときに長さで決める */
    blackout(at, black) {
        if (black) {
            this.blackSince ??= at;
            this.blackLastAt = at;
        } else if (this.blackSince !== null) {
            // 黒かった最初と最後のコマの間に、読み取りの間隔 1 つ分を足す（1 秒おきの読み取りで、2.2 秒の全滅が黒 2 コマ＝1 秒と
            // 短く出て全滅を逃した。Codex の差分レビュー）
            const length = this.blackLastAt - this.blackSince + Math.min(at - this.blackLastAt, BLACKOUT_GAP_MAX_MS);
            const since = this.blackSince;
            this.blackSince = null;
            this.advance(at);
            if (this.state === 'combat' && length >= BLACKOUT_WIPE_MIN_MS) {
                if (length <= BLACKOUT_WIPE_MAX_MS) {
                    this.end(since, `画面が ${(length / 1000).toFixed(1)} 秒暗転した。全滅`);
                } else {
                    this.log(at, `画面が ${(length / 1000).toFixed(1)} 秒暗転した。全滅の暗転（${BLACKOUT_WIPE_MAX_MS / 1000} 秒まで）より長いので、エリア転換として続ける`);
                }
            }
        }
        this.advance(at);
    }

    end(at, reason) {
        this.state = 'ended';
        // Do not restart on the same enemy-list observation after a wipe/end.
        this.holdUntilEnmityOff = this.enmityShown;
        this.log(at, `戦闘終了（${reason}）`);
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

    /** 詠唱バー・敵対リストで技名が決まった（同じ詠唱が見えている間、読むたびに何度渡してもよい） */
    cast(at, name) {
        this.advance(at);
        if (this.state !== 'combat') {
            return;
        }
        // 同じ技名が間を空けずに続いて読めたら、同じ詠唱の続き。次の同じ名前の予定に合わせ直さない
        // （2026-10-21 の動画: 10 秒おきのハーフムーンで、1 回の詠唱を 2 回目の予定にも合わせて 10 秒先へ進んだ）
        const last = this.castSeenAt.get(name);
        this.castSeenAt.set(name, at);
        if (last !== undefined && at - last < CAST_REPEAT_GAP_MS) {
            return;
        }
        if (!this.phase) {
            this.chooseBoss(at, name);
            return;
        }
        const rule = this.findRule((w) => w.cast !== undefined && castNames(w.cast).includes(name));
        if (rule) {
            this.transition(rule, at, `詠唱 ${name}`);
            return;
        }
        const now = this.phaseTime(at);
        const entry = this.syncTarget(name, now);
        if (!entry) {
            return;
        }
        const start = at - entry.t * 1000;
        const shift = (this.phaseStartAt - start) / 1000;
        if (this.lastSyncAt !== null) {
            const allowed = SYNC_SHIFT_MIN_S + SYNC_SHIFT_PER_S * (at - this.lastSyncAt) / 1000;
            const pending = this.pendingSync;
            const confirmed = pending && at - pending.at <= SYNC_CONFIRM_MS && Math.abs(pending.start - start) <= SYNC_AGREE_MS;
            if (Math.abs(shift) > allowed && !confirmed) {
                this.pendingSync = { start, at };
                this.log(at, `同期を保留 ${name}: ${this.phase.id} の ${now.toFixed(1)} 秒 → ${entry.t} 秒（${shift.toFixed(1)} 秒は前の同期から ${((at - this.lastSyncAt) / 1000).toFixed(1)} 秒でずらすには大きい。次の技で同じずれなら合わせる）`);
                return;
            }
        }
        this.pendingSync = null;
        this.lastSyncAt = at;
        this.synced.add(entry);
        this.phaseStartAt = start;
        this.log(at, `同期 ${name}: ${this.phase.id} の ${now.toFixed(1)} 秒 → ${entry.t} 秒（${shift.toFixed(1)} 秒ずらす）`);
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
        if (!this.phase && this.starts.length > 1) {
            return []; // どのボスかまだ決まっていない（戦闘前も、どのボスか分からないので出さない）
        }
        const phase = this.phase ?? this.starts[0];
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
        const now = this.state === 'combat' ? this.phaseTime(at) : 0;
        const names = new Set();
        if (this.state === 'combat' && !this.phase) {
            // どのボスかまだ決まっていない: ボスの技を全部（最初の技を読み逃しても、次の技で決められるように）
            for (const phase of this.starts) {
                phase.entries.filter((e) => e.sync !== false).forEach((e) => castNames(e.name).forEach((n) => names.add(n)));
            }
            return [...names];
        }
        const phase = this.phase ?? this.starts[0];
        for (const e of phase.entries) {
            const [before, after] = e.window ?? this.syncWindow;
            if (e.sync !== false && !this.synced.has(e) && now >= e.t - before && now <= e.t + after) {
                castNames(e.name).forEach((n) => names.add(n));
            }
        }
        for (const rule of phase.next ?? []) {
            if (rule.when.cast) {
                castNames(rule.when.cast).forEach((n) => names.add(n));
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
    // どの予想も合わない（1 つしかない、またはばらばら）ときは、いちばん大きい秒数の予想。読み違いは「10」を「1」のように
    // 桁を落とすことが多く、小さい秒数の予想は早すぎて、まだカウントダウン中に戦闘を始めてしまう（2026-10-21、動画で確認）
    predictedStart() {
        const samples = [...this.countdownSamples].map(([seconds, at]) => ({ seconds, p: at + seconds * 1000 }));
        if (samples.length === 0) {
            return null;
        }
        const sorted = samples.map((x) => x.p).sort((a, b) => a - b);
        const supported = sorted.filter((p, i) => sorted.some((q, j) => j !== i && Math.abs(p - q) <= COUNTDOWN_SUPPORT_MS));
        return supported[0] ?? samples.reduce((a, b) => (b.seconds > a.seconds ? b : a)).p;
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
        // 前の戦闘で読んだ HP は使わない（カウントダウンなしで続けて始めたとき、前の戦闘の HP 3% で次の戦闘がすぐ討伐になった。
        // 2026-10-23 ユーザーのエキルレの記録で、雑魚の戦闘が始まって数秒で前の HP のまま終わった）
        this.hp = null;
        this.lastHpAt = null;
        // ボスが何体もいるときは最初に読めた技で決める（cast）。それまでは戦闘開始を 0 秒として数える
        this.phase = this.starts.length > 1 ? null : this.starts[0];
        this.phaseStartAt = startAt;
        this.synced = new Set();
        this.lastSyncAt = null;
        this.pendingSync = null;
        this.enmityOffSince = this.enmityShown ? null : this.enmityOffSince;
        this.log(startAt, `戦闘開始（${reason}）`);
    }

    // どのボスかを、読めた技から決める。同期の窓に入る予定があるボスを先に（XML の順）、無ければ技名が入っている最初のボスの、
    // いちばん早い予定に合わせる（いまの秒は道中から数えていることがあり当てにならない。最初に読める技は開幕に近い。外れても後の同期で戻る）。
    // どのボスの技でもなければ待つ（道中の雑魚）。短い技名では決めない
    chooseBoss(at, name) {
        if ([...name].length < BOSS_NAME_MIN) {
            return;
        }
        const now = this.phaseTime(at);
        let found = null;
        for (const phase of this.starts) {
            const entry = this.syncTarget(name, now, phase);
            if (entry) {
                found = { phase, entry, how: '' };
                break;
            }
        }
        for (const phase of found ? [] : this.starts) {
            const entry = phase.entries.filter((e) => e.sync !== false && castNames(e.name).includes(name)).sort((a, b) => a.t - b.t)[0];
            if (entry) {
                found = { phase, entry, how: '（同期の窓の外。いちばん早い予定に合わせた）' };
                break;
            }
        }
        if (!found) {
            return;
        }
        this.phase = found.phase;
        this.phaseStartAt = at - found.entry.t * 1000;
        this.lastSyncAt = at;
        this.synced.add(found.entry);
        this.log(at, `ボスを決めた: ${found.phase.name ?? found.phase.id}（詠唱 ${name} → ${found.entry.t} 秒${found.how}）`);
    }

    findRule(test) {
        return (this.phase?.next ?? []).find((rule) => test(rule.when));
    }

    transition(rule, at, reason) {
        const from = this.phase.id;
        this.phase = this.phases.get(rule.to);
        this.phaseStartAt = at - (rule.at ?? 0) * 1000;
        this.synced = new Set();
        this.lastSyncAt = null;
        this.pendingSync = null;
        this.log(at, `フェーズ ${from} → ${rule.to}（${reason}）`);
    }

    // 名前が一致し、同期の窓に入っている予定のうち、いまの秒に最も近いもの
    syncTarget(name, now, phase = this.phase) {
        let best = null;
        for (const e of phase.entries) {
            const [before, after] = e.window ?? this.syncWindow;
            if (!castNames(e.name).includes(name) || e.sync === false || this.synced.has(e) || now < e.t - before || now > e.t + after) {
                continue;
            }
            if (!best || Math.abs(e.t - now) < Math.abs(best.t - now)) {
                best = e;
            }
        }
        return best;
    }

    noteEnmityEmpty(at) {
        if (this.enmityEmptySince !== null && at - this.enmityEmptySince >= ENMITY_SEEN_OFF_MS) {
            this.enmitySeenOff = true;
        }
    }

    // 時間で決まる変化を反映する
    advance(at) {
        if (!this.enmityShown) {
            this.noteEnmityEmpty(at);
        }
        // 敵対リストは ENMITY_ON_MIN_MS 続いてから「出た」とみなし、開始は出始めた時刻にさかのぼる
        const usable = this.hasEnmity && this.enmitySeenOff;
        // UI rendering must not turn one OCR hit into sustained combat evidence.
        const steady = usable && this.enmityShown
            && this.enmityObservedAt - this.enmityOnSince >= ENMITY_ON_MIN_MS;
        // 始めてよくない間（再生画面でコンテンツ名を読めていない）は、どの経路でも始めない。表示のための status() からも同じ
        const allowed = this.startAllowed;
        if (allowed && steady && (this.state === 'idle' || this.state === 'ended') && !this.holdUntilEnmityOff) {
            this.beginCombat(this.enmityOnSince, '敵対リスト（カウントダウンなし）');
        } else if (allowed && steady && this.state === 'countdown') {
            const predicted = this.predictedStart();
            // カウントダウン前に殴ったとみなすのは、カウントダウンが出た後に敵対リストが出たときだけ（前から出ていたものは使わない）
            const appeared = this.enmityOnSince >= this.countdownSince;
            if (appeared && (predicted === null || this.enmityOnSince < predicted - EARLY_PULL_MS)) {
                this.beginCombat(this.enmityOnSince, '敵対リスト（カウントダウン前に開始）');
            }
        }
        if (this.state === 'countdown') {
            const predicted = this.predictedStart();
            if (predicted !== null && at >= predicted) {
                if (allowed && !usable) {
                    this.beginCombat(predicted, 'カウントダウンの予想時刻');
                } else if (allowed && steady) {
                    this.beginCombat(predicted, 'カウントダウンの予想時刻と敵対リスト');
                } else if (at >= predicted + COUNTDOWN_GIVE_UP_MS) {
                    this.log(at, allowed ? 'カウントダウンの後に敵対リストが出ないので、取り消しとみなす'
                        : 'コンテンツ名を読めないまま開始の予想時刻を過ぎたので、カウントダウンを取り消しとみなす');
                    this.reset();
                }
            }
        }
        if (this.state !== 'combat') {
            return;
        }
        if (this.hasEnmity && !this.enmityShown && this.enmityOffSince !== null) {
            const off = at - this.enmityOffSince;
            // ボスが決まっていない戦闘（道中）は討伐では終えない（暗転・敵対リストが消えたままで終わる）
            const lastPhase = this.phase !== null && (this.phase.next ?? []).length === 0;
            if (lastPhase && this.hp !== null && this.hp <= KILL_HP && off >= ENMITY_OFF_END_MS) {
                this.end(at, `最後のフェーズで HP ${this.hp}% の後に敵対リストが消えた。討伐`);
                return;
            }
            if (off >= ENEMY_GONE_END_MS) {
                this.end(at, `敵対リストが ${ENEMY_GONE_END_MS / 1000} 秒以上消えたまま`);
                return;
            }
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
