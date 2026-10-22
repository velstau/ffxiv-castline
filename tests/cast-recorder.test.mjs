// 詠唱の記録（cast-recorder.js）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    normalizeRead, tailDistance, snapRead, isPresent, decideName, CastTracker, mergeSplitCasts, matchTimeline, summarizeDurations, applyDurations, draftTimeline,
} from '../public/js/cast-recorder.js';

test('normalizeRead: 先頭の「ー」と空白を落とし、! ? を全角にする', () => {
    assert.equal(normalizeRead(' ーーランドスケープ'), 'ランドスケープ');
    assert.equal(normalizeRead('レッツダンス!'), 'レッツダンス！');
    assert.equal(normalizeRead('一刀両断'), '一刀両断'); // 漢字の「一」は落とさない
});

test('decideName: 多数決のあと、近い候補に寄せる', () => {
    const reads = ['ランドスケーブ', 'ランドスケープ', 'ランドスケーブ'].map((text) => ({ text, conf: 0.9 }));
    assert.deepEqual(decideName(reads, ['ランドスケープ', 'アレンジ']),
        { name: 'ランドスケープ', read: 'ランドスケーブ', snapped: true, votes: 2, miss: 0.14 });
    // 候補から遠ければ読んだまま
    const other = decideName([{ text: 'ホーリーライト', conf: 0.9 }], ['ランドスケープ']);
    assert.equal(other.snapped, false);
    assert.equal(other.name, 'ホーリーライト');
    // 同じ票数なら確信度の高い読み
    assert.equal(decideName([{ text: 'アレッジ', conf: 0.7 }, { text: 'アレンジ', conf: 0.9 }]).read, 'アレンジ');
});

test('CastTracker: 見えていた区間を 1 回の詠唱にし、1 コマの読み逃しはつなぐ。時刻は前後のコマの中点', () => {
    const tracker = new CastTracker();
    const seen = { text: 'アレンジ', conf: 0.9 };
    const casts = [];
    for (let i = 0; i <= 60; i++) {
        // 1.0〜2.9 秒に見え、2.0 秒の 1 コマだけ読み逃す。4.0〜4.1 秒の 2 コマは短すぎるので詠唱にしない
        const on = (i >= 10 && i < 30 && i !== 20) || i === 40 || i === 41;
        casts.push(...tracker.push(i / 10, on ? seen : { text: '', conf: 0 }));
    }
    casts.push(...tracker.finish(6.0));
    assert.equal(casts.length, 1);
    assert.ok(Math.abs(casts[0].start - 0.95) < 1e-9, String(casts[0].start));
    assert.ok(Math.abs(casts[0].end - 2.95) < 1e-9, String(casts[0].end));
    assert.ok(Math.abs(casts[0].duration - 2.0) < 1e-9);
    assert.equal(casts[0].reads.length, 19);
});

test('CastTracker: 区間の技名と違う文字が続いたら、そこで閉じて別の区間にする', () => {
    const tracker = new CastTracker();
    const casts = [];
    for (let i = 0; i <= 40; i++) {
        // 1.0〜1.9 秒は技名、2.0〜2.9 秒はすぐ次に出た別の技名（消えずに続く）
        const read = i >= 10 && i < 20 ? { text: 'ベノムスコール', conf: 0.9 }
            : i >= 20 && i < 30 ? { text: 'ルビーの光', conf: 0.8 } : { text: '', conf: 0 };
        casts.push(...tracker.push(i / 10, read));
    }
    assert.deepEqual(casts.map((c) => [c.reads[0].text, Math.round(c.start * 100) / 100, Math.round(c.end * 100) / 100]),
        [['ベノムスコール', 0.95, 1.95], ['ルビーの光', 1.95, 2.95]]);
});

test('isPresent: かな・漢字が 2 文字以上で確信度が足りる読みだけ', () => {
    assert.equal(isPresent({ text: 'アレンジ', conf: 0.5 }), true);
    assert.equal(isPresent({ text: 'MpHei Lotus', conf: 0.9 }), false); // 英字だけ（プレイヤー名など）
    assert.equal(isPresent({ text: 'Lv100', conf: 0.9 }), false);
    assert.equal(isPresent({ text: '4ビート', conf: 0.9 }), true);
    assert.equal(isPresent({ text: 'ーー', conf: 0.9 }), false);
    assert.equal(isPresent({ text: 'アレンジ', conf: 0.3 }), false);
});

