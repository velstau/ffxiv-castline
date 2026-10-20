// FFLogs のレポートからタイムラインの XML を作る画面。通信はすべてブラウザから FFLogs へ直接行う。
import './storage-migrate.js';
import { FFLogsClient, parseReportUrl, loadReport, loadEnemyCasts } from './fflogs-api.js';
import { buildTimeline, summarizeEnemies } from './fflogs-timeline.js';
import { toTimelineXml } from './timeline-xml.js';

const STORE_KEYS = 'castline.fflogs-keys'; // { id, secret }（このブラウザにだけ保存する）
const STORE_LOCAL = 'castline.player.local-timelines'; // 再生画面の手元のファイル

const $ = (id) => document.getElementById(id);
const state = {
    contents: [], // data/contents.json
    code: null,
    report: null,
    fight: null,
    events: null,
    xml: '',
    fileName: '',
};

function load(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}
function save(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}
function setStatus(id, text, kind = '') {
    $(id).textContent = text;
    $(id).className = `status ${kind}`.trim();
}
const fmtSeconds = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

// ── キー ──
function client() {
    const id = $('key-id').value.trim();
    const secret = $('key-secret').value.trim();
    if (!id || !secret) {
        throw new Error('FFLogs のクライアント ID と secret を入れてください');
    }
    return new FFLogsClient(id, secret);
}

function saveKeys() {
    const ok = save(STORE_KEYS, { id: $('key-id').value.trim(), secret: $('key-secret').value.trim() });
    setStatus('key-status', ok ? 'このブラウザに保存しました。' : 'このブラウザでは保存できません（このページを開いている間だけ使えます）。', ok ? 'ok' : 'ng');
}

function clearKeys() {
    try {
        localStorage.removeItem(STORE_KEYS);
    } catch {
        // 保存できない環境では消すものも無い
    }
    $('key-id').value = '';
    $('key-secret').value = '';
    setStatus('key-status', '保存していたキーを消しました。');
}

// ── レポート ──
async function loadReportFromUrl() {
    const parsed = parseReportUrl($('report-url').value);
    if (!parsed) {
        setStatus('report-status', 'レポートの URL（https://ja.fflogs.com/reports/… の形）を入れてください。', 'ng');
        return;
    }
    setStatus('report-status', '読み込み中…');
    $('report-load').disabled = true;
    try {
        state.code = parsed.code;
        state.report = await loadReport(client(), parsed.code);
        const fights = state.report.fights;
        if (fights.length === 0) {
            throw new Error('このレポートにはボス戦がありません');
        }
        const select = $('fight-select');
        select.replaceChildren(...fights.map((f) => Object.assign(document.createElement('option'), {
            value: String(f.id),
            textContent: `#${f.id} ${f.name}（${f.kill ? '討伐' : `ワイプ ${f.fightPercentage ?? '?'}%`}、${fmtSeconds(f.endTime - f.startTime)}）`,
        })));
        const wanted = parsed.fight === 'last' ? fights.at(-1).id : parsed.fight;
        // URL の戦闘が無ければ、最初の討伐（無ければ最後の戦闘）
        select.value = String(fights.some((f) => f.id === wanted) ? wanted : (fights.find((f) => f.kill) ?? fights.at(-1)).id);
        setStatus('report-status', `「${state.report.title}」の戦闘 ${fights.length} 件を読み込みました。`, 'ok');
        $('fight-section').hidden = false;
        await loadFight();
    } catch (e) {
        setStatus('report-status', e.message, 'ng');
    } finally {
        $('report-load').disabled = false;
    }
}

async function loadFight() {
    const fight = state.report.fights.find((f) => String(f.id) === $('fight-select').value);
    state.fight = fight;
    state.events = null;
    $('result-section').hidden = true;
    // コンテンツ名は、戦闘の場所（gameZone）の番号から引く
    const content = state.contents.find((c) => c.territory === fight.gameZone?.id);
    $('content-input').value = content?.name ?? '';
    setStatus('fight-status', '敵の詠唱を読み込み中…');
    try {
        state.events = await loadEnemyCasts(client(), state.code, fight);
        const enemies = summarizeEnemies({ actors: state.report.masterData.actors, abilities: state.report.masterData.abilities, events: state.events });
        renderEnemies(enemies, fight);
        setStatus('fight-status', content
            ? `敵の詠唱 ${state.events.length} 件を読み込みました。`
            : `敵の詠唱 ${state.events.length} 件を読み込みました。場所「${fight.gameZone?.name ?? '不明'}」のコンテンツ名が一覧に無いので、画面の表記どおりに入れてください。`,
        content ? 'ok' : 'ng');
    } catch (e) {
        setStatus('fight-status', e.message, 'ng');
    }
}

