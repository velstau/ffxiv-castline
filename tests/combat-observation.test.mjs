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

test('HP の 1 回だけの読み違い（67.7→2→67.2）では討伐にしない。続けて近い値を読めば大きく下がった値も採る', () => {
    const e = make();
    e.started(0);
    e.enmity(500, true); e.enmity(1500, true);
    e.hpPercent(2000, 67.7);
    e.hpPercent(2500, 2);
    assert.equal(e.hp, 67.7);
    e.enmity(3000, false);
    e.hpPercent(3000, 67.2);
    assert.equal(e.hp, 67.2);
    assert.equal(e.status(7000).state, 'combat');
    // ターゲットが雑魚に替わった（83.5→37.7）ような本当の変化は、次の読み取りで採る
    e.hpPercent(8000, 83.5);
    e.hpPercent(8500, 37.7);
    assert.equal(e.hp, 83.5);
    e.hpPercent(9000, 37.5);
    assert.equal(e.hp, 37.5);
    // HP を何秒も読めなかった後は、大きく下がっていてもそのまま採る
    e.hpPercent(15000, 10);
    assert.equal(e.hp, 10);
});

test('討伐の直前に HP を 1 回だけ大きく読み違えても（4.7→47→0.4）、討伐を逃さない', () => {
    const e = make();
    e.started(0);
    e.enmity(500, true); e.enmity(1500, true);
    e.hpPercent(2000, 4.7);
    e.hpPercent(2500, 47);
    assert.equal(e.hp, 4.7);
    e.hpPercent(3000, 0.4);
    assert.equal(e.hp, 0.4);
    e.enmity(3500, false);
    assert.equal(e.status(7000).state, 'ended');
    // 雑魚（2%）からボス（83%）に替わったときは、次の読み取りで採る
    const f = make();
    f.started(0);
    f.hpPercent(1000, 2);
    f.hpPercent(1500, 83);
    assert.equal(f.hp, 2);
    f.hpPercent(2000, 82.9);
    assert.equal(f.hp, 82.9);
});

test('雑魚の 2% の後にボスの 83% を確かめ待ちの間は、敵対リストが途切れても討伐にしない', () => {
    const e = make();
    e.started(0);
    e.enmity(500, true); e.enmity(1500, true);
    e.hpPercent(2000, 2);
    e.enmity(2500, false);
    e.hpPercent(4500, 83);
    assert.equal(e.hp, 2);
    assert.equal(e.hpForKill(5500), null);
    assert.equal(e.status(5500).state, 'combat');
});

test('討伐の直前に 1 回だけ高く読み違えても（2→27）、確かめる期限を過ぎれば討伐にする', () => {
    const e = make();
    e.started(0);
    e.enmity(500, true); e.enmity(1500, true);
    e.hpPercent(2000, 2);
    e.hpPercent(2500, 27);
    e.enmity(3000, false);
    e.hpPercent(3000, null);
    assert.equal(e.status(7000).state, 'combat'); // 確かめ待ちの間は待つ
    assert.equal(e.status(7600).state, 'ended');
});

test('敵対リストを読めない間も 3% より高い HP を読めていれば、ボスは生きているので討伐にしない', async () => {
    const { killSuspected } = await import('../public/js/cast-recorder.js');
    const e = make();
    e.started(0);
    e.enmity(500, true); e.enmity(1500, true);
    e.hpPercent(2000, 10.5);
    e.enmity(2500, false);
    e.hpPercent(3000, 10.4);
    e.hpPercent(4500, 10);
    e.hpPercent(6000, 9.6); // 敵対リストを 5 秒読めない間も、ボスの HP は読めている（2026-10-28 の録画）
    e.hpPercent(7500, 9.5);
    assert.equal(killSuspected(e, 8000), false);
    assert.equal(e.status(8000).state, 'combat');
    // 敵対リストがまた出続け、消えると同時に HP も読めなくなった（本当の討伐）
    e.enmity(9000, true); e.enmity(9500, true); e.enmity(10000, true);
    e.hpPercent(10000, 0.4);
    e.enmity(10500, false);
    e.hpPercent(10500, null);
    assert.equal(e.status(13600).state, 'ended');
});

test('敵対リストを読めない間に 4%→1% と読み、HP も読めなくなったら（倒した）、3 秒後に討伐にする', () => {
    const e = make();
    e.started(0);
    e.enmity(500, true); e.enmity(1500, true);
    e.enmity(2000, false);
    e.hpPercent(2500, 4);
    e.hpPercent(3000, 1);
    e.hpPercent(3500, null);
    assert.equal(e.status(5900).state, 'combat'); // 最後に HP（1%）を読んでから 3 秒たつまでは待つ
    assert.equal(e.status(6100).state, 'ended');
});

test('3% 以下でも HP を読み続けている間は、敵対リストを読めなくても討伐にしない', () => {
    const e = make();
    e.started(0);
    e.enmity(500, true); e.enmity(1500, true);
    e.enmity(2000, false);
    e.hpPercent(2500, 4);
    [2.9, 2.8, 2.7, 2.6].forEach((hp, i) => e.hpPercent(3000 + i * 1000, hp));
    assert.equal(e.status(6000).state, 'combat');
    e.hpPercent(7000, null); // 倒して HP も読めなくなった
    assert.equal(e.status(8900).state, 'combat');
    assert.equal(e.status(9100).state, 'ended');
});

test('画面が暗くなったら、最後のフェーズでなくても HP 3% 以下と敵対リストの消失で討伐にする', () => {
    const tl = { phases: [{ id: 'a', entries: [], next: [{ to: 'b', when: { cast: 'x' } }] }, { id: 'b', entries: [], next: [] }] };
    const e = new TimelineEngine(tl, { hasEnmity: true });
    e.started(0);
    e.enmity(500, true); e.enmity(1500, true);
    e.hpPercent(2000, 0.3);
    e.dim(2500, true); // 討伐の瞬間に暗くなる
    e.hpPercent(2500, null);
    e.enmity(2500, false);
    assert.equal(e.status(2500).state, 'ended');
    // 暗くならなければ、最後のフェーズでないので終わらない（区間の切れ目・フェーズの移り変わり）
    const f = new TimelineEngine(tl, { hasEnmity: true });
    f.started(0);
    f.enmity(500, true); f.enmity(1500, true);
    f.hpPercent(2000, 0.3);
    f.enmity(2500, false);
    assert.equal(f.status(8000).state, 'combat');
    // 暗くなっても HP が高ければ終わらない（エリア転換）
    const g = new TimelineEngine(tl, { hasEnmity: true });
    g.started(0);
    g.enmity(500, true); g.enmity(1500, true);
    g.hpPercent(2000, 40);
    g.dim(2500, true);
    g.enmity(2500, false);
    assert.equal(g.status(3000).state, 'combat');
});
