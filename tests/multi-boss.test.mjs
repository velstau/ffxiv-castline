// ボスが何体もいるタイムライン（phase の start。ダンジョン・アライアンス）で、戦闘のたびに最初に読めた技からボスを決めるか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineEngine, validateTimeline } from '../public/js/timeline-engine.js';
import { draftTimeline, draftBossTimeline, looksLikeBoss, addFight } from '../public/js/cast-recorder.js';

const dungeon = {
    format: 'castline/1',
    content: 'テストのダンジョン',
    phases: [
        { id: 'b1', name: '1 ボス', start: true, entries: [{ t: 8, name: '一の通常技', duration: 3 }, { t: 20, name: '一の大技', duration: 5 }] },
        { id: 'b2', name: '2 ボス', start: true, entries: [{ t: 6, name: '二の通常技', duration: 3 }, { t: 30, name: '二の大技', duration: 5 }], next: [{ to: 'b2-2', when: { hp: 50 } }] },
        { id: 'b2-2', name: '2 ボス後半', entries: [{ t: 5, name: '二の後半', duration: 4 }] },
    ],
};

const engine = (timeline = dungeon) => {
    const log = [];
    const e = new TimelineEngine(timeline, { hasEnmity: true, log: (at, m) => log.push(m) });
    e.logs = log;
    return e;
};
const enmity = (e, from, to, shown) => {
    for (let at = from; at <= to; at += 500) {
        e.enmity(at, shown);
    }
};
// 敵対リストが出て戦闘が始まる（start は from）
const pull = (e, from) => {
    enmity(e, from - 3000, from - 500, false);
    enmity(e, from, from + 1500, true);
    assert.equal(e.status(from + 1500).state, 'combat');
};

test('start が 2 つ以上: 戦闘が始まってもボスは決めず、何も出さない', () => {
    const e = engine();
    pull(e, 10000);
    const s = e.status(12000);
    assert.equal(s.phase, null);
    assert.deepEqual(e.upcoming(12000), []);
    // 照合の候補は、すべてのボスの技
    assert.deepEqual(e.castCandidates(12000).sort(), ['一の大技', '一の通常技', '二の大技', '二の通常技'].sort());
});

test('最初に読めた技でボスを決め、その予定に合わせる', () => {
    const e = engine();
    pull(e, 10000);
    e.cast(10000 + 7000, '二の通常技'); // 二の技は 6 秒の予定。1 秒遅れて読めた
    const s = e.status(17000);
    assert.equal(s.phase.id, 'b2');
    assert.ok(Math.abs(s.phaseTime - 6) < 0.01, `phaseTime ${s.phaseTime}`);
    assert.equal(e.upcoming(17000)[0].entry.name, '二の通常技');
    // ボスが決まった後は普段どおり（HP で後半へ）
    e.hpPercent(40000, 45);
    assert.equal(e.status(40000).phase.id, 'b2-2');
});

test('最初の技を読み逃しても、後の技（同期の窓の外）でボスを決める', () => {
    const e = engine();
    pull(e, 10000);
    // 戦闘開始が遅れて判定され、一の大技（20 秒）を 45 秒で読んだ
    e.cast(10000 + 45000, '一の大技');
    const s = e.status(55000);
    assert.equal(s.phase.id, 'b1');
    assert.ok(Math.abs(s.phaseTime - 20) < 0.01);
    assert.ok(e.logs.some((m) => m.includes('同期の窓の外')));
});

test('道中から続いた戦闘: 敵対リストが消えてまた出たら、そこから数え直してボスの開幕の予定に合わせる', () => {
    const t = { ...dungeon, phases: [dungeon.phases[0], { ...dungeon.phases[1], entries: [{ t: 10, name: '二の全体攻撃', duration: 3 }, { t: 130, name: '二の全体攻撃', duration: 3 }] }, dungeon.phases[2]] };
    const e = engine(t);
    pull(e, 10000); // 道中
    enmity(e, 60000, 70000, false); // 雑魚を倒して移動（討伐にはならない）
    enmity(e, 70500, 72000, true); // ボスのプル
    e.cast(70500 + 11000, '二の全体攻撃');
    const s = e.status(81500);
    assert.equal(s.phase.id, 'b2');
    assert.ok(Math.abs(s.phaseTime - 10) < 0.01, `phaseTime ${s.phaseTime}`);
});

