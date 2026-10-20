// 再生画面: ゲーム画面を読み、タイムライン（これから来る技と発動までの秒）を流して読み上げる。
import './storage-migrate.js';
import { FrameSource } from './capture.js';
import { TextDetector, TextRecognizer } from './ocr.js';
import { TimelineEngine, castNames } from './timeline-engine.js';
import { parseTimelineXml, parseTimelineIndex } from './timeline-xml.js';
import { readFrame, checkRegion, findContent, scanLines, tilesOf } from './screen-reader.js';
import {
    countdownSearchArea, findCountdownLine, countdownRegionFrom, classifyCombatLines, castSearchAreaNear,
} from './region-finder.js';
import { REGION_KINDS, regionsFor, setRegion, missingRegions, exportRegions, importRegions, loadAll, screenKey } from './regions.js';
import { RegionEditor } from './region-editor.js';
import { Pip, pipSupported } from './pip.js';

// 配信するタイムラインの置き場所（index.xml とタイムラインの XML）。GitHub のリポジトリの main を正とし、
// 読めないときはサイトに同梱した写しを使う。?timelines=site でサイトの写しだけを読む（手元で直した XML の確認用）
const TIMELINE_GITHUB = 'https://raw.githubusercontent.com/velstau/ffxiv-castline/main/public/timelines/';
const TIMELINE_SITE = new URL('timelines/', location.href).href;
const TIMELINE_BASES = new URLSearchParams(location.search).get('timelines') === 'site' ? [TIMELINE_SITE] : [TIMELINE_GITHUB, TIMELINE_SITE];
const STORE_LOCAL = 'castline.player.local-timelines'; // [{ name, xml }]
const STORE_SETTINGS = 'castline.player.settings';
const INTERVAL_MS = 500;
const CONTENT_EVERY_MS = 5000; // コンテンツ名は戦闘外だけ、間引いて読む
// コンテンツ名の範囲があるのにこれだけ読めなければ、範囲がずれているかもしれないとログに出す（範囲があると自動では探さないため）
const CONTENT_MISS_WARN_MS = 60000;
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
    cloudBase: '', // 一覧を読めた置き場所（タイムラインの XML も同じ所から読む）
    local: [], // { name, xml, timeline }
    choice: 'auto', // 'auto' | 'cloud:<file>' | 'local:<name>'
    timeline: null,
    timelineLabel: '',
    engine: null,
    regions: null,
    regionsKey: '',
    detectedContent: null,
    lastContentAt: 0,
    contentMissSince: null,
    contentMissWarned: false,
    regionsLogged: '',
    lastCast: {}, // 読み取り元ごとに、最後に記録した技名（ログは変わったときだけ）
    spoken: new Set(),
    spokenStartAt: null,
    lastRender: 0,
};
const settings = { tts: true, lead: 5, autoRegions: true, ...load(STORE_SETTINGS, {}) };
const pip = new Pip();
let editor = null; // 範囲の設定（RegionEditor）

// 文字認識は 1 つずつ順に行う（読み取りの繰り返しと、範囲の設定の試し読み・自動判定が同じモデルを並行して使わないように）
let ocrQueue = Promise.resolve();
function withOcr(fn) {
    const run = ocrQueue.then(fn);
    ocrQueue = run.catch(() => {});
    return run;
}

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

// 別名つきの技名（「A|B」）の表示
const showName = (name) => castNames(name).join('／');

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
    const failures = [];
    for (const base of TIMELINE_BASES) {
        try {
            const res = await fetch(new URL('index.xml', base), { cache: 'no-cache' });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            state.cloud = parseTimelineIndex(await res.text());
            state.cloudBase = base;
            state.cloudError = '';
            if (failures.length > 0) {
                log(`GitHub の一覧を読めなかったので（${failures.join(' / ')}）、サイトの写しを使います。最新でない場合があります。`);
            }
            return;
        } catch (e) {
            failures.push(e.message);
        }
    }
    state.cloud = [];
    state.cloudBase = '';
    state.cloudError = `配信のタイムライン一覧を読めませんでした（${failures.join(' / ')}）。手元の XML は使えます。`;
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
        const res = await fetch(new URL(item.file, state.cloudBase), { cache: 'no-cache' });
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
    $('regions-grab').disabled = !state.running;
    $('regions-find').disabled = !state.ocr || !editor?.frame;
}

// ── 読む範囲 ──