test('tailDistance・snapRead: 先頭 5 文字までの余計な文字は数えない', () => {
    assert.equal(tailDistance('レラダブル・グラフィティ', 'ダブル・グラフィティ'), 0);
    assert.equal(tailDistance('CUラムースシャワー', 'ムースシャワー'), 0);
    assert.equal(tailDistance('ムースシャワー', 'ムースシャワー'), 0);
    assert.equal(tailDistance('ダブル・グラフィティイ', 'ダブル・グラフィティ'), 1); // 末尾の余計な文字は数える
    assert.equal(tailDistance('あいうえおかきくけこアレンジ', 'アレンジ'), 5); // 6 文字目からは数える
    const names = ['グラフィティ', 'ダブル・グラフィティ', 'ムースシャワー'];
    assert.equal(snapRead('しラダブル・グラフィティ', names, 0.25), 'ダブル・グラフィティ'); // 同じ近さなら長い候補
    assert.equal(snapRead('Uラーカラークラッシュ', names, 0.25), 'Uラーカラークラッシュ'); // 候補に無ければ読んだまま
});

test('mergeSplitCasts: 同じ技名で間が短い前後の詠唱をつなぐ', () => {
    const c = (start, end, name) => ({ start, end, duration: end - start, name, reads: [{ text: name }] });
    const merged = mergeSplitCasts([c(10, 10.7, 'アレンジ'), c(11.2, 16.7, 'アレンジ'), c(20, 26, 'アレンジ'), c(26.3, 27, 'ランドスケープ')]);
    assert.deepEqual(merged.map((m) => [m.start, m.end, m.name]), [[10, 16.7, 'アレンジ'], [20, 26, 'アレンジ'], [26.3, 27, 'ランドスケープ']]);
    assert.ok(Math.abs(merged[0].duration - 6.7) < 1e-9);
});

test('CastTracker: 確信度の低い読み・1 文字の読みは「見えていない」', () => {
    const tracker = new CastTracker();
    for (let i = 0; i < 10; i++) {
        tracker.push(i / 10, i % 2 ? { text: 'ア', conf: 0.9 } : { text: 'アレンジ', conf: 0.3 });
    }
    assert.deepEqual(tracker.finish(1), []);
});

const timeline = {
    phases: [
        { id: 'p1', entries: [
            { t: 10, name: 'カラーライオット', duration: 4.7 },
            { t: 20, name: 'ウイングマーク', duration: 3.7 },
            { t: 25, name: '詠唱なし', duration: 0 },
            { t: 30, name: 'カラーライオット', duration: 4.7 },
            { t: 40, name: 'アレンジ|ランドスケープ', duration: 0.7 },
        ] },
        { id: 'p2', entries: [
            { t: 5, name: 'ムース大行進', duration: 3.7 },
            { t: 15, name: 'プリンパーティー', duration: 3.7 },
        ] },
    ],
};

test('matchTimeline: フェーズの開始を合わせ、予定ごとに合わせ直して対応させる', () => {
    const casts = [
        { start: 112.0, duration: 6.7, name: 'カラーライオット' }, // p1 の 0 秒＝102 秒
        { start: 50.0, duration: 2.0, name: 'カラーライオット' }, // 前の戦闘（フェーズの開始より前）
        { start: 122.3, duration: 4.6, name: 'ウイングマーク' }, // 0.3 秒遅れ
        { start: 132.5, duration: 6.6, name: 'カラーライオット' }, // 合わせ直した後の予想（132.3）から 0.2 秒
        { start: 142.4, duration: 7.7, name: 'ランドスケープ' },
        { start: 200.0, duration: 4.7, name: 'ムース大行進' }, // p2 の 0 秒＝195 秒
        { start: 210.1, duration: 4.7, name: 'プリンパーティー' },
        { start: 215.0, duration: 3.0, name: 'ほかの敵の技' },
    ].sort((a, b) => a.start - b.start);
    const result = matchTimeline(timeline, casts);
    assert.deepEqual(result.phases.map((p) => [p.id, p.offset, p.hits, p.total]), [['p1', 102, 4, 4], ['p2', 195, 2, 2]]);
    assert.deepEqual(result.rows.map((r) => [r.name, r.gap]), [
        ['カラーライオット', 0], ['ウイングマーク', 0.3], ['カラーライオット', 0.2], ['アレンジ|ランドスケープ', -0.1],
        ['ムース大行進', 0], ['プリンパーティー', 0.1],
    ]);
    assert.deepEqual(result.unused.map((c) => c.name), ['カラーライオット', 'ほかの敵の技']);
});

