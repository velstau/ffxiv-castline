// 画面で読んだ文字の行から、カウントダウン・HP・詠唱バー・敵対リストの範囲を決める（自動の範囲指定）。
// 行の検出と読み取りは screen-reader.js の scanLines。ここは DOM も文字認識も使わない（node でテストする）。
// 行は { x, y, w, h, text, cast? }。cast は詠唱バーとして読んだときに決まった技名（決まらなければ null）。
import { levenshtein, parseCountdown, parseHpPercent } from './readers.js';

const clampRect = (r, width, height) => {
    const x = Math.max(0, Math.round(r.x));
    const y = Math.max(0, Math.round(r.y));
    return { x, y, w: Math.max(1, Math.min(width, Math.round(r.x + r.w)) - x), h: Math.max(1, Math.min(height, Math.round(r.y + r.h)) - y) };
};
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const chars = (s) => [...s].length;

/** カウントダウンを探す場所（画面の中央。告知の行は画面の中央の少し下に出る） */
export function countdownSearchArea(width, height) {
    const w = Math.min(width, 960);
    const h = Math.min(height, 960);
    return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/**
 * カウントダウンの告知の行（「戦闘開始まで16秒！」「戦闘開始！」）を探す。
 * 「5秒」だけの行などを取り違えないよう、「開始」か「まで」を含む行に限る。
 */
export function findCountdownLine(lines) {
    return lines.find((l) => parseCountdown(l.text) && /開始|まで/.test(l.text)) ?? null;
}

/**
 * 告知の行から、保存する範囲を作る。告知は画面中央に中央揃えで出て、文言で幅が変わる（「戦闘開始！」は 5 文字、
 * 「戦闘開始まで16秒！」は 10 文字）ので、中心はそのままで 11 文字分以上に広げる。
 * 下に「（名前）」の行が付くと 2 行になり、1 行目が 1/3 行ほど上にずれるので、上下にも余裕を取る。
 * 上は控えめにする（残り 5 秒からは、すぐ上に大きな数字が出る。入ると告知の行とつながって読み違える）。
 */
export function countdownRegionFrom(line, width, height) {
    const c = center(line);
    const w = Math.max(line.w * 1.3, line.h * 11);
    return clampRect({ x: c.x - w / 2, y: line.y - line.h * 0.5, w, h: line.h * 2.4 }, width, height);
}

// HP の行: 「99.0% G レッドホット」（% の数字が行の頭。満タンのうちは % が出ず「Lv100 レッドホット」）
const HP_HEAD = /^\D{0,2}?(\d{1,3}(?:\.\d)?)\s*[%％]\s*(.*)$/;
// 「FOCUS」の札は小さく、戦闘中は後ろの模様で「oC」のように一部しか読めないことがある（2026-10-20 実測）。
// HP の行のすぐ上にある短い行に限って見るので、緩めに照合する
const FOCUS_LABEL = /FOCUS|フォーカス|F?[O0o]CU?S?/i;

/**
 * HP の行を探す。ターゲットとフォーカスターゲットの 2 つが見つかることがあり、すぐ上に「FOCUS」の行があるほうを
 * フォーカスとする。フォーカスはボスに付けたままにすることが多く、ターゲットは雑魚に移るので、フォーカスを優先する。
 * @returns {{line, name:string, focus:boolean, others:number}|null} name は % の後ろの敵の名前（先頭の記号 1 文字は除く）
 */
export function findHpLine(lines) {
    const found = [];
    for (const line of lines) {
        const m = HP_HEAD.exec(line.text);
        if (!m || parseHpPercent(line.text) === null) {
            continue;
        }
        const name = m[2].replace(/^[A-Za-z0-9]\s*/, '').trim();
        const focus = lines.some((o) => o !== line && FOCUS_LABEL.test(o.text)
            && o.y + o.h <= line.y + line.h * 0.5 && line.y - (o.y + o.h) <= line.h * 1.5
            && o.x < line.x + line.w && line.x < o.x + o.w);
        found.push({ line, name, focus });
    }
    if (found.length === 0) {
        return null;
    }
    const pick = found.find((f) => f.focus) ?? found[0];
    return { ...pick, others: found.length - 1 };
}

/** HP の行から範囲を作る。読むのは頭の % の数字だけなので、名前の後ろの長さに引きずられないよう幅は 9 文字分まで */
export function hpRegionFrom(line, width, height) {
    const w = Math.min(line.w, line.h * 9) + line.h * 0.6;
    return clampRect({ x: line.x - line.h * 0.3, y: line.y - line.h * 0.15, w, h: line.h * 1.3 }, width, height);
}

/** 文字列のどこかに name が（読み違いを少し許して）含まれるか */
export function fuzzyContains(text, name) {
    const n = chars(name);
    if (n === 0) {
        return false;
    }
    const allow = Math.max(1, Math.floor(n * 0.25));
    const t = [...text];
    for (let len = Math.max(1, n - allow); len <= n + allow; len++) {
        for (let i = 0; i + len <= t.length; i++) {
            if (levenshtein(t.slice(i, i + len).join(''), name) <= allow) {
                return true;
            }
        }
    }
    return false;
}

// 戦闘前の画面にも文字があった場所（チャット欄・パーティリストなど）。敵対リストと詠唱バーは戦闘中にしか出ないので、
// ここに重なる行は候補から外す（2026-10-21: 戦闘前から出ているものを敵対リストとして見つけ、取り込みの直後に戦闘開始になった）
const onBaseline = (line, baseline) => baseline.some((b) => overlaps(line, b));

/**
 * 敵対リストの行を探す: 敵の名前（HP の行から取ったもの）を含み、数字も「Lv」も無い短い行。
 * 頭上やターゲットの名前は「Lv100 名前」で、「L100」「レ100」「ル10ロ」とも読めるので、数字のある行は除く。
 * チャットの文（「〜は「技」の構え。」）も名前を含むので、かぎ括弧・句読点のある行も除く。
 * HP の行・詠唱バーと重なる行、戦闘前にも文字があった場所（baseline）に重なる行も除く。
 */
export function findEnmityLine(lines, enemyName, exclude = [], baseline = []) {
    if (!enemyName) {
        return null;
    }
    const fits = lines.filter((l) => !/[\d%％「」『』。、]/.test(l.text) && !/L\s*[vV]/.test(l.text)
        && chars(l.text) <= chars(enemyName) + 12
        && !exclude.some((r) => r && overlaps(l, r))
        && !onBaseline(l, baseline)
        && fuzzyContains(l.text, enemyName));
    fits.sort((a, b) => chars(a.text) - chars(b.text));
    return fits[0] ?? null;
}

/**
 * 敵対リストの範囲。行は「アイコン 名前（詠唱中は右に技名）」で、下に敵が増えると行が下に伸びる。
 * 範囲に頭上の名前などほかの文字が入ると、敵対リストが消えたこと（戦闘の終わり）が分からなくなるので、
 * 3 行ほどに抑える（雑魚が多い戦闘では下に伸ばしてもらう）。
 */
export function enmityRegionFrom(line, width, height) {
    return clampRect({ x: line.x - line.h * 1.5, y: line.y - line.h * 0.4, w: line.h * 15, h: line.h * 8 }, width, height);
}

/**
 * 詠唱バーの行を探す: 技名に決まり、技名のほかに余計な文字がほとんど無い行（チャットの「〜の構え」・敵対リストを除く）。
 * 複数あれば near（HP の行）にいちばん近い行（ターゲットとフォーカスの両方に詠唱バーが出るため）。
 * 戦闘前にも文字があった場所（baseline）は外さない: 詠唱バーはターゲットの名前・HP の行のすぐ近くに出るので、戦闘前に
 * ボスを選んでいると重なって外れてしまう（2026-10-21 ゲーム内で、敵対リスト・HP は見つかり詠唱バーだけ見つからなかった）。
 * 技名と決まった行だけが候補なので、外さなくても取り違えは少ない。
 */
export function findCastLine(lines, { near = null, enemyName = '', exclude = [] } = {}) {
    const fits = lines.filter((l) => l.cast
        && chars(l.text) <= chars(l.cast) + 3
        && !/[「」]/.test(l.text)
        && !(enemyName && fuzzyContains(l.text, enemyName))
        && !exclude.some((r) => r && overlaps(l, r)));
    if (fits.length === 0) {
        return null;
    }
    if (near) {
        const c = center(near);
        const dist = (l) => Math.hypot(center(l).x - c.x, center(l).y - c.y);
        fits.sort((a, b) => dist(a) - dist(b));
    }
    return fits[0];
}

/**
 * 詠唱バーの範囲。技名の長さで幅が変わり、寄せ方も分からないので、中心はそのままで、
 * タイムラインでいちばん長い技名（longest 文字）が入るよう左右に広げる。
 */
export function castRegionFrom(line, longest, width, height) {
    const charWidth = line.w / Math.max(1, chars(line.cast ?? line.text));
    const w = Math.max(line.w, (longest + 1) * charWidth);
    const c = center(line);
    return clampRect({ x: c.x - w / 2, y: line.y - line.h * 0.2, w, h: line.h * 1.4 }, width, height);
}

/**
 * 画面全体で読んだ行から、まだ無い範囲（want: 'hp'|'cast'|'enmity' の集合）を決める。
 * @param {{x,y,w,h}} [hpRect] 保存済みの HP の範囲（あれば、詠唱バーはその近くを選ぶ）
 * @param {{x,y,w,h}} [enmityRect] 保存済みの敵対リストの範囲（詠唱バーの候補から外す）
 * @param {{x,y,w,h}[]} [baseline] 戦闘前の画面で文字があった行（敵対リストの候補から外す）
 * @returns {{hp?:{rect, focus:boolean, others:number, line}, enmity?:{rect, line}, cast?:{rect, name:string, line}, enemyName:string|null}}
 *          line は範囲を決めた行（確認用）
 */
export function classifyCombatLines(lines, {
    want, width, height, longestCast = 12, hpRect = null, enmityRect = null, enemyName = null, baseline = [],
}) {
    const out = { enemyName };
    const hp = findHpLine(lines);
    if (hp) {
        out.enemyName = hp.name || enemyName;
        if (want.has('hp')) {
            out.hp = { rect: hpRegionFrom(hp.line, width, height), focus: hp.focus, others: hp.others, line: hp.line };
        }
    }
    const hpLines = lines.filter((l) => HP_HEAD.test(l.text));
    const near = hp?.line ?? hpRect;
    let enmityLine = null;
    if (want.has('enmity') || want.has('cast')) {
        enmityLine = findEnmityLine(lines, out.enemyName, hpLines, baseline);
    }
    if (want.has('enmity') && enmityLine) {
        out.enmity = { rect: enmityRegionFrom(enmityLine, width, height), line: enmityLine };
    }
    if (want.has('cast')) {
        // 敵対リストにも詠唱中の技名が出るので、見つけた敵対リストの行と、保存済みの敵対リストの範囲は外す
        const castLine = findCastLine(lines, { near, enemyName: out.enemyName, exclude: [...hpLines, enmityLine, enmityRect] });
        if (castLine) {
            out.cast = { rect: castRegionFrom(castLine, longestCast, width, height), name: castLine.cast, line: castLine };
        }
    }
    return out;
}

/** 行の中の HP の % の値（ターゲット・フォーカスのどれか。無ければ null）。100 未満なら戦闘中とみなせる */
export function damagedHp(lines) {
    const values = lines.filter((l) => HP_HEAD.test(l.text)).map((l) => parseHpPercent(l.text)).filter((v) => v !== null);
    return values.length > 0 ? Math.min(...values) : null;
}

/** HP の範囲の周り（詠唱バーを先に探す場所）。詠唱バーはターゲットの HP の行の近くに出る */
export function castSearchAreaNear(rect, width, height) {
    const w = Math.min(width, 960);
    const h = Math.min(height, 480);
    const c = center(rect);
    return clampRect({ x: Math.min(Math.max(0, c.x - w / 2), width - w), y: Math.min(Math.max(0, c.y - h / 2), height - h), w, h }, width, height);
}
