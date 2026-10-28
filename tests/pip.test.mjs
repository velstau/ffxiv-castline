// 小窓の文字の大きさ・書体のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIP_SCALE, pipScale, pipFontFamily, applyPipStyle } from '../public/js/pip.js';

test('大きさは範囲内の刻みに丸め、読めない値は既定にする', () => {
    assert.equal(pipScale(125), 130);
    assert.equal(pipScale('150'), 150);
    assert.equal(pipScale(10), PIP_SCALE.min);
    assert.equal(pipScale(999), PIP_SCALE.max);
    assert.equal(pipScale('abc'), PIP_SCALE.default);
    assert.equal(pipScale(undefined), PIP_SCALE.default);
});

test('書体: 既定と知らない値は空、選んだ書体はブラウザの書体を後ろに足す', () => {
    assert.equal(pipFontFamily(''), '');
    assert.equal(pipFontFamily('unknown'), '');
    assert.equal(pipFontFamily('meiryo'), 'Meiryo, "メイリオ", var(--tblr-font-sans-serif)');
});

test('入れた書体の名前は引用符で囲み、CSS を崩す文字を外す', () => {
    assert.equal(pipFontFamily('custom', ' Noto Sans JP '), '"Noto Sans JP", var(--tblr-font-sans-serif)');
    assert.equal(pipFontFamily('custom', 'a"; color:red}'), '"a color:red", var(--tblr-font-sans-serif)');
    assert.equal(pipFontFamily('custom', ''), '');
    assert.equal(pipFontFamily('custom', '";'), '');
});

test('小窓の html に大きさと書体を当て、既定に戻すと書体の指定を外す', () => {
    const props = new Map();
    const style = { fontSize: '', setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) };
    const doc = { documentElement: { style } };
    applyPipStyle(doc, { scale: 150, font: 'biz-ud', fontName: '' });
    assert.equal(style.fontSize, '150%');
    assert.match(props.get('--tblr-body-font-family'), /^"BIZ UDPGothic"/);
    applyPipStyle(doc, { scale: 100, font: '', fontName: '' });
    assert.equal(style.fontSize, '100%');
    assert.equal(props.has('--tblr-body-font-family'), false);
});
