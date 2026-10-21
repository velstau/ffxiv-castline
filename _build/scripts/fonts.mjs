// ビルド後処理: app.css のフォント（Noto Sans JP / Mono）の参照先を、vel.works が配信しているもの（/assets/fonts/）に書き換える。
//
// フォントは日本語の分割ファイルだけで 6MB ほどあるので、このリポジトリには入れず、同じサイト（vel.works）の TOP が置いている
// ファイルを使う（@fontsource の版を vel.works/_build と同じに固定しているので、ファイル名が一致する）。
// vel.works 以外で配信したときはフォントが読めず、DADS の指定どおりシステムのフォントで表示される。
// 全対象ブラウザが woff2 に対応しているので woff の指定は外す。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cssPath = join(root, '../public/css/app.css');
const servedDir = join(root, '../../../top/assets/fonts'); // vel.works/top/assets/fonts（配信は /assets/fonts/）

let css = readFileSync(cssPath, 'utf8');
css = css.replace(/,\s*url\(\.\/files\/[^)]+\.woff\)\s*format\(["']woff["']\)/g, '');
const used = [...new Set([...css.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)].map((m) => m[1]))];
if (existsSync(servedDir)) {
    const missing = used.filter((name) => !existsSync(join(servedDir, name)));
    if (missing.length > 0) {
        throw new Error(`vel.works の /assets/fonts に無いフォント ${missing.length} 個（例: ${missing[0]}）。@fontsource の版を vel.works/_build と揃える`);
    }
} else {
    console.warn('vel.works/top/assets/fonts が無いので、フォントの有無を確かめていない');
}
css = css.replaceAll('url(./files/', 'url(/assets/fonts/');
if (css.includes('./files/')) {
    throw new Error('書き換え漏れの url(./files/...) が残っている');
}
writeFileSync(cssPath, css);

// 画面に埋め込む素材のライセンス文（Material Symbols = Apache-2.0。フォントは vel.works 側に置いてある）
const licenseDir = join(root, '../public/licenses');
mkdirSync(licenseDir, { recursive: true });
copyFileSync(join(root, 'node_modules/@material-symbols/svg-400/LICENSE'), join(licenseDir, 'material-symbols-Apache-2.0.txt'));
console.log(`fonts: ${used.length} files -> /assets/fonts/（vel.works のものを使う）`);
