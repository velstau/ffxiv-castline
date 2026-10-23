// 動画・取り込んだ画面から詠唱を記録する処理（タイムラインを記録する画面用）。DOM を使わない（node でテストする）。
// 詠唱バーの技名の範囲を細かい間隔で読み、技名が出ていた区間を 1 回の詠唱とする（出始め＝詠唱の開始、消えた＝詠唱の完了）。
// 詠唱バーの塗りは読まない（範囲の指定を増やさないため。2026-10-22 のユーザーの判断。精度が足りなければ見直す）。
// 時刻はすべて秒（動画なら動画の中の秒）。
import { castNames } from './timeline-engine.js';
import { levenshtein } from './readers.js';

// 技名の読みの後処理。名前の先頭は、バーの枠の線を「ー」と読み誤ることが多い（2026-10-22 の実験: 676 本の 10 コマ多数決で、
// 完全一致が 46% → 76%）。手元の技名 2,278 個に「ー」で始まるものは無い。漢字の「一」は「一刀両断」があるので落とさない
export function normalizeRead(text) {
    return String(text).trim().replace(/^[ー\s]+/, '').replace(/!/g, '！').replace(/\?/g, '？');
}

// 読んだ名前を候補に寄せてよい違い（違った文字数 ÷ 候補の文字数）。2026-10-22 の実験（676 本）で、
// 候補が全タイムラインの技名（2,278 個）のとき: 0.5 だと一覧に無い新しい技の 63% が似た別名に寄ってしまう。0.25 で 7%（一覧にある技は 94% 正しく寄る）
// 画面共有の記録で、戦闘の始まり・終わりだけを TimelineEngine で追うための空のタイムライン
// （予定もフェーズの移り先も無い。最後のフェーズなので、HP 3% 以下の後に敵対リストが消えたら討伐で終わる）
export const WATCH_TIMELINE = Object.freeze({ format: 'castline/1', content: '', phases: [{ id: 'p1', entries: [], next: [] }] });

// 戦闘の終わりは、再生画面の判定（2 秒の暗転・HP 3% 以下の後に敵対リストが 3 秒消えた・敵対リストが 90 秒消えた）に加えて、
// 記録用に討伐を早めに決める（2026-10-23 ユーザー指摘「戦闘終了が検知できていない」）。記録中は HP を 1 秒おきにしか読まないので
// 3% 以下を読む前に倒してしまうことが多い。ただし HP が低いときのムービー（最後のフェーズへの移り変わりなど）でも敵対リストは消えるので、
// これは「討伐の疑い」までで、呼び出し側が画面の表示（ムービー中は消える）を確かめてから終える。
// 「敵対リストがしばらく消えたら終わり」は短くしない（ムービーのたびに終わってしまう。2026-10-23 ユーザー指摘）
export const REC_KILL_HP = 10; // 最後に読んだ HP がこれ以下で、敵対リストが REC_KILL_OFF_MS 消えたら討伐の疑い
export const REC_KILL_OFF_MS = 3000;

// 敵対リストで始めた戦闘が、HP も詠唱も読めないまま敵対リストが消えたら、始まりの判定が誤り（敵対リストの範囲に別の表示が出た）として終える。
// 本当の戦闘では HP を読めるので、ムービーで敵対リストが消えても当たらない（2026-10-23 エキルレで、戦闘の後に敵対リストの範囲の文字が出入りして記録が終わらなかった）
export const FALSE_START_OFF_MS = 5000;

/** 始まりの判定が誤りだった疑い（engine の時刻 ms で）。casts: この戦闘で記録した詠唱の回数 */
export function falseStart(engine, ms, casts) {
    return engine.status(ms).state === 'combat' && engine.hasEnmity && engine.hp === null && casts === 0
        && engine.enmityOffSince !== null && ms - engine.enmityOffSince >= FALSE_START_OFF_MS;
}

/** 記録用の討伐の疑い（engine の時刻 ms で）。戦闘中で、最後に読んだ HP が REC_KILL_HP 以下、敵対リストが REC_KILL_OFF_MS 以上消えている */
export function killSuspected(engine, ms) {
    return engine.status(ms).state === 'combat' && engine.hasEnmity && engine.enmityOffSince !== null
        && engine.hp !== null && engine.hp <= REC_KILL_HP && ms - engine.enmityOffSince >= REC_KILL_OFF_MS;
}

