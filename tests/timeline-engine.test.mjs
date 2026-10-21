// タイムラインエンジンのテスト。実行: node --test tests/
// 時刻は 2026-10-20 の連続読み取りの実測ログ（煉獄編4 零式、カウントダウン 16 秒）をもとにしている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineEngine, validateTimeline, castNames, ENMITY_OFF_END_MS, ENEMY_GONE_END_MS, BLACKOUT_END_MS } from '../public/js/timeline-engine.js';

// 19:08:00.0 を 0 とした ms
const T = (s) => Date.UTC(2026, 9, 20, 10, 8, 0) + Math.round(s * 1000);
const sec = (ms) => (ms - T(0)) / 1000;

const timeline = {
    format: 'castline/1',
    content: '万魔殿パンデモニウム零式：煉獄編4',
    phases: [
        {
            id: 'p1',
            entries: [
                { t: 6.0, name: '創世の真炎', duration: 5 },
                { t: 15.0, name: 'オクタフレア・コンシーヴ', duration: 5 },
                { t: 21.0, name: '熾炎創火', duration: 4 },
                { t: 60.0, name: '創世の真炎', duration: 5 },
            ],
            next: [
                { to: 'p2', when: { cast: '移行技' }, at: 0 },
                { to: 'p2', when: { hp: 50 } },
                { to: 'p2', when: { time: 120 } },
            ],
        },
        {
            id: 'p2',
            entries: [{ t: 5.0, name: '後半の技', duration: 3 }],
            next: [{ to: 'p3', when: { hpLost: 3 } }],
        },
        { id: 'p3', entries: [] },
    ],
};

function engine(options = {}) {
    const log = [];
    const e = new TimelineEngine(timeline, { ...options, log: (at, m) => log.push(`${sec(at).toFixed(1)} ${m}`) });
    if (options.hasEnmity && !options.staleEnmity) {
        e.enmity(T(-60), false); // 戦闘前は敵対リストの範囲が空だった
    }
    return { e, log };
}

// 実測: 残り 16 秒 @10.1、10 秒 @16.1、5 秒 @21.2、「戦闘開始！」@26.2
function realCountdown(e) {
    e.countdown(T(10.1), 16);
    e.countdown(T(10.6), 16); // 吹き出しが出たまま（後の時刻は使わない）
    e.countdown(T(16.1), 10);
    e.countdown(T(21.2), 5);
}

test('サンプルのタイムラインは形式の確認を通る', () => {
    assert.deepEqual(validateTimeline(timeline), []);
});

test('形式の誤りを見つける', () => {
    const errors = validateTimeline({ format: 'x', content: '', phases: [{ id: 'a', entries: [{ t: 'x' }], next: [{ to: 'zz', when: { foo: 1 } }] }] });
    assert.equal(errors.length, 5, errors.join('\n'));
});

test('実測のカウントダウンから開始時刻を 26.1 秒と予想し、「戦闘開始！」で確定する', () => {
    const { e } = engine();
    realCountdown(e);
    assert.equal(sec(e.status(T(22)).predictedStart), 26.1);
    e.started(T(26.2));
    const s = e.status(T(26.2));
    assert.equal(s.state, 'combat');
    assert.equal(sec(e.startAt), 26.1);
});

test('「戦闘開始！」を読み逃しても、予想時刻になれば戦闘に入る（敵対リストを読んでいない場合）', () => {
    const { e } = engine();
    realCountdown(e);
    assert.equal(e.status(T(26.0)).state, 'countdown');
    assert.equal(e.status(T(26.3)).state, 'combat');
    assert.equal(sec(e.startAt), 26.1);
});

test('読み違えた秒数（外れ値）は予想に使わない', () => {
    const { e } = engine();
    realCountdown(e);
    e.countdown(T(18.0), 1); // 「10」を「1」と読んだ
    assert.equal(sec(e.status(T(22)).predictedStart), 26.1);
});