// 指定していない範囲と、そのためにできないこと（画面の大きさは取り込み中の画面、無ければ範囲の設定に使っている画面）
function renderMissing() {
    const size = state.frameSize ?? (editor?.frame && { width: editor.frame.width, height: editor.frame.height });
    if (!size) {
        $('regions-missing').textContent = '';
        return;
    }
    const missing = missingRegions(regionsFor(size.width, size.height));
    $('regions-missing').textContent = missing.length === 0
        ? `画面 ${screenKey(size.width, size.height)} の範囲はすべて指定してあります。`
        : `画面 ${screenKey(size.width, size.height)} で未指定: ${missing.map((m) => `${m.label}（${m.lost}）`).join('、')}`;
    $('regions-missing').className = `status ${missing.length === 0 ? 'ok' : 'ng'}`;
}

function regionsChanged() {
    state.regionsKey = ''; // 次のフレームで読み直す
    renderMissing();
    updateButtons();
}

async function grabForRegions() {
    const grabbed = await state.source?.grab(0);
    if (!grabbed) {
        return;
    }
    editor.setFrame(grabbed.bitmap); // 範囲の設定が持つ（次に替えたときに閉じる）
    setStatus('regions-status', `いまのゲーム画面（${screenKey(grabbed.bitmap.width, grabbed.bitmap.height)}）を使います。`, 'ok');
    regionsChanged();
}

async function imageForRegions(file) {
    try {
        editor.setFrame(await createImageBitmap(file));
    } catch {
        setStatus('regions-status', `${file.name} を画像として読めませんでした。`, 'ng');
        return;
    }
    const key = screenKey(editor.frame.width, editor.frame.height);
    setStatus('regions-status', `${file.name}（${key}）を使います。取り込む画面と大きさが違うと、ここで指定した範囲は使われません。`, 'ok');
    regionsChanged();
}

async function findContentRegion() {
    const frame = editor.frame;
    $('regions-find').disabled = true;
    try {
        const found = await withOcr(() => findContent(state.ocr, frame, state.contents,
            (done, total) => setStatus('regions-status', `コンテンツ名を探しています… ${done}/${total}`)));
        if (!found) {
            setStatus('regions-status', '見つかりませんでした。コンテンツの中で、画面に「コンテンツ情報」が出ている状態の画面で試してください。', 'ng');
            return;
        }
        setRegion(frame.width, frame.height, 'content', found.rect);
        editor.refresh();
        editor.select('content');
        setStatus('regions-status', `「${found.name}」を見つけ、その行を長い名前も入る幅に広げて保存しました。拡大図で確かめ、ずれていれば直してください。`, 'ok');
        regionsChanged();
    } finally {
        updateButtons();
    }
}

