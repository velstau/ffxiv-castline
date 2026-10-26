// 初期設定の画面: 読む範囲を、手順に沿ってゲーム画面に出たものから自動で見つけて保存する（region-auto.js）。
// 手で直す画面（拡大図、region-editor.js）と、ファイルへの書き出し・読み込みもここ。再生画面は保存した範囲を使うだけ。
import './storage-migrate.js';
import { FrameSource, captureSession } from './capture.js';
import { OcrClient } from './ocr-client.js';
import { STORE_REGIONS, REGION_KINDS, regionsFor, setRegion, clearRegions, exportRegions, importRegions, loadAll, screenKey, savedScreens } from './regions.js';
import { RegionEditor } from './region-editor.js';
import { icon } from './icons.js';
import { RegionAutoFinder, castNamesOf, foundDetail } from './region-auto.js';
import { loadTimelineIndex, fetchTimeline, loadLocalTimelines } from './timeline-source.js';

const STORE_SETTINGS = 'castline.player.settings'; // 再生画面の設定（autoRegions: 再生中も足りない範囲を自動で探すか）
const STEP_EVERY_MS = 1000;
const CONTENT_READ_EVERY_MS = 3000; // コンテンツ名の範囲が指定済みのとき、名前を読む間隔（タイムラインの技名を知るため）

const $ = (id) => document.getElementById('setup-' + id);
const state = {
    ocr: null,
    source: null,
    running: false,
    contents: [],
    allNames: [], // 配信の全タイムラインの技名（data/castnames.json）。タイムラインの無いコンテンツの詠唱バーを探すのに使う
    frameSize: null,
    // 再設定: false（設定済みなら手順を出さない）・'clear'（次に取り込んだ画面の大きさの範囲を消してから始める）・true（手順を出す）
    redo: false,
    content: null, // 読み取ったコンテンツ名
    timeline: null, // そのコンテンツのタイムライン（詠唱バーの技名に使う）
    timelineChecked: false, // タイムラインがあるか確かめ終えたか
    index: null,
    finder: null,
    lastContentRead: -Infinity,
    found: {}, // 種類 → 自動で見つけたときの記録（表示用）
    // 見つけた範囲の確認に使う画面: 種類 → { bitmap, at }（見つけた瞬間の画面。カウントダウン・詠唱バーはすぐ消えるため）
    snapshots: {},
    liveSnap: null, // 「いまのゲーム画面で見る」で撮った画面（見つけた瞬間の画面が無い種類に使う）
    checksKey: '', // 確認の一覧を描き直すかどうかの目印
};
const CROP_MAX_W = 640; // 確認の一覧の切り抜きの最大の大きさ（画素。CSS で枠の幅に縮める）
const CROP_MAX_H = 320;
const CROP_ZOOM_MAX = 3;
let editor = null;

function setStatus(id, text, kind = '') {
    const el = $(id);
    el.textContent = text;
    el.className = `read-status ${kind}`.trim();
}

function clock(at = Date.now()) {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function log(message) {
    const time = clock();
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
        el.className = `read-status step-state ${done ? 'ok' : ''}`.trim();
    }
}

function itemState(id, done, text) {
    const li = $(id);
    li.className = done ? 'done' : '';
    li.replaceChildren(icon(done ? 'check_circle' : 'radio_button_unchecked'), Object.assign(document.createElement('span'), { textContent: text }));
}

const foundText = (id) => (state.found[id]?.line ? `（「${state.found[id].line.text}」の行）` : '');

// 初期設定が済んでいれば、手順の代わりに「設定は不要」と出す（2026-10-21 のユーザーの指定。手順 1〜4 が出ると紛らわしい）。
// 同じ画面の設定が保存済みなら共有後も手順を閉じる。未設定の解像度・明示的な再設定では手順を出す
function renderSetupDone() {
    const complete = savedScreens().filter((s) => s.complete).map((s) => s.key);
    const currentKey = state.frameSize ? screenKey(state.frameSize.width, state.frameSize.height) : null;
    const showDone = !state.redo && (currentKey ? complete.includes(currentKey) : complete.length > 0);
    $('setup-done').hidden = !showDone;
    $('setup-steps').hidden = showDone;
    if (showDone) {
        $('setup-done-text').textContent = `初期設定は済んでいます（画面 ${complete.join('・')}）。`;
    }
}