test('吹き出しの読み遅れ: 遅れた予想より、ほかと合う早い予想を採る（2026-10-20 の実測 2 回）', () => {
    // 1 回目: 10 秒と 5 秒の吹き出しが遅れて読めた。「戦闘開始！」は 16.2（19:42:50.3 を 0.3 とした秒）
    let { e } = engine();
    e.countdown(T(0.3), 16);
    e.countdown(T(9.5), 10);
    e.countdown(T(12.6), 5);
    assert.equal(sec(e.predictedStart()), 16.3);
    // 2 回目: 16 秒の吹き出しが遅れて読めた。「戦闘開始！」は 49.2
    ({ e } = engine());
    e.countdown(T(34.3), 16);
    e.countdown(T(38.9), 10);
    e.countdown(T(44.1), 5);
    assert.equal(sec(e.predictedStart()), 48.9);
});

test('詠唱で同期する: 創世の真炎を 6.6 秒目に読んだら、予定の 6.0 秒に合わせる', () => {
    const { e, log } = engine();
    realCountdown(e);
    e.started(T(26.2));
    e.cast(T(32.7), '創世の真炎');
    assert.equal(e.status(T(32.7)).phaseTime.toFixed(1), '6.0');
    assert.match(log.at(-1), /同期 創世の真炎/);
    // 同じ予定では 2 度合わせない（詠唱が見えている間、何度も渡されても動かない）
    e.cast(T(33.2), '創世の真炎');
    assert.equal(e.status(T(33.2)).phaseTime.toFixed(1), '6.5');
});

test('同期の窓の外の詠唱では合わせない（60 秒目の創世の真炎を 6 秒目に取り違えない）', () => {
    const { e } = engine();
    e.started(T(0));
    e.cast(T(40), '創世の真炎'); // 40 秒目: 6 秒目（窓は 16 秒まで）にも 60 秒目（窓は 50 秒から）にも入らない
    assert.equal(e.status(T(40)).phaseTime, 40);
    e.cast(T(55), '創世の真炎'); // 55 秒目: 60 秒目の窓に入る
    assert.equal(e.status(T(55)).phaseTime, 60);
});

test('詠唱の候補は、同期の窓に入っている技と移り方の技だけ', () => {
    const { e } = engine();
    e.started(T(0));
    // 12 秒目: 創世の真炎（6 秒、窓は 16 秒まで）・オクタフレア（15 秒）・熾炎創火（21 秒、窓は 11 秒から）
    assert.deepEqual(e.castCandidates(T(12)).sort(), ['オクタフレア・コンシーヴ', '創世の真炎', '熾炎創火', '移行技'].sort());
    assert.deepEqual(e.castCandidates(T(10)).sort(), ['オクタフレア・コンシーヴ', '創世の真炎', '移行技'].sort());
    assert.deepEqual(e.castCandidates(T(40)).sort(), ['移行技']);
});

test('フェーズの移り方: 詠唱・HP・時間・HP が読めない時間', () => {
    let { e } = engine();
    e.started(T(0));
    e.cast(T(30), '移行技');
    assert.equal(e.status(T(31)).phase.id, 'p2');
    assert.equal(e.status(T(31)).phaseTime, 1);

    ({ e } = engine());
    e.started(T(0));
    e.hpPercent(T(10), 60);
    assert.equal(e.status(T(10)).phase.id, 'p1');
    e.hpPercent(T(20), 49.9);
    assert.equal(e.status(T(20)).phase.id, 'p2');

    ({ e } = engine());
    e.started(T(0));
    const s = e.status(T(122));
    assert.equal(s.phase.id, 'p2');
    assert.equal(s.phaseTime, 2); // 120 秒ちょうどに移ったとして数える
    // p2 で HP を一度も読めないまま 3 秒たてば p3（時間で移った直後から数える）
    assert.equal(e.status(T(123.1)).phase.id, 'p3');

    // p2 は HP が 3 秒読めなければ p3 へ。p2 に入る前に読めなかった時間は数えない
    ({ e } = engine());
    e.started(T(0));
    e.hpPercent(T(1), 80);
    e.hpPercent(T(10), 40); // → p2（10 秒）
    e.hpPercent(T(11), null);
    assert.equal(e.status(T(12.5)).phase.id, 'p2');
    assert.equal(e.status(T(13.1)).phase.id, 'p3');
});

