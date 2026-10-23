// 記録の画面で、タイムラインなし（空のタイムライン）の TimelineEngine で戦闘の始まり・終わりだけを追えるか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineEngine } from '../public/js/timeline-engine.js';
import { WATCH_TIMELINE, killSuspected, falseStart } from '../public/js/cast-recorder.js';

const engine = () => new TimelineEngine(WATCH_TIMELINE, { hasEnmity: true });
const enmityOff = (e, from, to) => {
    for (let at = from; at <= to; at += 500) {
        e.enmity(at, false);
    }
};

test('空のタイムライン: カウントダウンで始まり、暗転で終わり、次のカウントダウンでまた始まる', () => {
    const e = engine();
    enmityOff(e, 0, 5000);
    for (let s = 10; s >= 1; s--) {
        e.countdown(5000 + (10 - s) * 1000, s);
    }
    e.enmity(15000, true);
    e.enmity(16000, true);
    assert.equal(e.status(16000).state, 'combat');
    assert.ok(Math.abs(e.startAt - 15000) <= 1000, `開始 ${e.startAt}`);
    e.blackout(60000, true);
    e.blackout(62500, true);
    assert.equal(e.status(62500).state, 'ended');
    enmityOff(e, 63000, 70000);
    for (let s = 5; s >= 1; s--) {
        e.countdown(70000 + (5 - s) * 1000, s);
    }
    e.enmity(75000, true);
    e.enmity(76200, true);
    assert.equal(e.status(76200).state, 'combat');
});

test('空のタイムライン: カウントダウンなしでも、敵対リストが出たら始まり、HP 3% 以下の後に消えたら討伐で終わる', () => {
    const e = engine();
    enmityOff(e, 0, 5000);
    e.enmity(6000, true);
    e.enmity(7200, true);
    assert.equal(e.status(7200).state, 'combat');
    assert.equal(e.startAt, 6000);
    e.hpPercent(100000, 2);
    enmityOff(e, 101000, 105000);
    assert.equal(e.status(105000).state, 'ended');
});

test('空のタイムライン: 手で止めたら終わり、敵対リストが消えてまた出たら始まる', () => {
    const e = engine();
    enmityOff(e, 0, 5000);
    e.enmity(6000, true);
    e.enmity(7200, true);
    e.halt(30000);
    e.enmity(31000, true);
    assert.equal(e.status(32500).state, 'ended');
    enmityOff(e, 33000, 38000);
    e.enmity(40000, true);
    e.enmity(41200, true);
    assert.equal(e.status(41200).state, 'combat');
});

test('空のタイムライン: 戦闘中に手で止めたら「戦闘開始！」の読みでは始めず、次のカウントダウンでまた始まる', () => {
    const e = engine();
    enmityOff(e, 0, 5000);
    e.enmity(6000, true);
    e.enmity(7200, true);
    assert.equal(e.status(7200).state, 'combat');
    e.halt(30000);
    e.started(31000); // 止めた直後の読み違い・残った吹き出し
    assert.equal(e.status(31000).state, 'ended');
    // 全滅して数え直し: 敵対リストが残ったままでも、カウントダウンが出たら次の戦闘
    for (let s = 10; s >= 1; s--) {
        e.countdown(60000 + (10 - s) * 1000, s);
    }
    assert.equal(e.status(65000).state, 'countdown');
    e.started(70000);
    assert.equal(e.status(70000).state, 'combat');
    assert.ok(Math.abs(e.startAt - 70000) <= 1000, `開始 ${e.startAt}`);
});

test('記録用の討伐の疑い: HP 10% 以下を読んだ後に敵対リストが 3 秒消えたら。HP が高ければ、長く消えても疑わない（ムービー）', () => {
    const start = () => {
        const e = engine();
        enmityOff(e, 0, 5000);
        e.enmity(6000, true);
        e.enmity(7200, true);
        return e;
    };
    const kill = start();
    kill.hpPercent(100000, 7); // 3% 以下は読めなかった
    enmityOff(kill, 101000, 103500);
    assert.equal(killSuspected(kill, 103500), false);
    enmityOff(kill, 104000, 104000);
    assert.equal(killSuspected(kill, 104000), true);
    assert.equal(kill.status(104000).state, 'combat'); // 終えるのは呼び出し側（画面の表示を確かめてから）

    const movie = start();
    movie.hpPercent(100000, 45);
    enmityOff(movie, 101000, 160000); // 1 分のムービー
    assert.equal(killSuspected(movie, 160000), false);
    assert.equal(movie.status(160000).state, 'combat');
});

test('前の戦闘の HP は次の戦闘に持ち越さない（カウントダウンなしで続けて始めても、すぐ討伐にならない）', () => {
    const e = engine();
    enmityOff(e, 0, 5000);
    e.enmity(6000, true);
    e.enmity(7200, true);
    e.hpPercent(60000, 2);
    enmityOff(e, 61000, 65000);
    assert.equal(e.status(65000).state, 'ended');
    e.enmity(70000, true);
    e.enmity(71200, true);
    assert.equal(e.status(71200).state, 'combat');
    assert.equal(e.hp, null);
    enmityOff(e, 72000, 76000);
    assert.equal(e.status(76000).state, 'combat'); // HP 2% の持ち越しで討伐にならない
    assert.equal(killSuspected(e, 76000), false);
});

test('始まりの誤判定: HP も詠唱も読めないまま敵対リストが 5 秒消えたら。HP を読んだ戦闘や詠唱を記録した戦闘では当たらない', () => {
    const start = () => {
        const e = engine();
        enmityOff(e, 0, 5000);
        e.enmity(6000, true);
        e.enmity(7200, true);
        return e;
    };
    const flicker = start();
    enmityOff(flicker, 8000, 12500);
    assert.equal(falseStart(flicker, 12500, 0), false);
    enmityOff(flicker, 13000, 13000);
    assert.equal(falseStart(flicker, 13000, 0), true);
    assert.equal(falseStart(flicker, 13000, 2), false);
    const real = start();
    real.hpPercent(9000, 88);
    enmityOff(real, 10000, 70000); // ムービー
    assert.equal(falseStart(real, 70000, 0), false);
});
