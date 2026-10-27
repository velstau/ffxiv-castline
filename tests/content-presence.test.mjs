import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentPresence, acceptContentName } from '../public/js/content-presence.js';

const SAVAGE = '至天の座アルカディア零式：ヘビー級1';
const NORMAL = '至天の座アルカディア：ヘビー級1';
test('足し合わせて決めた名前は、1 回の読み取りで決まった名前を変えない（零式とノーマルの行き来）', () => {
    assert.equal(acceptContentName({ combined: NORMAL }), NORMAL); // まだ決まっていなければ使う
    assert.equal(acceptContentName({ combined: NORMAL, current: SAVAGE }), null);
    assert.equal(acceptContentName({ combined: SAVAGE, current: SAVAGE }), SAVAGE); // 同じなら確認として使う
    assert.equal(acceptContentName({ single: NORMAL, current: SAVAGE }), NORMAL); // 1 回で決まれば戦闘外では変える
});
test('戦闘中はコンテンツ名を変えない', () => {
    assert.equal(acceptContentName({ single: NORMAL, current: SAVAGE, inCombat: true }), null);
    assert.equal(acceptContentName({ single: SAVAGE, current: SAVAGE, inCombat: true }), SAVAGE);
    assert.equal(acceptContentName({ single: SAVAGE, current: null, inCombat: true }), SAVAGE);
});

test('コンテンツを確認していない状態、確認が途切れた状態では開始を許可しない', () => {
    const p = new ContentPresence();
    assert.equal(p.canStart(0), false);
    p.observe(1000, true);assert.equal(p.canStart(1500), true);
    p.observe(2000, false);assert.equal(p.canStart(2000), true); // 1 回読めなかっただけでは止めない
    assert.equal(p.canStart(7000), true);
    assert.equal(p.canStart(7001), false); // 最後に確認してから 6 秒を過ぎたら止める
    assert.equal(p.shouldClear(7999,false), false);
    assert.equal(p.shouldClear(8000,false), true);
});
test('HPや詠唱がある実戦中はOCRの途切れだけで解除しない。コンテンツを再確認したら再開可能', () => {
    const p = new ContentPresence();p.observe(0,true);p.observe(1000,false);
    assert.equal(p.shouldClear(8000,true),false);
    p.observe(9000,true);assert.equal(p.canStart(9000),true);
    assert.equal(p.shouldClear(10000,false),false);
});
test('戦闘中はムービーの長さ（66 秒）では解除せず、読み上げだけ止める。180 秒で解除', () => {
    const p = new ContentPresence();p.observe(0,true);p.observe(1000,false);
    assert.equal(p.shouldMute(6999,false), false);
    assert.equal(p.shouldMute(7000,false), true);
    assert.equal(p.shouldMute(7000,true), false); // HP・詠唱が読めていれば止めない
    assert.equal(p.shouldClear(67000,false,true), false);
    assert.equal(p.shouldClear(180999,false,true), false);
    assert.equal(p.shouldClear(181000,false,true), true);
    p.observe(70000,true);
    assert.equal(p.shouldMute(70000,false), false);
});
test('古い確認・共有再開前の確認を新しい戦闘開始に流用しない', () => {
    const p = new ContentPresence();p.observe(0,true);
    assert.equal(p.canStart(6001),false);
    p.reset();assert.equal(p.canStart(1000),false);
});