// 敵対リストを 0.5 秒ごとに読んだ結果を渡す
function enmityFrom(e, from, to, shown) {
    for (let s = from; s <= to + 1e-9; s += 0.5) {
        e.enmity(T(s), shown);
    }
}

test('敵対リスト: カウントダウンなしの開始、早すぎる開始、取り消し、戦闘終了', () => {
    let { e } = engine({ hasEnmity: true });
    enmityFrom(e, 5, 5.5, true);
    assert.equal(e.status(T(5.5)).state, 'idle'); // 出てから 1 秒たつまでは決めない
    e.enmity(T(6), true);
    assert.equal(e.status(T(6)).state, 'combat');
    assert.equal(sec(e.startAt), 5); // 出始めた時刻にさかのぼる

    ({ e } = engine({ hasEnmity: true }));
    realCountdown(e);
    enmityFrom(e, 22, 23, true); // 予想 26.1 より早く殴った
    assert.equal(sec(e.startAt), 22);

    ({ e } = engine({ hasEnmity: true }));
    realCountdown(e);
    assert.equal(e.status(T(27)).state, 'countdown'); // 予想を過ぎたが敵対リストがまだ
    assert.equal(e.status(T(31.2)).state, 'idle'); // 5 秒過ぎても出ないので取り消し

    ({ e } = engine({ hasEnmity: true }));
    realCountdown(e);
    enmityFrom(e, 26.5, 27.5, true);
    assert.equal(e.status(T(27.5)).state, 'combat');
    assert.equal(sec(e.startAt), 26.1);
    // 敵対リストが消えただけでは終わらない（フェーズの移り変わり）。長く消えたままなら終わる
    e.enmity(T(100), false);
    assert.equal(e.status(T(100 + ENMITY_OFF_END_MS / 1000 + 10)).state, 'combat');
    assert.equal(e.status(T(100 + ENEMY_GONE_END_MS / 1000)).state, 'ended');
});

// 画面の暗転を 0.5 秒ごとに読んだ結果を渡す
function blackFrom(e, from, to, black) {
    for (let s = from; s <= to + 1e-9; s += 0.5) {
        e.blackout(T(s), black);
    }
}

test('全滅: 画面全体の暗転が続いたら終わる。一瞬の暗転では終わらない', () => {
    const { e } = engine({ hasEnmity: true });
    enmityFrom(e, 0, 30, true);
    blackFrom(e, 30.5, 31.5, true);
    blackFrom(e, 32, 33, false);
    assert.equal(e.status(T(33)).state, 'combat');
    blackFrom(e, 40, 40 + BLACKOUT_END_MS / 1000, true);
    assert.equal(e.status(T(40 + BLACKOUT_END_MS / 1000)).state, 'ended');
});

test('討伐: 最後のフェーズで HP が少ないときだけ、敵対リストが消えたら終わる', () => {
    // 最後ではないフェーズ（p2）で HP 1% → 敵対リストが消えても終わらない（フェーズの移り変わり）
    let { e } = engine({ hasEnmity: true });
    enmityFrom(e, 0, 5, true);
    e.hpPercent(T(5.2), 1);
    assert.equal(e.status(T(5.2)).phase.id, 'p2');
    for (let s = 5.5; s <= 15; s += 0.5) {
        e.enmity(T(s), false);
        e.hpPercent(T(s), 1); // p2 のまま（HP を読めている間は p3 へ移らない）
    }
    assert.equal(e.status(T(15)).phase.id, 'p2');
    assert.equal(e.status(T(15)).state, 'combat');

    // 最後のフェーズ（p3）で HP 2% → 敵対リストが 3 秒消えたら討伐
    ({ e } = engine({ hasEnmity: true }));
    enmityFrom(e, 0, 4.5, true);
    e.hpPercent(T(5), 40); // → p2
    e.hpPercent(T(6), null); // HP が 3 秒読めない → p3
    enmityFrom(e, 6.5, 19.5, true);
    e.hpPercent(T(20), 2);
    enmityFrom(e, 20.5, 30, true);
    assert.equal(e.status(T(20)).phase.id, 'p3');
    enmityFrom(e, 30.5, 33, false);
    assert.equal(e.status(T(33)).state, 'combat');
    e.enmity(T(33.5), false);
    assert.equal(e.status(T(33.5)).state, 'ended');
});

