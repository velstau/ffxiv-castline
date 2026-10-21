// ギミックのアイコン（Castline 独自の図案。public/icons/gimmick/<id>.svg）。タイムラインの entry の gimmick に id か名前を書く。
// 色は役割ごとにそろえる: 全体・範囲は赤橙、タンクは赤、頭割りは黄、散開・視線は紫、位置は青緑、線・鎖は青、番号は白地

export const GIMMICK_ICONS = [
    { id: 'raidwide', name: '全体攻撃' },
    { id: 'tankbuster', name: 'タンク強攻撃' },
    { id: 'tank-share', name: 'タンク頭割り' },
    { id: 'stack', name: '頭割り' },
    { id: 'spread', name: '散開' },
    { id: 'tower', name: '塔踏み' },
    { id: 'dice', name: 'サイコロ' },
    { id: 'half-room', name: '半面攻撃' },
    { id: 'target-marker', name: '単体マーカー' },
    { id: 'aoe-marker', name: 'AoEマーカー' },
    { id: 'gaze-look', name: '視線見る' },
    { id: 'gaze-away', name: '視線見ない' },
    { id: 'proximity', name: '距離減衰' },
    { id: 'knockback', name: 'ノックバック' },
    { id: 'tether-stretch', name: '線伸ばす' },
    { id: 'tether-take', name: '線取る' },
    { id: 'chain', name: '鎖' },
    { id: 'divebomb', name: 'ダイブボム' },
    { id: 'range-near', name: '距離調整ニア' },
    { id: 'range-middle', name: '距離調整ミドル' },
    { id: 'range-far', name: '距離調整ファー' },
    { id: 'bind', name: '足止め' },
    { id: 'chariot', name: 'ボス中心円形範囲（チャリオット）' },
    { id: 'dynamo', name: 'ボス中心ドーナツ型範囲（ダイナモ）' },
    { id: 'line', name: '直線範囲' },
    { id: 'cone', name: '扇範囲' },
    { id: 'aoe', name: 'AoE範囲' },
];

const byKey = new Map(GIMMICK_ICONS.flatMap((g) => [[g.id, g], [g.name, g]]));
// 括弧の前だけでも引けるように（「チャリオット」「ダイナモ」も）
for (const g of GIMMICK_ICONS) {
    const m = g.name.match(/^(.+?)（(.+)）$/);
    if (m) {
        byKey.set(m[1], g);
        byKey.set(m[2], g);
    }
}

/** id か名前から、用意したギミックのアイコン（{id, name, url}）。無ければ null */
export function gimmickIcon(key) {
    const g = byKey.get(key);
    return g ? { ...g, url: new URL(`../icons/gimmick/${g.id}.svg`, import.meta.url).href } : null;
}
