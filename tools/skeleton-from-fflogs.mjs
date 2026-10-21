// FFLogs の公開ランキングの討伐の記録から、タイムラインの骨組み（XML）と、敵の全部の技の時刻（events.json）を作る（運営者の手元の道具）。
// 生成画面（generator.html）と同じ処理（fflogs-timeline.js）を Node から使う。hojoring-overlay.py の入力になる。
//
//   FFLOGS_CLIENT_ID=… FFLOGS_CLIENT_SECRET=… node tools/skeleton-from-fflogs.mjs <file> <encounter>[,<encounter>…] [--difficulty 101] [--page N]
//
//   file       contents.json の file（aac-cruiserweight-m1-savage など）。出力は tools/skeletons/<file>.xml と <file>.events.json
//              （events はフェーズごとと戦闘ごと。hojoring-overlay.py の --events-all で読む）
//   encounter  FFLogs の encounter の番号。前半・後半に分かれた戦闘は「,」で並べる（フェーズは a-p1・b-p1 …）
//   difficulty 零式 101、ほかは 100（FFLogs の難易度）
//   max-length これより長い（秒）討伐の記録は使わない（何十分もかかった外れ値の記録を避ける。convert-hojoring-pc.sh は Hojoring の最後の時刻の 1.2 倍を渡す）
//   page       ランキングの何ページ目から選ぶか。省略時は最後のページ（上位の記録は速く、終盤の技が出ないため、遅い記録から採る）
//
// 問い合わせの結果は tools/cache/ に保存し、次からはそれを使う（FFLogs の利用回数の上限があるため。git の対象外）。
// 生成物にはレポートの番号を書かない（ランキングから選んだほかの人の記録でも同じ）。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFLogsClient, loadReport } from '../public/js/fflogs-api.js';
import { summarizeEnemies, buildTimeline, mergeParts, phaseTransitions } from '../public/js/fflogs-timeline.js';
import { toTimelineXml } from '../public/js/timeline-xml.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = join(root, 'tools/cache');
const outDir = join(root, 'tools/skeletons');
const MAX_EVENT_PAGES = 300; // 絶の長い戦闘でも取り切る（生成画面の上限 30 では足りないことがある）
const ENEMY_MIN_CASTS = 3; // 予定に入れる敵: 詠唱が 3 回以上で、いちばん多い敵の 1 割以上
const ENEMY_MIN_SHARE = 0.1;
const MAX_RANK_PAGES = 20; // ランキングを最後のページまでたどる上限
const PHASE_MARGIN_MS = 20000; // フェーズごとの技の一覧に、前後のフェーズの技もこれだけ含める（区間の境目の技を照合できるように）

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function args() {
    const [file, encounters, ...rest] = process.argv.slice(2);
    if (!file || !encounters) {
        console.error('使い方: node tools/skeleton-from-fflogs.mjs <file> <encounter>[,<encounter>…] [--difficulty 101] [--page N]');
        process.exit(2);
    }
    const opt = (name, def) => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? Number(rest[i + 1]) : def;
    };
    return { file, encounters: encounters.split(',').map(Number), difficulty: opt('difficulty', 100), page: opt('page', 0), maxLength: opt('max-length', 0) || Infinity };
}

async function cached(name, fetcher, keep = () => true) {
    const path = join(cacheDir, `${name}.json`);
    if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    const data = await fetcher();
    if (keep(data)) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(path, JSON.stringify(data));
    }
    return data;
}

async function loadAllCasts(client, code, fight) {
    const events = [];
    let start = fight.startTime;
    for (let page = 0; start !== null && start !== undefined; page++) {
        if (page >= MAX_EVENT_PAGES) {
            throw new Error(`技の記録が ${MAX_EVENT_PAGES} ページを超えました`);
        }
        const data = await client.query(`query($code: String!, $fight: [Int], $start: Float, $end: Float) {
            reportData { report(code: $code) {
                events(fightIDs: $fight, startTime: $start, endTime: $end, dataType: Casts, hostilityType: Enemies, translate: true) {
                    data nextPageTimestamp
                }
            } }
        }`, { code, fight: [fight.id], start, end: fight.endTime });
        const page_ = data.reportData.report.events;
        events.push(...page_.data);
        start = page_.nextPageTimestamp;
    }
    return events;
}

