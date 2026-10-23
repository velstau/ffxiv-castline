// 動画ファイルか画面共有から詠唱を記録する画面。いまのタイムラインの詠唱時間を記録に合わせて直すか、記録から新しいタイムラインの下書きを作る。
// 映像はこのブラウザの中だけで読む（どこへも送らない）。読む範囲は初期設定の画面で指定した「詠唱バー（技名）」（画面の大きさごと）。
import './storage-migrate.js';
import { OcrClient } from './ocr-client.js';
import { VideoFrameSource } from './video-source.js';
import { ScreenFrameSource } from './screen-source.js';
import { regionsFor } from './regions.js';
import { TimelineEngine } from './timeline-engine.js';
import { isBlackFrame } from './blackout.js';
import { Pip, pipSupported } from './pip.js';
import { combineCandidates } from './readers.js';
import { castNamesOf } from './region-auto.js';
import { STORE_LOCAL, loadTimelineIndex, fetchTimeline, loadLocalTimelines } from './timeline-source.js';
import { toTimelineXml } from './timeline-xml.js';
import {
    normalizeRead, snapRead, decideName, CastTracker, mergeSplitCasts, matchTimeline, summarizeDurations, applyDurations, draftTimeline,
    SNAP_MISS_ANY, SNAP_MISS_OWN, WATCH_TIMELINE, killSuspected, falseStart, FALSE_START_OFF_MS,
} from './cast-recorder.js';

const STEP_S = 0.1; // コマどうしの間隔（動画の秒）の目安。出始め・消えたの時刻はこの間隔で決まる

