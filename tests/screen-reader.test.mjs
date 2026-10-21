// 画面の読み取りのテスト。実行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinLineBoxes } from '../public/js/screen-reader.js';

test('行の枠: 1 行を途中で分けて見つけた部分をつなぎ、別の行や離れた文字はつながない', () => {
    const lines = joinLineBoxes([
        { x: 2380, y: 47, w: 150, h: 16 }, // 「ア零式：ヘビー級1」
        { x: 2245, y: 46, w: 130, h: 17 }, // 「至天の座アルカデイ」
        { x: 2400, y: 20, w: 120, h: 16 }, // 「コンテンツ情報」（上の行）
        { x: 2000, y: 47, w: 60, h: 16 }, // 同じ高さでも離れている
    ]);
    assert.deepEqual(lines, [
        { x: 2400, y: 20, w: 120, h: 16, parts: 1 },
        { x: 2245, y: 46, w: 285, h: 17, parts: 2 },
        { x: 2000, y: 47, w: 60, h: 16, parts: 1 },
    ]);
});