function renderEnemies(enemies, fight) {
    $('enemy-list').replaceChildren(...enemies.map((e) => {
        const label = document.createElement('label');
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: String(e.id) });
        // 既定は戦闘名と同じ名前の敵（ボス本体）
        box.checked = e.name === fight.name;
        label.append(box, ` ${e.name}（詠唱 ${e.casts}・詠唱なし ${e.instants}）`);
        const li = document.createElement('li');
        li.append(label);
        return li;
    }));
}

// ── 生成 ──
function generate() {
    const content = $('content-input').value.trim();
    if (!content) {
        setStatus('fight-status', 'コンテンツ名を入れてください（画面の「コンテンツ情報」の表記どおり）。', 'ng');
        return;
    }
    const sourceIDs = new Set([...$('enemy-list').querySelectorAll('input:checked')].map((b) => Number(b.value)));
    if (sourceIDs.size === 0) {
        setStatus('fight-status', '予定に入れる敵を 1 つ以上選んでください。', 'ng');
        return;
    }
    const fight = state.fight;
    const phaseNames = state.report.phases?.find((p) => p.encounterID === fight.encounterID)?.phases ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const timeline = buildTimeline({
        fight,
        actors: state.report.masterData.actors,
        abilities: state.report.masterData.abilities,
        events: state.events,
        sourceIDs,
        content,
        phaseNames,
        includeInstant: $('include-instant').checked,
        title: `${content}（FFLogs から生成）`,
        note: `FFLogs のレポート ${state.code} の戦闘 #${fight.id}（${fight.kill ? '討伐' : 'ワイプ'}、${fmtSeconds(fight.endTime - fight.startTime)}）から ${today} に生成。`
            + 't は詠唱開始、duration は詠唱時間。詠唱の無い技は sync="false"（表示だけ）',
    });
    state.xml = toTimelineXml(timeline);
    state.fileName = `${content.replace(/[\\/:*?"<>|：]/g, '_')}_${state.code}_${fight.id}.xml`;
    $('xml-output').value = state.xml;
    renderPreview(timeline);
    $('result-section').hidden = false;
    setStatus('result-status', `予定 ${timeline.phases.reduce((n, p) => n + p.entries.length, 0)} 件、フェーズ ${timeline.phases.length} 件のタイムラインを作りました。`, 'ok');
}

function renderPreview(timeline) {
    const rows = [];
    for (const phase of timeline.phases) {
        if (timeline.phases.length > 1) {
            const tr = document.createElement('tr');
            const th = Object.assign(document.createElement('th'), { colSpan: 4, textContent: `${phase.id}${phase.name ? ` ${phase.name}` : ''}` });
            tr.append(th);
            rows.push(tr);
        }
        for (const e of phase.entries) {
            const tr = document.createElement('tr');
            for (const [text, cls] of [[e.t.toFixed(1), 'num'], [e.duration ? e.duration.toFixed(1) : '—', 'num'], [e.name, ''], [e.sync === false ? '表示だけ（詠唱なし）' : '同期', '']]) {
                tr.append(Object.assign(document.createElement('td'), { textContent: text, className: cls }));
            }
            rows.push(tr);
        }
    }
    $('preview').replaceChildren(...rows);
}

function download() {
    const url = URL.createObjectURL(new Blob([state.xml], { type: 'application/xml' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: state.fileName });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function useInPlayer() {
    const list = load(STORE_LOCAL, []).filter((t) => t.name !== state.fileName);
    list.push({ name: state.fileName, xml: state.xml });
    const ok = save(STORE_LOCAL, list);
    setStatus('result-status', ok
        ? `再生画面の「手元のファイル」に ${state.fileName} を入れました。同じコンテンツなら配信より優先して使われます。`
        : 'このブラウザでは保存できません。XML を保存して、再生画面で読み込んでください。', ok ? 'ok' : 'ng');
}

// ── 初期化 ──
async function init() {
    const keys = load(STORE_KEYS, null);
    if (keys) {
        $('key-id').value = keys.id ?? '';
        $('key-secret').value = keys.secret ?? '';
        setStatus('key-status', 'このブラウザに保存したキーを使います。', 'ok');
    }
    $('key-save').addEventListener('click', saveKeys);
    $('key-clear').addEventListener('click', clearKeys);
    $('report-load').addEventListener('click', loadReportFromUrl);
    $('report-url').addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            loadReportFromUrl();
        }
    });
    $('fight-select').addEventListener('change', loadFight);
    $('generate').addEventListener('click', generate);
    $('download').addEventListener('click', download);
    $('use-in-player').addEventListener('click', useInPlayer);
    try {
        state.contents = (await (await fetch('data/contents.json')).json()).contents;
    } catch {
        state.contents = [];
    }
    $('content-list').replaceChildren(...state.contents.map((c) => Object.assign(document.createElement('option'), { value: c.name })));
}

init();