const $ = (id) => document.getElementById(id);
const state = {
    ocr: null,
    source: null, // VideoFrameSource | ScreenFrameSource
    clock: '動画', // 記録の時刻が何の秒か: '動画'（動画の秒）・'記録'（画面共有で手で始めてからの秒）・'戦闘'（戦闘開始からの秒）
    live: null, // 画面共有の見張り（startWatching）
    rec: null, // 画面共有で記録中のもの（beginLive）
    targets: new Map(), // 直すタイムラインの選択肢の値 → { promise, ready }（戦闘の始まりで待たずに使えるよう、選んだときに読んでおく）
    autoContent: '', // 画面から読んで入れたコンテンツ名（利用者が書き換えたら上書きしない）
    autoTimeline: '', // 画面から読んで選んだタイムライン
    contentNames: [],
    lastSummary: null,
    pip: new Pip(),
    rect: null, // 詠唱バー（技名）の範囲
    index: { items: [], base: '' },
    local: [],
    contents: [],
    allNames: [], // data/castnames.json（新しいタイムラインで寄せる先）
    running: false,
    casts: [],
    result: null, // { kind:'fix', timeline, summary, file } | { kind:'new', casts }
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
const mode = () => document.querySelector('input[name="mode"]:checked').value;
const inputKind = () => document.querySelector('input[name="input"]:checked').value;
const sharing = () => state.source instanceof ScreenFrameSource;
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const cell = (text, className = '') => Object.assign(document.createElement('td'), { textContent: text, className });

function updateButtons() {
    // コンテンツ名は無くても始められる（画面から読むか、後で入れる。無ければファイル名は recorded.xml）
    const ready = state.ocr && state.source && state.rect && !state.running && (mode() === 'new' || $('timeline-select').value !== '');
    $('rec-start').disabled = !ready;
    $('rec-stop').disabled = !state.running;
    $('video-file').disabled = state.running;
    $('screen-start').disabled = state.running || sharing();
    $('screen-stop').disabled = !sharing();
    $('pip-open').disabled = !sharing();
    document.querySelectorAll('input[name="input"]').forEach((r) => {
        r.disabled = state.running;
    });
}

// ── 文字認識のモデル ──
async function loadModels() {
    try {
        const url = (path) => new URL(path, location.href).href;
        state.ocr = await OcrClient.load({ rec: url('models/ppocrv5_rec.onnx'), dict: url('models/ppocrv5_dict.txt'), det: url('models/ppocrv5_det.onnx') });
        setStatus('model-status', '文字認識の準備ができました。', 'ok');
    } catch (e) {
        setStatus('model-status', `文字認識のモデルを読み込めませんでした: ${e.message}`, 'ng');
    }
    updateButtons();
}

// ── 映像と範囲 ──
function closeSource() {
    finishLive();
    state.live = null;
    state.source?.close();
    state.source = null;
    state.rect = null;
    $('video-box').replaceChildren();
    $('video-box').hidden = true;
    $('region-help').hidden = true;
    setStatus('video-status', '');
}

function switchInput() {
    closeSource();
    const screen = inputKind() === 'screen';
    $('file-field').hidden = screen;
    $('screen-field').hidden = !screen;
    document.querySelectorAll('.file-only').forEach((el) => {
        el.hidden = screen;
    });
    $('region-help-file').hidden = screen;
    $('region-help-screen').hidden = !screen;
    $('video-file').value = '';
    updateButtons();
}

// 共有の確認はボタンのクリックの中でしか出せないので、ほかの読み込みを待たずにすぐ呼ぶ
async function openScreen() {
    closeSource();
    setStatus('video-status', '共有する画面を選んでください…');
    let source;
    try {
        source = await ScreenFrameSource.open(() => {
            // ブラウザの「共有を停止」。記録中なら記録の終わりで片づける
            if (!state.running && state.source === source) {
                closeSource();
                setStatus('video-status', '画面の共有が終わりました。');
                updateButtons();
            }
        }, () => setStatus('video-status', '共有した画面の最初のコマを待っています…（ゲームの画面が動いていれば、すぐに届きます）'));
    } catch (e) {
        setStatus('video-status', e.name === 'NotAllowedError' ? '画面の共有を取りやめました。' : `画面を共有できませんでした: ${e.message}`, 'ng');
        updateButtons();
        return;
    }
    state.source = source;
    loadRegion();
    startWatching(source);
    renderLive();
}

function closeScreen() {
    const running = state.running;
    closeSource();
    setStatus('video-status', running ? '画面の共有をやめました（記録はここまでで終えます）。' : '画面の共有をやめました。');
    updateButtons();
}

async function openVideo(file) {
    state.source?.close();
    state.source = null;
    $('video-box').replaceChildren();
    $('video-box').hidden = true;
    try {
        state.source = await VideoFrameSource.open(file);
    } catch (e) {
        setStatus('video-status', e.message, 'ng');
        updateButtons();
        return;
    }
    const { video } = state.source;
    video.controls = true;
    $('video-box').append(video);
    $('video-box').hidden = false;
    $('range-to').placeholder = String(Math.floor(state.source.duration));
    loadRegion();
}

function loadRegion() {
    const source = state.source;
    if (!source) {
        return;
    }
    state.rect = regionsFor(source.width, source.height).cast ?? null;
    const about = sharing()
        ? `共有している画面 ${source.width}x${source.height}${source.method === 'MediaStreamTrackProcessor' ? '' : `（取り込み: ${source.method}）`}`
        : `動画 ${source.width}x${source.height}・${fmt(source.duration)}`;
    if (state.rect) {
        setStatus('video-status', `${about}。詠唱バー（技名）の範囲: x ${state.rect.x}・y ${state.rect.y}・幅 ${state.rect.w}・高さ ${state.rect.h}`, 'ok');
    } else {
        setStatus('video-status', `${about}。この大きさの「詠唱バー（技名）」の範囲がまだありません。`, 'ng');
    }
    $('region-help').hidden = Boolean(state.rect);
    updateButtons();
}

async function saveFrame() {
    const { video } = state.source;
    const bitmap = await state.source.frameAt(video.currentTime);
    const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `castline-frame-${Math.round(video.currentTime)}s.png` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ── タイムラインの一覧 ──
async function loadTimelines() {
    state.index = await loadTimelineIndex();
    state.local = loadLocalTimelines();
    const options = [Object.assign(document.createElement('option'), { value: '', textContent: '選んでください' })];
    for (const t of state.local) {
        options.push(Object.assign(document.createElement('option'), { value: `local:${t.name}`, textContent: `手元: ${t.name}` }));
    }
    for (const item of state.index.items) {
        options.push(Object.assign(document.createElement('option'), { value: `cloud:${item.file}`, textContent: item.title }));
    }
    $('timeline-select').replaceChildren(...options);
    if (state.index.error) {
        setStatus('rec-status', state.index.error, 'ng');
    }
}

async function selectedTimeline(value = $('timeline-select').value) {
    if (value.startsWith('local:')) {
        const name = value.slice('local:'.length);
        return { timeline: state.local.find((t) => t.name === name).timeline, file: name };
    }
    const file = value.slice('cloud:'.length);
    const item = state.index.items.find((i) => i.file === file);
    return { timeline: await fetchTimeline(item, state.index.base), file };
}

// 選んだタイムラインを読んでおく（戦闘の始まりで自動で記録を始めるときは待てないため）
function prefetchTarget() {
    const value = $('timeline-select').value;
    if (!value) {
        return Promise.resolve(null);
    }
    let entry = state.targets.get(value);
    if (!entry) {
        entry = { promise: selectedTimeline(value), ready: null };
        state.targets.set(value, entry);
        entry.promise.then((t) => {
            entry.ready = t;
        }, () => state.targets.delete(value));
    }
    return entry.promise;
}

// ── 記録（共通） ──
// 寄せる先の技名: 直すときはそのタイムラインの技名、新しく作るときは配信の全技名
function snapping(target) {
    return target ? { candidates: castNamesOf(target.timeline), maxMiss: SNAP_MISS_OWN } : { candidates: state.allNames, maxMiss: SNAP_MISS_ANY };
}

function addCasts(closed, { candidates, maxMiss }) {
    for (const cast of closed) {
        const item = { ...cast, ...decideName(cast.reads, candidates, maxMiss) };
        state.casts.push(item);
        renderCast(item);
    }
}

// 記録の時刻が何の秒か（state.clock）の見出し
const clockHead = () => (state.clock === '戦闘' ? '戦闘開始からの秒' : `${state.clock}の秒`);

// 記録を始めた: 一覧と結果を空にする。clock: '動画' | '記録' | '戦闘'
function beginView(clock) {
    state.clock = clock;
    $('casts-time-head').textContent = clockHead();
    state.casts = [];
    state.result = null;
    $('casts').replaceChildren();
    $('casts-box').hidden = false;
    $('result-section').hidden = true;
}

// 記録を終えた: 読みが途中で割れた同じ技名の詠唱をつなぎ、一覧を出し直して結果を出す
function finishView(target) {
    state.lastTarget = target;
    state.casts = mergeSplitCasts(state.casts);
    $('casts').replaceChildren();
    state.casts.forEach(renderCast);
    if (state.casts.length === 0) {
        setStatus('rec-status', '詠唱を 1 回も読めませんでした。範囲が詠唱バーの技名に合っているか、初期設定の画面で確かめてください。', 'ng');
        $('casts-box').hidden = true;
        state.lastSummary = '前回の記録: 詠唱なし';
        return;
    }
    if (!$('rec-status').classList.contains('ng')) {
        setStatus('rec-status', `記録しました（詠唱 ${state.casts.length} 回）。`, 'ok');
    }
    state.lastSummary = `前回の記録: 詠唱 ${state.casts.length} 回`;
    if (target) {
        showFix(target);
    } else {
        showNew();
    }
}

// ── 記録（動画ファイル） ──
async function start() {
    if (sharing()) {
        await startLiveManually();
        return;
    }
    let target = null;
    try {
        target = mode() === 'fix' ? await selectedTimeline() : null;
    } catch (e) {
        setStatus('rec-status', e.message, 'ng');
        return;
    }
    const snap = snapping(target);
    const source = state.source;
    const from = Math.max(0, Number($('range-from').value) || 0);
    const to = $('range-to').value === '' ? source.duration : Math.min(source.duration, Number($('range-to').value));
    beginView('動画');
    state.running = true;
    $('rec-progress').hidden = false;
    source.video.controls = false;
    updateButtons();
    setStatus('rec-status', '記録しています…');

    const tracker = new CastTracker();
    const rect = state.rect;
    let last = from;
    try {
        await source.run(async (bitmap, at) => {
            const read = await state.ocr.readCastFree(bitmap, rect);
            addCasts(tracker.push(at, { text: snapRead(normalizeRead(read.text), snap.candidates, snap.maxMiss), conf: read.conf }), snap);
            last = at;
        }, {
            from, to, step: STEP_S,
            onProgress: (at, rate) => {
                $('rec-progress').value = (at - from) / Math.max(1e-3, to - from);
                setStatus('rec-status', `記録しています… 動画 ${fmt(at)} / ${fmt(to)}（${rate.toFixed(1)} 倍速）・詠唱 ${state.casts.length} 回`);
            },
        });
        addCasts(tracker.finish(last), snap);
    } catch (e) {
        setStatus('rec-status', `記録を続けられませんでした: ${e.message}`, 'ng');
    }
    state.running = false;
    source.video.controls = true;
    $('rec-progress').hidden = true;
    updateButtons();
    finishView(target);
}

function stop() {
    if (sharing()) {
        stopLive();
        return;
    }
    state.source?.stop();
}

// ── 記録（画面共有） ──
// 共有している間はコマを受け取り続け、記録中なら詠唱バーを読む。あわせて戦闘の始まり・終わりとコンテンツ名を見張る（watch）。
// 戦闘の判定は再生画面と同じ TimelineEngine に、予定の無い空のタイムラインで任せる（カウントダウン・「戦闘開始！」・敵対リストで始まり、
// 暗転で全滅、HP 3% 以下の後に敵対リストが消えたら討伐）。engine の時刻は ms（定数が ms のため。ここで秒から直す）
const WATCH_EVERY_S = 0.5;
const WATCH_REC_EVERY_S = 1; // 記録中は詠唱バーの読み取りを優先して、見張りの間を空ける
const CONTENT_EVERY_S = 5; // コンテンツ名が決まった後に読み直す間隔（別のコンテンツに入ったとき）
const CONTENT_RETRY_S = 1;
const CONTENT_COMBINE = 5; // 1 回で決まらないコンテンツ名の読みを、この回数まで足し合わせる（再生画面と同じ）
const LIVE_RENDER_EVERY_S = 0.5;
const LIVE_LOG_MAX = 80;

function startWatching(source) {
    const live = {
        source,
        engine: new TimelineEngine(WATCH_TIMELINE, { hasEnmity: false, log: (ms, message) => liveLog(live, ms / 1000, message) }),
        lastAt: 0, lastWatch: -Infinity, lastRender: -Infinity, lastContentRead: -Infinity,
        contentReads: [], content: null, fps: 0, status: null, declined: null, missing: [], black: false, enmity: null,
    };
    $('live-log').replaceChildren();
    state.live = live;
    source.run((bitmap, at) => liveFrame(live, bitmap, at), { onProgress: (at, fps) => { live.fps = fps; } })
        .catch((e) => setStatus('rec-status', `画面を読み続けられませんでした: ${e.message}`, 'ng'))
        .finally(() => {
            if (state.live !== live) {
                return;
            }
            finishLive();
            state.live = null;
            if (live.source.ended && state.source === live.source) {
                closeSource();
                setStatus('video-status', '画面の共有が終わりました。');
            }
            renderLive();
            updateButtons();
        });
}

async function liveFrame(live, bitmap, at) {
    live.lastAt = at;
    // 暗転（全滅）はコマごとに見る（縮小して見るだけで軽い。見張りの間隔だと、短い暗転を 2 秒続いたと決められない）
    const black = isBlackFrame(bitmap);
    if (black !== live.black) {
        live.black = black;
        liveLog(live, at, black ? '画面が暗転した' : '画面の暗転が終わった');
    }
    live.engine.blackout(at * 1000, black);
    const rec = state.rec;
    if (rec) {
        const read = await state.ocr.readCastFree(bitmap, rec.rect);
        if (state.rec === rec) {
            rec.last = at;
            addCasts(rec.tracker.push(at - rec.origin, { text: snapRead(normalizeRead(read.text), rec.candidates, rec.maxMiss), conf: read.conf }), rec);
        }
    }
    // 文字認識の準備ができる前（モデルを読んでいる間）に共有を始めたら、見張りは待つ。見張りで失敗しても、読み取りは止めない
    if (state.ocr && at - live.lastWatch >= (state.rec ? WATCH_REC_EVERY_S : WATCH_EVERY_S)) {
        live.lastWatch = at;
        try {
            await watch(live, bitmap, at);
        } catch (e) {
            liveLog(live, at, `見張りで失敗しました: ${e.message}`);
        }
    }
    if (at - live.lastRender >= LIVE_RENDER_EVERY_S) {
        live.lastRender = at;
        renderLive();
    }
}

async function watch(live, bitmap, at) {
    const ms = at * 1000;
    const { engine } = live;
    const regions = regionsFor(bitmap.width, bitmap.height);
    engine.hasEnmity = Boolean(regions.enmity);
    live.missing = [!regions.content && 'コンテンツ名', !regions.countdown && !regions.enmity && 'カウントダウン・敵対リスト'].filter(Boolean);
    const inCombat = engine.status(ms).state === 'combat';
    const wantContent = !inCombat && Boolean(regions.content)
        && at - live.lastContentRead >= (live.content ? CONTENT_EVERY_S : CONTENT_RETRY_S);
    if (wantContent) {
        live.lastContentRead = at;
    }
    const obs = await state.ocr.readFrame(bitmap, regions, { content: wantContent ? state.contentNames : null, countdown: !inCombat });
    if (state.live !== live) {
        return;
    }
    if (obs.content) {
        noteContent(live, obs.content);
    }
    if (obs.countdown?.started) {
        engine.started(ms);
    } else if (obs.countdown) {
        engine.countdown(ms, obs.countdown.seconds);
    }
    if ('hp' in obs) {
        engine.hpPercent(ms, obs.hp);
    }
    if ('enmity' in obs) {
        if (obs.enmity !== live.enmity) {
            live.enmity = obs.enmity;
            liveLog(live, at, obs.enmity ? '敵対リストが出た' : '敵対リストが消えた');
        }
        engine.enmity(ms, obs.enmity);
    }
    if (killSuspected(engine, ms)) {
        await confirmKill(live, bitmap, at, regions);
    } else if (falseStart(engine, ms, state.rec ? state.casts.length : 0)) {
        engine.end(ms, `HP も詠唱も読めないまま敵対リストが ${FALSE_START_OFF_MS / 1000} 秒消えた。始まりの判定の誤り（敵対リストの範囲に別の表示が出た）とみなす`);
    }
    live.status = engine.status(ms);
    if (live.status.state === 'combat') {
        // 同じ戦闘で記録を始められなかった（範囲・タイムラインが無い）ときは、その戦闘の間は繰り返さない
        if (!state.rec && $('auto-rec').checked && live.declined !== engine.startAt && !beginLive({ origin: engine.startAt / 1000, auto: true })) {
            live.declined = engine.startAt;
        }
    } else if (state.rec?.auto) {
        finishLive();
    }
}

// 討伐の疑い（killSuspected）を、画面の表示で確かめてから終える。ムービー中は画面の表示（コンテンツ名・ホットバーなど）が消え、
// 討伐の後は残る。コンテンツ名の範囲に文字があれば討伐（範囲が無ければ確かめられないので討伐とする）
async function confirmKill(live, bitmap, at, regions) {
    const { engine } = live;
    const ms = at * 1000;
    let hud = true;
    if (regions.content) {
        const obs = await state.ocr.readFrame(bitmap, { content: regions.content }, { content: state.contentNames });
        hud = Boolean(obs.content?.text?.trim());
    }
    if (hud) {
        engine.end(ms, `HP ${engine.hp}% の後に敵対リストが消え、画面の表示は出ている。討伐`);
    } else if (live.cutsceneFrom !== engine.enmityOffSince) {
        live.cutsceneFrom = engine.enmityOffSince;
        liveLog(live, at, `HP ${engine.hp}% の後に敵対リストが消えたが、画面の表示（コンテンツ名）も消えている。ムービー中とみなして続ける`);
    }
}

// 判定の記録（画面の「判定の記録」。戦闘の始まり・終わりが合わないときに、何が見えていたかを確かめるため）
function liveLog(live, at, message) {
    if (state.live !== live) {
        return;
    }
    live.lastLog = message;
    const li = Object.assign(document.createElement('li'), { textContent: `${fmt(at)} ${message}` });
    const list = $('live-log');
    list.prepend(li);
    while (list.children.length > LIVE_LOG_MAX) {
        list.lastChild.remove();
    }
}

// コンテンツ名: 1 回で決まらなければ、何回かの読みを足し合わせて決める（再生画面と同じ）
function noteContent(live, read) {
    let name = read.decided;
    if (!name && read.ranked?.length > 0) {
        live.contentReads = [...live.contentReads, read].slice(-CONTENT_COMBINE);
        name = combineCandidates(live.contentReads);
    }
    if (!name || name === live.content) {
        return;
    }
    live.content = name;
    live.contentReads = [];
    applyContent(name);
}

// 読んだコンテンツ名を入れる。利用者が書いた・選んだものは上書きしない（空か、前に自動で入れたものだけ変える）
function applyContent(name) {
    const input = $('content-input');
    if (input.value.trim() === '' || input.value === state.autoContent) {
        input.value = name;
        state.autoContent = name;
    }
    const select = $('timeline-select');
    if (select.value === '' || select.value === state.autoTimeline) {
        // 直すタイムラインも、そのコンテンツのものを選ぶ（手元を先に。再生画面と同じ順）
        const local = state.local.find((t) => t.timeline.content === name);
        const cloud = state.index.items.find((i) => i.content === name);
        const value = local ? `local:${local.name}` : cloud ? `cloud:${cloud.file}` : '';
        if (value && value !== select.value) {
            select.value = value;
            state.autoTimeline = value;
            prefetchTarget();
        }
    }
    updateButtons();
}

/** 記録を始める。auto: 戦闘の始まりで自動で始めた（origin は戦闘開始の時刻）。始められなければ false */
function beginLive({ origin, auto }) {
    const fix = mode() === 'fix';
    const target = fix ? state.targets.get($('timeline-select').value)?.ready ?? null : null;
    if (!state.rect || !state.ocr || (fix && !target)) {
        if (auto) {
            setStatus('rec-status', !state.rect ? '戦闘が始まりましたが、詠唱バーの範囲が無いので記録していません。'
                : fix ? '戦闘が始まりましたが、直すタイムラインを選んでいない（読めていない）ので記録していません。'
                    : '戦闘が始まりましたが、文字認識の準備ができていないので記録していません。', 'ng');
        }
        return false;
    }
    // 前の記録の結果は、この記録で詠唱を読めなかったときに戻す（雑魚の戦闘・始まりの誤判定で、前の結果を消さない）
    const prev = state.casts.length > 0 ? { casts: state.casts, clock: state.clock, target: state.lastTarget } : null;
    state.rec = { tracker: new CastTracker(), origin, auto, target, rect: state.rect, last: origin, prev, ...snapping(target) };
    state.running = true;
    beginView(auto ? '戦闘' : '記録');
    setStatus('rec-status', auto ? '戦闘が始まったので記録しています…（戦闘が終わると止まります）' : '記録しています…');
    updateButtons();
    renderLive();
    return true;
}

async function startLiveManually() {
    if (mode() === 'fix') {
        try {
            await prefetchTarget();
        } catch (e) {
            setStatus('rec-status', e.message, 'ng');
            return;
        }
    }
    beginLive({ origin: state.live?.lastAt ?? 0, auto: false });
}

/** 記録を終える（手で止めた・戦闘が終わった・共有が終わった。何度呼んでもよい） */
function finishLive() {
    const rec = state.rec;
    if (!rec) {
        return;
    }
    state.rec = null;
    state.running = false;
    addCasts(rec.tracker.finish(rec.last - rec.origin), rec);
    updateButtons();
    if (state.casts.length === 0 && rec.prev) {
        beginView(rec.prev.clock); // 一覧と見出しを前の記録に戻す
        state.casts = rec.prev.casts;
        finishView(rec.prev.target);
        setStatus('rec-status', '詠唱を読めないまま戦闘が終わったので、前の記録の結果のままにしました。');
    } else {
        finishView(rec.target);
    }
    renderLive();
}

// 手で止めた。戦闘中なら engine も止め、次の戦闘（カウントダウンか、敵対リストが一度消えてまた出たとき）でまた自動で始める
function stopLive() {
    const live = state.live;
    if (live && state.rec && live.engine.status(live.lastAt * 1000).state === 'combat') {
        live.engine.halt(live.lastAt * 1000);
    }
    finishLive();
}

// 見張りの状態の文（ページと小窓に出す）
function liveText() {
    const live = state.live;
    if (!live) {
        return { head: '画面を共有していません', detail: state.lastSummary ?? '', recording: false };
    }
    const rec = state.rec;
    if (rec) {
        const last = state.casts.at(-1);
        return {
            head: `● 記録中 ${fmt(Math.max(0, live.lastAt - rec.origin))}`,
            detail: [`詠唱 ${state.casts.length} 回`, last && `直近: ${last.name}`, `1 秒に ${live.fps.toFixed(1)} コマ`,
                live.engine.hp !== null && `HP ${live.engine.hp}%`, live.enmity !== null && `敵対リスト ${live.enmity ? 'あり' : 'なし'}`].filter(Boolean).join('・'),
            recording: true,
        };
    }
    const s = live.status?.state;
    const head = s === 'countdown' ? 'カウントダウン中' : s === 'combat' ? '戦闘中（記録していません）' : '待機中';
    const detail = [
        live.content ? `コンテンツ: ${live.content}` : 'コンテンツ名を読んでいます',
        $('auto-rec').checked ? '戦闘が始まると記録します' : '「記録を始める」で記録します',
        live.missing.length > 0 && `範囲がありません: ${live.missing.join('・')}（初期設定の画面で）`,
        state.lastSummary,
        live.lastLog && `最後の判定: ${live.lastLog}`,
    ].filter(Boolean).join('・');
    return { head, detail, recording: false };
}

function renderLive() {
    const t = liveText();
    $('live-head').textContent = t.head;
    $('live-detail').textContent = t.detail;
    $('live-box').classList.toggle('rec-live-on', t.recording);
}

// ── 小窓（ゲームの上に記録の状態を出す） ──
const PIP_HTML = '<div class="rec-pip"><p class="rec-pip-head" data-k="head"></p><p class="rec-pip-detail" data-k="detail"></p>'
    + '<button type="button" data-k="stop">記録を止める</button></div>';

async function openPip() {
    if (!pipSupported()) {
        setStatus('rec-status', 'このブラウザでは小窓を開けません（Chrome か Edge の新しい版で開いてください）。', 'ng');
        return;
    }
    const win = await state.pip.open({ width: 360, height: 170, html: PIP_HTML, onFrame: (w) => paintPip(w.document) });
    win.document.querySelector('[data-k="stop"]').addEventListener('click', stop);
}

function paintPip(doc) {
    const t = liveText();
    const set = (k, text) => {
        const el = doc.querySelector(`[data-k="${k}"]`);
        if (el.textContent !== text) {
            el.textContent = text;
        }
    };
    set('head', t.head);
    set('detail', t.detail);
    doc.querySelector('.rec-pip').classList.toggle('rec-live-on', t.recording);
    doc.querySelector('[data-k="stop"]').disabled = !t.recording;
}


function renderCast(c) {
    const tr = document.createElement('tr');
    const name = cell(c.name, `rec-name${c.snapped ? ' rec-snapped' : ''}`);
    if (!c.snapped) {
        name.title = '候補の技名に寄せていません（読んだ文字のまま）';
    }
    tr.append(cell(fmt(c.start), 'num'), cell(c.duration.toFixed(2), 'num'), name, cell(`${c.read}（${c.votes}/${c.reads.length}）`));
    $('casts').append(tr);
}

// ── 結果: いまのタイムラインを直す ──
const STATUS_LABEL = { same: '合う', longer: '長い', shorter: '短い', unsure: '1 回だけ（要確認）', scattered: 'ばらつく（要確認）' };

function showFix({ timeline, file }) {
    const matched = matchTimeline(timeline, state.casts);
    const summary = summarizeDurations(matched.rows);
    state.result = { kind: 'fix', timeline, summary, file };
    const found = matched.phases.filter((p) => p.offset !== null);
    setStatus('result-summary', `フェーズ ${found.length}/${matched.phases.length} を${state.clock}の中で見つけました`
        + `（${matched.phases.map((p) => `${p.id}: ${p.offset === null ? '見つからない' : `${state.clock} ${fmt(p.offset)}`}`).join('・')}）。`
        + `どの予定にも当たらない詠唱 ${matched.unused.length} 回。直す行にチェックを付けてください（2 回以上そろって長い行に最初から付けています）。`);
    $('result-head').replaceChildren(rowOf('th', ['直す', '技名', 'XML の詠唱時間', '記録', 'そろった回数', '判定']));
    const rows = summary.map((s, i) => {
        const tr = document.createElement('tr');
        const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: s.status === 'longer', disabled: s.status === 'same' });
        check.dataset.index = String(i);
        check.setAttribute('aria-label', `${s.name} を直す`);
        check.addEventListener('change', buildFixXml);
        const box = document.createElement('td');
        box.append(check);
        tr.append(box, cell(s.name, 'rec-name'), cell(s.duration.toFixed(1), 'num'), cell(s.measured.toFixed(1), 'num'),
            cell(`${s.agree}/${s.values.length}（${s.values.join(' ')}）`), cell(STATUS_LABEL[s.status], s.status === 'unsure' || s.status === 'scattered' ? 'rec-unsure' : ''));
        return tr;
    });
    $('result-rows').replaceChildren(...rows);
    $('zero-field').hidden = true;
    $('result-section').hidden = false;
    buildFixXml();
}

