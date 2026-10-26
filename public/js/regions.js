// 読み取る範囲（コンテンツ名・カウントダウン・HP・詠唱バー・敵対リスト）の保存と、ファイルへの書き出し・読み込み。
// 範囲は取り込んだ画面の大きさ（"幅x高さ"）ごとに持つ（解像度が変わると HUD の位置も変わるため）。
// DOM を使わない（node でテストする）。保存先は引数で差し替えられる（既定は localStorage）。

export const STORE_REGIONS = 'castline.regions';
export const REGIONS_FORMAT = 'castline-regions/1';

/**
 * 範囲の種類。rule は指定の目安（画面に出す）、lost は指定しないとできなくなること。
 * 並びは画面に出す順
 */
export const REGION_KINDS = [
    {
        id: 'content', label: 'コンテンツ名', color: '#f5c542',
        rule: '「コンテンツ情報」の下のコンテンツ名を 1 行だけ。長い名前も入るよう、横は広めに',
        lost: 'タイムラインを自動で選べません（一覧から選んでください）',
    },
    {
        id: 'countdown', label: 'カウントダウン', color: '#4fc3f7',
        rule: '画面中央に出る残り秒数と「戦闘開始！」が入るように',
        lost: 'カウントダウンから開始の時刻を予想できません',
    },
    {
        id: 'hp', label: 'HP（%）', color: '#ff7b72',
        rule: 'ターゲットの HP の % の数字を 1 行だけ',
        lost: 'HP でのフェーズの移行ができません',
    },
    {
        id: 'cast', label: '詠唱バー（技名）', color: '#c792ea',
        rule: 'ターゲットの詠唱バーの技名を 1 行だけ。長い技名も入るよう、横は広めに',
        lost: '詠唱での合わせ直しと、詠唱で決まる分岐（ヘビー級4 の前半／後半など）ができません',
    },
    {
        id: 'enmity', label: '敵対リスト', color: '#6fdc8c',
        rule: '敵の名前の列を上から下まで（詠唱中の技名もここに出る）',
        lost: '討伐で止まりません（全滅は画面の暗転で止まります）',
    },
];
const KIND_IDS = new Set(REGION_KINDS.map((k) => k.id));

export const screenKey = (width, height) => `${width}x${height}`;

function defaultStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

/** 保存してある全部の範囲 { "幅x高さ": { 種類: {x,y,w,h} } }。読めなければ空 */
export function loadAll(storage = defaultStorage()) {
    try {
        const all = JSON.parse(storage?.getItem(STORE_REGIONS) ?? '{}');
        return all && typeof all === 'object' ? all : {};
    } catch {
        return {};
    }
}

function saveAll(all, storage) {
    try {
        storage?.setItem(STORE_REGIONS, JSON.stringify(all));
        if (typeof window !== 'undefined' && storage === defaultStorage()) {
            window.dispatchEvent(new StorageEvent('storage', { key: STORE_REGIONS }));
        }
        return true;
    } catch {
        return false; // 保存できなくても、このページを開いている間は使える
    }
}

/** その画面の大きさの範囲 { 種類: {x,y,w,h} } */
export function regionsFor(width, height, storage = defaultStorage()) {
    return loadAll(storage)[screenKey(width, height)] ?? {};
}

/** 範囲を 1 つ保存する（rect が null なら消す） */
export function setRegion(width, height, id, rect, storage = defaultStorage()) {
    const all = loadAll(storage);
    const key = screenKey(width, height);
    const regions = { ...(all[key] ?? {}) };
    if (rect) {
        regions[id] = roundRect(rect);
    } else {
        delete regions[id];
    }
    if (Object.keys(regions).length > 0) {
        all[key] = regions;
    } else {
        delete all[key];
    }
    return saveAll(all, storage);
}

/** その画面の大きさの範囲を全部消す（ほかの画面の大きさの範囲は残す） */
export function clearRegions(width, height, storage = defaultStorage()) {
    const all = loadAll(storage);
    delete all[screenKey(width, height)];
    return saveAll(all, storage);
}

const roundRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

