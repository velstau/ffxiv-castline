// 再生画面: ゲーム画面を読み、タイムライン（これから来る技と発動までの秒）を流して読み上げる。
import './storage-migrate.js';
import { FrameSource } from './capture.js';
import { TextDetector, TextRecognizer } from './ocr.js';
import { TimelineEngine } from './timeline-engine.js';
import { parseTimelineXml, parseTimelineIndex } from './timeline-xml.js';
import { readFrame, loadRegions } from './screen-reader.js';
import { Pip, pipSupported } from './pip.js';

// 配信するタイムラインの置き場所（index.xml とタイムラインの XML）。GitHub に置くときは raw の URL（末尾 /）に変える
const TIMELINE_BASE = new URL('timelines/', location.href).href;
const STORE_LOCAL = 'castline.player.local-timelines'; // [{ name, xml }]
const STORE_SETTINGS = 'castline.player.settings';
const INTERVAL_MS = 500;
const CONTENT_EVERY_MS = 5000; // コンテンツ名は戦闘外だけ、間引いて読む
const RENDER_EVERY_MS = 100;
const SPEAK_LATE_MAX_S = 2; // 読み上げる時刻をこれ以上過ぎた予定は読まない（同期で時刻が飛んだとき）
const UPCOMING_COUNT = 6;

const $ = (id) => document.getElementById(id);
const state = {
    ocr: null,
    source: null,
    running: false,
    contents: [], // コンテンツ名の候補（data/contents.json）
    cloud: [], // { file, content, title, timeline? }
    cloudError: '',
    local: [], // { name, xml, timeline }
    choice: 'auto', // 'auto' | 'cloud:<file>' | 'local:<name>'
    timeline: null,
    timelineLabel: '',
    engine: null,
    regions: null,
    regionsKey: '',
    detectedContent: null,
    lastContentAt: 0,
    lastCast: {}, // 読み取り元ごとに、最後に記録した技名（ログは変わったときだけ）
    spoken: new Set(),
    spokenStartAt: null,
    lastRender: 0,
};
const settings = { tts: true, lead: 5, ...load(STORE_SETTINGS, {}) };
const pip = new Pip();

// ── 保存（localStorage は使えない環境があるので、失敗しても動くようにする） ──
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
    } catch {
        // 保存できなくても、このページを開いている間は使える
    }
}