// 再設定（「この画面の範囲を全部消して、やり直す」と 1 つにした。2026-10-21 のユーザーの指摘）
function redo() {
    if (state.frameSize) {
        // 取り込んだ画面があれば、その大きさの範囲をいま消す（確認は clearScreenRegions が出す）
        state.redo = true;
        clearScreenRegions();
    } else {
        if (savedScreens().length > 0
            && !confirm('保存してある範囲を消して、はじめから設定し直します（消すのは、このあと取り込んだ画面の大きさの範囲だけです）。よろしいですか？\n残したい場合は、先に「範囲をファイルに書き出す」を押してください。')) {
            return;
        }
        state.redo = 'clear';
    }
    render();
    $('steps').scrollIntoView({ block: 'start' });
    $('start').focus();
}

// 詠唱バーの照合に使う技名。タイムラインの無いコンテンツは、配信の全タイムラインの技名のうち 4 文字以上のもので、厳しく照合して探す
// （2026-10-23 ノーマルの煉獄編4 で詠唱バーが見つからなかった。零式のタイムラインと技名がほぼ共通。
// 手元の動画 8 本で、全技名のままだと 4 本で短い技名にゴミの行が当たって先に採られ、4 文字以上・厳しい照合では 8 本とも本物が先だった。
// 技名がまったく違う新しいコンテンツでは、ほかのコンテンツの技名がバフ名などに出て当たることがまれにある。
// 技名なしで「同じ場所に違う文字」で探す方式は、8 本のうち 5 本で DPS メーター・セリフなどを先につかんだので採らない）
const UNKNOWN_CAST_MIN_CHARS = 4;
const strictCast = () => !state.timeline && state.timelineChecked;

function castCandidates() {
    if (state.timeline) {
        return castNamesOf(state.timeline);
    }
    return state.timelineChecked ? state.allNames.filter((n) => [...n].length >= UNKNOWN_CAST_MIN_CHARS) : [];
}

function render() {
    renderSetupDone();
    const size = state.frameSize;
    const regions = size ? regionsFor(size.width, size.height) : {};
    const key = size ? screenKey(size.width, size.height) : '';
    // 詠唱バーは、タイムラインの無いコンテンツでは無くても済ませる（再生には要らない。記録に使うので、配信の全技名で探しはする）
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
        ? `HP: 見つけました${state.found.hp ? state.found.hp.label.replace(/^HP/, '') : ''}`
        : 'HP: 殴って HP が減ると見つけます');
    itemState('item-enmity', Boolean(regions.enmity), regions.enmity ? `敵対リスト: 見つけました${foundText('enmity')}` : '敵対リスト: 戦闘中に見つけます');
    itemState('item-cast', Boolean(regions.cast), regions.cast
        ? `詠唱バー: 見つけました${state.found.cast?.name ? `（${state.found.cast.name}）` : ''}`
        : !castNeeded ? `詠唱バー: このコンテンツはタイムラインが無いので、配信のほかのタイムラインの技名（${castCandidates().length} 個）で探します。`
            + 'ノーマルと零式のように技名が共通なら見つかります。見つけたら下の一覧で枠を確かめてください。見つからなければ、記録に使うときは拡大図で囲んでください（再生だけなら無くても使えます）'
            : !state.timelineChecked ? 'ボスの詠唱バー: コンテンツ名を読んでから探します（技名で見つけるため）'
                : `ボスの詠唱バー: ボスが技を詠唱したときに見つけます（タイムラインの技 ${castNamesOf(state.timeline).length} 個で照合）`);
    stepState('step-done', allDone, false, allDone
        ? `画面 ${key} の範囲をすべて指定しました。再生画面へ進めます。`
        : '');

    $('start').disabled = state.running || !state.ocr;
    $('stop').disabled = !state.running;
    $('regions-grab').disabled = !state.running;
    // 取り込む前でも押せる（押すと取り込みを始めてから撮る。指定済みの範囲を確かめたいだけの人が、上のボタンを探さずに済む）
    $('checks-grab').disabled = !state.running && !state.ocr;
    $('regions-find').disabled = !state.ocr || !editor?.frame;
    renderChecks();
}

