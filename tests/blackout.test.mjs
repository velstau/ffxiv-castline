// 画面の暗転の判定のテスト。実行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlackPixels } from '../public/js/blackout.js';

const pixels = (n, bright = []) => {
    const data = new Uint8ClampedArray(n * 4).fill(4);
    for (const i of bright) {
        data.set([200, 200, 200, 255], i * 4);
    }
    return data;
};

test('暗転: ほぼ全部が真っ黒なら暗転。HUD の明るい点が少しでもあれば暗転ではない', () => {
    assert.equal(isBlackPixels(pixels(9216)), true);
    assert.equal(isBlackPixels(pixels(9216, [0, 1, 2])), true); // 0.5% 未満の明るい点（ノイズ）は無視
    assert.equal(isBlackPixels(pixels(9216, Array.from({ length: 200 }, (_, i) => i))), false); // ホットバーなど
    const dim = new Uint8ClampedArray(9216 * 4).fill(30); // 暗い戦場（真っ黒ではない）
    assert.equal(isBlackPixels(dim), false);
});

test('暗くなった: HUD が残っていても、6 割以上が黒なら暗くなった（討伐の瞬間）。暗い演出（3 割ほど）では暗くならない', async () => {
    const { isDimPixels } = await import('../public/js/blackout.js');
    assert.equal(isDimPixels(pixels(9216, Array.from({ length: 1400 }, (_, i) => i))), true); // HUD が 15%
    assert.equal(isDimPixels(pixels(9216, Array.from({ length: 6400 }, (_, i) => i))), false); // 黒は 3 割
    assert.equal(isDimPixels(pixels(9216)), true); // 真っ黒の暗転も含む
});