function exportRegionsFile() {
    const all = loadAll();
    if (Object.keys(all).length === 0) {
        setStatus('regions-status', '書き出す範囲がありません。', 'ng');
        return;
    }
    const url = URL.createObjectURL(new Blob([exportRegions(all)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: 'castline-regions.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('regions-status', `範囲を castline-regions.json に書き出しました（画面 ${Object.keys(all).join('・')}）。`, 'ok');
}

async function importRegionsFile(file) {
    const { screens, errors } = importRegions(await file.text());
    if (errors.length > 0) {
        setStatus('regions-status', `${file.name} を読み込めませんでした: ${errors.join(' / ')}`, 'ng');
        return;
    }
    editor.refresh();
    const size = state.frameSize ?? editor.frame;
    const current = size && screenKey(size.width, size.height);
    setStatus('regions-status', `${file.name} から画面 ${screens.join('・')} の範囲を読み込みました。`
        + (current && !screens.includes(current) ? `いまの画面（${current}）の範囲は入っていません。` : ''), current && !screens.includes(current) ? 'ng' : 'ok');
    regionsChanged();
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
    Object.assign(state, { contentMissSince: null, contentMissWarned: false, regionsLogged: '' });
    updateButtons();
    setStatus('run-status', '読み取り中です。', 'ok');
    log(`── 読み取り開始（取り込み ${state.source.method}）`);
    autoFindLoop(state.source);

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
    state.frameSize = null; // 範囲の設定は、止めたあとは指定に使っている画面の大きさで見る
    updateButtons();
    setStatus('run-status', '止めました。');
    log('── 読み取り停止');
}

async function tick({ bitmap: frame, at }) {
    const key = `${frame.width}x${frame.height}`;
    if (key !== state.regionsKey) {
        state.regionsKey = key;
        state.regions = regionsFor(frame.width, frame.height);
        state.frameSize = { width: frame.width, height: frame.height };
        const names = Object.keys(state.regions);
        if (names.length === 0) {
            setStatus('run-status', settings.autoRegions
                ? `画面 ${key} の範囲はまだありません。画面に出たものから自動で探します（下の「読む範囲」）。`
                : `画面 ${key} の範囲がありません。下の「読む範囲」で「いまのゲーム画面を使う」を押して指定してください。`, 'ng');
        } else {
            setStatus('run-status', `読み取り中です（画面 ${key}、範囲 ${names.length} 種類）。`, 'ok');
        }
        renderMissing();
        if (state.engine) {
            state.engine.hasEnmity = Boolean(state.regions.enmity);
        }
        // どの範囲を使い、どれを自動で探すかをログに残す（変わったときだけ）
        const labels = (ids) => ids.map((id) => REGION_KINDS.find((k) => k.id === id).label).join('・') || 'なし';
        const absent = REGION_KINDS.map((k) => k.id).filter((id) => !state.regions[id]);
        const summary = `画面 ${key}: 指定済みの範囲 ${labels(names)}`
            + (absent.length === 0 ? '' : settings.autoRegions ? `／自動で探す ${labels(absent)}` : `／未指定 ${labels(absent)}（自動で探すのは切ってあります）`);
        if (summary !== state.regionsLogged) {
            state.regionsLogged = summary;
            log(summary, at);
        }
    }
    const engine = state.engine;
    const inCombat = engine?.status(at).state === 'combat';
    const wantContent = !inCombat && at - state.lastContentAt >= CONTENT_EVERY_MS;
    if (wantContent) {
        state.lastContentAt = at;
    }
    const obs = await withOcr(() => readFrame(state.ocr, frame, state.regions, {
        content: wantContent ? state.contents : null,
        countdown: !inCombat,
        // 技名は戦闘中だけ、いまの時刻の前後にある技に絞って照合する
        castCandidates: inCombat ? engine.castCandidates(at) : [],
    }));

    if (wantContent && state.regions.content && !state.detectedContent && !state.contentMissWarned) {
        if (obs.content?.decided) {
            state.contentMissSince = null;
        } else if (state.contentMissSince === null) {
            state.contentMissSince = at;
        } else if (at - state.contentMissSince >= CONTENT_MISS_WARN_MS) {
            state.contentMissWarned = true;
            log(`コンテンツ名の範囲を ${CONTENT_MISS_WARN_MS / 1000} 秒読めていません（読めた文字: ${obs.content?.text || 'なし'}）。`
                + 'コンテンツの中なら範囲がずれています。「読む範囲」でコンテンツ名を選んで「この範囲を消す」を押すと、自動で探し直します', at);
        }
    }
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

// ── 範囲の自動指定 ──
// 取り込み中、まだ無い範囲を画面に出たものから探して保存する（読み取りとは別のフレームで、間を空けて行う）。
// コンテンツ名は入った直後、カウントダウンは告知が出たとき、HP・敵対リスト・詠唱バーは殴って戦闘になってから見つかる。
// 文字認識は区画ごとに順番待ちするので、探している間も読み取りは止まらない（間隔は空く）。
const AUTO_EVERY_MS = 1000;
const AUTO_CONTENT_EVERY_MS = 5000;
const AUTO_FULL_EVERY_MS = 6000; // 画面全体を読む間隔（数秒かかる）
// 戦闘外の間隔。HP の % は殴ったあとにしか出ないので戦闘外は間を空けるが、止めはしない
// （敵対リストもカウントダウンも無いと、殴っても戦闘になったと分からないため）
const AUTO_FULL_IDLE_EVERY_MS = 15000;
const AUTO_NEAR_EVERY_MS = 2000; // 詠唱バーだけ残ったら、HP の近くを短い間隔で読む（詠唱は数秒で消えるため）
const auto = { lastContent: 0, lastFull: 0, lastNear: 0, enemyName: null };

// タイムラインの技名のうち、詠唱バーに出るもの（詠唱のある技）
function timelineCasts() {
    const names = new Set();
    for (const phase of state.timeline?.phases ?? []) {
        for (const e of phase.entries) {
            if (e.duration > 0 && e.sync !== false) {
                castNames(e.name).forEach((n) => names.add(n));
            }
        }
    }
    return [...names];
}

async function autoFindLoop(source) {
    Object.assign(auto, { lastContent: 0, lastFull: 0, lastNear: 0 });
    let nextAt = 0;
    while (state.running && state.source === source) {
        const grabbed = await source.grab(nextAt);
        if (!grabbed) {
            break;
        }
        nextAt = grabbed.at + AUTO_EVERY_MS;
        try {
            if (settings.autoRegions && state.ocr) {
                await autoFindStep(grabbed.bitmap, grabbed.at, source);
            }
        } catch (e) {
            log(`範囲の自動指定でエラー: ${e.message}`);
        } finally {
            grabbed.bitmap.close();
        }
    }
}

async function autoFindStep(frame, at, source) {
    const { width, height } = frame;
    const regions = regionsFor(width, height);
    const live = () => state.running && state.source === source && settings.autoRegions;
    const found = [];
    const store = (id, rect, label) => {
        setRegion(width, height, id, rect);
        found.push(label);
    };
    const status = state.engine?.status(at).state;

    if (!regions.content && at - auto.lastContent >= AUTO_CONTENT_EVERY_MS) {
        auto.lastContent = at;
        const hit = await findContent(state.ocr, frame, state.contents, undefined, { lock: withOcr });
        if (hit && live()) {
            store('content', hit.rect, `コンテンツ名（${hit.name}）`);
        }
    }
    if (!regions.countdown && status !== 'combat' && live()) {
        const lines = await withOcr(() => scanLines(state.ocr, frame, countdownSearchArea(width, height)));
        const line = findCountdownLine(lines);
        if (line && live()) {
            store('countdown', countdownRegionFrom(line, width, height), 'カウントダウン');
        }
    }

    const casts = timelineCasts();
    const want = new Set(['hp', 'enmity', 'cast'].filter((id) => !regions[id] && (id !== 'cast' || casts.length > 0)));
    // カウントダウン中は読み取りを優先する（開始の時刻を外さないため）
    if (want.size > 0 && status !== 'countdown' && live()) {
        const longestCast = Math.max(1, ...casts.map((n) => [...n].length));
        let lines = null;
        if (want.size === 1 && want.has('cast') && regions.hp && at - auto.lastNear >= AUTO_NEAR_EVERY_MS) {
            auto.lastNear = at;
            lines = await withOcr(() => scanLines(state.ocr, frame, castSearchAreaNear(regions.hp, width, height), casts));
        } else if (at - auto.lastFull >= (status === 'combat' || !state.engine ? AUTO_FULL_EVERY_MS : AUTO_FULL_IDLE_EVERY_MS)) {
            auto.lastFull = at;
            lines = [];
            for (const tile of tilesOf(frame)) {
                if (!live()) {
                    return;
                }
                const part = await withOcr(() => scanLines(state.ocr, frame, tile, want.has('cast') ? casts : []));
                // 区画の重なりで同じ行を 2 回読んだものは 1 つにする
                lines.push(...part.filter((l) => !lines.some((o) => o.text === l.text
                    && Math.abs(o.x - l.x) < l.h && Math.abs(o.y - l.y) < l.h / 2)));
            }
        }
        if (lines && live()) {
            const r = classifyCombatLines(lines, { want, width, height, longestCast, hpRect: regions.hp ?? null, enemyName: auto.enemyName });
            auto.enemyName = r.enemyName ?? auto.enemyName;
            if (r.hp) {
                store('hp', r.hp.rect, r.hp.focus ? 'HP（フォーカスターゲット）' : `HP${r.hp.others > 0 ? '（ターゲット）' : ''}`);
            }
            if (r.enmity) {
                store('enmity', r.enmity.rect, '敵対リスト');
            }
            if (r.cast) {
                store('cast', r.cast.rect, `詠唱バー（${r.cast.name}）`);
            }
        }
    }

    if (found.length > 0) {
        log(`範囲を自動で指定: ${found.join('・')}`, at);
        setStatus('regions-status', `画面 ${screenKey(width, height)} の ${found.join('・')} を自動で指定しました。`
            + 'ずれていれば下で直してください（「この範囲を消す」で消すと、また自動で探します）。', 'ok');
        if (editor.frame?.width === width && editor.frame?.height === height) {
            editor.refresh();
        }
        regionsChanged();
    }
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
        name: u.entry.label ? `${showName(u.entry.name)}（${u.entry.label}）` : showName(u.entry.name),
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
            pip.speak(e.tts ?? showName(e.name)); // text は表示だけ。tts が無ければ技名を読む（Hojoring の notice と text と同じ分け方）
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
    editor = new RegionEditor($('region-editor'), {
        check: (id, rect, frame) => (state.ocr
            ? withOcr(() => checkRegion(state.ocr, frame, id, rect, state.contents))
            : Promise.resolve({ ok: null, text: '文字認識のモデルを読み込み中です' })),
        onChange: regionsChanged,
    });
    $('regions-auto').checked = settings.autoRegions;
    $('regions-auto').addEventListener('change', (ev) => {
        settings.autoRegions = ev.target.checked;
        save(STORE_SETTINGS, settings);
    });
    $('regions-grab').addEventListener('click', grabForRegions);
    $('regions-image').addEventListener('change', async (ev) => {
        if (ev.target.files[0]) {
            await imageForRegions(ev.target.files[0]);
        }
        ev.target.value = '';
    });
    $('regions-find').addEventListener('click', findContentRegion);
    $('regions-export').addEventListener('click', exportRegionsFile);
    $('regions-import').addEventListener('change', async (ev) => {
        if (ev.target.files[0]) {
            await importRegionsFile(ev.target.files[0]);
        }
        ev.target.value = '';
    });
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
