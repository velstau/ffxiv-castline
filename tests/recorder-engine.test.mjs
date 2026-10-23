// 記録の画面で、タイムラインなし（空のタイムライン）の TimelineEngine で戦闘の始まり・終わりだけを追えるか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineEngine } from '../public/js/timeline-engine.js';
import { WATCH_TIMELINE } from '../public/js/cast-recorder.js';

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