/** 書き出すファイルの中身（JSON。読みやすいよう範囲 1 つを 1 行に書く） */
export function exportRegions(all = loadAll()) {
    const screens = Object.entries(all).filter(([, regions]) => Object.keys(regions).length > 0);
    const lines = ['{', `  "format": ${JSON.stringify(REGIONS_FORMAT)},`, '  "screens": {'];
    screens.forEach(([key, regions], i) => {
        lines.push(`    ${JSON.stringify(key)}: {`);
        const ids = REGION_KINDS.map((k) => k.id).filter((id) => regions[id]);
        ids.forEach((id, j) => {
            const r = regions[id];
            lines.push(`      ${JSON.stringify(id)}: { "x": ${r.x}, "y": ${r.y}, "w": ${r.w}, "h": ${r.h} }${j < ids.length - 1 ? ',' : ''}`);
        });
        lines.push(`    }${i < screens.length - 1 ? ',' : ''}`);
    });
    lines.push('  }', '}', '');
    return lines.join('\n');
}

/**
 * 書き出したファイルを読んで確かめる。
 * @returns {{screens: object|null, errors: string[]}} errors が空でなければ使えない
 */
export function parseRegions(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return { screens: null, errors: [`JSON として読めません: ${e.message}`] };
    }
    if (data?.format !== REGIONS_FORMAT) {
        return { screens: null, errors: [`範囲のファイルではありません（format が "${REGIONS_FORMAT}" ではありません）`] };
    }
    const errors = [];
    const screens = {};
    for (const [key, regions] of Object.entries(data.screens ?? {})) {
        const m = /^(\d+)x(\d+)$/.exec(key);
        if (!m || !regions || typeof regions !== 'object') {
            errors.push(`画面の大きさ "${key}" は「幅x高さ」（例: 2560x1440）で書いてください`);
            continue;
        }
        const [width, height] = [Number(m[1]), Number(m[2])];
        screens[key] = {};
        for (const [id, r] of Object.entries(regions)) {
            const where = `${key} の ${id}`;
            if (!KIND_IDS.has(id)) {
                errors.push(`${where}: 知らない範囲の種類です（${[...KIND_IDS].join('・')} のどれか）`);
            } else if (!['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r?.[k]))) {
                errors.push(`${where}: x・y・w・h を数で書いてください`);
            } else if (r.w <= 0 || r.h <= 0 || r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) {
                errors.push(`${where}: 画面（${key}）からはみ出しています`);
            } else {
                screens[key][id] = roundRect(r);
            }
        }
    }
    if (errors.length === 0 && Object.keys(screens).length === 0) {
        errors.push('範囲が 1 つも書かれていません');
    }
    return { screens: errors.length === 0 ? screens : null, errors };
}

/**
 * ファイルの範囲を保存に入れる（同じ画面の大きさの同じ種類は置き換える。ほかは残す）。
 * @returns {{screens: string[], errors: string[]}} 入れた画面の大きさ
 */
export function importRegions(text, storage = defaultStorage()) {
    const { screens, errors } = parseRegions(text);
    if (!screens) {
        return { screens: [], errors };
    }
    const all = loadAll(storage);
    for (const [key, regions] of Object.entries(screens)) {
        all[key] = { ...(all[key] ?? {}), ...regions };
    }
    saveAll(all, storage);
    return { screens: Object.keys(screens), errors: [] };
}

/**
 * 範囲を保存してある画面の大きさ。[{key, missing, usable, complete}]
 * usable: 再生できる（コンテンツ名と、戦闘の開始を知る範囲がある）。complete: 初期設定が済んでいる（詠唱バーのほかは全部ある。
 * 詠唱バーはタイムラインの無いコンテンツでは探さず、再生中にも自動で探すため）
 */
export function savedScreens(storage = defaultStorage()) {
    return Object.entries(loadAll(storage))
        .filter(([, r]) => r && typeof r === 'object' && Object.keys(r).length > 0)
        .map(([key, r]) => {
            const missing = missingRegions(r);
            const usable = Boolean(r.content) && !missing.some((m) => m.id === 'start');
            return { key, missing, usable, complete: usable && missing.every((m) => m.id === 'cast') };
        });
}

/** 指定していない範囲と、そのためにできないこと（[{id, label, lost}]） */
export function missingRegions(regions) {
    const missing = REGION_KINDS.filter((k) => !regions?.[k.id]);
    // カウントダウンと敵対リストのどちらも無いと、そもそも開始を検知できない
    if (!regions?.countdown && !regions?.enmity) {
        return [{ id: 'start', label: 'カウントダウン・敵対リスト', lost: '戦闘の開始を検知できません（タイムラインが始まりません）' },
            ...missing.filter((k) => k.id !== 'countdown')];
    }
    return missing;
}
