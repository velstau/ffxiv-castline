// 初期設定の画面: 読む範囲を、手順に沿ってゲーム画面に出たものから自動で見つけて保存する（region-auto.js）。
// 手で直す画面（拡大図、region-editor.js）と、ファイルへの書き出し・読み込みもここ。再生画面は保存した範囲を使うだけ。
import './storage-migrate.js';
import { FrameSource } from './capture.js';
import { OcrClient } from './ocr-client.js';
import { STORE_REGIONS, regionsFor, setRegion, clearRegions, exportRegions, importRegions, loadAll, screenKey } from './regions.js';
import { RegionEditor } from './region-editor.js';
import { icon } from './icons.js';
import { RegionAutoFinder, castNamesOf, foundDetail } from './region-auto.js';
import { loadTimelineIndex, fetchTimeline, loadLocalTimelines } from './timeline-source.js';

const STORE_SETTINGS = 'castline.player.settings'; // 再生画面の設定（autoRegions: 再生中も足りない範囲を自動で探すか）
const STEP_EVERY_MS = 1000;
const CONTENT_READ_EVERY_MS = 3000; // コンテンツ名の範囲が指定済みのとき、名前を読む間隔（タイムラインの技名を知るため）

const $ = (id) => document.getElementById(id);
const state = {
    ocr: null,
    source: null,
    running: false,
    contents: [],
    frameSize: null,
    content: null, // 読み取ったコンテンツ名
    timeline: null, // そのコンテンツのタイムライン（詠唱バーの技名に使う）
    timelineChecked: false, // タイムラインがあるか確かめ終えたか
    index: null,
    finder: null,
    lastContentRead: -Infinity,
    found: {}, // 種類 → 自動で見つけたときの記録（表示用）
};
let editor = null;

function setStatus(id, text, kind = '') {
    const el = $(id);
    el.textContent = text;
    el.className = `status ${kind}`.trim();
}

function log(message) {
    const d = new Date();
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const el = $('log');
    el.value += `${time} ${message}\n`;
    el.scrollTop = el.scrollHeight;
}

function loadSettings() {
    try {
        return JSON.parse(localStorage.getItem(STORE_SETTINGS) ?? '{}') ?? {};
    } catch {
        return {};
    }
}
function saveSetting(key, value) {
    try {
        localStorage.setItem(STORE_SETTINGS, JSON.stringify({ ...loadSettings(), [key]: value }));
    } catch {
        // 保存できなくても、このページを開いている間は使える
    }
}

// ── モデル・コンテンツ名の一覧・タイムライン ──
async function loadModel() {
    const progress = $('model-progress');
    const got = {};
    const total = {};
    try {
        const url = (path) => new URL(path, location.href).href;
        state.ocr = await OcrClient.load(
            { rec: url('models/ppocrv5_rec.onnx'), dict: url('models/ppocrv5_dict.txt'), det: url('models/ppocrv5_det.onnx') },
            (name, received, size) => {
                got[name] = received;
                total[name] = size;
                const sumGot = Object.values(got).reduce((a, b) => a + b, 0);
                const sumTotal = Object.values(total).reduce((a, b) => a + b, 0);
                if (sumTotal) {
                    progress.value = sumGot / sumTotal;
                    setStatus('model-status', `文字認識のモデルをダウンロード中… ${(sumGot / 1e6).toFixed(1)} / ${(sumTotal / 1e6).toFixed(1)} MB`);
                }
            },
        );
        progress.hidden = true;
        setStatus('model-status', '文字認識の準備ができました。', 'ok');
    } catch (e) {
        setStatus('model-status', `文字認識のモデルを読み込めませんでした: ${e.message}`, 'ng');
    }
    render();
}

async function timelineFor(content) {
    const local = loadLocalTimelines().find((t) => t.timeline.content === content);
    if (local) {
        return { timeline: local.timeline, note: `手元のファイル ${local.name}` };
    }
    state.index ??= await loadTimelineIndex();
    const item = state.index.items.find((t) => t.content === content);
    return item ? { timeline: await fetchTimeline(item, state.index.base), note: item.title } : null;
}

