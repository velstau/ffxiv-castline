// FFLogs の詠唱からタイムラインを組み立てる処理のテスト。データはヘビー級1 の実ログ（2026-10-20）の形をまねた合成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, summarizeEnemies } from '../public/js/fflogs-timeline.js';
import { toTimelineXml } from '../public/js/timeline-xml.js';
import { validateTimeline } from '../public/js/timeline-engine.js';

const S = 100000; // 戦闘開始の timestamp
const actors = [{ id: 11, name: 'ヴァンプ・ファタール' }, { id: 19, name: 'トーチャー・ファタール' }];
const abilities = [
    { gameID: 0xB384, name: 'キラーボイス' },
    { gameID: 0xB35A, name: 'ハードコア' },
    { gameID: 0xB37F, name: 'ハードコア' },
    { gameID: 0xB3A0, name: 'サングインスクラッチ' },
    { gameID: 0xB705, name: '前進' },
    { gameID: 7, name: '攻撃' },
    { gameID: 0xB999, name: 'unknown_b999' },
    { gameID: 0xB400, name: '移行の技' },
];
const begin = (s, id, dur, src = 11, inst) => ({ type: 'begincast', timestamp: S + s * 1000, sourceID: src, abilityGameID: id, duration: dur * 1000, ...(inst ? { sourceInstance: inst } : {}) });
const cast = (s, id, src = 11, inst) => ({ type: 'cast', timestamp: S + s * 1000, sourceID: src, abilityGameID: id, ...(inst ? { sourceInstance: inst } : {}) });

const events = [
    begin(6.1, 0xB384, 4.7), cast(10.8, 0xB384),
    // ハードコア: 本体 2.7 秒、見えない補助 2 体（sourceInstance あり）4.7 秒
    begin(16.2, 0xB35A, 2.7), begin(16.2, 0xB37F, 4.7, 11, 1), begin(16.2, 0xB37F, 4.7, 11, 2), cast(18.9, 0xB35A), cast(20.9, 0xB37F, 11, 1),
    cast(20.0, 7), // オートアタック
    cast(21.0, 0xB999), // 名前の無い技
    cast(25.0, 0xB3A0), cast(25.5, 0xB3A0), // 詠唱なし、1 秒以内に 2 回 → 1 つ
    begin(30.0, 0xB705, 4.2, 19), cast(34.2, 0xB705, 19),
];
const fight = { id: 2, name: 'ヴァンプ・ファタール', startTime: S, endTime: S + 60000, kill: true };

test('敵ごとの数: 本体の詠唱と詠唱なしを数え、補助・オートアタック・名前の無い技は数えない', () => {
    assert.deepEqual(summarizeEnemies({ actors, abilities, events }), [
        { id: 11, name: 'ヴァンプ・ファタール', casts: 2, instants: 2 },
        { id: 19, name: 'トーチャー・ファタール', casts: 1, instants: 0 },
    ]);
});

test('本体の詠唱だけを予定にし、詠唱なしは表示だけ、1 秒以内の重複はまとめる', () => {
    const tl = buildTimeline({ fight, actors, abilities, events, sourceIDs: new Set([11]), content: 'c', title: 't', note: 'n' });
    assert.deepEqual(validateTimeline(tl), []);
    assert.deepEqual(tl.phases[0].entries, [
        { t: 6.1, duration: 4.7, name: 'キラーボイス' },
        { t: 16.2, duration: 2.7, name: 'ハードコア' },
        { t: 25, duration: 0, name: 'サングインスクラッチ', sync: false },
    ]);
    const without = buildTimeline({ fight, actors, abilities, events, sourceIDs: new Set([11, 19]), includeInstant: false, content: 'c', title: 't', note: 'n' });
    assert.deepEqual(without.phases[0].entries.map((e) => e.name), ['キラーボイス', 'ハードコア', '前進']);
});

