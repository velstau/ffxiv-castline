// 再生画面の「次にすること」のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guideSteps } from '../public/js/player-guide.js';

const base = {
    savedScreens: [], frame: null, autoRegions: true, choice: 'auto', timelineLabel: '', detectedContent: null, timelineError: '',
    tts: true, ttsTested: null, ocr: 'loading', ocrProgress: 0.25, running: false, pipSupported: true, pipOpen: false, engineState: null,
};
const kinds = (r) => Object.fromEntries(r.steps.map((s) => [s.id, s.kind]));
const step = (r, id) => r.steps.find((s) => s.id === id);

test('はじめて: 範囲を決める手順が「いま」。タイムラインは自動で済み、読み上げは飛ばせる', () => {
    const r = guideSteps(base);
    assert.equal(r.current, 'setup');
    assert.deepEqual(kinds(r), { setup: 'todo', timeline: 'done', tts: 'todo', capture: 'todo', pip: 'todo', play: 'todo' });
    assert.ok(step(r, 'tts').optional && !step(r, 'pip').optional);
    assert.match(step(r, 'capture').text, /25%/);
});

test('範囲が保存してあれば取り込みが「いま」。読み上げを試していなくても先へ進む', () => {
    const r = guideSteps({ ...base, savedScreens: ['1920×1080'], ocr: 'ready' });
    assert.equal(r.current, 'capture');
    assert.match(step(r, 'setup').text, /1920×1080/);
    assert.equal(guideSteps({ ...base, savedScreens: ['1920×1080'], ttsTested: 'ok' }).steps.find((s) => s.id === 'tts').kind, 'done');
    assert.equal(step(guideSteps({ ...base, ttsTested: 'ng' }), 'tts').kind, 'ng');
});

test('取り込み中: 画面の大きさで範囲を見る。戦闘の開始の範囲が無く自動で探さないなら問題あり', () => {
    const running = { ...base, savedScreens: [], running: true, ocr: 'ready', engineState: 'idle', timelineLabel: 'M1' };
    const missingStart = { key: '2560×1440', missing: [{ id: 'start', label: '戦闘の開始' }] };
    assert.equal(guideSteps({ ...running, frame: missingStart }).current, 'setup');
    assert.equal(step(guideSteps({ ...running, frame: missingStart, autoRegions: false }), 'setup').kind, 'ng');
    const ok = guideSteps({ ...running, frame: { key: '2560×1440', missing: [{ id: 'hp', label: 'HP' }] } });
    assert.equal(ok.current, 'pip');
    assert.equal(guideSteps({ ...running, frame: { key: 'x', missing: [] }, pipOpen: true }).current, 'play');
    // 小窓が使えないブラウザでは飛ばす
    const noPip = guideSteps({ ...running, frame: { key: 'x', missing: [] }, pipSupported: false });
    assert.equal(noPip.current, 'play');
    assert.equal(step(noPip, 'pip').kind, 'ng');
    assert.equal(step(ok, 'setup').kind, 'done');
});

test('タイムライン: 読み取ったコンテンツのタイムラインが無ければ問題あり、戦闘中は全部済む', () => {
    const running = { ...base, savedScreens: [], frame: { key: 'x', missing: [] }, running: true, ocr: 'ready' };
    const none = guideSteps({ ...running, detectedContent: '零式A' });
    assert.equal(none.current, 'timeline');
    assert.equal(step(none, 'timeline').kind, 'ng');
    const combat = guideSteps({ ...running, timelineLabel: 'M1', engineState: 'combat', pipOpen: true, ttsTested: 'ok' });
    assert.equal(combat.current, null);
    assert.ok(combat.steps.every((s) => s.kind === 'done'));
});