async function setContent(name) {
    if (!name || name === state.content) {
        return;
    }
    Object.assign(state, { content: name, timeline: null, timelineChecked: false });
    log(`コンテンツ名 ${name}`);
    try {
        const found = await timelineFor(name);
        if (state.content !== name) {
            return;
        }
        state.timeline = found?.timeline ?? null;
        log(found
            ? `タイムライン: ${found.note}（詠唱バーで照合する技 ${castNamesOf(found.timeline).length} 個）`
            : 'このコンテンツのタイムラインはありません（詠唱バーは探しません）');
    } catch (e) {
        log(`タイムラインを読めませんでした（詠唱バーは探しません）: ${e.message}`);
    }
    state.timelineChecked = true;
    render();
}

// ── 手順の表示 ──
function stepState(id, done, current, text) {
    const li = $(id);
    li.className = done ? 'done' : current ? 'current' : 'todo';
    li.querySelector('.step-mark').replaceChildren(done ? icon('check_circle') : li.dataset.step);
    const el = li.querySelector('.step-state');
    if (el) {
        el.textContent = text;
        el.className = `status step-state ${done ? 'ok' : ''}`.trim();
    }
}

function itemState(id, done, text) {
    const li = $(id);
    li.className = done ? 'done' : '';
    li.replaceChildren(icon(done ? 'check_circle' : 'radio_button_unchecked'), Object.assign(document.createElement('span'), { textContent: text }));
}

const foundText = (id) => (state.found[id]?.line ? `（「${state.found[id].line.text}」の行）` : '');

function render() {
    const size = state.frameSize;
    const regions = size ? regionsFor(size.width, size.height) : {};
    const key = size ? screenKey(size.width, size.height) : '';
    // 詠唱バーは、タイムラインがあるコンテンツだけ探す（技名で見つけるため）
    const castNeeded = !(state.timelineChecked && !state.timeline);
    const done = {
        capture: state.running && Boolean(size),
        content: Boolean(regions.content),
        countdown: Boolean(regions.countdown),
        combat: Boolean(regions.hp && regions.enmity && (regions.cast || !castNeeded)),
    };
    const order = ['capture', 'content', 'countdown', 'combat'];
    const current = order.find((id) => !done[id]) ?? 'done';
    const allDone = order.slice(1).every((id) => done[id]) && Boolean(size);

    stepState('step-capture', done.capture, current === 'capture', !state.ocr ? '文字認識の準備を待っています。'
        : size ? `画面 ${key} を${state.running ? '取り込み中です' : '取り込みました（止めています）'}。`
            : state.running ? '画面を待っています…' : '');
    stepState('step-content', done.content, current === 'content', done.content
        ? `見つけました${state.content ? `: ${state.content}` : '（名前を読んでいます…）'}`
        : state.running ? '探しています…' : '');
    stepState('step-countdown', done.countdown, current === 'countdown', done.countdown
        ? `見つけました${foundText('countdown')}`
        : state.running ? 'カウントダウンを待っています…' : '');
    stepState('step-combat', done.combat, current === 'combat', '');
    itemState('item-hp', Boolean(regions.hp), regions.hp
        ? `HP: 見つけました${state.found.hp ? `（${state.found.hp.label.replace(/^HP/, '').replace(/[（）]/g, '') || 'ターゲット'}）` : ''}`
        : 'HP: 殴って HP が減ると見つけます');
    itemState('item-enmity', Boolean(regions.enmity), regions.enmity ? `敵対リスト: 見つけました${foundText('enmity')}` : '敵対リスト: 戦闘中に見つけます');
    itemState('item-cast', Boolean(regions.cast) || !castNeeded, regions.cast
        ? `詠唱バー: 見つけました${state.found.cast?.name ? `（${state.found.cast.name}）` : ''}`
        : !castNeeded ? '詠唱バー: このコンテンツはタイムラインが無いので探しません（無くても使えます）'
            : 'ボスの詠唱バー: ボスが技を詠唱したときに見つけます');
    stepState('step-done', allDone, false, allDone
        ? `画面 ${key} の範囲をすべて指定しました。再生画面へ進めます。`
        : '');

    $('start').disabled = state.running || !state.ocr;
    $('stop').disabled = !state.running;
    $('regions-grab').disabled = !state.running;
    $('regions-find').disabled = !state.ocr || !editor?.frame;
}

