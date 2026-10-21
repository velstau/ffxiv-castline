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
 * 予定のアイコン（ギミック 1 つ → スキルの順）。[{key, url, alt}]
 * ギミックは <icons> の id を先に見て、無ければ用意したアイコン（id か名前）。スキルは <icons> の id だけ。
 * <icons> の src は、配信のタイムラインなら XML の場所（baseUrl）からの相対パス。手元の XML は URL（http・https・data）だけ使える
 */
export function entryIcons(entry, timeline) {
    const defined = new Map((timeline.icons ?? []).map((icon) => [icon.id, icon]));
    const url = (src) => {
        try {
            return timeline.baseUrl ? new URL(src, timeline.baseUrl).href : new URL(src).href;
        } catch {
            return null; // 手元の XML の相対パスなど
        }
    };
    const own = (id) => {
        const icon = defined.get(id);
        const href = icon?.src && url(icon.src);
        return href ? { key: id, url: href, alt: icon.name ?? id } : null;
    };
    const out = [];
    if (entry.gimmick) {
        const builtin = gimmickIcon(entry.gimmick);
        const icon = own(entry.gimmick) ?? (builtin && { key: builtin.id, url: builtin.url, alt: builtin.name });
        if (icon) {
            out.push(icon);
        }
    }
    for (const id of entry.skills ?? []) {
        const icon = own(id);
        if (icon) {
            out.push(icon);
        }
    }
    return out;
}

/** 使えないアイコンの指定（読み込んだときに記録に出す。表示は飛ばすだけで、タイムラインは使える） */
export function iconProblems(timeline) {
    const problems = new Set();
    for (const phase of timeline.phases) {
        for (const e of phase.entries) {
            const icons = entryIcons(e, timeline).map((i) => i.key);
            if (e.gimmick && entryIcons({ ...e, skills: [] }, timeline).length === 0) {
                problems.add(`ギミックのアイコン「${e.gimmick}」がありません`);
            }
            for (const id of e.skills ?? []) {
                if (!icons.includes(id)) {
                    problems.add(`スキルのアイコン「${id}」が <icons> に無いか、src を読めません（手元の XML は URL だけ使えます）`);
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
