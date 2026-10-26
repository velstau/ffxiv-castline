import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineEngine } from '../public/js/timeline-engine.js';
const make = () => new TimelineEngine({ phases: [{ id: 'p1', entries: [], next: [] }] }, { hasEnmity: true });

test('1回の敵対リスト検出後に画面描画だけ進んでも戦闘を開始しない', () => {
    const e = make();
    e.enmity(0, false);
    e.enmity(2000, false);
    e.enmity(3000, true);
    assert.equal(e.status(3500).state, 'idle');
    assert.equal(e.status(5000).state, 'idle');
    e.enmity(5100, false);
    assert.equal(e.status(7000).state, 'idle');
});

test('敵対リストが実際に1秒間観測されたら、出始めを戦闘開始とする', () => {
    const e = make();
    e.enmity(0, false);
    e.enmity(2000, false);
    e.enmity(3000, true);
    e.enmity(3500, true);
    assert.equal(e.status(4000).state, 'idle');
    e.enmity(4000, true);
    assert.equal(e.status(4000).state, 'combat');
    assert.equal(e.startAt, 3000);
});


test('終了直後に残っている敵対リストだけで再開始せず、消えて再出現すれば開始できる', () => {
    const e = make();
    e.enmity(0, false); e.enmity(2000, false);
    e.enmity(3000, true); e.enmity(4000, true);
    assert.equal(e.status(4000).state, 'combat');
    e.end(5000, '全滅');
    assert.equal(e.status(5500).state, 'ended');
    e.enmity(6000, true);
    assert.equal(e.status(6000).state, 'ended');
    e.enmity(7000, false); e.enmity(9000, false);
    e.enmity(10000, true); e.enmity(11000, true);
    assert.equal(e.status(11000).state, 'combat');
});


test('討伐の追加確認: HP9%を読んだ後に敵が消えた場合。古いHP・中間フェーズ・確認範囲なしでは採用しない', async () => {
    const { needsKillConfirmation } = await import('../public/js/combat-end.js');
    const e = make();
    e.started(1000);
    e.hpPercent(2000, 9);
    e.enmity(2500, false);
    assert.equal(needsKillConfirmation(e, 5500, true), true);
    assert.equal(needsKillConfirmation(e, 5500, false), false);
    e.phase.next = [{ to: 'other', when: { time: 100 } }];
    assert.equal(needsKillConfirmation(e, 5500, true), false);
    e.phase.next = [];
    e.lastHpAt = -10000;
    assert.equal(needsKillConfirmation(e, 5500, true), false);
});


test('報告ログ再現: 10.6秒消失後の0.5秒の陽性では、終了待ちの消失時刻をリセットしない', () => {
    const e = make();
    e.started(0); e.hpPercent(1000, 50);
    e.enmity(2000, true); e.enmity(3000, true);
    e.enmity(92300, false);
    e.enmity(102900, true);
    assert.equal(e.enmityOffSince, 92300);
    e.enmity(103400, false);
    assert.equal(e.enmityOffSince, 92300);
    assert.equal(e.status(110000).state, 'combat'); // 消失だけでムービーを誤って終了させない
    assert.equal(e.status(182300).state, 'combat'); // 2026-10-26 の録画で 76 秒の消失があったので 90 秒では終えない
    e.enmity(212300, false);
    assert.equal(e.status(212300).state, 'ended');
});

test('実際に敵対リストが1秒以上戻った場合は、消失の待ちを解除する', () => {
    const e = make();e.started(0);
    e.enmity(2000, false);
    e.enmity(5000, true);
    assert.equal(e.enmityOffSince, 2000);
    e.enmity(6000, true);
    assert.equal(e.enmityOffSince, null);
});


test('クリア表示は定型文だけに限定し、会話や似た文字を採用しない', async () => {
    const { isDutyCompleteText } = await import('../public/js/combat-end.js');
    assert.equal(isDutyCompleteText([{text:'D U T Y  C O M P L E T E'}]), true);
    assert.equal(isDutyCompleteText([{text:'DUTY'}, {text:'COMPLETE!'}]), true);
    assert.equal(isDutyCompleteText([{text:'コンプリート'}]), true);
    assert.equal(isDutyCompleteText([{text:'INCOMPLETE'}]), false);
    assert.equal(isDutyCompleteText([{text:'DUTY COMPLETEを見た'}]), false);
    assert.equal(isDutyCompleteText([]), false);
});

test('クリア表示は別フレームで再確認し、読めない/間隔が空いたら確認をやり直す', async () => {
    const { ClearNoticeTracker } = await import('../public/js/combat-end.js');
    const t = new ClearNoticeTracker();
    assert.equal(t.observe(1000,true),false);
    assert.equal(t.observe(1000,true),false);
    assert.equal(t.observe(2000,true),true);
    assert.equal(t.observe(2500,false),false);
    assert.equal(t.observe(3000,true),false);
    assert.equal(t.observe(10000,true),false);
});
