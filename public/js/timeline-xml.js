// タイムラインファイル（XML）を読んで、タイムラインエンジンが使う形にする。形式は README の「タイムラインファイル」。
import { validateTimeline } from './timeline-engine.js';

function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const error = doc.querySelector('parsererror');
    if (error) {
        // Chrome は「This page contains the following errors:」の後に誤りの行を続けるので、誤りの行だけを出す
        const detail = error.textContent.replace(/^This page contains the following errors:/, '').trim().split('\n')[0];
        throw new Error(`XML として読めません: ${detail}`);
    }
    return doc;
}

const children = (el, name) => [...el.children].filter((c) => c.tagName === name);

/**
 * タイムラインの XML を読む。
 * @returns {{timeline: object|null, errors: string[]}} errors が空でなければ使えない
 */
export function parseTimelineXml(text) {
    let doc;
    try {
        doc = parseXml(text);
    } catch (e) {
        return { timeline: null, errors: [e.message] };
    }
    const root = doc.documentElement;
    if (root.tagName !== 'timeline') {
        return { timeline: null, errors: ['いちばん外側の要素が <timeline> ではありません'] };
    }
    const errors = [];
    // 数の属性。書かれていなければ undefined、数でなければ誤りとして記録する
    const num = (el, name, where) => {
        if (!el.hasAttribute(name)) {
            return undefined;
        }
        const value = Number(el.getAttribute(name));
        if (!Number.isFinite(value)) {
            errors.push(`${where}: ${name}="${el.getAttribute(name)}" が数ではありません`);
        }
        return value;
    };
    const pair = (el, name, where) => (el.hasAttribute(name) ? pairOf(el.getAttribute(name), name, where) : undefined);
    const pairOf = (text, name, where) => {
        if (text === undefined) {
            return undefined;
        }
        const values = text.trim().split(/[\s,]+/).map(Number);
        if (values.length !== 2 || !values.every(Number.isFinite)) {
            errors.push(`${where}: ${name} は「前 後」の 2 つの秒で書いてください（例: "10 10"）`);
        }
        return values;
    };
    const attr = (el, name) => (el.hasAttribute(name) ? el.getAttribute(name) : undefined);
    const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

    // 先頭の情報は 1 行ずつの子要素（<format> <content> <title> <author> <license> <sync-window> <note>）。
    // author・license はタイムラインの作者とライセンス（再生画面に出す）
    const field = (name) => children(root, name)[0]?.textContent.trim();
    const timeline = clean({
        format: field('format'),
        content: field('content'),
        title: field('title'),
        author: field('author'),
        license: field('license'),
        note: field('note'),
        syncWindow: pairOf(field('sync-window'), 'sync-window', '<timeline>'),
        phases: children(root, 'phase').map((p, i) => {
            const where = `<phase> ${i + 1} 番目（${attr(p, 'id') ?? 'id なし'}）`;
            const start = attr(p, 'start');
            if (start !== undefined && start !== 'true' && start !== 'false') {
                errors.push(`${where}: start は true か false にしてください（"${start}"）`);
            }
            return clean({
                id: attr(p, 'id'),
                name: attr(p, 'name'),
                start: start === 'true' ? true : undefined,
                entries: children(p, 'entry').map((e, j) => {
                    const at = `${where} の <entry> ${j + 1} 番目`;
                    return clean({
                        t: num(e, 't', at),
                        duration: num(e, 'duration', at),
                        // XML の castname（詠唱バーの技名）と text（表示の文言）を、エンジンの name・label にする
                        name: attr(e, 'castname'),
                        label: attr(e, 'text'),
                        tts: attr(e, 'tts') || undefined, // tts="" は読まないので、無いのと同じにする（書き出しで tts="" を作らない）
                        sync: attr(e, 'sync') === 'false' ? false : undefined,
                        window: pair(e, 'window', at),
                        // アイコン: gimmick_icon はギミック 1 つ、skills_icon はスキル（カンマ区切り）。画像のファイル（この XML からの相対パスか URL）、
                        // または拡張子なしで用意したギミックのアイコン（id か名前）。2026-10-21 のユーザーの指定
                        gimmickIcon: attr(e, 'gimmick_icon')?.trim() || undefined,
                        skillIcons: attr(e, 'skills_icon')?.split(',').map((s) => s.trim()).filter(Boolean),
                    });
                }),
                next: children(p, 'next').map((n, j) => {
                    const at = `${where} の <next> ${j + 1} 番目`;
                    return clean({
                        to: attr(n, 'to'),
                        at: num(n, 'at', at),
                        from: num(n, 'from', at),
                        until: num(n, 'until', at),
                        when: clean({
                            cast: attr(n, 'cast'),
                            hp: num(n, 'hp', at),
                            time: num(n, 'time', at),
                            hpLost: num(n, 'hp-lost', at),
                        }),
                    });
                }),
            });
        }),
    });
    errors.push(...validateTimeline(timeline));
    return { timeline: errors.length === 0 ? timeline : null, errors };
}