test('matchTimeline: そろう予定が少ないフェーズは見つからないとする', () => {
    const result = matchTimeline(timeline, [{ start: 112, duration: 6.7, name: 'カラーライオット' }]);
    assert.equal(result.phases[0].offset, null);
    assert.equal(result.rows.length, 0);
});

test('summarizeDurations: 技ごとに最も多くそろった記録の中央値で比べる', () => {
    const rows = [
        ...[6.68, 6.72, 6.7, 3.1].map((d) => ({ name: 'カラーライオット', duration: 4.7, cast: { duration: d } })),
        { name: 'ウイングマーク', duration: 3.7, cast: { duration: 4.62 } },
        { name: 'ムース大行進', duration: 3.7, cast: { duration: 3.75 } },
        { name: 'プリンパーティー', duration: 3.7, cast: null },
        ...[5.2, 5.59, 6.52, 6.74].map((d) => ({ name: 'アレンジ', duration: 6.7, cast: { duration: d } })),
    ];
    assert.deepEqual(summarizeDurations(rows).map((s) => [s.name, s.measured, s.agree, s.status]), [
        ['アレンジ', 6.7, 1, 'scattered'], // 4 回のうち XML に近い 1 回だけでは「合う」にしない
        ['ウイングマーク', 4.6, 1, 'unsure'],
        ['カラーライオット', 6.7, 3, 'longer'],
        ['ムース大行進', 3.8, 1, 'same'],
    ]);
});

test('applyDurations: 技名と元の詠唱時間が同じ予定だけを直す', () => {
    const fixed = applyDurations(timeline, [{ name: 'カラーライオット', duration: 4.7, measured: 6.7 }]);
    assert.deepEqual(fixed.phases[0].entries.map((e) => e.duration), [6.7, 3.7, 0, 6.7, 0.7]);
    assert.equal(timeline.phases[0].entries[0].duration, 4.7); // 元は変えない
});

test('draftTimeline: 最初の詠唱（か指定の時刻）を 0 秒にした 1 フェーズの下書き', () => {
    const draft = draftTimeline([
        { start: 12.34, duration: 4.66, name: 'カラーライオット' },
        { start: 20.0, duration: 2.04, name: 'アレンジ' },
    ], { content: 'テスト', zero: 10 });
    assert.deepEqual(draft.phases[0].entries, [
        { t: 2.3, name: 'カラーライオット', duration: 4.7 },
        { t: 10, name: 'アレンジ', duration: 2 },
    ]);
    assert.equal(draft.format, 'castline/1');
});

test('クルーザー級2 の動画で測った詠唱から、表（tools/cast-durations.tsv）と同じ直しが出る', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/m2-casts.json', import.meta.url), 'utf8'));
    const result = matchTimeline(fixture.timeline, fixture.casts);
    assert.ok(result.phases.every((p) => p.offset !== null), JSON.stringify(result.phases));
    const changes = summarizeDurations(result.rows).filter((s) => s.status === 'longer')
        .map((s) => `${s.name} ${s.duration.toFixed(1)}→${s.measured.toFixed(1)}`).sort();
    const tsv = readFileSync(new URL('../tools/cast-durations.tsv', import.meta.url), 'utf8').split('\n')
        .map((line) => line.split('\t')).filter((c) => c[0] === 'aac-cruiserweight-m2-savage')
        .map((c) => `${c[1]} ${c[2]}→${c[3]}`).sort();
    // 表の 11 行のうち、この動画 1 本で 2 回以上そろうもの（1 回だけの行は unsure になる）
    const unsure = summarizeDurations(result.rows).filter((s) => s.status === 'unsure')
        .map((s) => `${s.name} ${s.duration.toFixed(1)}→${s.measured.toFixed(1)}`);
    assert.deepEqual([...changes, ...unsure].sort(), tsv);
});