test('全滅の暗転を読み逃しても、敵が見えないときのカウントダウンで数え直す', () => {
    const { e } = engine({ hasEnmity: true });
    enmityFrom(e, 0, 30, true);
    enmityFrom(e, 30.5, 50, false);
    assert.equal(e.status(T(50)).state, 'combat');
    e.countdown(T(60), 16);
    assert.equal(e.status(T(61)).state, 'countdown');
    assert.equal(sec(e.status(T(61)).predictedStart), 76);
    // 敵対リストが出ている（戦闘中）ときのカウントダウンは無視する
    const { e: e2 } = engine({ hasEnmity: true });
    enmityFrom(e2, 0, 30, true);
    e2.countdown(T(30.2), 10);
    assert.equal(e2.status(T(31)).state, 'combat');
});

test('敵対リスト: 戦闘の後に一瞬だけ出ても、次の戦闘とはみなさない（2026-10-20 の実測）', () => {
    const { e } = engine({ hasEnmity: true });
    enmityFrom(e, 12.5, 27, true); // 実測 12.3〜27.4 に表示
    enmityFrom(e, 27.5, 32, false);
    blackFrom(e, 28, 31, true); // 全滅の暗転
    assert.equal(e.status(T(32)).state, 'ended');
    e.enmity(T(32.5), true); // 実測 32.5〜33.0 と 37.6〜38.1 に一瞬だけ表示
    enmityFrom(e, 33, 37.5, false);
    e.enmity(T(38), true);
    enmityFrom(e, 38.5, 45, false);
    assert.equal(e.status(T(45)).state, 'ended');
});

test('これから来る予定: 発動までの秒を返し、発動から 2 秒たったものは消える', () => {
    const { e } = engine();
    e.started(T(0));
    const list = e.upcoming(T(12), 3);
    assert.deepEqual(list.map((u) => [u.entry.name, u.hitIn]), [
        ['創世の真炎', -1], // 6 + 5 = 11 秒に発動、まだ 2 秒たっていない
        ['オクタフレア・コンシーヴ', 8],
        ['熾炎創火', 13],
    ]);
    assert.equal(e.upcoming(T(14), 1)[0].entry.name, 'オクタフレア・コンシーヴ');
});

test('毎回どれかが出る技（A|B）: どちらが読めても同期し、候補には両方を出す', () => {
    assert.deepEqual(castNames('アグリゲートソニック| スプレッドソニック'), ['アグリゲートソニック', 'スプレッドソニック']);
    const alt = {
        format: 'castline/1',
        content: 'テスト',
        phases: [
            { id: 'p1', entries: [{ t: 10, name: 'アグリゲートソニック|スプレッドソニック', duration: 4 }], next: [{ to: 'p2', when: { cast: 'ブレイクビーツ|ブレイクダウン' } }] },
            { id: 'p2', entries: [] },
        ],
    };
    const e = new TimelineEngine(alt);
    e.started(T(0));
    assert.deepEqual(e.castCandidates(T(5)).sort(), ['アグリゲートソニック', 'スプレッドソニック', 'ブレイクダウン', 'ブレイクビーツ'].sort());
    e.cast(T(11), 'スプレッドソニック');
    assert.equal(e.status(T(11)).phaseTime.toFixed(1), '10.0');
    e.cast(T(20), 'ブレイクダウン');
    assert.equal(e.status(T(20)).phase.id, 'p2');
});