test('数え直しが無くても、同期の窓の外ではいちばん早い予定に合わせる', () => {
    const t = { ...dungeon, phases: [dungeon.phases[0], { ...dungeon.phases[1], entries: [{ t: 10, name: '二の全体攻撃', duration: 3 }, { t: 130, name: '二の全体攻撃', duration: 3 }] }, dungeon.phases[2]] };
    const e = engine(t);
    pull(e, 10000);
    e.cast(10000 + 100000, '二の全体攻撃'); // 道中の始まりから 100 秒（t=130 の窓の外、t=10 の窓の外）
    assert.ok(Math.abs(e.status(110000).phaseTime - 10) < 0.01);
});

test('短い技名（4 文字未満）ではボスを決めない', () => {
    const t = { ...dungeon, phases: [{ ...dungeon.phases[0], entries: [{ t: 8, name: 'ファイア', duration: 3 }, { t: 9, name: '突進', duration: 2 }] }, dungeon.phases[1]] };
    const e = engine(t);
    pull(e, 10000);
    e.cast(19000, '突進');
    assert.equal(e.status(19000).phase, null);
    e.cast(19500, 'ファイア');
    assert.equal(e.status(19500).phase.id, 'b1');
});

test('どのボスの技でもなければ決めない（道中の雑魚）。討伐でも終えず、敵対リストが消えたままで終える', () => {
    const e = engine();
    pull(e, 10000);
    e.cast(15000, '雑魚の技');
    assert.equal(e.status(15000).phase, null);
    e.hpPercent(20000, 2);
    enmity(e, 20500, 20500 + 10000, false);
    assert.equal(e.status(30500).state, 'combat', 'ボスが決まっていないので HP では討伐にしない');
    // 次の戦闘（2 ボス）で、また決め直す
    const e2 = engine();
    pull(e2, 10000);
    e2.cast(16000, '二の通常技');
    assert.equal(e2.status(16000).phase.id, 'b2');
});

test('次の戦闘ではボスを決め直す', () => {
    const e = engine();
    pull(e, 10000);
    e.cast(18000, '一の通常技');
    assert.equal(e.status(18000).phase.id, 'b1');
    e.blackout(60000, true);
    e.blackout(63000, true);
    assert.equal(e.status(63000).state, 'ended');
    e.blackout(64000, false);
    pull(e, 100000);
    assert.equal(e.status(102000).phase, null);
    e.cast(106500, '二の通常技');
    assert.equal(e.status(106500).phase.id, 'b2');
});

test('start が 1 つか無ければ、今までどおり phases[0] から始める', () => {
    for (const start of [undefined, true]) {
        const e = engine({ ...dungeon, phases: dungeon.phases.map((p, i) => ({ ...p, start: i === 0 ? start : undefined })) });
        pull(e, 10000);
        assert.equal(e.status(12000).phase.id, 'b1');
        assert.equal(e.upcoming(12000)[0].entry.name, '一の通常技');
    }
});

test('start は true か false', () => {
    assert.deepEqual(validateTimeline(dungeon), []);
    const bad = { ...dungeon, phases: [{ ...dungeon.phases[0], start: 'yes' }] };
    assert.equal(validateTimeline(bad).length, 1);
});

const casts = (...pairs) => pairs.map(([start, name]) => ({ start, duration: 3, name }));

