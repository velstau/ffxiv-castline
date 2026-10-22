// 動画ファイルから詠唱を記録する画面。いまのタイムラインの詠唱時間を記録に合わせて直すか、記録から新しいタイムラインの下書きを作る。
// 動画はこのブラウザの中だけで読む（どこへも送らない）。読む範囲は初期設定の画面で指定した「詠唱バー（技名）」（動画の大きさごと）。
import './storage-migrate.js';
import { OcrClient } from './ocr-client.js';
import { VideoFrameSource } from './video-source.js';
import { regionsFor } from './regions.js';
import { castNamesOf } from './region-auto.js';
import { STORE_LOCAL, loadTimelineIndex, fetchTimeline, loadLocalTimelines } from './timeline-source.js';
import { toTimelineXml } from './timeline-xml.js';
import {
    normalizeRead, snapRead, decideName, CastTracker, mergeSplitCasts, matchTimeline, summarizeDurations, applyDurations, draftTimeline,
    SNAP_MISS_ANY, SNAP_MISS_OWN,
} from './cast-recorder.js';

const STEP_S = 0.1; // コマどうしの間隔（動画の秒）の目安。出始め・消えたの時刻はこの間隔で決まる

const $ = (id) => document.getElementById(id);
const state = {
    ocr: null,
    source: null,
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
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const cell = (text, className = '') => Object.assign(document.createElement('td'), { textContent: text, className });

function updateButtons() {
    const ready = state.ocr && state.source && state.rect && !state.running
        && (mode() === 'new' ? $('content-input').value.trim() !== '' : $('timeline-select').value !== '');
    $('rec-start').disabled = !ready;
    $('rec-stop').disabled = !state.running;
    $('video-file').disabled = state.running;
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

// ── 動画と範囲 ──
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
    const size = `${source.width}x${source.height}`;
    const length = fmt(source.duration);
    if (state.rect) {
        setStatus('video-status', `動画 ${size}・${length}。詠唱バー（技名）の範囲: x ${state.rect.x}・y ${state.rect.y}・幅 ${state.rect.w}・高さ ${state.rect.h}`, 'ok');
    } else {
        setStatus('video-status', `動画 ${size}・${length}。この大きさの「詠唱バー（技名）」の範囲がまだありません。`, 'ng');
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

async function selectedTimeline() {
    const value = $('timeline-select').value;
    if (value.startsWith('local:')) {
        const name = value.slice('local:'.length);
        return { timeline: state.local.find((t) => t.name === name).timeline, file: name };
    }
    const file = value.slice('cloud:'.length);
    const item = state.index.items.find((i) => i.file === file);
    return { timeline: await fetchTimeline(item, state.index.base), file };
}

// ── 記録 ──
async function start() {
    const fix = mode() === 'fix';
    let target = null;
    try {
        target = fix ? await selectedTimeline() : null;
    } catch (e) {
        setStatus('rec-status', e.message, 'ng');
        return;
    }
    const candidates = fix ? castNamesOf(target.timeline) : state.allNames;
    const maxMiss = fix ? SNAP_MISS_OWN : SNAP_MISS_ANY;
    const from = Math.max(0, Number($('range-from').value) || 0);
    const to = $('range-to').value === '' ? state.source.duration : Math.min(state.source.duration, Number($('range-to').value));
    state.running = true;
    state.casts = [];
    state.result = null;
    $('casts').replaceChildren();
    $('casts-box').hidden = false;
    $('result-section').hidden = true;
    $('rec-progress').hidden = false;
    state.source.video.controls = false;
    updateButtons();
    setStatus('rec-status', '記録しています…');

    const tracker = new CastTracker();
    const rect = state.rect;
    const add = (closed) => {
        for (const cast of closed) {
            const name = decideName(cast.reads, candidates, maxMiss);
            const item = { ...cast, ...name };
            state.casts.push(item);
            renderCast(item);
        }
    };
    let last = from;
    try {
        await state.source.run(async (bitmap, at) => {
            const read = await state.ocr.readCastFree(bitmap, rect);
            add(tracker.push(at, { text: snapRead(normalizeRead(read.text), candidates, maxMiss), conf: read.conf }));
            last = at;
        }, {
            from, to, step: STEP_S,
            onProgress: (at, rate) => {
                $('rec-progress').value = (at - from) / Math.max(1e-3, to - from);
                setStatus('rec-status', `記録しています… 動画 ${fmt(at)} / ${fmt(to)}（${rate.toFixed(1)} 倍速）・詠唱 ${state.casts.length} 回`);
            },
        });
        add(tracker.finish(last));
    } catch (e) {
        setStatus('rec-status', `記録を続けられませんでした: ${e.message}`, 'ng');
    }
    state.running = false;
    state.source.video.controls = true;
    $('rec-progress').hidden = true;
    updateButtons();
    // 読みが途中で割れた同じ技名の詠唱をつなぎ、一覧を出し直す
    state.casts = mergeSplitCasts(state.casts);
    $('casts').replaceChildren();
    state.casts.forEach(renderCast);
    if (state.casts.length === 0) {
        setStatus('rec-status', '詠唱を 1 回も読めませんでした。範囲が詠唱バーの技名に合っているか、初期設定の画面で確かめてください。', 'ng');
        return;
    }
    if (!$('rec-status').classList.contains('ng')) {
        setStatus('rec-status', `記録しました（詠唱 ${state.casts.length} 回）。`, 'ok');
    }
    if (fix) {
        showFix(target);
    } else {
        showNew();
    }
}

function stop() {
    state.source?.stop();
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
    setStatus('result-summary', `フェーズ ${found.length}/${matched.phases.length} を動画の中で見つけました`
        + `（${matched.phases.map((p) => `${p.id}: ${p.offset === null ? '見つからない' : `動画 ${fmt(p.offset)}`}`).join('・')}）。`
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
    $('result-head').replaceChildren(rowOf('th', ['入れる', '動画の秒', '詠唱時間', '技名']));
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
    $('zero-input').value = (Math.floor(state.result.casts[0].start * 10) / 10).toFixed(1);
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
    $('region-reload').addEventListener('click', loadRegion);
    for (const radio of document.querySelectorAll('input[name="mode"]')) {
        radio.addEventListener('change', () => {
            $('timeline-field').hidden = mode() !== 'fix';
            $('content-field').hidden = mode() !== 'new';
            updateButtons();
        });
    }
    $('timeline-select').addEventListener('change', updateButtons);
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