test('カウントダウン: 2 つの予想が食い違うときは大きい秒数のほう（「10」を「1」と読んでも早まらない。2026-10-21 の動画）', () => {
    const { e } = engine();
    e.countdown(T(10.1), 16);
    e.countdown(T(16.1), 1); // 「戦闘開始まで10秒！」を「1」と読んだ
    assert.equal(sec(e.status(T(17.5)).predictedStart), 26.1);
    assert.equal(e.status(T(17.5)).state, 'countdown');
});

test('手で止める: 敵対リストが出たままでは始まらず、一度消えてから出れば始まる', () => {
    let { e } = engine({ hasEnmity: true });
    enmityFrom(e, 5, 30, true);
    assert.equal(e.status(T(30)).state, 'combat');
    e.halt(T(30.2));
    enmityFrom(e, 30.5, 40, true);
    assert.equal(e.status(T(40)).state, 'ended');
    enmityFrom(e, 41, 45, false);
    enmityFrom(e, 50, 51, true);
    assert.equal(e.status(T(51)).state, 'combat');
    assert.equal(sec(e.startAt), 50);

    // 止めた後のカウントダウンは、ふつうに数える
    ({ e } = engine({ hasEnmity: true }));
    e.started(T(0));
    e.halt(T(5));
    realCountdown(e);
    assert.equal(e.status(T(20)).state, 'countdown');
});

test('カウントダウン中、開始の予想より大きく早い「戦闘開始」は読み違いとして無視する', () => {
    const { e } = engine();
    e.countdown(T(10.1), 16);
    e.started(T(10.6));
    assert.equal(e.status(T(11)).state, 'countdown');
    e.started(T(26.2));
    assert.equal(e.status(T(26.3)).state, 'combat');
});

test('敵対リストの範囲に始めから文字があるうちは、敵対リストでは始めない（止めた動画の画面）', () => {
    const { e, log } = engine({ hasEnmity: true, staleEnmity: true });
    enmityFrom(e, 0, 10, true);
    assert.equal(e.status(T(10)).state, 'idle');
    assert.ok(log.some((l) => l.includes('始めから文字がある')));
    // カウントダウンは敵対リストを見ずに予想時刻で始める
    e.countdown(T(11), 5);
    enmityFrom(e, 11.5, 16.5, true);
    assert.equal(e.status(T(16.5)).state, 'combat');
    assert.equal(sec(e.startAt), 16);
    // 一度消えてから出れば、敵対リストで始まる
    const { e: e2 } = engine({ hasEnmity: true, staleEnmity: true });
    enmityFrom(e2, 0, 5, true);
    enmityFrom(e2, 5.5, 8, false);
    enmityFrom(e2, 9, 10, true);
    assert.equal(e2.status(T(10)).state, 'combat');
    assert.equal(sec(e2.startAt), 9);
});

test('手で止めた後は、画面に残った「戦闘開始！」では始めない', () => {
    const { e } = engine();
    e.countdown(T(10), 5);
    e.halt(T(12));
    e.started(T(15.1));
    assert.equal(e.status(T(16)).state, 'ended');
    e.countdown(T(30), 5); // 次のカウントダウン
    e.started(T(35.1));
    assert.equal(e.status(T(35.2)).state, 'combat');
});

test('カウントダウン中に手で止めたら、そのカウントダウンの続きの吹き出しでは数え直さない', () => {
    const { e } = engine();
    e.countdown(T(10), 16);
    e.halt(T(12));
    e.countdown(T(16), 10);
    e.countdown(T(21.1), 5);
    assert.equal(e.status(T(27)).state, 'ended');
    e.countdown(T(40), 10); // 別のカウントダウン
    assert.equal(e.status(T(41)).state, 'countdown');
});
