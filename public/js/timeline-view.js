// 再生画面と小窓の、これから来る予定の表示（表示名・アイコン・同じ攻撃が続くときのまとめ）
import { castNames } from './timeline-engine.js';
import { gimmickIcon } from './gimmick-icons.js';

// 同じ表示の予定が続けて来るとき、発動の間がこれ以内なら 1 行にまとめて「×N」と出す
export const GROUP_GAP_S = 10;

/** 表示名: text があれば text だけ、無ければ技名（「A|B」は「A／B」） */
export function displayName(entry) {
    return entry.label ?? castNames(entry.name).join('／');
}

/**
 * アイコンの指定 1 つを画像にする。{key, url, alt} か null（使えない）。
 * フォルダの無い名前が用意したギミックのアイコン（id か名前。拡張子は見ない）なら、それを使う（「tower.png」「tower」「塔踏み」「チャリオット」）。
 * それ以外は画像のファイル: 配信のタイムラインなら XML の場所（baseUrl）からの相対パス、手元の XML は URL（http・https・data）だけ使える。
 * 用意したアイコンと同じ名前の自分の画像を使うときは「./tower.png」と書く
 */
export function resolveIcon(spec, timeline) {
    const builtin = !/[/:]/.test(spec) && gimmickIcon(spec.replace(/\.[a-z0-9]+$/i, ''));
    if (builtin) {
        return { key: builtin.url, url: builtin.url, alt: builtin.name };
    }
    if (!/\.[a-z0-9]+$/i.test(spec) && !/^[a-z]+:/i.test(spec)) {
        return null; // 拡張子の無い、用意したアイコンに無い名前
    }
    try {
        const url = timeline.baseUrl ? new URL(spec, timeline.baseUrl).href : new URL(spec).href;
        const alt = decodeURIComponent(spec.split(/[/?#]/).filter(Boolean).at(-1) ?? spec).replace(/\.[a-z0-9]+$/i, '');
        return { key: url, url, alt };
    } catch {
        return null; // 手元の XML の相対パスなど
    }
}

/** 予定のアイコン（gimmick_icon 1 つ → skills_icon の順）。[{key, url, alt}] */
export function entryIcons(entry, timeline) {
    return [entry.gimmickIcon, ...(entry.skillIcons ?? [])]
        .filter(Boolean)
        .map((spec) => resolveIcon(spec, timeline))
        .filter(Boolean);
}

/** 使えないアイコンの指定（読み込んだときに記録に出す。表示は飛ばすだけで、タイムラインは使える） */
export function iconProblems(timeline) {
    const problems = new Set();
    for (const phase of timeline.phases) {
        for (const e of phase.entries) {
            for (const spec of [e.gimmickIcon, ...(e.skillIcons ?? [])].filter(Boolean)) {
                if (!resolveIcon(spec, timeline)) {
                    problems.add(/\.[a-z0-9]+$/i.test(spec)
                        ? `アイコン「${spec}」を読めません（手元の XML は URL だけ使えます）`
                        : `アイコン「${spec}」は用意したギミックのアイコンにありません（画像なら拡張子まで書く）`);
                }
            }
        }
    }
    return [...problems];
}

/**
 * 発動の早い順の予定（{entry, hitIn, castIn}）を表示の行にする。同じ表示名・アイコンの予定が続き、
 * 発動の間が gapS 以内なら 1 行にまとめる（count。時刻は最初のもの）。発動済み（hitIn ≤ 0）の行はまとめない。
 * @returns {{entry, hitIn, castIn, name:string, icons:{key,url,alt}[], count:number}[]}
 */
export function upcomingRows(upcoming, timeline, gapS = GROUP_GAP_S) {
    const rows = [];
    for (const u of upcoming) {
        const name = displayName(u.entry);
        const icons = entryIcons(u.entry, timeline);
        const key = `${name}\u0000${icons.map((i) => i.key).join(' ')}`;
        const last = rows.at(-1);
        if (last && last.key === key && u.hitIn > 0 && last.hitIn > 0 && u.hitIn - last.lastHitIn <= gapS) {
            last.count += 1;
            last.lastHitIn = u.hitIn;
            continue;
        }
        rows.push({ ...u, name, icons, key, count: 1, lastHitIn: u.hitIn });
    }
    return rows.map(({ key, lastHitIn, ...row }) => row);
}
