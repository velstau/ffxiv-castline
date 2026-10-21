// タイムラインの置き場所（配信の一覧と XML、このブラウザに読み込んだ手元の XML）。再生画面と初期設定の画面で共用する。
import { parseTimelineXml, parseTimelineIndex } from './timeline-xml.js';

// 配信するタイムラインの置き場所（index.xml とタイムラインの XML）。GitHub のリポジトリの main を正とし、
// 読めないときはサイトに同梱した写しを使う。?timelines=site でサイトの写しだけを読む（手元で直した XML の確認用）
const TIMELINE_GITHUB = 'https://raw.githubusercontent.com/velstau/ffxiv-castline/main/public/timelines/';
const TIMELINE_SITE = new URL('../timelines/', import.meta.url).href;
export const TIMELINE_BASES = new URLSearchParams(location.search).get('timelines') === 'site'
    ? [TIMELINE_SITE] : [TIMELINE_GITHUB, TIMELINE_SITE];
export const STORE_LOCAL = 'castline.player.local-timelines'; // [{ name, xml }]

/**
 * 配信の一覧を読む。GitHub から読めなければサイトの写し。
 * @returns {Promise<{items:{file,content,title,timeline?}[], base:string, failures:string[], error:string}>}
 *          error が空でなければ、どこからも読めなかった
 */
export async function loadTimelineIndex() {
    const failures = [];
    for (const base of TIMELINE_BASES) {
        try {
            const res = await fetch(new URL('index.xml', base), { cache: 'no-cache' });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            return { items: parseTimelineIndex(await res.text()), base, failures, error: '' };
        } catch (e) {
            failures.push(e.message);
        }
    }
    return {
        items: [], base: '', failures,
        error: `配信のタイムライン一覧を読めませんでした（${failures.join(' / ')}）。手元の XML は使えます。`,
    };
}

/** 一覧の 1 つのタイムラインを読む（読んだものは item.timeline に覚える） */
export async function fetchTimeline(item, base) {
    if (!item.timeline) {
        const res = await fetch(new URL(item.file, base), { cache: 'no-cache' });
        if (!res.ok) {
            throw new Error(`${item.file} を読めません（HTTP ${res.status}）`);
        }
        const { timeline, errors } = parseTimelineXml(await res.text());
        if (!timeline) {
            throw new Error(`${item.file} の形式に誤りがあります: ${errors.join(' / ')}`);
        }
        timeline.baseUrl = new URL(item.file, base).href; // アイコンの画像（gimmick_icon・skills_icon）の相対パスの基準
        item.timeline = timeline;
    }
    return item.timeline;
}

/** このブラウザに読み込んだ手元の XML（読めるものだけ） */
export function loadLocalTimelines() {
    let list = [];
    try {
        list = JSON.parse(localStorage.getItem(STORE_LOCAL) ?? '[]');
    } catch {
        list = [];
    }
    return (Array.isArray(list) ? list : [])
        .map(({ name, xml }) => ({ name, xml, timeline: parseTimelineXml(xml).timeline }))
        .filter((t) => t.timeline);
}
