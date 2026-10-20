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
    const pair = (el, name, where) => {
        if (!el.hasAttribute(name)) {
            return undefined;
        }
        const values = el.getAttribute(name).trim().split(/[\s,]+/).map(Number);
        if (values.length !== 2 || !values.every(Number.isFinite)) {
            errors.push(`${where}: ${name} は「前 後」の 2 つの秒で書いてください（例: "10 10"）`);
        }
        return values;
    };
    const attr = (el, name) => (el.hasAttribute(name) ? el.getAttribute(name) : undefined);
    const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

    const timeline = clean({
        format: attr(root, 'format'),
        content: attr(root, 'content'),
        title: attr(root, 'title'),
        note: children(root, 'note')[0]?.textContent.trim(),
        syncWindow: pair(root, 'sync-window', '<timeline>'),
        phases: children(root, 'phase').map((p, i) => {
            const where = `<phase> ${i + 1} 番目（${attr(p, 'id') ?? 'id なし'}）`;
            return clean({
                id: attr(p, 'id'),
                name: attr(p, 'name'),
                entries: children(p, 'entry').map((e, j) => {
                    const at = `${where} の <entry> ${j + 1} 番目`;
                    return clean({
                        t: num(e, 't', at),
                        duration: num(e, 'duration', at),
                        name: attr(e, 'name'),
                        label: attr(e, 'label'),
                        tts: attr(e, 'tts'),
                        sync: attr(e, 'sync') === 'false' ? false : undefined,
                        window: pair(e, 'window', at),
                    });
                }),
                next: children(p, 'next').map((n, j) => {
                    const at = `${where} の <next> ${j + 1} 番目`;
                    return clean({
                        to: attr(n, 'to'),
                        at: num(n, 'at', at),
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
 * 配信する一覧（index.xml）を読む。
 * @returns {{file:string, content:string, title:string}[]}
 */
export function parseTimelineIndex(text) {
    const root = parseXml(text).documentElement;
    return children(root, 'timeline')
        .map((t) => ({ file: t.getAttribute('file'), content: t.getAttribute('content'), title: t.getAttribute('title') ?? t.getAttribute('file') }))
        .filter((t) => t.file && t.content);
}
