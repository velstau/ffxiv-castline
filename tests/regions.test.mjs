// 範囲の保存・書き出し・読み込みのテスト。実行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setRegion, regionsFor, exportRegions, parseRegions, importRegions, loadAll, missingRegions, clearRegions, savedScreens } from '../public/js/regions.js';

function memoryStorage() {
    const data = new Map();
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

test('画面の大きさごとに保存し、null で消す', () => {
    const s = memoryStorage();
    setRegion(2560, 1009, 'content', { x: 2100.4, y: 35, w: 440, h: 40 }, s);
    setRegion(2560, 1009, 'hp', { x: 1, y: 2, w: 3, h: 4 }, s);
    setRegion(1920, 1080, 'cast', { x: 5, y: 6, w: 7, h: 8 }, s);
    assert.deepEqual(regionsFor(2560, 1009, s), { content: { x: 2100, y: 35, w: 440, h: 40 }, hp: { x: 1, y: 2, w: 3, h: 4 } });
    setRegion(2560, 1009, 'hp', null, s);
    assert.deepEqual(Object.keys(regionsFor(2560, 1009, s)), ['content']);
    setRegion(1920, 1080, 'cast', null, s);
    assert.deepEqual(Object.keys(loadAll(s)), ['2560x1009']);
});

test('書き出したファイルを読み込むと元に戻る（範囲 1 つが 1 行）', () => {
    const a = memoryStorage();
    setRegion(2560, 1009, 'enmity', { x: 10, y: 20, w: 300, h: 200 }, a);
    setRegion(2560, 1009, 'content', { x: 2100, y: 35, w: 440, h: 40 }, a);
    const text = exportRegions(loadAll(a));
    assert.match(text, /\n      "content": \{ "x": 2100, "y": 35, "w": 440, "h": 40 \},\n      "enmity": /);
    const b = memoryStorage();
    setRegion(1920, 1080, 'hp', { x: 1, y: 2, w: 3, h: 4 }, b);
    assert.deepEqual(importRegions(text, b), { screens: ['2560x1009'], errors: [] });
    assert.deepEqual(loadAll(b), { ...loadAll(a), '1920x1080': { hp: { x: 1, y: 2, w: 3, h: 4 } } });
});

test('おかしなファイルは読み込まない', () => {
    assert.match(parseRegions('{').errors[0], /JSON として読めません/);
    assert.match(parseRegions('{"format":"castline/1"}').errors[0], /範囲のファイルではありません/);
    const bad = parseRegions(JSON.stringify({ format: 'castline-regions/1', screens: {
        'big': {}, '100x100': { foo: { x: 0, y: 0, w: 1, h: 1 }, hp: { x: 90, y: 0, w: 20, h: 5 }, cast: { x: 'a' } } } }));
    assert.equal(bad.screens, null);
    assert.equal(bad.errors.length, 4, bad.errors.join('\n'));
    assert.match(parseRegions(JSON.stringify({ format: 'castline-regions/1', screens: {} })).errors[0], /1 つも/);
});

test('指定していない範囲と、できなくなること', () => {
    assert.deepEqual(missingRegions({ content: {}, countdown: {}, hp: {}, cast: {}, enmity: {} }), []);
    const none = missingRegions({});
    assert.equal(none[0].id, 'start');
    assert.ok(!none.some((m) => m.id === 'countdown'));
    assert.deepEqual(missingRegions({ countdown: {}, content: {}, hp: {} }).map((m) => m.id), ['cast', 'enmity']);
});

test('画面の大きさの範囲を全部消す（ほかの大きさは残す）', () => {
    const s = memoryStorage();
    setRegion(2560, 1032, 'content', { x: 1, y: 2, w: 3, h: 4 }, s);
    setRegion(2560, 1032, 'hp', { x: 1, y: 2, w: 3, h: 4 }, s);
    setRegion(1920, 1080, 'cast', { x: 5, y: 6, w: 7, h: 8 }, s);
    clearRegions(2560, 1032, s);
    assert.deepEqual(regionsFor(2560, 1032, s), {});
    assert.deepEqual(Object.keys(loadAll(s)), ['1920x1080']);
});

test('savedScreens: 再生できる（コンテンツ名＋開始）と、初期設定が済んだ（詠唱バーのほか全部）を分ける', () => {
    const s = memoryStorage();
    const r = { x: 0, y: 0, w: 10, h: 10 };
    for (const id of ['content', 'countdown']) {
        setRegion(1920, 1080, id, r, s);
    }
    for (const id of ['content', 'countdown', 'hp', 'enmity']) {
        setRegion(2560, 1440, id, r, s);
    }
    setRegion(800, 600, 'hp', r, s);
    const got = Object.fromEntries(savedScreens(s).map((x) => [x.key, [x.usable, x.complete]]));
    assert.deepEqual(got, { '1920x1080': [true, false], '2560x1440': [true, true], '800x600': [false, false] });
});
