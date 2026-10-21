// 再生画面の予定の表示（表示名・アイコン・同じ攻撃のまとめ）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName, entryIcons, iconProblems, upcomingRows } from '../public/js/timeline-view.js';
import { GIMMICK_ICONS, gimmickIcon } from '../public/js/gimmick-icons.js';
import { toTimelineXml } from '../public/js/timeline-xml.js';

const tl = (entries, extra = {}) => ({ format: 'castline/1', content: 'c', phases: [{ id: 'p1', entries }], ...extra });
const up = (entry, hitIn) => ({ entry, hitIn, castIn: hitIn - (entry.duration ?? 0) });

test('表示名: text があれば text だけ、無ければ技名（A|B は A／B）', () => {
    assert.equal(displayName({ name: 'ハードコア', label: 'タンク強' }), 'タンク強');
    assert.equal(displayName({ name: 'アグリゲートソニック|スプレッドソニック' }), 'アグリゲートソニック／スプレッドソニック');
});

test('同じ攻撃が続くときは 1 行にまとめる（間が 10 秒以内・発動済みはまとめない・アイコンが違えば別）', () => {
    const a = { t: 0, name: 'シンブリザガ' };
    const rows = upcomingRows([up(a, -1), up(a, 4), up(a, 9.3), up(a, 14.6), up(a, 19.9), up({ t: 0, name: '別' }, 25), up(a, 30), up(a, 45)], tl([]));
    assert.deepEqual(rows.map((r) => [r.name, r.count, r.hitIn]), [
        ['シンブリザガ', 1, -1], ['シンブリザガ', 4, 4], ['別', 1, 25], ['シンブリザガ', 1, 30], ['シンブリザガ', 1, 45],
    ]);
    const marked = { t: 0, name: 'シンブリザガ', gimmick: 'spread' };
    assert.equal(upcomingRows([up(a, 4), up(marked, 6)], tl([])).length, 2);
});

test('アイコン: 用意したギミックは id でも名前でも引け、<icons> のスキルは XML の場所から解決する', () => {
    assert.equal(GIMMICK_ICONS.length, 27);
    assert.equal(gimmickIcon('頭割り').id, 'stack');
    assert.equal(gimmickIcon('チャリオット').id, 'chariot');
    assert.match(gimmickIcon('stack').url, /\/icons\/gimmick\/stack\.svg$/);
    const timeline = tl([], {
        baseUrl: 'https://example.com/timelines/m1.xml',
        icons: [{ id: 'rampart', src: 'icons/rampart.png', name: 'ランパート' }, { id: 'stack', src: 'my-stack.png' }],
    });
    const icons = entryIcons({ name: 'x', gimmick: 'タンク強攻撃', skills: ['rampart', 'nothing'] }, timeline);
    assert.deepEqual(icons.map((i) => [i.key, i.alt]), [['tankbuster', 'タンク強攻撃'], ['rampart', 'ランパート']]);
    assert.equal(icons[1].url, 'https://example.com/timelines/icons/rampart.png');
    // <icons> に同じ id があれば、用意したアイコンより優先
    assert.equal(entryIcons({ name: 'x', gimmick: 'stack' }, timeline)[0].url, 'https://example.com/timelines/my-stack.png');
    // 手元の XML（baseUrl なし）の相対パスは使えない。URL なら使える
    const local = tl([{ t: 1, name: 'x', gimmick: 'なにか', skills: ['rampart', 'web'] }], {
        icons: [{ id: 'rampart', src: 'icons/rampart.png' }, { id: 'web', src: 'https://example.com/a.png' }],
    });
    assert.deepEqual(entryIcons(local.phases[0].entries[0], local).map((i) => i.key), ['web']);
    assert.equal(iconProblems(local).length, 2);
});

test('XML: gimmick・skills は window の後、<icons> はフェーズの前に書く', () => {
    const xml = toTimelineXml(tl([{ t: 1, name: 'x', label: 'タンク強', gimmick: 'tankbuster', skills: ['rampart', 'reprisal'] }], {
        icons: [{ id: 'rampart', src: 'icons/rampart.png', name: 'ランパート' }],
    }));
    assert.match(xml, /<icons>\n    <icon id="rampart" src="icons\/rampart.png" name="ランパート"\/>\n  <\/icons>\n  <phase id="p1">/);
    assert.match(xml, /<entry t="1.0" text="タンク強" castname="x" gimmick="tankbuster" skills="rampart reprisal"\/>/);
});