// ── 取り込みと自動の範囲指定 ──
async function start() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
        setStatus('model-status', 'このページでは画面を取り込めません。https か localhost で開いてください。', 'ng');
        return;
    }
    let source;
    try {
        source = await FrameSource.start(stop);
    } catch (e) {
        log(`取り込みを始められませんでした（${e.name}）`);
        return;
    }
    Object.assign(state, { source, running: true, frameSize: null, found: {}, lastContentRead: -Infinity });
    // 初期設定の画面は読み取りと競わないので、戦闘前の画面（敵対リストの候補から外す場所）も短い間隔で覚える
    state.finder = new RegionAutoFinder({
        ocr: state.ocr, contents: () => state.contents, casts: () => castNamesOf(state.timeline), idleFullEveryMs: 6000,
    });
    log(`── 取り込み開始（${source.method}）`);
    render();
    const live = () => state.running && state.source === source;
    let nextAt = 0;
    while (live()) {
        const grabbed = await source.grab(nextAt);
        if (!grabbed) {
            break;
        }
        nextAt = grabbed.at + STEP_EVERY_MS;
        try {
            await step(grabbed.bitmap, grabbed.at, live);
        } catch (e) {
            log(`エラー: ${e.message}`);
        } finally {
            grabbed.bitmap.close();
        }
        render();
    }
}

async function step(frame, at, live) {
    const { width, height } = frame;
    if (state.frameSize?.width !== width || state.frameSize?.height !== height) {
        state.frameSize = { width, height };
        const names = Object.keys(regionsFor(width, height));
        log(`画面 ${screenKey(width, height)}: 指定済みの範囲 ${names.length > 0 ? names.join('・') : 'なし'}`);
    }
    const regions = regionsFor(width, height);
    // コンテンツ名の範囲が指定済みで名前が分からないときは読む（タイムラインの技名で詠唱バーを探すため）
    if (regions.content && !state.content && at - state.lastContentRead >= CONTENT_READ_EVERY_MS) {
        state.lastContentRead = at;
        const obs = await state.ocr.readFrame(frame, { content: regions.content }, { content: state.contents });
        await setContent(obs.content?.decided);
    }
    const found = await state.finder.step(frame, at, live);
    if (found.length === 0) {
        return;
    }
    for (const f of found) {
        state.found[f.id] = f;
        log(`見つけました: ${foundDetail(f)}`);
    }
    const content = found.find((f) => f.id === 'content');
    if (content) {
        await setContent(content.name);
    }
    if (editor.frame?.width === width && editor.frame?.height === height) {
        editor.refresh();
    }
}

function stop() {
    if (!state.running) {
        return;
    }
    state.running = false;
    state.source?.stop();
    state.source = null;
    log('── 取り込み停止');
    render();
}

// ── 手で直す・やり直す・ファイル ──
async function grabForRegions() {
    const grabbed = await state.source?.grab(0);
    if (!grabbed) {
        return;
    }
    editor.setFrame(grabbed.bitmap); // 範囲の設定が持つ（次に替えたときに閉じる）
    setStatus('editor-status', `いまのゲーム画面（${screenKey(grabbed.bitmap.width, grabbed.bitmap.height)}）を使います。`, 'ok');
    render();
}

async function imageForRegions(file) {
    try {
        editor.setFrame(await createImageBitmap(file));
    } catch {
        setStatus('editor-status', `${file.name} を画像として読めませんでした。`, 'ng');
        return;
    }
    const key = screenKey(editor.frame.width, editor.frame.height);
    setStatus('editor-status', `${file.name}（${key}）を使います。取り込む画面と大きさが違うと、ここで指定した範囲は使われません。`, 'ok');
    render();
}

async function findContentRegion() {
    const frame = editor.frame;
    $('regions-find').disabled = true;
    try {
        const found = await state.ocr.findContent(frame, state.contents,
            (done, total) => setStatus('editor-status', `コンテンツ名を探しています… ${done}/${total}`));
        if (!found) {
            setStatus('editor-status', '見つかりませんでした。コンテンツの中で、画面に「コンテンツ情報」が出ている状態の画面で試してください。', 'ng');
            return;
        }
        setRegion(frame.width, frame.height, 'content', found.rect);
        editor.refresh();
        editor.select('content');
        setStatus('editor-status', `「${found.name}」を見つけ、その行を長い名前も入る幅に広げて保存しました。拡大図で確かめ、ずれていれば直してください。`, 'ok');
        await setContent(found.name);
    } finally {
        render();
    }
}

