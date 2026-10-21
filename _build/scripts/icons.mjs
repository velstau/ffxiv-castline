// Material Symbols（Google、Apache-2.0）をインライン SVG として使う（vel.works/_build/scripts/icons.mjs と同じ決まり）。
//
// (1) HTML には目印だけを書く:   <svg data-ms="timeline" class="icon"></svg>（塗りつぶし版は名前に -fill）
//     このスクリプトが中身（path）と属性（viewBox・fill・aria-hidden）を書き込む。何度実行しても同じ結果になる。
// (2) JS で組み立てる画面のアイコンは、下の JS_ICONS に名前を書くと public/js/icons.js に書き出す（icon(name) で使う）。
//
// スタイルは Rounded・字重 400（@material-symbols/svg-400/rounded）。アイコンは装飾（aria-hidden）。意味は隣の文字で伝える。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iconDir = join(root, 'node_modules/@material-symbols/svg-400/rounded');
const publicDir = join(root, '../public');

// JS で使うアイコン（setup.js の手順の印など）
const JS_ICONS = ['check_circle', 'radio_button_unchecked', 'error', 'zoom_in'];

const cache = new Map();
function iconBody(name) {
    if (!cache.has(name)) {
        const svg = readFileSync(join(iconDir, `${name}.svg`), 'utf8');
        const m = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
        if (!m) {
            throw new Error(`SVG を読めない: ${name}`);
        }
        cache.set(name, m[1].trim());
    }
    return cache.get(name);
}

const pattern = /<svg\b([^>]*?)\bdata-ms="([a-z0-9_]+(?:-fill)?)"([^>]*)>[\s\S]*?<\/svg>/g;
let total = 0;
const used = new Set();
for (const file of readdirSync(publicDir).filter((f) => f.endsWith('.html')).map((f) => join(publicDir, f))) {
    const src = readFileSync(file, 'utf8');
    const out = src.replace(pattern, (_all, before, name, after) => {
        const cls = `${before} ${after}`.match(/\bclass="([^"]*)"/);
        used.add(name);
        total++;
        return `<svg data-ms="${name}"${cls ? ` class="${cls[1]}"` : ''} viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true" focusable="false">${iconBody(name)}</svg>`;
    });
    if (out !== src) {
        writeFileSync(file, out);
    }
}

const entries = JS_ICONS.map((name) => `    ${name}: '${iconBody(name).replaceAll("'", "\\'")}',`).join('\n');
writeFileSync(join(publicDir, 'js/icons.js'), `// 生成ファイル（_build/scripts/icons.mjs）。手で直さない。Material Symbols Rounded 400（Apache-2.0）
const PATHS = {
${entries}
};

/** アイコンの svg 要素（装飾。意味は隣の文字で伝える）。cls は class 属性 */
export function icon(name, cls = 'icon', doc = document) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 -960 960 960');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', cls);
    svg.innerHTML = PATHS[name];
    return svg;
}
`);
console.log(`icons: HTML ${total} 箇所・${used.size} 種類 (${[...used].sort().join(', ')})、JS ${JS_ICONS.length} 種類`);
