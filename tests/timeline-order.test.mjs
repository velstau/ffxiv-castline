// 配信のタイムラインの一覧の並び（timeline-order.js）。実際の index.xml と contents.json で確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupTimelines } from '../public/js/timeline-order.js';

const contents = JSON.parse(readFileSync(new URL('../public/data/contents.json', import.meta.url), 'utf8')).contents;
const items = [...readFileSync(new URL('../public/timelines/index.xml', import.meta.url), 'utf8').matchAll(/<content>([^<]*)<\/content>/g)]
    .map(([, content]) => ({ content }));

test('配信の一覧は 零式・絶・極の順で、全部どこかに入る', () => {
    const groups = groupTimelines(items, contents);
    assert.deepEqual(groups.map((g) => g.label), ['零式', '絶', '極・滅']);
    assert.equal(groups.flatMap((g) => g.items).length, items.length);
});

test('零式は新しいシーズンから、シーズンの中は 1 層から', () => {
    const names = groupTimelines(items, contents)[0].items.map((i) => i.content);
    assert.deepEqual(names.slice(0, 4), [1, 2, 3, 4].map((n) => `至天の座アルカディア零式：ヘビー級${n}`));
    // 行番号は 辺獄編 4 が 801・3 が 807 と前後するが、層の順に並ぶ
    const hengoku = names.filter((n) => n.includes('辺獄編'));
    assert.deepEqual(hengoku, [1, 2, 3, 4].map((n) => `万魔殿パンデモニウム零式：辺獄編${n}`));
    assert.ok(names.indexOf('万魔殿パンデモニウム零式：天獄編1') < names.indexOf('万魔殿パンデモニウム零式：煉獄編1'));
    assert.ok(names.at(-1).includes('アルファ編'));
});

test('絶・極はレベルの高い順、同じレベルなら新しい順', () => {
    const [, ultimate, extreme] = groupTimelines(items, contents);
    assert.match(ultimate.items[0].content, /妖星乱舞/);
    assert.match(ultimate.items.at(-1).content, /バハムート/);
    // 極ヴァリガルマンダは Lv100 で行番号が小さいが、Lv90 の極より上
    const names = extreme.items.map((i) => i.content);
    assert.ok(names.indexOf('極ヴァリガルマンダ討滅戦') < names.findIndex((n) => n.includes('ゼロムス')));
});

test('contents.json に無いコンテンツは「その他」として最後に元の順で', () => {
    const groups = groupTimelines([{ content: '知らないコンテンツB' }, ...items.slice(0, 1), { content: '知らないコンテンツA' }], contents);
    assert.equal(groups.at(-1).label, 'その他');
    assert.deepEqual(groups.at(-1).items.map((i) => i.content), ['知らないコンテンツB', '知らないコンテンツA']);
});