export const SNAP_MISS_ANY = 0.25;
// 候補がそのタイムラインの技名だけのとき（補正）。動画の技名の確かめ（tools/cast-name-check.py）の 0.5 より少し緩い
// （2026-10-22 の検証: 動画 4 本で技名の正答が 97.1% → 98.4%。0.7 にしても変わらない）
export const SNAP_MISS_OWN = 0.6;

// 技名の前に付く余計な文字（範囲の左下に入った「FOCUS」の表示・枠の線など）は、読みの先頭のこれだけの文字まで数えない。
// 技名は右寄せで、余計な文字はコマごとに変わる（2026-10-22 のブラウザでの確認: 「レラダブル・グラフィティ」「しラダブル・グラフィティ」…で、
// そのままでは 1 回の詠唱の多数決が 88 コマ中 8 コマに割れた）
export const PREFIX_SKIP = 5;

/** 読みの先頭 skip 文字までは消しても数えないとしたときの、name との編集距離 */
export function tailDistance(read, name, skip = PREFIX_SKIP) {
    const a = [...read];
    const b = [...name];
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [Math.max(0, i - skip)];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * 読みに最も近い候補（違い＝tailDistance ÷ 候補の文字数）。違いが同じなら長い候補（「グラフィティ」より「ダブル・グラフィティ」）。
 * @returns {{name:string, miss:number}|null} 候補が無ければ null
 */
export function nearestName(read, candidates) {
    let best = null;
    for (const name of candidates) {
        const miss = tailDistance(read, name) / [...name].length;
        if (!best || miss < best.miss - 1e-9 || (Math.abs(miss - best.miss) <= 1e-9 && [...name].length > [...best.name].length)) {
            best = { name, miss };
        }
    }
    return best;
}

/**
 * 1 コマの読みを、近い候補があればその技名にする（区間のつなぎと多数決を、コマごとに変わる余計な文字に左右されないように）。
 * @returns {string} 候補の技名か、読んだ文字のまま
 */
export function snapRead(text, candidates, maxMiss) {
    const best = nearestName(text, candidates);
    return best && best.miss <= maxMiss ? best.name : text;
}

/**
 * 1 回の詠唱で読んだ文字の多数決をとり、候補に近ければ寄せる。
 * @param {{text:string, conf:number}[]} reads normalizeRead 済みの読み（snapRead で寄せてあってもよい）
 * @param {string[]} candidates 寄せる先の技名
 * @returns {{name:string, read:string, snapped:boolean, votes:number, miss:number|null}}
 *          name は寄せた技名（寄せなければ読んだ文字のまま）、votes は read と同じ読みのコマ数
 */
export function decideName(reads, candidates = [], maxMiss = SNAP_MISS_ANY) {
    const counts = new Map();
    for (const { text, conf } of reads) {
        if (text) {
            const c = counts.get(text) ?? { n: 0, conf: 0 };
            counts.set(text, { n: c.n + 1, conf: c.conf + conf });
        }
    }
    const ranked = [...counts.entries()].sort(([, a], [, b]) => b.n - a.n || b.conf / b.n - a.conf / a.n);
    if (ranked.length === 0) {
        return { name: '', read: '', snapped: false, votes: 0, miss: null };
    }
    const [read, { n: votes }] = ranked[0];
    const best = nearestName(read, candidates);
    const miss = best ? Math.round(best.miss * 100) / 100 : null;
    if (best && best.miss <= maxMiss) {
        return { name: best.name, read, snapped: true, votes, miss };
    }
    return { name: read, read, snapped: false, votes, miss };
}

// 詠唱の区切り方の定数は、2026-10-22 に動画 4 本・138 回の詠唱（塗りから測った正解つき）で決めた。文字検出なしで範囲全体を読み、
// 確信度 0.4・つなぐ間 0.1 秒（0.1 秒刻みなら 1 コマ）・0.3 秒未満は捨てる、で開始の |ずれ|>0.15 秒は 1.4%、詠唱時間の中央値のずれは +0.015 秒。
// 消えるのが詠唱の完了より遅れる一定の分（余韻）は無かった
// 技名が出ているとみなす読み: かな・漢字が 2 文字以上で、確信度（recognizer.confidence）がこれ以上。
// 英字・数字だけの読み（範囲に入ったプレイヤー名・「Lv100」など）は技名ではない（2026-10-22 のブラウザでの確認: 0.3〜1 秒の雑音の区間が 89 回あった）
export const PRESENT_MIN_CHARS = 2;
export const PRESENT_MIN_CONF = 0.4;
const SKILL_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
// 見えたコマどうしの間がこれ以下なら、同じ詠唱の途中の読み逃しとみなしてつなぐ（0.1 秒刻みで 1 コマの読み逃し）
export const GAP_FILL_S = 0.2;
export const MIN_CAST_S = 0.3; // これより短い区間は詠唱とみなさない（名前・数字などの読みの断片）
// 区間のそれまでの読み（最も多いもの）とこれ以上違う読みは、別の文字とみなす（詠唱が終わった直後に出た名前などで区間が延びないように。
// 2026-10-22 の検証: 消えたあと「MpHei Lotus」が 0.8 秒出て延びた）。違いは編集距離 ÷ 長いほうの文字数。
// 厳しすぎると、低い解像度で詠唱の途中から先頭に別の字が付いた読み（「ダブルクラフィティ」→「マルータフルクラフィティ」）で区間が割れる。
// 0.5 では動画 4 本の詠唱時間の |ずれ|>0.2 秒が 14.9%、0.8 で 4.8%（0.7〜0.9 はほぼ同じ。区切らないと別の詠唱を巻き込んで悪くなる）
export const OTHER_TEXT_MISS = 0.8;
const OTHER_AFTER_READS = 3; // 別の文字かを比べるのは、区間の読みがこれだけたまってから
// 前後の詠唱が同じ技名で、間がこれ以下なら 1 回の詠唱が途中で割れたものとしてつなぐ（2026-10-22 の検証: 1704x720 の動画で
// 「アレンジ」が途中から「アレンッ」と読めて確信度が落ち、割れた）
export const MERGE_GAP_S = 0.7;
// 前のコマとの間がこれ以下なら、出始め・消えたの時刻を前後のコマの中点にする（0.1 秒刻みだと最初に見えたコマは平均 0.04 秒遅い）
const MIDPOINT_MAX_S = 0.5;

export const isPresent = (read) => Boolean(read)
    && (read.text.match(SKILL_CHAR)?.length ?? 0) >= PRESENT_MIN_CHARS && read.conf >= PRESENT_MIN_CONF;

const differs = (a, b) => levenshtein(a, b) / Math.max([...a].length, [...b].length, 1) > OTHER_TEXT_MISS;

function mostCommon(reads) {
    const counts = new Map();
    for (const { text } of reads) {
        counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    return [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/**
 * 1 コマずつ読みを受け取り、技名が出ていた区間を詠唱 1 回にまとめる。
 * 出始めは最初に見えたコマと前のコマの中点、消えたは見えた最後のコマと次のコマの中点。
 * 区間の途中で別の文字が続けて読めたら、そこで区間を閉じ、別の文字から新しい区間を始める。
 */
export class CastTracker {
    constructor({ gapFill = GAP_FILL_S, minCast = MIN_CAST_S } = {}) {
        Object.assign(this, { gapFill, minCast });
        this.open = null; // { start, lastSeen, firstGone, reads, other }
        this.prevAt = null;
        this.casts = [];
    }

    /**
     * @param {number} at コマの時刻（秒、増える順）
     * @param {{text:string, conf:number}|null} read 範囲の読み（読めなければ null）
     * @returns {object[]} この呼び出しで閉じた詠唱
     */
    push(at, read) {
        const closed = [];
        const prevAt = this.prevAt;
        this.prevAt = at;
        const edge = (before, after) => (before !== null && after - before <= MIDPOINT_MAX_S ? (before + after) / 2 : after);
        let present = isPresent(read);
        const open = this.open;
        if (open && present && at - open.lastSeen > this.gapFill + 1e-6 && open.other.length === 0) {
            // 見えないコマを渡されずに間が空いた
            closed.push(...this.close(open.firstGone === null ? open.lastSeen : edge(open.lastSeen, open.firstGone)));
        } else if (open && present && open.reads.length >= OTHER_AFTER_READS && differs(read.text, mostCommon(open.reads))) {
            // 区間の技名と違う文字。見えていないものとして扱い、続けば新しい区間にする
            open.firstGone ??= at;
            open.other.push({ at, text: read.text, conf: read.conf, prevAt });
            present = false;
        }
        if (present) {
            if (!this.open) {
                this.open = { start: edge(prevAt, at), lastSeen: at, firstGone: null, reads: [], other: [] };
            }
            this.open.lastSeen = at;
            this.open.firstGone = null;
            this.open.other = [];
            this.open.reads.push({ at, text: read.text, conf: read.conf });
        } else if (this.open) {
            this.open.firstGone ??= at;
            if (read && !isPresent(read)) {
                this.open.other = []; // 別の文字は続いていない
            }
            if (at - this.open.lastSeen > this.gapFill + 1e-6) {
                const { other, lastSeen, firstGone } = this.open;
                closed.push(...this.close(edge(lastSeen, firstGone)));
                if (other.length > 0 && other[0].at === firstGone) {
                    // 消えたのと同時に出ていた別の文字から、新しい区間を始める
                    this.open = {
                        start: edge(other[0].prevAt, other[0].at), lastSeen: other.at(-1).at, firstGone: null,
                        reads: other.map(({ at: t, text, conf }) => ({ at: t, text, conf })), other: [],
                    };
                }
            }
        }
        return closed;
    }

    /** 最後のコマのあと。開いている区間を閉じる（終わりは見えた最後のコマ） */
    finish(at) {
        if (!this.open) {
            return [];
        }
        const { lastSeen, firstGone } = this.open;
        return this.close(firstGone === null ? Math.max(lastSeen, at) : (lastSeen + firstGone) / 2);
    }

    close(end) {
        const { start, reads } = this.open;
        this.open = null;
        if (end - start < this.minCast) {
            return [];
        }
        const cast = { start, end, duration: end - start, reads };
        this.casts.push(cast);
        return [cast];
    }
}

/**
 * 同じ技名で間が短い前後の詠唱を 1 回につなぐ（読みが途中で割れたもの）。name は decideName で決めたもの。
 * @param {{start:number, end:number, duration:number, name:string, reads:object[]}[]} casts 時刻の順
 */
export function mergeSplitCasts(casts, gap = MERGE_GAP_S) {
    const out = [];
    for (const c of casts) {
        const prev = out.at(-1);
        if (prev && c.name && prev.name === c.name && c.start - prev.end <= gap) {
            out[out.length - 1] = { ...prev, end: c.end, duration: c.end - prev.start, reads: [...prev.reads, ...c.reads], merged: (prev.merged ?? 1) + 1 };
        } else {
            out.push(c);
        }
    }
    return out;
}

// ── 既存のタイムラインとの突き合わせ（補正） ──
// 位相合わせは tools/measure-cast-bars.py の align() と同じ考え方に、技名の一致を足したもの

export const MATCH_S = 0.5; // フェーズの開始を決めるとき、詠唱の出始めと予定の詠唱開始を同じとみなす差
export const ALIGN_SHARE = 0.4; // フェーズの開始を採るのは、予定の詠唱がこの割合以上そろうときだけ
export const FOLLOW_S = 1.0; // フェーズの中で、予定から何秒までの詠唱をその予定のものとみなすか（ずれは予定ごとに合わせ直す）

const syncEntries = (phase) => phase.entries
    .map((e, index) => ({ ...e, index }))
    .filter((e) => e.duration > 0 && e.sync !== false)
    .sort((a, b) => a.t - b.t);
const sameName = (cast, entry) => castNames(entry.name).includes(cast.name);

/**
 * 記録した詠唱を、タイムラインのフェーズ・予定に対応させる。
 * @param {{phases:{id:string, entries:{t:number, name:string, duration?:number, sync?:boolean}[]}[]}} timeline
 * @param {{start:number, duration:number, name:string}[]} casts 時刻の順
 * @returns {{phases:{id:string, offset:number|null, hits:number, total:number}[],
 *            rows:{phase:string, index:number, t:number, name:string, duration:number, cast:object|null, gap:number|null}[],
 *            unused:object[]}}
 *          offset はフェーズの 0 秒が動画の何秒か（見つからなければ null）。gap は予想した開始と記録の差（秒）
 */
export function matchTimeline(timeline, casts) {
    const used = new Set();
    const phases = [];
    const rows = [];
    let cursor = -Infinity;
    for (const phase of timeline.phases) {
        const entries = syncEntries(phase);
        if (entries.length === 0) {
            continue;
        }
        const free = casts.filter((c) => !used.has(c) && c.start >= cursor);
        let best = { offset: null, hits: 0 };
        for (const c of free) {
            for (const e of entries) {
                if (!sameName(c, e)) {
                    continue;
                }
                const offset = c.start - e.t;
                const hits = entries.filter((x) => free.some((y) => sameName(y, x) && Math.abs(y.start - offset - x.t) <= MATCH_S)).length;
                if (hits > best.hits || (hits === best.hits && best.offset !== null && offset < best.offset)) {
                    best = { offset, hits };
                }
            }
        }
        const need = Math.max(Math.min(3, entries.length), Math.ceil(entries.length * ALIGN_SHARE));
        if (best.offset === null || best.hits < need) {
            phases.push({ id: phase.id, offset: null, hits: best.hits, total: entries.length });
            continue;
        }
        phases.push({ id: phase.id, offset: best.offset, hits: best.hits, total: entries.length });
        let offset = best.offset;
        for (const e of entries) {
            const expected = offset + e.t;
            const near = free
                .filter((c) => !used.has(c) && sameName(c, e) && Math.abs(c.start - expected) <= FOLLOW_S)
                .sort((a, b) => Math.abs(a.start - expected) - Math.abs(b.start - expected));
            const cast = near[0] ?? null;
            if (cast) {
                used.add(cast);
                offset = cast.start - e.t; // 予定ごとに合わせ直す
                cursor = cast.start;
            }
            rows.push({
                phase: phase.id, index: e.index, t: e.t, name: e.name, duration: e.duration,
                cast, gap: cast ? Math.round((cast.start - expected) * 100) / 100 : null,
            });
        }
    }
    return { phases, rows, unused: casts.filter((c) => !used.has(c)) };
}

export const AGREE_S = 0.15; // 同じ技の記録どうしを、そろったとみなす差
export const DIFFER_S = 0.25; // XML の詠唱時間とこれ以上違えば、直す候補にする

/**
 * 技ごと（技名と XML の詠唱時間の組）に記録の詠唱時間をまとめ、XML と比べる。
 * 値は最も多くそろった記録の中央値（0.1 秒に丸める）。
 * @returns {{name:string, duration:number, measured:number, values:number[], agree:number, status:'same'|'longer'|'shorter'|'unsure'|'scattered'}[]}
 *          status: same＝合う、longer/shorter＝2 回以上そろって違う、unsure＝1 回だけ違う（再生で確かめる）、
 *          scattered＝記録の半分以上がそろわない（値を信じない）
 */
export function summarizeDurations(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (!row.cast) {
            continue;
        }
        const key = `${row.name}\t${row.duration}`;
        if (!groups.has(key)) {
            groups.set(key, { name: row.name, duration: row.duration, values: [] });
        }
        groups.get(key).values.push(row.cast.duration);
    }
    return [...groups.values()].map(({ name, duration, values }) => {
        const sorted = [...values].sort((a, b) => a - b);
        const cluster = sorted
            .map((v) => sorted.filter((x) => Math.abs(x - v) <= AGREE_S))
            .sort((a, b) => b.length - a.length || Math.abs(median(a) - duration) - Math.abs(median(b) - duration))[0];
        const measured = Math.round(median(cluster) * 10) / 10;
        // 記録の半分以上がそろわなければ、どの値も信じない（2026-10-22 のブラウザでの確認: アレンジの 5.2・5.59・6.52・6.74 秒から
        // XML に近い 1 回を採って「合う」と出ていた。1704x720 の動画では、詠唱の終わりで読みが落ちて短く切れることがある）
        const status = values.length >= 2 && cluster.length * 2 < values.length ? 'scattered'
            : Math.abs(measured - duration) < DIFFER_S ? 'same'
                : cluster.length >= 2 ? (measured > duration ? 'longer' : 'shorter') : 'unsure';
        return { name, duration, measured, values: sorted.map((v) => Math.round(v * 100) / 100), agree: cluster.length, status };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 選んだ直しを当てたタイムラインを返す（元は変えない）。
 * @param {{name:string, duration:number, measured:number}[]} picks 技名と元の詠唱時間が同じ予定の duration を measured にする
 */
export function applyDurations(timeline, picks) {
    const key = (name, duration) => `${name}\t${Number(duration).toFixed(1)}`;
    const map = new Map(picks.map((p) => [key(p.name, p.duration), p.measured]));
    return {
        ...timeline,
        phases: timeline.phases.map((phase) => ({
            ...phase,
            entries: phase.entries.map((e) => (e.duration > 0 && map.has(key(e.name, e.duration))
                ? { ...e, duration: map.get(key(e.name, e.duration)) } : e)),
        })),
    };
}

// ── 記録から新しいタイムラインを作る ──

/**
 * 記録した詠唱を、1 フェーズのタイムラインの下書きにする。
 * @param {{start:number, duration:number, name:string}[]} casts
 * @param {{content:string, title?:string, author?:string, zero?:number}} meta zero は 0 秒にする時刻（既定は最初の詠唱の開始）
 */
export function draftTimeline(casts, { content, title, author, zero } = {}) {
    const origin = zero ?? casts[0]?.start ?? 0;
    return {
        format: 'castline/1',
        content,
        title: title || undefined,
        author: author || undefined,
        phases: [{
            id: 'p1',
            entries: casts
                .filter((c) => c.name && c.start >= origin - 0.05) // 画面の欄は 0.1 秒に丸めて出すので、丸めた分は許す
                .map((c) => ({ t: Math.max(0, Math.round((c.start - origin) * 10) / 10), name: c.name, duration: Math.round(c.duration * 10) / 10 })),
        }],
    };
}

// ── ダンジョン・アライアンス: 1 つのコンテンツの戦闘をまとめる ──

export const BOSS_MIN_CASTS = 5; // これより詠唱の少ない戦闘は道中とみなす（結果に入れる既定を外すだけ。利用者が選び直せる）
export const BOSS_MIN_S = 60; // これより短い戦闘も道中とみなす

/** 戦闘がボスらしいか（詠唱が BOSS_MIN_CASTS 回以上で、BOSS_MIN_S 秒以上続いた） */
export function looksLikeBoss(casts, seconds) {
    return casts.length >= BOSS_MIN_CASTS && seconds >= BOSS_MIN_S;
}

/**
 * 戦闘ごとの記録を 1 本のタイムラインの下書きにする。戦闘が 1 つなら draftTimeline と同じ（フェーズ p1）。
 * 2 つ以上なら戦闘ごとに start のフェーズ（b1, b2…、名前は「1 体目」…）にし、再生画面が最初に読めた技でボスを決める。
 * @param {{casts:{start:number, duration:number, name:string}[], zero?:number}[]} fights casts の start はその戦闘の秒
 * @param {{content:string, title?:string, author?:string}} meta
 */
export function draftBossTimeline(fights, meta = {}) {
    if (fights.length === 1) {
        return draftTimeline(fights[0].casts, { ...meta, zero: fights[0].zero });
    }
    return {
        ...draftTimeline([], meta),
        phases: fights.map((f, i) => ({
            ...draftTimeline(f.casts, { zero: f.zero }).phases[0],
            id: `b${i + 1}`,
            name: `${i + 1} 体目`,
            start: true,
        })),
    };
}