/**
 * 配信する一覧（index.xml）を読む。各タイムラインの file・content・title は 1 行ずつの子要素（タイムラインの先頭の情報と同じ形）。
 * 以前の属性の形（<timeline file="…" content="…" title="…"/>）も読む（GitHub の raw は最大 5 分キャッシュされ、
 * push の直後は古い一覧と新しい読み方が混ざるため）。
 * @returns {{file:string, content:string, title:string}[]}
 */
export function parseTimelineIndex(text) {
    const root = parseXml(text).documentElement;
    return children(root, 'timeline')
        .map((t) => {
            const field = (name) => children(t, name)[0]?.textContent.trim() || t.getAttribute(name) || undefined;
            return { file: field('file'), content: field('content'), title: field('title') ?? field('file') };
        })
        .filter((t) => t.file && t.content);
}

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlAttr = (name, value) => (value === undefined || value === null ? '' : ` ${name}="${escapeXml(Array.isArray(value) ? value.join(' ') : value)}"`);

/** エンジンの形のタイムラインを XML にする（parseTimelineXml の逆） */
export function toTimelineXml(timeline) {
    const lines = ['<?xml version="1.0" encoding="utf-8"?>'];
    lines.push('<timeline>');
    for (const [name, value] of [['format', timeline.format], ['content', timeline.content], ['title', timeline.title],
        ['author', timeline.author], ['license', timeline.license], ['sync-window', timeline.syncWindow?.join(' ')], ['note', timeline.note]]) {
        if (value !== undefined && value !== null && value !== '') {
            lines.push(`  <${name}>${escapeXml(value)}</${name}>`);
        }
    }
    for (const phase of timeline.phases) {
        lines.push(`  <phase${xmlAttr('id', phase.id)}${xmlAttr('name', phase.name)}${xmlAttr('start', phase.start ? 'true' : undefined)}>`);
        for (const e of phase.entries) {
            // 属性の順は t・text・castname・duration・sync・tts・window・gimmick_icon・skills_icon で統一する（見やすさのため。2026-10-20 のユーザーの指定）
            // t と duration は必ず小数点以下 1 桁（56 → 56.0。2026-10-20 のユーザーの指定）
            lines.push(`    <entry${xmlAttr('t', Number(e.t).toFixed(1))}${xmlAttr('text', e.label)}${xmlAttr('castname', e.name)}`
                + `${xmlAttr('duration', e.duration ? Number(e.duration).toFixed(1) : undefined)}${xmlAttr('sync', e.sync === false ? 'false' : undefined)}${xmlAttr('tts', e.tts)}${xmlAttr('window', e.window)}`
                + `${xmlAttr('gimmick_icon', e.gimmickIcon)}${xmlAttr('skills_icon', e.skillIcons?.length ? e.skillIcons.join(',') : undefined)}/>`);
        }
        for (const rule of phase.next ?? []) {
            const w = rule.when;
            lines.push(`    <next${xmlAttr('to', rule.to)}${xmlAttr('at', rule.at)}${xmlAttr('cast', w.cast)}${xmlAttr('from', rule.from)}${xmlAttr('until', rule.until)}${xmlAttr('hp', w.hp)}`
                + `${xmlAttr('time', w.time)}${xmlAttr('hp-lost', w.hpLost)}/>`);
        }
        lines.push('  </phase>');
    }
    lines.push('</timeline>', '');
    return lines.join('\n');
}