/** ランキングの記録を 1 つ選んで、レポート・戦闘・技を取る（場所がコンテンツと違う記録は飛ばす） */
async function loadKill(client, encounter, difficulty, page, territory, maxLength) {
    // ランキングは速い順なので、指定が無ければ最後のページ（遅い記録ほど終盤の技まで出る）。空のページは手前へ戻す（空の結果は保存しない）
    const fetchPage = (n) => cached(`rank-${encounter}-${difficulty}-${n}`, async () => (await client.query(
        `query($id: Int!, $difficulty: Int, $page: Int) { worldData { encounter(id: $id) { name fightRankings(difficulty: $difficulty, page: $page) } } }`,
        { id: encounter, difficulty, page: n },
    )).worldData.encounter, (data) => (data?.fightRankings?.rankings ?? []).length > 0);
    if (!page) {
        page = 1;
        while (page < MAX_RANK_PAGES && (await fetchPage(page))?.fightRankings?.hasMorePages) {
            page++;
        }
    }
    let ranking = null;
    let list = [];
    for (; page >= 1 && list.length === 0; page--) {
        ranking = await fetchPage(page);
        list = ranking?.fightRankings?.rankings ?? [];
    }
    page++;
    // 長い記録ほど後半の技まで出るので、長い順に試す
    const ranked = [...list].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
        .map((r, i) => ({ code: r.report.code, fightID: r.report.fightID, duration: r.duration, key: `kill-${encounter}-${difficulty}-${page}-${i}` }))
        .filter((c) => !(c.duration > maxLength * 1000)).slice(0, 5);
    const kill = await tryKills(client, ranked, territory, maxLength);
    if (kill) {
        return { ...kill, encounterName: ranking?.name };
    }
    // 古いコンテンツのランキングの記録は FFLogs でアーカイブされていて読めない（2026-10、有料会員だけ）。
    // 最近アップロードされたレポートの中から、そのコンテンツの討伐を探す（長い順。同期なしで短く倒した記録は技が欠けるため）
    console.warn('  ランキングの記録が読めないので、最近のレポートから探します');
    const recent = await recentKills(client, encounter, difficulty);
    console.warn(`  最近の討伐 ${recent.kills.length} 件（長いもの: ${recent.kills.slice(0, 3).map((k) => clock(k.duration)).join('・')}、上限 ${Number.isFinite(maxLength) ? clock(maxLength * 1000) : 'なし'}）`);
    // 保存の名前は並びの番号のまま（場所ごとの検索を保存しているので、並びは変わらない）
    const candidates = recent.kills.map((r, i) => ({ ...r, key: `kill-${encounter}-${difficulty}-recent-${i}` }))
        .filter((c) => c.duration <= maxLength * 1000).slice(0, 8);
    const found = await tryKills(client, candidates, territory, maxLength);
    if (found) {
        return { ...found, encounterName: recent.name };
    }
    throw new Error(`encounter ${encounter} に使える記録がありません`);
}

async function tryKills(client, candidates, territory, maxLength = Infinity) {
    for (const [i, c] of candidates.entries()) {
        const kill = await cached(c.key, async () => {
            try {
                const report = await loadReport(client, c.code);
                const fight = report.fights.find((f) => f.id === c.fightID);
                if (!fight) {
                    return { error: '戦闘が見つかりません' };
                }
                const events = await loadAllCasts(client, c.code, fight);
                return { report, fight, events };
            } catch (e) {
                // アーカイブ・非公開など、その記録では変わらないものだけ保存する。利用回数の上限・通信の失敗はその場で止める
                if (!/archived|private|not found|見つかりません/i.test(e.message)) {
                    throw e;
                }
                return { error: e.message.slice(0, 80) };
            }
        });
        if (kill.error) {
            console.warn(`  記録 ${i + 1}: ${kill.error}`);
            continue;
        }
        if (kill.fight.endTime - kill.fight.startTime > maxLength * 1000) {
            console.warn(`  記録 ${i + 1}: ${clock(kill.fight.endTime - kill.fight.startTime)} は長すぎるので使わない`);
            continue;
        }
        if (territory && kill.fight.gameZone?.id !== territory) {
            console.warn(`  記録 ${i + 1}: 場所 ${kill.fight.gameZone?.id}（${kill.fight.gameZone?.name}）がコンテンツの場所 ${territory} と違うので使わない`);
            continue;
        }
        return kill;
    }
    return null;
}

const RECENT_DAYS = 180;
const RECENT_PAGES = 10; // 1 ページ 50 件（100 件では問い合わせの複雑さの上限を超える）