// ── 見つけた範囲の確認（種類ごとに、範囲の周りの切り抜きと枠） ──
function snapshotFor(id) {
    const size = state.frameSize ?? editor?.frame;
    const own = state.snapshots[id];
    if (own && (!size || (own.bitmap.width === size.width && own.bitmap.height === size.height))) {
        return { ...own, kind: 'found' };
    }
    return state.liveSnap ? { ...state.liveSnap, kind: 'live' } : null;
}

function drawCrop(canvas, bitmap, rect, color) {
    const pad = Math.max(16, Math.round(Math.max(rect.w, rect.h) * 0.3));
    const x = Math.max(0, rect.x - pad);
    const y = Math.max(0, rect.y - pad);
    const w = Math.min(bitmap.width, rect.x + rect.w + pad) - x;
    const h = Math.min(bitmap.height, rect.y + rect.h + pad) - y;
    const scale = Math.min(CROP_ZOOM_MAX, CROP_MAX_W / w, CROP_MAX_H / h);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.strokeRect((rect.x - x) * scale, (rect.y - y) * scale, rect.w * scale, rect.h * scale);
}

function renderChecks() {
    const size = state.frameSize ?? editor?.frame;
    const regions = size ? regionsFor(size.width, size.height) : {};
    const key = JSON.stringify([size && screenKey(size.width, size.height), size ? regions : loadAll(), // 取り込む前は保存してある範囲を出すので、それも見る
        Object.entries(state.snapshots).map(([id, s]) => [id, s.at]), state.liveSnap?.at ?? null]);
    if (key === state.checksKey) {
        return;
    }
    state.checksKey = key;
    const saved = size ? {} : loadAll();
    $('region-checks').replaceChildren(...REGION_KINDS.map((kind) => {
        const rect = regions[kind.id];
        const li = document.createElement('li');
        li.className = `rc-card${rect ? '' : ' rc-none'}`;
        const head = document.createElement('div');
        head.className = 'rc-head';
        const swatch = Object.assign(document.createElement('span'), { className: 'swatch' });
        swatch.style.background = kind.color;
        head.append(swatch, Object.assign(document.createElement('strong'), { textContent: kind.label }));
        li.append(head);
        if (!rect) {
            // 取り込む前は、保存してある範囲があればそう出す（「まだありません」だと設定が消えたように見える）
            const savedIn = size ? [] : Object.entries(saved).filter(([, r]) => r?.[kind.id]).map(([k]) => k);
            li.append(Object.assign(document.createElement('p'), {
                className: `read-status${savedIn.length > 0 ? ' ok' : ''}`,
                textContent: savedIn.length > 0 ? `指定済み（画面 ${savedIn.join('・')}）。取り込むと、いまのゲーム画面で確かめられます。` : 'まだありません',
            }));
            return li;
        }
        const snap = snapshotFor(kind.id);
        const found = state.found[kind.id];
        let note;
        if (snap) {
            const canvas = Object.assign(document.createElement('canvas'), { className: 'rc-crop' });
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', `${kind.label}の範囲の周りの画面`);
            drawCrop(canvas, snap.bitmap, rect, kind.color);
            li.append(canvas);
            note = snap.kind === 'found'
                ? `見つけたときの画面（${clock(snap.at)}）${found?.line ? `。「${found.line.text}」の行から決めました` : ''}`
                : `いまの画面（${clock(snap.at)}）。いま出ていないもの（カウントダウンなど）は写りません`;
        } else {
            note = state.running ? '前に決めた範囲です。「いまのゲーム画面で見る」で確かめられます' : '前に決めた範囲です。取り込みを始めると確かめられます';
        }
        li.append(Object.assign(document.createElement('p'), { className: 'rc-note', textContent: note }));
        const button = Object.assign(document.createElement('button'), { type: 'button' });
        button.append(icon('zoom_in'), '拡大図で確かめる・直す');
        button.disabled = !snap && !state.running;
        button.addEventListener('click', () => openInEditor(kind.id));
        li.append(button);
        return li;
    }));
}

