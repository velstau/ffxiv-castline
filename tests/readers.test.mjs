// 技名の照合（pickCast）のテスト。認識モデルの代わりに、読んだ文字列から作った合成の出力を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spottingPenalty } from '../public/js/ctc.js';
import { pickCast, parseCountdown, readCountdown } from '../public/js/readers.js';

const SKILLS = ['創世の真炎', 'オクタフレア・コンシーヴ', 'テトラフレア・コンシーヴ', '熾炎創火', '創獣炎舞'];

// ocr.js の TextRecognizer.spot と同じ形の照合をする代わりの認識器
function fakeRecognizer() {
    const chars = [...new Set([...SKILLS.join(''), ...'Bヘファイストー…オクタフレアABC'])];
    const charIndex = new Map(chars.map((c, i) => [c, i + 1])); // 0 番は空白記号
    const classes = chars.length + 1;
    return {
        // 1 文字ごとに「その文字 0.9」「空白 0.9」の 2 時刻を並べる
        read(text) {
            const frames = [...text].flatMap((c) => [charIndex.get(c), 0]);
            const data = new Float32Array(frames.length * classes).fill(0.1 / (classes - 1));
            frames.forEach((k, t) => { data[t * classes + k] = 0.9; });
            return { text, output: { data, dims: [1, frames.length, classes] } };
        },
        spot(output, candidates) {
            const [, steps] = output.dims;
            return candidates
                .map((text) => ({ text, penalty: spottingPenalty(output.data, steps, classes, [...text].map((c) => charIndex.get(c))) }))
                .sort((a, b) => b.penalty - a.penalty);
        },
    };
}

const r = fakeRecognizer();
const pick = (text, options, candidates = SKILLS) => pickCast(r, r.read(text), candidates, options).decided;

test('詠唱バー: 前に余計な文字が付いても、当てはまる候補のうち長いものを採る', () => {
    assert.equal(pick('ーーオクタフレア・コンシーヴ'), 'オクタフレア・コンシーヴ');
    assert.equal(pick('ーーオクタフレア・コンシーヴ', {}, [...SKILLS, 'コンシーヴ']), 'オクタフレア・コンシーヴ');
});

test('敵対リスト: 途中で切れた技名（「テトラフレア・コ…」）を頭の部分で決める', () => {
    assert.equal(pick('Bヘファイストテトラフレア・コ…', { truncated: true }), 'テトラフレア・コンシーヴ');
    assert.equal(pick('Bヘファイストテトラフレア・コ…'), null); // 頭の部分で照合しなければ決まらない
    assert.equal(pick('Bヘファイストオクタフ', { truncated: true }), 'オクタフレア・コンシーヴ');
    assert.equal(pick('Bヘファイスト創世の真炎', { truncated: true }), '創世の真炎');
});

test('敵対リスト: 頭の部分が短すぎるとき・同じ頭の候補が複数あるときは決めない', () => {
    assert.equal(pick('Bヘファイストテトラ', { truncated: true }), null);
    assert.equal(pick('Bヘファイストオクタフレア…', { truncated: true }, ['オクタフレア', 'オクタフレア・コンシーヴ']), null);
    assert.equal(pick('Bヘファイスト', { truncated: true }), null);
});

test('カウントダウン: 秒数の読めない「戦闘開始まで…」を戦闘開始にしない・全角数字と O の読み違い', () => {
    assert.deepEqual(parseCountdown('戦闘開始まで16秒！'), { seconds: 16 });
    assert.deepEqual(parseCountdown('戦闘開始！'), { started: true });
    assert.equal(parseCountdown('戦闘開始まで秒！'), null);
    assert.equal(parseCountdown('戦闘開始まで'), null);
    assert.deepEqual(parseCountdown('戦闘開始まで１０秒！'), { seconds: 10 });
    assert.deepEqual(parseCountdown('戦闘開始まで1O秒！'), { seconds: 10 });
    assert.deepEqual(parseCountdown('則闘開始！'), { started: true });
});

test('カウントダウン: 吹き出しが「戦闘開始」と「まで16秒！」の 2 行に分かれて見つかっても、残り 16 秒と読む', async () => {
    const lines = ['戦闘開始', 'まで16秒！', '（Vel Stau）'];
    const detector = { detect: async () => ({ ms: 1, boxes: lines.map((_, i) => ({ x: 0, y: i * 20, w: 100, h: 18, i })) }) };
    const recognizer = { read: async (_, box) => ({ ms: 1, text: lines[box.i] }) };
    assert.deepEqual((await readCountdown(detector, recognizer, null, {})).countdown, { seconds: 16 });
    const started = { read: async () => ({ ms: 1, text: '戦闘開始！' }) };
    const one = { detect: async () => ({ ms: 1, boxes: [{ x: 0, y: 0, w: 100, h: 18 }] }) };
    assert.deepEqual((await readCountdown(one, started, null, {})).countdown, { started: true });
});
