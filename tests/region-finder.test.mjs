// 自動の範囲指定（region-finder.js）。fixtures の行は、実際のゲーム画面（2560x1080）を画面全体で検出・認識した結果
// （ほかのプレイヤーの名前は Xx・ナマエに置き換え）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    findCountdownLine, countdownRegionFrom, countdownSearchArea, findHpLine, findEnmityLine, findCastLine,
    classifyCombatLines, castRegionFrom, fuzzyContains, damagedHp,
} from '../public/js/region-finder.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const W = 2560;
const H = 1080;
const inside = (box, rect) => box.x >= rect.x && box.y >= rect.y && box.x + box.w <= rect.x + rect.w && box.y + box.h <= rect.y + rect.h;
const within = (lines, area) => lines.filter((l) => inside(l, area));

test('カウントダウンの告知を画面中央から探し、文言・行数が変わっても入る範囲にする', () => {
    const area = countdownSearchArea(W, H);
    const line = findCountdownLine(within(fixture('scan-countdown-16s'), area));
    assert.equal(line.text, '戦闘開始まで16秒！');
    const rect = countdownRegionFrom(line, W, H);
    // 同じ場所に出る「戦闘開始！」（1 行の告知。2 行の告知より少し下）も入る
    const started = fixture('scan-combat-start').find((l) => l.text === '戦闘開始！');
    assert.ok(inside(started, rect), JSON.stringify({ rect, started }));
    assert.ok(rect.w <= 400 && rect.h <= 80, JSON.stringify(rect)); // 広げすぎない（頭上の名前などを入れない）
});

test('カウントダウンは「開始」「まで」の無い数字だけの行では決めない', () => {
    assert.equal(findCountdownLine([{ x: 0, y: 0, w: 50, h: 20, text: '5秒' }]), null);
    assert.equal(findCountdownLine([{ x: 0, y: 0, w: 50, h: 20, text: '戦闘開始！' }]).text, '戦闘開始！');
});

test('HP の行: ターゲットとフォーカスの両方があれば、FOCUS の下のほうを採る（全角の ％ も読む）', () => {
    const hp = findHpLine(fixture('scan-combat-start'));
    assert.equal(hp.focus, true);
    assert.equal(hp.others, 1);
    assert.equal(hp.line.text, '99.0％Gレッドホット');
    assert.equal(hp.name, 'レッドホット');
    // 満タンのうち（% が出ない）は見つからない
    assert.equal(findHpLine(fixture('scan-countdown-16s')), null);
});

test('敵対リストの行: 敵の名前だけの行を採り、頭上・ターゲットの名前（Lv100 名前、L100・レ100 と読めたもの）は採らない', () => {
    const lines = fixture('scan-combat-start');
    const line = findEnmityLine(lines, 'レッドホット');
    assert.equal(line.text, 'レッドホット');
    assert.deepEqual([line.x, line.y], [779, 450]);
    assert.equal(findEnmityLine(fixture('scan-countdown-16s'), 'レッドホット'), null);
    assert.ok(fuzzyContains('Bレッドオット', 'レッドホット'));
});

test('戦闘開始の画面から HP と敵対リストの範囲が決まり、詠唱バーは技名が無ければ決めない', () => {
    const r = classifyCombatLines(fixture('scan-combat-start'), { want: new Set(['hp', 'enmity', 'cast']), width: W, height: H });
    assert.equal(r.enemyName, 'レッドホット');
    assert.ok(r.hp.focus);
    assert.ok(inside({ x: 1666, y: 112, w: 80, h: 28 }, r.hp.rect), JSON.stringify(r.hp.rect)); // 「99.0％」の部分
    assert.ok(inside({ x: 779, y: 450, w: 80, h: 18 }, r.enmity.rect), JSON.stringify(r.enmity.rect));
    assert.equal(r.cast, undefined);
});

test('詠唱バー: 技名だけの行を、HP に近い順に採る（チャットの構え・敵対リストの行は採らない）', () => {
    const lines = [
        { x: 960, y: 150, w: 120, h: 22, text: 'キラーボイス', cast: 'キラーボイス' }, // ターゲットの詠唱バー
        { x: 1670, y: 140, w: 120, h: 22, text: 'キラーボイス', cast: 'キラーボイス' }, // フォーカスの詠唱バー
        { x: 30, y: 900, w: 400, h: 20, text: 'レッドホットは「キラーボイス」の構え。', cast: 'キラーボイス' },
        { x: 779, y: 450, w: 200, h: 18, text: 'レッドホットキラーボ', cast: 'キラーボイス' },
    ];
    const near = { x: 1666, y: 112, w: 154, h: 28 };
    assert.equal(findCastLine(lines, { near, enemyName: 'レッドホット' }).x, 1670);
    assert.equal(findCastLine(lines, { near: { x: 963, y: 123, w: 164, h: 24 }, enemyName: 'レッドホット' }).x, 960);
    assert.equal(findCastLine(lines.slice(2), { enemyName: 'レッドホット' }), null);
    // 範囲は長い技名も入るよう左右に広げる
    const rect = castRegionFrom(lines[0], 12, W, H);
    assert.ok(rect.w >= 120 * 13 / 6 - 1 && inside(lines[0], rect), JSON.stringify(rect));
});

test('敵対リスト: チャットの文と、戦闘前にも文字があった場所の行は採らない', () => {
    const combat = fixture('scan-combat-start');
    const chat = { x: 30, y: 900, w: 400, h: 20, text: 'レッドホットは「キラーボイス」の構え。' };
    const onChatArea = { x: 30, y: 930, w: 100, h: 20, text: 'レッドホット' }; // 戦闘前から文字のある場所（チャット欄）に出た名前
    const baseline = [{ x: 20, y: 925, w: 500, h: 22 }];
    const lines = [chat, onChatArea, ...combat];
    const line = findEnmityLine(lines, 'レッドホット', [], baseline);
    assert.deepEqual([line.x, line.y], [779, 450]);
    // 本物の敵対リストが無ければ、どれも採らない
    assert.equal(findEnmityLine([chat, onChatArea], 'レッドホット', [], baseline), null);
    // 戦闘前の画面（カウントダウン中）には敵対リストの場所に文字が無い
    const before = fixture('scan-countdown-16s');
    assert.ok(!before.some((b) => b.x < 779 + 80 && 779 < b.x + b.w && b.y < 450 + 18 && 450 < b.y + b.h));
});

test('戦闘中かどうか: HP の % が 100 未満の行があるか', () => {
    assert.equal(damagedHp(fixture('scan-combat-start')), 99);
    assert.equal(damagedHp(fixture('scan-countdown-16s')), null);
    assert.equal(damagedHp([{ x: 0, y: 0, w: 80, h: 20, text: '100%Gレッドホット' }]), 100);
});