function buildFixXml() {
    const { timeline, summary, file } = state.result;
    const picks = [...$('result-rows').querySelectorAll('input[type="checkbox"]:checked')].map((c) => summary[Number(c.dataset.index)]);
    state.xml = toTimelineXml(applyDurations(timeline, picks));
    state.fileName = file.endsWith('.xml') ? file : `${file}.xml`;
    $('xml-output').value = state.xml;
    setStatus('result-status', `${picks.length} 種類の技の詠唱時間を直した XML です。`);
}

// ── 結果: 新しいタイムラインの下書き ──
function showNew() {
    state.result = { kind: 'new', casts: state.casts.map((c) => ({ ...c })) };
    setStatus('result-summary', '技名は直せます。読んだ文字のまま（候補に寄せていない）の行は薄く出しています。要らない行はチェックを外してください。');
    $('result-head').replaceChildren(rowOf('th', ['入れる', clockHead(), '詠唱時間', '技名']));
    const rows = state.result.casts.map((c, i) => {
        const tr = document.createElement('tr');
        const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
        check.setAttribute('aria-label', `${fmt(c.start)} の詠唱を入れる`);
        check.addEventListener('change', () => {
            c.skip = !check.checked;
            buildNewXml();
        });
        const box = document.createElement('td');
        box.append(check);
        const input = Object.assign(document.createElement('input'), { type: 'text', value: c.name, className: `rec-name-input${c.snapped ? '' : ' rec-unsure'}` });
        input.setAttribute('aria-label', `${fmt(c.start)} の技名`);
        input.addEventListener('input', () => {
            c.name = input.value.trim();
            buildNewXml();
        });
        const name = Object.assign(document.createElement('td'), { className: 'rec-name' });
        name.append(input);
        tr.append(box, cell(fmt(c.start), 'num'), cell(c.duration.toFixed(1), 'num'), name);
        tr.dataset.index = String(i);
        return tr;
    });
    $('result-rows').replaceChildren(...rows);
    // 戦闘の始まりで記録を始めたときは、0 秒＝戦闘開始。そのほかは最初の詠唱の開始
    const combat = state.clock === '戦闘';
    $('zero-label').textContent = `0 秒にする時刻（${clockHead()}。既定は${combat ? ' 0（戦闘開始）' : '最初の詠唱の開始'}）`;
    $('zero-input').value = combat ? '0.0' : (Math.floor(state.result.casts[0].start * 10) / 10).toFixed(1);
    $('zero-field').hidden = false;
    $('result-section').hidden = false;
    buildNewXml();
}

