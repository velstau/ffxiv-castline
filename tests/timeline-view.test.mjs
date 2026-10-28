// 再生画面の予定の表示（表示名・アイコン・同じ攻撃のまとめ）のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName, entryIcons, iconProblems, upcomingRows } from '../public/js/timeline-view.js';
import { gimmickIcon } from '../public/js/gimmick-icons.js';
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
    const marked = { t: 0, name: 'シンブリザガ', gimmickIcon: 'spread' };
    assert.equal(upcomingRows([up(a, 4), up(marked, 6)], tl([])).length, 2);
});

test('アイコン: 用意したギミックは id・名前・拡張子付きで引け、画像のファイルは XML の場所から解決する', () => {
    assert.equal(gimmickIcon('頭割り').id, 'stack');
    assert.equal(gimmickIcon('チャリオット').id, 'chariot');
    assert.match(gimmickIcon('stack').url, /\/icons\/gimmick\/stack\.svg$/);
    const timeline = tl([], { baseUrl: 'https://example.com/timelines/m1.xml' });
    const icons = entryIcons({ name: 'x', gimmickIcon: 'tankbuster.png', skillIcons: ['icons/rampart.png', 'nothing'] }, timeline);
    assert.deepEqual(icons.map((i) => i.alt), ['タンク強攻撃', 'rampart']);
    assert.match(icons[0].url, /\/icons\/gimmick\/tankbuster\.svg$/);
    assert.equal(icons[1].url, 'https://example.com/timelines/icons/rampart.png');
    assert.match(entryIcons({ name: 'x', gimmickIcon: '塔踏み' }, timeline)[0].url, /tower\.svg$/);
    // 用意したアイコンと同じ名前の自分の画像は ./ を付ける
    assert.equal(entryIcons({ name: 'x', gimmickIcon: './tower.png' }, timeline)[0].url, 'https://example.com/timelines/tower.png');
    // 手元の XML（baseUrl なし）の相対パスは使えない。URL と用意したアイコンは使える
    const local = tl([{ t: 1, name: 'x', gimmickIcon: 'なにか', skillIcons: ['rampart.png', 'https://example.com/a.png', 'stack'] }]);
    assert.deepEqual(entryIcons(local.phases[0].entries[0], local).map((i) => i.url.split('/').at(-1)), ['a.png', 'stack.svg']);
    assert.equal(iconProblems(local).length, 2);
});

test('XML: gimmick_icon・skills_icon（カンマ区切り）は window の後に書く', () => {
    const xml = toTimelineXml(tl([{ t: 1, name: 'x', label: 'タンク強', gimmickIcon: 'tankbuster.png', skillIcons: ['rampart.png', 'rampart2.png'] }]));
    assert.match(xml, /<entry t="1.0" text="タンク強" castname="x" gimmick_icon="tankbuster.png" skills_icon="rampart.png,rampart2.png"\/>/);
});

test('XML: 詠唱で移る条件の時刻の範囲 from・until は cast の後に書く', () => {
    const t = tl([{ t: 1, name: 'x' }]);
    t.phases[0].next = [{ to: t.phases[0].id, at: 28.1, when: { cast: 'パーフェクトデシメート' }, until: 34 }];
    assert.match(toTimelineXml(t), /<next to="[^"]+" at="28.1" cast="パーフェクトデシメート" until="34"\/>/);
});