async function grabForChecks() {
    if (!state.running) {
        await start(); // 共有の確認はクリックの中でしか出せないので、ほかを待たずにすぐ始める（取り込みが始まったところで返る）
        if (!state.running) {
            return;
        }
    }
    const grabbed = await state.source?.grab(0);
    if (!grabbed) {
        return;
    }
    state.liveSnap?.bitmap.close();
    state.liveSnap = { bitmap: grabbed.bitmap, at: Date.now() };
    render();
}

// その種類の確認に使った画面（見つけた瞬間の画面か、いまの画面）を拡大図に出して、その種類を選ぶ
async function openInEditor(id) {
    const snap = snapshotFor(id);
    if (snap) {
        editor.setFrame(await createImageBitmap(snap.bitmap)); // 拡大図が持って閉じるので複製を渡す
        setStatus('editor-status', snap.kind === 'found'
            ? `見つけたときの画面（${clock(snap.at)}）を使っています。直すと、この画面の大きさの範囲として保存します。`
            : `いまのゲーム画面（${clock(snap.at)}）を使っています。`, 'ok');
    } else {
        await grabForRegions();
    }
    $('editor-details').open = true;
    editor.select(id);
    render();
    $('editor-details').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearSnapshots() {
    Object.values(state.snapshots).forEach((s) => s.bitmap.close());
    state.snapshots = {};
    state.liveSnap?.bitmap.close();
    state.liveSnap = null;
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
        ocr: state.ocr, contents: () => state.contents, casts: castCandidates, strictCast, idleFullEveryMs: 6000,
    });
    log(`── 取り込み開始（${source.method}）`);
    render();
    run(source); // 読み取りは裏で続ける（start は取り込みが始まったところで返る。grabForChecks が待つ）
}

async function run(source) {
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
        if (state.redo === 'clear') {
            state.redo = true;
            if (Object.keys(regionsFor(width, height)).length > 0) {
                clearRegions(width, height);
                Object.assign(state, { found: {}, content: null, timeline: null, timelineChecked: false });
                clearSnapshots();
                state.finder?.reset();
                editor.refresh();
                log(`再設定: 画面 ${screenKey(width, height)} の範囲を消して、はじめから探します`);
            }
        }
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
    const bitmap = await createImageBitmap(frame); // 見つけた瞬間の画面（確認の一覧で使う。frame は呼ぶ側が閉じる）
    for (const [i, f] of found.entries()) {
        state.found[f.id] = f;
        state.snapshots[f.id]?.bitmap.close();
        state.snapshots[f.id] = { bitmap: i === 0 ? bitmap : await createImageBitmap(bitmap), at: Date.now() };
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
    clearSnapshots();
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
    $('checks-grab').addEventListener('click', grabForChecks);
    $('regions-image').addEventListener('change', async (ev) => {
        if (ev.target.files[0]) {
            await imageForRegions(ev.target.files[0]);
        }
        ev.target.value = '';
    });
    $('regions-find').addEventListener('click', findContentRegion);
    $('regions-redo').addEventListener('click', redo);
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
    try {
        state.allNames = (await (await fetch('data/castnames.json')).json()).names;
    } catch {
        state.allNames = [];
    }
    await loadModel();
}

export const ready = init();

export function refresh() { editor?.refresh(); render(); }
export function leave() { stop(); }

export async function attachShared() {
    if (captureSession.source && state.ocr && !state.running) { await start(); }
}