// いまの画面の大きさの範囲を全部消す（ずれた範囲が残っていると、自動では探さないため）
function clearScreenRegions() {
    const size = state.frameSize ?? editor.frame;
    if (!size) {
        setStatus('file-status', '先に「ゲーム画面の取り込みを始める」を押してください（どの画面の大きさの範囲を消すかが決まります）。', 'ng');
        return;
    }
    const key = screenKey(size.width, size.height);
    if (Object.keys(regionsFor(size.width, size.height)).length === 0) {
        setStatus('file-status', `画面 ${key} の範囲はもうありません。`, 'ok');
        return;
    }
    if (!confirm(`画面 ${key} の範囲を全部消します。よろしいですか？（残したい場合は先に「範囲をファイルに書き出す」）`)) {
        return;
    }
    clearRegions(size.width, size.height);
    state.found = {};
    state.finder?.reset();
    editor.refresh();
    log(`画面 ${key} の範囲を全部消しました`);
    setStatus('file-status', `画面 ${key} の範囲を全部消しました。上の手順 2 からやり直してください。`, 'ok');
    render();
}

function exportRegionsFile(statusId) {
    const all = loadAll();
    if (Object.keys(all).length === 0) {
        setStatus(statusId, '書き出す範囲がありません。', 'ng');
        return;
    }
    const url = URL.createObjectURL(new Blob([exportRegions(all)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: 'castline-regions.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(statusId, `範囲を castline-regions.json に書き出しました（画面 ${Object.keys(all).join('・')}）。`, 'ok');
}

async function importRegionsFile(file) {
    const { screens, errors } = importRegions(await file.text());
    if (errors.length > 0) {
        setStatus('file-status', `${file.name} を読み込めませんでした: ${errors.join(' / ')}`, 'ng');
        return;
    }
    editor.refresh();
    const size = state.frameSize ?? editor.frame;
    const current = size && screenKey(size.width, size.height);
    const missing = current && !screens.includes(current);
    setStatus('file-status', `${file.name} から画面 ${screens.join('・')} の範囲を読み込みました。`
        + (missing ? `いまの画面（${current}）の範囲は入っていません。` : ''), missing ? 'ng' : 'ok');
    log(`${file.name} から画面 ${screens.join('・')} の範囲を読み込みました`);
    render();
}

// ── 初期化 ──
async function init() {
    editor = new RegionEditor($('region-editor'), {
        check: (id, rect, frame) => (state.ocr
            ? state.ocr.checkRegion(frame, id, rect, state.contents)
            : Promise.resolve({ ok: null, text: '文字認識のモデルを読み込み中です' })),
        onChange: render,
    });
    $('start').addEventListener('click', start);
    $('stop').addEventListener('click', stop);
    $('regions-grab').addEventListener('click', grabForRegions);
    $('regions-image').addEventListener('change', async (ev) => {
        if (ev.target.files[0]) {
            await imageForRegions(ev.target.files[0]);
        }
        ev.target.value = '';
    });
    $('regions-find').addEventListener('click', findContentRegion);
    $('regions-clear').addEventListener('click', clearScreenRegions);
    $('regions-export').addEventListener('click', () => exportRegionsFile('file-status'));
    $('export-done').addEventListener('click', () => exportRegionsFile('file-status'));
    $('regions-import').addEventListener('change', async (ev) => {
        if (ev.target.files[0]) {
            await importRegionsFile(ev.target.files[0]);
        }
        ev.target.value = '';
    });
    $('regions-auto').checked = loadSettings().autoRegions ?? true;
    $('regions-auto').addEventListener('change', (ev) => saveSetting('autoRegions', ev.target.checked));
    $('log-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText($('log').value);
        } catch {
            $('log').focus();
            $('log').select();
        }
    });
    // 再生画面（別のタブ）で範囲が変わったら表示し直す
    window.addEventListener('storage', (ev) => {
        if (ev.key === STORE_REGIONS) {
            editor.refresh();
            render();
        }
    });
    render();
    try {
        state.contents = (await (await fetch('data/contents.json')).json()).contents.map((c) => c.name);
    } catch {
        state.contents = [];
        log('コンテンツ名の一覧を読めませんでした（コンテンツ名は探せません）');
    }
    await loadModel();
}

init();
