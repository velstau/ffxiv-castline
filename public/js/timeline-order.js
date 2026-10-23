// 配信のタイムラインの一覧を、プルダウン用にまとまりごと・新しい順に並べる（再生画面と記録画面で共用）。
// まとまりは 零式・絶・極と滅（極は名前に「極」が付かないもの〔終極の戦い〕もあるので英語名の Extreme で見る）・レイド（ノーマル・アライアンス）・討滅戦（ノーマル）・ダンジョンの順。中は レベルの高い順 → 同じシーズンなら 1 層から順。
// ContentFinderCondition の行番号はシーズンの中で前後する（辺獄編 4 が 801、3 が 807）ので、層の番号は名前の末尾の数字から取り、
// シーズンの新しさはそのシーズンでいちばん小さい行番号で比べる。contents.json に無いコンテンツは「その他」として最後に元の順で置く。

const GROUPS = [
    { label: '零式', match: (c) => c.type === 'レイド' && c.name.includes('零式') },
    { label: '絶', match: (c) => c.type === '絶レイド' },
    { label: '極・滅', match: (c) => (c.type === '討伐・討滅戦' && c.file?.endsWith('-extreme')) || c.type === '滅アライアンスレイド' },
    { label: 'レイド', match: (c) => c.type === 'レイド' },
    { label: '討滅戦', match: (c) => c.type === '討伐・討滅戦' },
    { label: 'ダンジョン', match: (c) => c.type === 'ダンジョン' },
];

const series = (name) => name.replace(/\d+$/, '');
const floor = (name) => Number(name.match(/(\d+)$/)?.[1] ?? 0);

/**
 * @template {{content:string}} T
 * @param {T[]} items 配信の一覧（index.xml の順）
 * @param {{id:number, name:string, type:string, level:number, file:string|null}[]} contents data/contents.json の contents
 * @returns {{label:string, items:T[]}[]} 空のまとまりは含めない
 */
export function groupTimelines(items, contents) {
    const byName = new Map(contents.map((c) => [c.name, c]));
    const seriesId = new Map();
    for (const c of contents) {
        const key = series(c.name);
        seriesId.set(key, Math.min(seriesId.get(key) ?? Infinity, c.id));
    }
    const groups = [...GROUPS.map((g) => ({ ...g, items: [] })), { label: 'その他', match: () => true, items: [] }];
    for (const item of items) {
        const c = byName.get(item.content);
        (c ? groups.find((g) => g.match(c)) : groups.at(-1)).items.push(item);
    }
    const key = (item) => {
        const c = byName.get(item.content);
        return [-c.level, -seriesId.get(series(c.name)), floor(c.name)];
    };
    for (const g of groups.slice(0, -1)) {
        g.items.sort((a, b) => {
            const ka = key(a);
            const kb = key(b);
            return ka.map((v, i) => v - kb[i]).find((d) => d !== 0) ?? 0;
        });
    }
    return groups.filter((g) => g.items.length > 0).map(({ label, items: list }) => ({ label, items: list }));
}