function clockText(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${Math.floor(date.getMilliseconds() / 100)}`;
}
function log(message, at = Date.now()) {
    const area = $('log');
    area.value += `${clockText(new Date(at))} ${message}\n`;
    area.scrollTop = area.scrollHeight;
}
function setStatus(id, text, kind = '') {
    $(id).textContent = text;
    $(id).className = `status ${kind}`.trim();
}

// ── モデル ──
async function loadModel() {
    const progress = $('model-progress');
    try {
        const got = {};
        const total = {};
        const onProgress = (name) => (received, size) => {
            got[name] = received;
            total[name] = size;
            const sumGot = Object.values(got).reduce((a, b) => a + b, 0);
            const sumTotal = Object.values(total).reduce((a, b) => a + b, 0);
            if (sumTotal) {
                progress.value = sumGot / sumTotal;
                setStatus('model-status', `文字認識のモデルをダウンロード中… ${(sumGot / 1e6).toFixed(1)} / ${(sumTotal / 1e6).toFixed(1)} MB`);
            }
        };
        const [recognizer, detector] = await Promise.all([
            TextRecognizer.load('models/ppocrv5_rec.onnx', 'models/ppocrv5_dict.txt', onProgress('rec')),
            TextDetector.load('models/ppocrv5_det.onnx', onProgress('det')),
        ]);
        state.ocr = { recognizer, detector };
        progress.hidden = true;
        setStatus('model-status', '文字認識の準備ができました。', 'ok');
    } catch (e) {
        setStatus('model-status', `文字認識のモデルを読み込めませんでした: ${e.message}`, 'ng');
    }
    updateButtons();
}

// ── タイムライン ──
async function loadCloudIndex() {
    try {
        const res = await fetch(new URL('index.xml', TIMELINE_BASE), { cache: 'no-cache' });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        state.cloud = parseTimelineIndex(await res.text());
        state.cloudError = '';
    } catch (e) {
        state.cloud = [];
        state.cloudError = `配信のタイムライン一覧を読めませんでした（${e.message}）。手元の XML は使えます。`;
    }
}

function loadLocal() {
    state.local = load(STORE_LOCAL, [])
        .map(({ name, xml }) => ({ name, xml, timeline: parseTimelineXml(xml).timeline }))
        .filter((t) => t.timeline);
}

function renderSelect() {
    const select = $('timeline-select');
    const option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
    const groups = [];
    if (state.local.length > 0) {
        const g = Object.assign(document.createElement('optgroup'), { label: '手元のファイル' });
        g.append(...state.local.map((t) => option(`local:${t.name}`, `${t.timeline.title ?? t.timeline.content}（${t.name}）`)));
        groups.push(g);
    }
    if (state.cloud.length > 0) {
        const g = Object.assign(document.createElement('optgroup'), { label: '配信' });
        g.append(...state.cloud.map((t) => option(`cloud:${t.file}`, t.title)));
        groups.push(g);
    }
    select.replaceChildren(option('auto', '読み取ったコンテンツ名から自動で選ぶ'), ...groups);
    select.value = [...select.options].some((o) => o.value === state.choice) ? state.choice : 'auto';
    state.choice = select.value;
    $('local-remove').disabled = !state.choice.startsWith('local:');
}

async function cloudTimeline(item) {
    if (!item.timeline) {
        const res = await fetch(new URL(item.file, TIMELINE_BASE), { cache: 'no-cache' });
        if (!res.ok) {
            throw new Error(`${item.file} を読めません（HTTP ${res.status}）`);
        }
        const { timeline, errors } = parseTimelineXml(await res.text());
        if (!timeline) {
            throw new Error(`${item.file} の形式に誤りがあります: ${errors.join(' / ')}`);
        }
        item.timeline = timeline;
    }
    return item.timeline;
}

// 選択（または読み取ったコンテンツ名）から使うタイムラインを決める。手元のファイルを配信より優先する
async function resolveTimeline() {
    let found = null;
    try {
        if (state.choice === 'auto') {
            const local = state.local.find((t) => t.timeline.content === state.detectedContent);
            const cloud = state.cloud.find((t) => t.content === state.detectedContent);
            if (local) {
                found = { timeline: local.timeline, label: `${local.timeline.title ?? local.timeline.content}（手元のファイル ${local.name}）` };
            } else if (cloud) {
                found = { timeline: await cloudTimeline(cloud), label: `${cloud.title}（配信）` };
            }
        } else if (state.choice.startsWith('local:')) {
            const local = state.local.find((t) => `local:${t.name}` === state.choice);
            found = local && { timeline: local.timeline, label: `${local.timeline.title ?? local.timeline.content}（手元のファイル ${local.name}）` };
        } else {
            const cloud = state.cloud.find((t) => `cloud:${t.file}` === state.choice);
            found = cloud && { timeline: await cloudTimeline(cloud), label: `${cloud.title}（配信）` };
        }
    } catch (e) {
        setStatus('timeline-status', e.message, 'ng');
        return;
    }
    if (found?.timeline === state.timeline) {
        return;
    }
    state.timeline = found?.timeline ?? null;
    state.timelineLabel = found?.label ?? '';
    state.engine = state.timeline
        ? new TimelineEngine(state.timeline, { hasEnmity: Boolean(state.regions?.enmity), log: (at, m) => log(m, at) })
        : null;
    state.spoken = new Set();
    state.spokenStartAt = null;
    if (state.timeline) {
        log(`タイムライン: ${state.timelineLabel}`);
    }
    renderTimelineStatus();
}

function renderTimelineStatus() {
    const content = state.detectedContent ? `読み取ったコンテンツ名: ${state.detectedContent}` : 'コンテンツ名はまだ読み取れていません';
    if (state.cloudError && !state.timeline) {
        setStatus('timeline-status', `${content}。${state.cloudError}`, 'ng');
    } else if (state.timeline) {
        setStatus('timeline-status', `${content}。使うタイムライン: ${state.timelineLabel}`, 'ok');
    } else if (state.choice === 'auto' && state.detectedContent) {
        setStatus('timeline-status', `${content}。このコンテンツのタイムラインはありません（手元の XML を読み込むか、一覧から選んでください）。`);
    } else {
        setStatus('timeline-status', `${content}。`);
    }
}

async function importLocal(files) {
    const list = load(STORE_LOCAL, []);
    const problems = [];
    for (const file of files) {
        const xml = await file.text();
        const { errors } = parseTimelineXml(xml);
        if (errors.length > 0) {
            problems.push(`${file.name}: ${errors.join(' / ')}`);
            continue;
        }
        const i = list.findIndex((t) => t.name === file.name);
        if (i >= 0) {
            list[i] = { name: file.name, xml };
        } else {
            list.push({ name: file.name, xml });
        }
        state.choice = `local:${file.name}`;
    }
    save(STORE_LOCAL, list);
    loadLocal();
    renderSelect();
    await resolveTimeline();
    if (problems.length > 0) {
        setStatus('timeline-status', `読み込めなかったファイルがあります: ${problems.join(' ／ ')}`, 'ng');
    }
}

async function removeLocal() {
    const name = state.choice.replace(/^local:/, '');
    save(STORE_LOCAL, load(STORE_LOCAL, []).filter((t) => t.name !== name));
    state.choice = 'auto';
    loadLocal();
    renderSelect();
    await resolveTimeline();
}

// ── 読み取り ──
function updateButtons() {
    $('start').disabled = state.running || !state.ocr;
    $('stop').disabled = !state.running;
    $('reset').disabled = !state.engine;
}

async function start() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
        setStatus('run-status', 'このページでは画面を取り込めません。https か localhost で開いてください。', 'ng');
        return;
    }
    try {
        state.source = await FrameSource.start(stop);
    } catch (e) {
        setStatus('run-status', `取り込みを始められませんでした（${e.name}）`, 'ng');
        return;
    }
    state.running = true;
    state.regionsKey = '';
    state.lastContentAt = 0;
    updateButtons();
    setStatus('run-status', '読み取り中です。', 'ok');
    log(`── 読み取り開始（取り込み ${state.source.method}）`);

    let nextAt = 0;
    while (state.running && state.source) {
        // 前回のフレームから 0.5 秒以上あとに届いたフレームを待つ（ゲームが前面だとタイマーが間引かれるので使わない）
        const grabbed = await state.source.grab(nextAt);
        if (!grabbed) {
            break;
        }
        nextAt = grabbed.at + INTERVAL_MS;
        try {
            if (state.running) {
                await tick(grabbed);
            }
        } catch (e) {
            log(`エラー: ${e.message}`);
        } finally {
            grabbed.bitmap.close();
        }
    }
}

function stop() {
    if (!state.running) {
        return;
    }
    state.running = false;
    state.source?.stop();
    state.source = null;
    updateButtons();
    setStatus('run-status', '止めました。');
    log('── 読み取り停止');
}

async function tick({ bitmap: frame, at }) {
    const key = `${frame.width}x${frame.height}`;
    if (key !== state.regionsKey) {
        state.regionsKey = key;
        state.regions = loadRegions(frame.width, frame.height);
        const names = Object.keys(state.regions);
        if (names.length === 0) {
            setStatus('run-status', `画面 ${key} の範囲がありません。試験ページ（lab.html）で、この解像度の画面の上で範囲を選んでください。`, 'ng');
        } else {
            setStatus('run-status', `読み取り中です（画面 ${key}、範囲 ${names.length} 種類${state.regions.enmity ? '' : '。敵対リストの範囲がないので、戦闘の終わりは判定しません'}）。`, 'ok');
        }
        if (state.engine) {
            state.engine.hasEnmity = Boolean(state.regions.enmity);
        }
    }
    const engine = state.engine;
    const inCombat = engine?.status(at).state === 'combat';
    const wantContent = !inCombat && at - state.lastContentAt >= CONTENT_EVERY_MS;
    if (wantContent) {
        state.lastContentAt = at;
    }
    const obs = await readFrame(state.ocr, frame, state.regions, {
        content: wantContent ? state.contents : null,
        countdown: !inCombat,
        // 技名は戦闘中だけ、いまの時刻の前後にある技に絞って照合する
        castCandidates: inCombat ? engine.castCandidates(at) : [],
    });

    if (obs.content?.decided && obs.content.decided !== state.detectedContent) {
        state.detectedContent = obs.content.decided;
        log(`コンテンツ名 ${obs.content.decided}`, at);
        if (state.choice === 'auto') {
            await resolveTimeline();
        }
        renderTimelineStatus();
    }
    if (engine && engine === state.engine) {
        if (obs.countdown?.started) {
            engine.started(at);
        } else if (obs.countdown) {
            engine.countdown(at, obs.countdown.seconds);
        }
        if ('hp' in obs) {
            engine.hpPercent(at, obs.hp);
        }
        if ('enmity' in obs) {
            engine.enmity(at, obs.enmity);
        }
        for (const cast of obs.casts) {
            if (cast.decided && state.lastCast[cast.source] !== cast.decided) {
                log(`詠唱（${cast.source === 'bar' ? '詠唱バー' : '敵対リスト'}） ${cast.decided}`, at);
            }
            state.lastCast[cast.source] = cast.decided;
            if (cast.decided) {
                engine.cast(at, cast.decided);
            }
        }
    }
    updateButtons();
    update(true);
}

// ── 表示と読み上げ ──
const STATE_TEXT = { idle: '待機中', countdown: 'カウントダウン', combat: '戦闘中', ended: '戦闘終了' };

function secondsText(s) {
    return s < 10 ? s.toFixed(1) : String(Math.ceil(s));
}
function combatClock(s) {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function buildView(now) {
    const engine = state.engine;
    if (!engine) {
        return { head: 'タイムラインがありません', sub: '一覧から選ぶか、コンテンツ名を読み取ると始まります', items: [] };
    }
    const s = engine.status(now);
    let sub = '';
    if (s.state === 'idle') {
        sub = 'カウントダウンか敵対リストで始まります';
    } else if (s.state === 'countdown') {
        sub = s.predictedStart ? `開始まで ${secondsText(Math.max(0, (s.predictedStart - now) / 1000))} 秒` : '';
    } else if (s.state === 'combat') {
        const phases = engine.timeline.phases.length > 1 ? `・${s.phase.name ?? s.phase.id}` : '';
        sub = `${combatClock(s.combatTime)}${phases}`;
    } else {
        sub = '次のカウントダウンか敵対リストで、また始まります';
    }
    const items = engine.upcoming(now, UPCOMING_COUNT).map((u) => ({
        in: u.hitIn > 0 ? secondsText(u.hitIn) : '発動',
        name: u.entry.label ? `${u.entry.name}（${u.entry.label}）` : u.entry.name,
        kind: u.hitIn <= 0 ? 'done' : u.castIn <= 0 ? 'casting' : '',
    }));
    return { head: STATE_TEXT[s.state], sub, items, status: s };
}

const PANEL_HTML = `
    <div class="tl-panel">
        <div class="tl-head"><span data-k="head"></span> <span class="tl-sub" data-k="sub"></span></div>
        <ol class="tl-list" data-k="list"></ol>
    </div>`;

function renderPanel(doc, view) {
    const panel = doc.querySelector('.tl-panel');
    if (!panel) {
        return;
    }
    panel.querySelector('[data-k="head"]').textContent = view.head;
    panel.querySelector('[data-k="sub"]').textContent = view.sub;
    panel.querySelector('[data-k="list"]').replaceChildren(...view.items.map((item) => {
        const li = doc.createElement('li');
        li.className = item.kind;
        const time = doc.createElement('span');
        time.className = 'tl-in';
        time.textContent = item.in;
        const name = doc.createElement('span');
        name.textContent = item.name;
        li.append(time, name);
        return li;
    }));
}

function speech(now) {
    const engine = state.engine;
    if (!settings.tts || !engine || engine.status(now).state !== 'combat') {
        return;
    }
    if (engine.startAt !== state.spokenStartAt) {
        // 新しい戦闘
        state.spokenStartAt = engine.startAt;
        state.spoken = new Set();
        pip.speak('戦闘開始');
    }
    for (const u of engine.upcoming(now, 20)) {
        const e = u.entry;
        const late = settings.lead - u.hitIn; // 読み上げる時刻（発動の lead 秒前）を何秒過ぎたか
        if (state.spoken.has(e) || late < 0) {
            continue;
        }
        state.spoken.add(e);
        if (late <= SPEAK_LATE_MAX_S && e.tts !== '') {
            pip.speak(e.tts ?? e.label ?? e.name);
        }
    }
}

// 表示の更新。ページの描画（表示中だけ動く）・小窓の描画・読み取りのたびに呼ばれるので、間引く
function update(force = false) {
    const now = Date.now();
    if (!force && now - state.lastRender < RENDER_EVERY_MS) {
        return;
    }
    state.lastRender = now;
    const view = buildView(now);
    renderPanel(document, view);
    if (pip.isOpen) {
        renderPanel(pip.win.document, view);
    }
    speech(now);
}

async function openPip() {
    if (!pipSupported()) {
        setStatus('run-status', 'このブラウザは小窓（Document Picture-in-Picture）に対応していません。Chrome か Edge の新しい版で開いてください。', 'ng');
        return;
    }
    await pip.open({ width: 380, height: 300, html: PANEL_HTML, onFrame: () => update() });
    update(true);
}

function reset() {
    state.engine?.reset();
    state.spoken = new Set();
    state.spokenStartAt = null;
    log('リセット');
    update(true);
}

// ── 初期化 ──
async function init() {
    $('panel').innerHTML = PANEL_HTML;
    $('tts').checked = settings.tts;
    $('lead').value = settings.lead;
    $('tts').addEventListener('change', () => {
        settings.tts = $('tts').checked;
        save(STORE_SETTINGS, settings);
    });
    $('lead').addEventListener('change', () => {
        const lead = Number($('lead').value);
        settings.lead = Number.isFinite(lead) ? Math.min(30, Math.max(0, lead)) : 5;
        $('lead').value = settings.lead;
        save(STORE_SETTINGS, settings);
    });
    $('tts-test').addEventListener('click', () => pip.speak('読み上げの試験です'));
    $('start').addEventListener('click', start);
    $('stop').addEventListener('click', stop);
    $('reset').addEventListener('click', reset);
    $('pip-open').addEventListener('click', openPip);
    $('timeline-select').addEventListener('change', async () => {
        state.choice = $('timeline-select').value;
        $('local-remove').disabled = !state.choice.startsWith('local:');
        await resolveTimeline();
        updateButtons();
    });
    $('local-file').addEventListener('change', async (ev) => {
        await importLocal([...ev.target.files]);
        ev.target.value = '';
        updateButtons();
    });
    $('local-remove').addEventListener('click', removeLocal);
    $('log-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText($('log').value);
        } catch {
            $('log').focus();
            $('log').select();
        }
    });

    try {
        state.contents = (await (await fetch('data/contents.json')).json()).contents.map((c) => c.name);
    } catch {
        state.contents = [];
    }
    loadLocal();
    await loadCloudIndex();
    renderSelect();
    renderTimelineStatus();
    const loop = () => {
        update();
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    loadModel();
}

init();