test('フェーズ: 次のフェーズの最初の詠唱がいまのフェーズに無ければ詠唱で、あれば時間で移る', () => {
    const phased = {
        ...fight,
        endTime: S + 120000,
        phaseTransitions: [{ id: 1, startTime: S }, { id: 2, startTime: S + 40000 }, { id: 3, startTime: S + 80000 }],
    };
    const more = [...events, begin(43.0, 0xB400, 3), begin(85.0, 0xB384, 4.7)];
    const tl = buildTimeline({ fight: phased, actors, abilities, events: more, sourceIDs: new Set([11]), phaseNames: [{ id: 2, name: '中盤' }],
        content: 'c', title: 't', note: 'n' });
    assert.deepEqual(validateTimeline(tl), []);
    assert.deepEqual(tl.phases.map((p) => [p.id, p.name, p.entries.map((e) => [e.t, e.name])]), [
        ['p1', undefined, [[6.1, 'キラーボイス'], [16.2, 'ハードコア'], [25, 'サングインスクラッチ']]],
        ['p2', '中盤', [[3, '移行の技']]],
        ['p3', undefined, [[5, 'キラーボイス']]],
    ]);
    assert.deepEqual(tl.phases[0].next, [{ to: 'p2', at: 3, when: { cast: '移行の技' } }]);
    // p3 の最初の「キラーボイス」は p1 にもあるが p2 には無いので、詠唱で移る
    assert.deepEqual(tl.phases[1].next, [{ to: 'p3', at: 5, when: { cast: 'キラーボイス' } }]);
});

test('XML: 記号を escape し、詠唱時間 0 と既定値は書かない', () => {
    const xml = toTimelineXml({
        format: 'castline/1', content: 'A&B', title: '"題"', note: '<注>',
        phases: [{ id: 'p1', entries: [{ t: 1, duration: 0, name: 'x', sync: false }, { t: 2, duration: 3, name: 'y', window: [5, 5] }],
            next: [{ to: 'p1', when: { hpLost: 3 } }] }],
    });
    assert.match(xml, /<timeline>\n  <format>castline\/1<\/format>\n  <content>A&amp;B<\/content>\n  <title>&quot;題&quot;<\/title>/);
    assert.match(xml, /<note>&lt;注&gt;<\/note>/);
    assert.match(xml, /<entry t="1" castname="x" sync="false"\/>/);
    assert.match(xml, /<entry t="2" duration="3" castname="y" window="5 5"\/>/);
    assert.match(xml, /<next to="p1" hp-lost="3"\/>/);
});

test('既定の敵: 戦闘名と同じ名前の敵。無ければ詠唱の多い敵とその 3 割以上の敵', async () => {
    const { defaultEnemyIds } = await import('../public/js/fflogs-timeline.js');
    const enemies = [{ id: 1, name: 'レッドホット', casts: 41 }, { id: 2, name: 'ディープブルー', casts: 41 }, { id: 3, name: '水牢', casts: 6 }];
    assert.deepEqual([...defaultEnemyIds(enemies, 'Red Hot and Deep Blue')], [1, 2]);
    assert.deepEqual([...defaultEnemyIds(enemies, '水牢')], [3]);
    assert.deepEqual([...defaultEnemyIds([], 'x')], []);
});

test('前後半をまとめる: 最初の詠唱で判定し、エンジンはその詠唱でそのパートへ移る', async () => {
    const { mergeParts } = await import('../public/js/fflogs-timeline.js');
    const { TimelineEngine } = await import('../public/js/timeline-engine.js');
    const part = (names) => ({ format: 'castline/1', content: 'c', phases: [{ id: 'p1', entries: names.map(([t, name]) => ({ t, duration: 3, name })) }] });
    const first = part([[10.9, 'フィクサー・オブ・アルカディア'], [29.3, 'リーサルスカージ']]);
    const second = part([[11.0, 'アルカディアン・フレイム'], [25.4, 'レプリケーション'], [40.7, 'スネークキック']]);
    const { timeline, error } = mergeParts([{ label: '前半', timeline: first }, { label: '後半', timeline: second }], { content: 'c', title: 't', note: 'n' });
    assert.equal(error, null);
    assert.deepEqual(validateTimeline(timeline), []);
    assert.deepEqual(timeline.phases.map((p) => [p.id, p.name]), [['start', '開始待ち'], ['a-p1', '前半'], ['b-p1', '後半']]);
    assert.deepEqual(timeline.phases[0].next.map((r) => [r.to, r.at, r.when.cast]), [
        ['a-p1', 10.9, 'フィクサー・オブ・アルカディア'], ['a-p1', 29.3, 'リーサルスカージ'],
        ['b-p1', 11, 'アルカディアン・フレイム'], ['b-p1', 25.4, 'レプリケーション'],
    ]);
    const e = new TimelineEngine(timeline);
    e.started(1000);
    assert.ok(e.castCandidates(1000).includes('アルカディアン・フレイム'));
    e.cast(1000 + 11500, 'アルカディアン・フレイム');
    const s = e.status(1000 + 11500);
    assert.equal(s.phase.id, 'b-p1');
    assert.equal(s.phaseTime, 11);
    // 最初の詠唱が同じパートどうしは判定できない
    assert.match(mergeParts([{ label: 'A', timeline: first }, { label: 'B', timeline: first }], { content: 'c' }).error, /判定できません/);
});