function buildNewXml() {
    const content = $('content-input').value.trim();
    const zero = Number($('zero-input').value);
    const casts = state.result.casts.filter((c) => !c.skip && c.name);
    state.xml = toTimelineXml(draftTimeline(casts, { content, zero: Number.isFinite(zero) ? zero : undefined }));
    const file = state.contents.find((c) => c.name === content)?.file;
    state.fileName = `${file ?? 'recorded'}.xml`;
    $('xml-output').value = state.xml;
    setStatus('result-status', `詠唱 ${casts.length} 回の下書きです（フェーズは 1 つ。フェーズの分け方や表示の文は XML を直してください）。`);
}

function rowOf(tag, texts) {
    const tr = document.createElement('tr');
    tr.append(...texts.map((textContent) => Object.assign(document.createElement(tag), { textContent })));
    return tr;
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
    $('video-file').addEventListener('change', (ev) => {
        if (ev.target.files[0]) {
            openVideo(ev.target.files[0]);
        }
    });
    $('frame-save').addEventListener('click', saveFrame);
    for (const radio of document.querySelectorAll('input[name="input"]')) {
        radio.addEventListener('change', switchInput);
    }
    $('screen-start').addEventListener('click', openScreen);
    $('screen-stop').addEventListener('click', closeScreen);
    $('region-reload').addEventListener('click', loadRegion);
    for (const radio of document.querySelectorAll('input[name="mode"]')) {
        radio.addEventListener('change', () => {
            $('timeline-field').hidden = mode() !== 'fix';
            $('content-field').hidden = mode() !== 'new';
            updateButtons();
        });
    }
    $('timeline-select').addEventListener('change', () => {
        prefetchTarget().catch(() => {});
        updateButtons();
    });
    $('pip-open').addEventListener('click', openPip);
    $('auto-rec').addEventListener('change', renderLive);
    $('content-input').addEventListener('input', updateButtons);
    $('zero-input').addEventListener('input', () => state.result?.kind === 'new' && buildNewXml());
    $('rec-start').addEventListener('click', start);
    $('rec-stop').addEventListener('click', stop);
    $('download').addEventListener('click', download);
    $('use-in-player').addEventListener('click', useInPlayer);
    // 別のタブ（初期設定の画面）で範囲を指定したら読み直す
    window.addEventListener('storage', (ev) => ev.key === 'castline.regions' && loadRegion());
    loadModels();
    loadTimelines().then(updateButtons);
    try {
        state.contents = (await (await fetch('data/contents.json')).json()).contents;
        state.contentNames = state.contents.map((c) => c.name);
    } catch {
        state.contents = [];
    }
    $('content-list').replaceChildren(...state.contents.map((c) => Object.assign(document.createElement('option'), { value: c.name })));
    try {
        state.allNames = (await (await fetch('data/castnames.json')).json()).names;
    } catch {
        state.allNames = [];
    }
}

init();
