import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentPresence } from '../public/js/content-presence.js';

test('コンテンツを確認していない状態、確認が途切れた状態では開始を許可しない', () => {
    const p = new ContentPresence();
    assert.equal(p.canStart(0), false);
    p.observe(1000, true);assert.equal(p.canStart(1500), true);
    p.observe(2000, false);assert.equal(p.canStart(2000), false);
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