/** 最近のレポートにある、その encounter・難易度の討伐（長い順）。レポートの検索は場所（FFLogs の zone）ごとに保存して、同じ場所の層で使い回す */
async function recentKills(client, encounter, difficulty) {
    const info = await cached(`encounter-${encounter}`, async () => (await client.query(
        `query($id: Int!) { worldData { encounter(id: $id) { name zone { id } } } }`, { id: encounter })).worldData.encounter);
    const fights = await cached(`recent-zone-${info.zone.id}`, async () => {
        const since = Date.now() - RECENT_DAYS * 86400e3;
        const out = [];
        for (let page = 1; page <= RECENT_PAGES; page++) {
            const data = (await client.query(`query($zone: Int, $since: Float, $page: Int) { reportData { reports(zoneID: $zone, startTime: $since, limit: 50, page: $page) {
                has_more_pages data { code fights(killType: Kills) { id encounterID difficulty startTime endTime } } } } }`,
            { zone: info.zone.id, since, page })).reportData.reports;
            for (const r of data.data) {
                for (const f of r.fights ?? []) {
                    out.push({ code: r.code, fightID: f.id, encounterID: f.encounterID, difficulty: f.difficulty, duration: f.endTime - f.startTime });
                }
            }
            if (!data.has_more_pages) {
                break;
            }
        }
        return out;
    });
    const kills = fights.filter((f) => f.encounterID === encounter && f.difficulty === difficulty).sort((a, b) => b.duration - a.duration);
    return { name: info.name, kills };
}

/** buildTimeline と同じフェーズの分け方 */
function phaseWindows(fight) {
    const transitions = phaseTransitions(fight);
    return transitions.map((tr, i) => ({
        id: `p${i + 1}`,
        start: tr.startTime,
        end: transitions[i + 1]?.startTime ?? fight.endTime,
    }));
}

/** 敵の技（詠唱開始 b・発動 c）を [時刻(ms), 種類, 技名] で。tools/fflogs-events.py の extract と同じ選び方 */
function castRows({ report, events }) {
    const names = new Map(report.masterData.abilities.map((a) => [a.gameID, a.name]));
    const rows = [];
    for (const e of events) {
        if ((e.type !== 'begincast' && e.type !== 'cast') || e.abilityGameID === 1 || e.abilityGameID === 7) {
            continue;
        }
        const name = names.get(e.abilityGameID) ?? '';
        if (name && !name.toLowerCase().startsWith('unknown')) {
            rows.push([e.timestamp, e.type === 'begincast' ? 'b' : 'c', name]);
        }
    }
    return rows;
}

/** hojoring-overlay.py の --events-all が読む形: フェーズごとに、そのフェーズの始まりからの秒で並べた技の一覧 */
function phaseEvents(kill, prefix) {
    const rows = castRows(kill);
    const out = {};
    for (const w of phaseWindows(kill.fight)) {
        const seen = new Set();
        const list = [];
        for (const [ts, type, name] of rows) {
            if (ts < w.start - PHASE_MARGIN_MS || ts > w.end + PHASE_MARGIN_MS) {
                continue;
            }
            const row = [Math.round((ts - w.start) / 100) / 10, type, name];
            const key = JSON.stringify(row);
            if (!seen.has(key)) {
                seen.add(key);
                list.push(row);
            }
        }
        list.sort((a, b) => a[0] - b[0]);
        out[`${prefix}${w.id}`] = { length: Math.round((w.end - w.start) / 100) / 10, events: list };
    }
    return out;
}

/** 戦闘全体の技の一覧（戦闘の始まりからの秒）と、各フェーズの始まり。区間が複数のフェーズにまたがるときに使う */
function fightEvents(kill, prefix) {
    const seen = new Set();
    const events = [];
    for (const [ts, type, name] of castRows(kill)) {
        const row = [Math.round((ts - kill.fight.startTime) / 100) / 10, type, name];
        const key = JSON.stringify(row);
        if (!seen.has(key)) {
            seen.add(key);
            events.push(row);
        }
    }
    events.sort((a, b) => a[0] - b[0]);
    const starts = Object.fromEntries(phaseWindows(kill.fight).map((w) => [`${prefix}${w.id}`, Math.round((w.start - kill.fight.startTime) / 100) / 10]));
    return { starts, events };
}