test('記録の下書き: 戦闘が 1 つなら今までと同じ、2 つ以上ならボスごとの start のフェーズ', () => {
    const one = casts([5, '一の通常技'], [20, '一の大技']);
    assert.deepEqual(draftBossTimeline([{ casts: one, zero: 0 }], { content: 'X' }), draftTimeline(one, { content: 'X', zero: 0 }));
    const t = draftBossTimeline([{ casts: one, zero: 0 }, { casts: casts([8, '二の通常技']), zero: 2 }], { content: 'X' });
    assert.deepEqual(validateTimeline(t), []);
    assert.deepEqual(t.phases.map((p) => [p.id, p.name, p.start]), [['b1', '1 体目', true], ['b2', '2 体目', true]]);
    assert.deepEqual(t.phases[1].entries, [{ t: 6, name: '二の通常技', duration: 3 }]);
    // そのまま再生に使える
    const e = new TimelineEngine(t, { hasEnmity: true });
    pull(e, 10000);
    e.cast(16000, '二の通常技');
    assert.equal(e.status(16000).phase.id, 'b2');
});

test('道中とみなすのは、詠唱が 5 回未満か 60 秒未満の戦闘', () => {
    const five = casts([1, 'a'], [2, 'b'], [3, 'c'], [4, 'd'], [5, 'e']);
    assert.equal(looksLikeBoss(five, 60), true);
    assert.equal(looksLikeBoss(five.slice(1), 120), false);
    assert.equal(looksLikeBoss(five, 59), false);
});

const fight = (names, seconds, content = 'X') => ({ casts: names.map((name, i) => ({ start: i * 10, duration: 3, name })), seconds, content });
const boss1 = ['一の通常技', '一の大技', '一の全体攻撃', '一の範囲攻撃', '一の連続技'];
const boss2 = ['二の通常技', '二の大技', '二の全体攻撃', '二の範囲攻撃', '二の連続技'];

test('戦闘の一覧: 道中は外し、別のボスは両方入れる（ダンジョン）', () => {
    const fights = [];
    addFight(fights, fight(['雑魚の技'], 40));
    assert.equal(fights[0].keep, true, 'ほかに無いので入れる');
    addFight(fights, fight(boss1, 150));
    assert.deepEqual(fights.map((f) => f.keep), [false, true], 'ボスが来たら、ほかに無いので入れていた道中は外す');
    addFight(fights, fight(['雑魚の技', '雑魚の魔法'], 50));
    addFight(fights, fight(boss2, 200));
    assert.deepEqual(fights.map((f) => f.keep), [false, true, false, true]);
});

test('戦闘の一覧: 同じボスのやり直し（零式の全滅）は最新だけ', () => {
    const fights = [];
    addFight(fights, fight(boss1, 300));
    addFight(fights, fight([...boss1, '一の後半の技'], 420));
    assert.deepEqual(fights.map((f) => f.keep), [false, true]);
    // 短い全滅は、前の長い挑戦を残す
    addFight(fights, fight(boss1.slice(0, 2), 30));
    assert.deepEqual(fights.map((f) => f.keep), [false, true, false]);
});

test('戦闘の一覧: 1 回だけの短い戦闘でも結果に入れる・別のコンテンツに入ったら前は外す', () => {
    const fights = [];
    addFight(fights, fight(['技名その一', '技名その二'], 40, 'A'));
    assert.equal(fights[0].keep, true);
    addFight(fights, fight(boss2, 200, 'B'));
    assert.deepEqual(fights.map((f) => f.keep), [false, true]);
    addFight(fights, fight(['別の雑魚'], 20, 'C'));
    assert.deepEqual(fights.map((f) => f.keep), [false, false, true], '別のコンテンツの戦闘は外し、ほかに無いので入れる');
});

test('start が 1 つで先頭でないとき、戦闘前の予告もそのフェーズから', () => {
    const t = { ...dungeon, phases: [{ ...dungeon.phases[0], start: undefined }, dungeon.phases[1], dungeon.phases[2]] };
    const e = engine(t);
    assert.equal(e.upcoming(1000)[0].entry.name, '二の通常技');
    pull(e, 10000);
    assert.equal(e.status(12000).phase.id, 'b2');
});

test('戦闘の一覧: 汎用の技名 1 つだけの重なりでは同じボスにしない', () => {
    const fights = [];
    addFight(fights, fight([...boss1, 'ファイア'], 150));
    addFight(fights, fight([...boss2, 'ファイア'], 150));
    assert.deepEqual(fights.map((f) => f.keep), [true, true]);
});