function eventsFile(phases, fights) {
    const fightBody = Object.entries(fights).map(([id, f]) => `    ${JSON.stringify(id)}: {\n      "starts": ${JSON.stringify(f.starts)},\n      "events": [\n`
        + f.events.map((r) => `        ${JSON.stringify(r)}`).join(',\n') + '\n      ]\n    }');
    return eventsPhases(phases).replace(/\n}\n$/, `,\n  "fights": {\n${fightBody.join(',\n')}\n  }\n}\n`);
}

function eventsPhases(phases) {
    const body = Object.entries(phases).map(([id, p]) => `    ${JSON.stringify(id)}: {\n      "length": ${p.length},\n      "events": [\n`
        + p.events.map((r) => `        ${JSON.stringify(r)}`).join(',\n') + '\n      ]\n    }');
    return `{\n  "phases": {\n${body.join(',\n')}\n  }\n}\n`;
}

async function main() {
    const { file, encounters, difficulty, page, maxLength } = args();
    const contents = JSON.parse(readFileSync(join(root, 'public/data/contents.json'), 'utf8')).contents;
    const content = contents.find((c) => c.file === file);
    if (!content) {
        throw new Error(`contents.json に file「${file}」がありません`);
    }
    const client = new FFLogsClient(process.env.FFLOGS_CLIENT_ID, process.env.FFLOGS_CLIENT_SECRET);
    const today = new Date().toISOString().slice(0, 10);
    const parts = [];
    const allEvents = {};
    const allFights = {};
    for (const [i, encounter] of encounters.entries()) {
        const kill = await loadKill(client, encounter, difficulty, page, content.territory, maxLength);
        const { fight, report, events } = kill;
        const enemies = summarizeEnemies({ actors: report.masterData.actors, abilities: report.masterData.abilities, events });
        const most = Math.max(0, ...enemies.map((e) => e.casts));
        const chosen = enemies.filter((e) => e.casts >= ENEMY_MIN_CASTS && e.casts >= most * ENEMY_MIN_SHARE);
        const phaseNames = report.phases?.find((p) => p.encounterID === fight.encounterID)?.phases ?? [];
        const timeline = buildTimeline({
            fight, actors: report.masterData.actors, abilities: report.masterData.abilities, events,
            sourceIDs: new Set(chosen.map((e) => e.id)), content: content.name, phaseNames, includeInstant: true,
            title: content.name, note: '',
        });
        const prefix = encounters.length > 1 ? `${String.fromCharCode(97 + i)}-` : '';
        Object.assign(allEvents, phaseEvents(kill, prefix));
        allFights[prefix ? prefix.slice(0, 1) : 'all'] = fightEvents(kill, prefix);
        console.log(`${kill.encounterName}: 討伐 ${clock(fight.endTime - fight.startTime)}・フェーズ ${timeline.phases.length}`
            + `（${timeline.phases.map((p) => `${p.id} ${p.entries.length} 件`).join('・')}）`);
        console.log(`  予定に入れた敵: ${chosen.map((e) => `${e.name}（詠唱 ${e.casts}・なし ${e.instants}）`).join('、')}`);
        const left = enemies.filter((e) => !chosen.includes(e) && e.casts > 0);
        if (left.length > 0) {
            console.log(`  入れなかった敵: ${left.map((e) => `${e.name}（詠唱 ${e.casts}）`).join('、')}`);
        }
        const labels = encounters.length === 2 ? ['前半', '後半'] : encounters.map((_, j) => `パート${j + 1}`);
        parts.push({ label: labels[i], timeline, length: fight.endTime - fight.startTime });
    }
    const lengths = parts.map((p) => clock(p.length)).join('・');
    const note = `FFLogs の公開ランキングの討伐の記録（${lengths}）から ${today} に生成。`
        + 't は詠唱開始、duration は詠唱時間。詠唱の無い技は sync="false"（表示だけ）';
    const title = `${content.name}（FFLogs から生成）`;
    let timeline;
    if (parts.length === 1) {
        timeline = { ...parts[0].timeline, title, note };
    } else {
        const merged = mergeParts(parts, { content: content.name, title, note });
        if (!merged.timeline) {
            throw new Error(merged.error);
        }
        timeline = merged.timeline;
    }
    writeFileSync(join(outDir, `${file}.xml`), toTimelineXml(timeline));
    writeFileSync(join(outDir, `${file}.events.json`), eventsFile(allEvents, allFights));
    console.log(`→ tools/skeletons/${file}.xml・${file}.events.json`);
}

main().catch((e) => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
});
