// OCR 試験ページ。画像の上で範囲を選び、文字認識の結果と解釈を表に出す。
import { FrameSource } from './capture.js';
import { TextDetector, TextRecognizer } from './ocr.js';
import { pickCandidate, readCast, readCountdown, parseHpPercent, CANDIDATE_MARGIN_MIN, CAST_PENALTY_MAX } from './readers.js';

const REGIONS = [
    { id: 'content', label: 'コンテンツ名', color: '#f5c542' },
    { id: 'countdown', label: 'カウントダウン', color: '#4fc3f7' },
    { id: 'hp', label: 'HP（%）', color: '#ff7b72' },
    { id: 'cast', label: '詠唱バー（技名）', color: '#c792ea' },
    { id: 'enmity', label: '敵対リスト', color: '#6fdc8c' },
];
const STORE_REGIONS = 'ocr-timeline.lab.regions';
const STORE_CANDIDATES = 'ocr-timeline.lab.candidates';
const STORE_CAST_CANDIDATES = 'ocr-timeline.lab.cast-candidates';

const $ = (id) => document.getElementById(id);
const state = {
    recognizer: null,
    detector: null,
    defaultCandidates: [],
    images: [], // { label, bitmap }
    current: -1,
    active: REGIONS[0].id,
    source: null, // FrameSource（画面の取り込み）
};

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

// 範囲は解像度ごとに持つ（解像度が変わると HUD の位置も変わるため）
function resolutionKey(bitmap) {
    return `${bitmap.width}x${bitmap.height}`;
}
function regionsFor(bitmap) {
    return load(STORE_REGIONS, {})[resolutionKey(bitmap)] ?? {};
}
function setRegion(bitmap, id, rect) {
    const all = load(STORE_REGIONS, {});
    const key = resolutionKey(bitmap);
    all[key] = { ...(all[key] ?? {}), [id]: rect };
    save(STORE_REGIONS, all);
}

function linesOf(textareaId) {
    return $(textareaId).value.split('\n').map((s) => s.trim()).filter(Boolean);
}
const candidates = () => linesOf('candidates');
const castCandidates = () => linesOf('cast-candidates');

// ── モデル ──
async function loadModel() {
    const status = $('model-status');
    const progress = $('model-progress');
    try {
        // 2 つのモデルの進み具合を合わせて出す
        const got = {};
        const total = {};
        const onProgress = (name) => (received, size) => {
            got[name] = received;
            total[name] = size;
            const sumGot = Object.values(got).reduce((a, b) => a + b, 0);
            const sumTotal = Object.values(total).reduce((a, b) => a + b, 0);
            if (sumTotal) {
                progress.value = sumGot / sumTotal;
                status.textContent = `ダウンロード中… ${(sumGot / 1e6).toFixed(1)} / ${(sumTotal / 1e6).toFixed(1)} MB`;
            }
        };
        [state.recognizer, state.detector] = await Promise.all([
            TextRecognizer.load('models/ppocrv5_rec.onnx', 'models/ppocrv5_dict.txt', onProgress('rec')),
            TextDetector.load('models/ppocrv5_det.onnx', onProgress('det')),
        ]);
        progress.hidden = true;
        status.textContent = '準備できました（PP-OCRv5 mobile の認識・検出）';
        status.className = 'status ok';
        $('read-all').disabled = state.current < 0;
        updateWatchButtons();
        readAll();
    } catch (e) {
        status.textContent = `モデルを読み込めませんでした: ${e.message}`;
        status.className = 'status ng';
    }
}

// ── 画像 ──
function addImage(label, bitmap, select = true) {
    state.images.push({ label, bitmap });
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    const index = state.images.length - 1;
    button.addEventListener('click', () => selectImage(index));
    $('thumbs').append(button);
    if (select) {
        selectImage(index);
    }
}

function selectImage(index) {
    state.current = index;
    [...$('thumbs').children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
    const { bitmap } = state.images[index];
    const canvas = $('stage');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.hidden = false;
    $('stage-empty').hidden = true;
    $('read-all').disabled = !state.recognizer;
    draw();
    readAll();
}

function currentBitmap() {
    return state.current >= 0 ? state.images[state.current].bitmap : null;
}

function draw(dragRect = null) {
    const bitmap = currentBitmap();
    if (!bitmap) {
        return;
    }
    const canvas = $('stage');
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const lineWidth = Math.max(2, Math.round(bitmap.width / 800));
    // キャンバスは表示幅に縮めて見せるので、元画像の幅に合わせて大きめに描く
    const fontSize = Math.max(16, Math.round(bitmap.width / 55));
    ctx.font = `${fontSize}px sans-serif`;
    const regions = regionsFor(bitmap);
    for (const def of REGIONS) {
        const r = def.id === state.active && dragRect ? dragRect : regions[def.id];
        if (!r) {
            continue;
        }
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = def.color;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = def.color;
        ctx.fillText(def.label, r.x, Math.max(fontSize, r.y - lineWidth * 2));
    }
}

// ── 範囲の選択（ドラッグ） ──
function setupRegionPicker() {
    const picker = $('region-picker');
    for (const def of REGIONS) {
        const label = document.createElement('label');
        label.innerHTML = `<input type="radio" name="region" value="${def.id}"><span class="swatch" style="background:${def.color}"></span>${def.label}`;
        const input = label.querySelector('input');
        input.checked = def.id === state.active;
        input.addEventListener('change', () => {
            state.active = def.id;
        });
        picker.append(label);
    }

    const canvas = $('stage');
    let start = null;
    const toSource = (ev) => {
        const box = canvas.getBoundingClientRect();
        return {
            x: Math.round((ev.clientX - box.left) * canvas.width / box.width),
            y: Math.round((ev.clientY - box.top) * canvas.height / box.height),
        };
    };
    const rectFrom = (a, b) => {
        const x = Math.max(0, Math.min(a.x, b.x));
        const y = Math.max(0, Math.min(a.y, b.y));
        return {
            x,
            y,
            w: Math.min(canvas.width, Math.max(a.x, b.x)) - x,
            h: Math.min(canvas.height, Math.max(a.y, b.y)) - y,
        };
    };
    canvas.addEventListener('pointerdown', (ev) => {
        start = toSource(ev);
        canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener('pointermove', (ev) => {
        if (start) {
            draw(rectFrom(start, toSource(ev)));
        }
    });
    canvas.addEventListener('pointerup', (ev) => {
        if (!start) {
            return;
        }
        const rect = rectFrom(start, toSource(ev));
        start = null;
        if (rect.w >= 4 && rect.h >= 4) {
            setRegion(currentBitmap(), state.active, rect);
            readAll();
        }
        draw();
    });
}

// ── 読み取り ──
let reading = Promise.resolve();
function readAll() {
    // 認識は 1 つずつ順に行う（同じセッションを並行して動かさない）
    reading = reading.then(readAllNow).catch((e) => console.error(e));
    return reading;
}

async function readAllNow() {
    const bitmap = currentBitmap();
    const tbody = $('results');
    if (!bitmap || !state.recognizer) {
        return;
    }
    const regions = regionsFor(bitmap);
    const rows = [];
    for (const def of REGIONS) {
        const rect = regions[def.id];
        if (!rect) {
            rows.push(row(def.label, '—', '範囲が未設定です', ''));
            continue;
        }
        if (def.id === 'enmity') {
            // 敵対リストは、文字が出ているか（戦闘中だけ表示される）と、各行の技名（詠唱中は敵の名前の横に出る）を見る
            const list = await readCast(state.detector, state.recognizer, bitmap, rect, castCandidates(), { wholeIfNoLines: false });
            const shown = list.lines > 0
                ? `<span class="decided">表示あり（戦闘中、${list.lines} 行）</span>`
                : '<span class="undecided">表示なし</span>';
            rows.push(row(def.label, list.text || '（文字なし）',
                list.lines > 0 ? `${shown}<br>技名: ${describeCast(list.result)}` : shown, `${list.ms.toFixed(0)} ms`));
            continue;
        }
        if (def.id === 'cast') {
            // 範囲の中の行を分けて 1 行ずつ照合する（ボス名の行が混ざるため）
            const cast = await readCast(state.detector, state.recognizer, bitmap, rect, castCandidates());
            rows.push(row(def.label, cast.text || '（読めず）', describeCast(cast.result), `${cast.ms.toFixed(0)} ms`));
            continue;
        }
        if (def.id === 'countdown') {
            // 範囲の中から文字の行を探して 1 行ずつ読む（吹き出しは行数・幅が変わる）
            const cd = await readCountdown(state.detector, state.recognizer, bitmap, rect);
            rows.push(row(def.label, cd.text || '（読めず）', describeCountdown(cd.countdown), `${cd.ms.toFixed(0)} ms`));
            continue;
        }
        const read = await state.recognizer.read(bitmap, rect);
        rows.push(row(def.label, read.text || '（読めず）', interpret(def.id, read), `${read.ms.toFixed(0)} ms`));
    }
    tbody.replaceChildren(...rows);
}

function interpret(id, read) {
    if (id === 'content') {
        return describeCandidates(read, candidates(), '決めきれない（手動で選ぶ）', '候補がありません（下の一覧に書いてください）');
    }
    if (id === 'hp') {
        const hp = parseHpPercent(read.text);
        return hp === null ? '<span class="undecided">% を読めない</span>' : `<span class="decided">${hp}%</span>`;
    }
    return '';
}

function describeCandidates(read, list, undecidedLabel, emptyLabel) {
    const result = pickCandidate(state.recognizer, read, list);
    if (result.ranked.length === 0) {
        return escapeHtml(emptyLabel);
    }
    const margin = Number.isFinite(result.margin) ? result.margin.toFixed(1) : '—';
    const head = result.decided
        ? `<span class="decided">決定: ${escapeHtml(result.decided)}</span>`
        : `<span class="undecided">${escapeHtml(undecidedLabel)}</span>`;
    const reason = `1 位と 2 位の差 ${margin}（${CANDIDATE_MARGIN_MIN} 以上で決定）、1 位と読み取った文字の違い ${result.distance} 文字`;
    const items = result.ranked.slice(0, 3)
        .map((c) => `<li>${escapeHtml(c.text)}（${c.logP.toFixed(1)}）</li>`).join('');
    return `${head}<br>${reason}<ol class="ranked">${items}</ol>`;
}

function describeCast(result) {
    if (castCandidates().length === 0) {
        return '技名の候補を書くと照合します';
    }
    const head = result.decided
        ? `<span class="decided">決定: ${escapeHtml(result.decided)}</span>`
        : '<span class="undecided">候補のどれとも決められない</span>';
    const items = result.ranked.slice(0, 3)
        .map((c) => `<li>${escapeHtml(c.text)}（減点 ${c.penalty.toFixed(1)}）</li>`).join('');
    return `${head}<br>読んだ文字の一部分が候補と一致するかで判定（減点 ${CAST_PENALTY_MAX} 以内が当てはまる、0 は完全一致）<ol class="ranked">${items}</ol>`;
}

function describeCountdown(cd) {
    if (!cd) {
        return '<span class="undecided">カウントダウンではない</span>';
    }
    return cd.started ? '<span class="decided">戦闘開始</span>' : `<span class="decided">残り ${cd.seconds} 秒</span>`;
}

function row(label, text, judgement, time) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(text)}</td><td>${judgement}</td><td class="num">${escapeHtml(time)}</td>`;
    return tr;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 画面の取り込み（https か localhost でしか使えない） ──
async function startCapture() {
    const status = $('capture-status');
    if (!navigator.mediaDevices?.getDisplayMedia) {
        status.textContent = 'このページでは画面を取り込めません。https か localhost で開いてください。';
        status.className = 'status ng';
        return;
    }
    try {
        state.source = await FrameSource.start(stopCapture);
    } catch (e) {
        status.textContent = `取り込みを始められませんでした（${e.name}）`;
        status.className = 'status ng';
        return;
    }
    status.textContent = `取り込み中です（${state.source.method}）。「今の画面を追加」で静止画として加えます。`;
    status.className = 'status ok';
    $('capture-start').disabled = true;
    $('capture-grab').disabled = false;
    $('capture-stop').disabled = false;
    updateWatchButtons();
}

async function grabFrame() {
    const grabbed = await state.source?.grab();
    if (grabbed) {
        addImage(`取り込み ${clockText(new Date(grabbed.at))}`, grabbed.bitmap);
    }
}

function stopCapture() {
    stopWatch();
    state.source?.stop();
    state.source = null;
    $('capture-start').disabled = false;
    $('capture-grab').disabled = true;
    $('capture-stop').disabled = true;
    $('capture-status').textContent = '';
    updateWatchButtons();
}

// ── 連続読み取り（取り込み中の画面を一定間隔で読み、変化だけを記録する） ──
const WATCH_INTERVAL_MS = 500;
const WATCH_CONTENT_EVERY_MS = 5000; // コンテンツ名は滅多に変わらないので間引く
const WATCH_MAX_SNAPSHOTS = 10; // 自動で加える画像の上限（カウントダウン・詠唱それぞれ）
const watch = {
    running: false,
    last: {}, // 範囲ごとに、最後に記録した値
    lastContentAt: 0,
    snapshots: { countdown: 0, cast: 0 },
};

function updateWatchButtons() {
    const ready = Boolean(state.recognizer && state.detector && state.source);
    $('watch-start').disabled = watch.running || !ready;
    $('watch-stop').disabled = !watch.running;
    if (!watch.running) {
        $('watch-status').textContent = ready ? '始められます。' : 'ゲーム画面の取り込みを始めると使えます。';
        $('watch-status').className = 'status';
    }
}

function clockText(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${Math.floor(date.getMilliseconds() / 100)}`;
}

function appendLog(line) {
    const log = $('watch-log');
    log.value += `${line}\n`;
    log.scrollTop = log.scrollHeight;
}

// ページが隠れた・戻ったことも記録する（隠れると読み取りが遅れることがあるため、ログを読むときの手がかりにする）
function logVisibility() {
    appendLog(`${clockText()} （このページが${document.visibilityState === 'visible' ? '表示されました' : '隠れました'}）`);
}

async function startWatch() {
    if (watch.running || !state.source) {
        return;
    }
    watch.running = true;
    watch.last = {};
    watch.lastContentAt = 0;
    updateWatchButtons();
    $('watch-status').textContent = '読み取り中…';
    $('watch-status').className = 'status ok';
    document.addEventListener('visibilitychange', logVisibility);

    let nextAt = 0;
    let first = true;
    while (watch.running && state.source) {
        // 前回のフレームから 0.5 秒以上あとに届いたフレームを待つ（タイマーは使わない）
        const grabbed = await state.source.grab(nextAt);
        if (!grabbed) {
            break;
        }
        if (!watch.running) {
            grabbed.bitmap.close();
            break;
        }
        nextAt = grabbed.at + WATCH_INTERVAL_MS;
        if (first) {
            first = false;
            const { width, height } = grabbed.bitmap;
            const set = Object.keys(regionsFor(grabbed.bitmap));
            appendLog(`── 開始 ${clockText(new Date(grabbed.at))}（画面 ${width}x${height}、範囲 ${set.length ? set.join('・') : 'なし'}、取り込み ${state.source.method}、ページ ${document.visibilityState === 'visible' ? '表示' : '非表示'}）`);
            if (set.length === 0) {
                appendLog('  この解像度の範囲がありません。「今の画面を追加」で静止画を加え、範囲を選んでから始めてください。');
            }
        }
        reading = reading.then(() => watchTick(grabbed)).catch((e) => appendLog(`  エラー: ${e.message}`));
        await reading;
    }
}

function stopWatch() {
    if (!watch.running) {
        return;
    }
    watch.running = false;
    document.removeEventListener('visibilitychange', logVisibility);
    appendLog(`── 停止 ${clockText()}`);
    updateWatchButtons();
}

async function watchTick({ bitmap: frame, at }) {
    const now = new Date(at); // 記録する時刻はフレームが届いた時刻（読み取りにかかった時間の分ずれないように）
    const regions = regionsFor(frame);
    const started = performance.now();
    const delay = Date.now() - at;
    const keep = {};

    // 値が前回と変わったときだけ記録する
    const record = (id, key, text) => {
        if (watch.last[id] === key) {
            return false;
        }
        watch.last[id] = key;
        appendLog(`${clockText(now)} ${text}`);
        if (id !== 'hp' && id !== 'content') {
            pipNotify(`${clockText(now)} ${text.replace(/「.*」$/, '')}`);
        }
        return true;
    };

    if (regions.content && at - watch.lastContentAt >= WATCH_CONTENT_EVERY_MS) {
        watch.lastContentAt = at;
        const read = await state.recognizer.read(frame, regions.content);
        if (read.text === '') {
            record('content', '', 'コンテンツ名 読めない');
        } else {
            const result = pickCandidate(state.recognizer, read, candidates());
            const shown = result.decided ? `決定 ${result.decided}` : `決めきれない（1 位 ${result.ranked[0]?.text ?? 'なし'}）`;
            record('content', result.decided ?? `?${read.text}`, `コンテンツ名 ${shown}「${read.text}」`);
        }
    }
    if (regions.countdown) {
        const cd = await readCountdown(state.detector, state.recognizer, frame, regions.countdown);
        if (cd.countdown?.started) {
            keep.countdown = record('countdown', 'start', `カウントダウン 戦闘開始「${cd.text}」`);
            if (keep.countdown) {
                speakIfEnabled('戦闘開始');
            }
        } else if (cd.countdown) {
            const expected = new Date(at + cd.countdown.seconds * 1000);
            keep.countdown = record('countdown', `s${cd.countdown.seconds}`,
                `カウントダウン 残り ${cd.countdown.seconds} 秒（開始予想 ${clockText(expected)}）「${cd.text}」`);
        } else if (watch.last.countdown && watch.last.countdown !== 'none') {
            // 吹き出しは 16・10・5 秒と開始のときだけ出て、すぐ消える。消えるのは正常
            record('countdown', 'none', `カウントダウン 表示なし「${cd.text}」`);
        }
    }
    if (regions.hp) {
        const read = await state.recognizer.read(frame, regions.hp);
        const hp = parseHpPercent(read.text);
        // HP は細かく変わるので、1% 単位で変わったときと、読める・読めないが変わったときだけ記録する
        record('hp', hp === null ? 'none' : `${Math.floor(hp)}`, `HP ${hp === null ? '読めない' : `${hp}%`}「${read.text}」`);
    }
    // 技名はターゲットの詠唱バーと敵対リストの両方から読む（詠唱バーはカメラの角度でボスの頭上の表示と重なることがある）。
    // どちらで決まったかを比べられるよう、別々に記録する
    const castLog = (id, label, cast) => {
        const result = cast.result;
        if (!result.decided && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(cast.text)) {
            record(id, '', `${label} なし`);
            return;
        }
        const top = result.ranked[0];
        const hint = top ? `、最も近い候補 ${top.text}（減点 ${top.penalty.toFixed(1)}）` : '';
        // 敵対リストは詠唱していなくても敵の名前が出ているので、決まったときと決まらなかったときだけを区別して記録する
        const key = result.decided ?? (id === 'cast' ? `?${cast.text}` : '?');
        // 戦闘前に範囲の模様を英字として読むことがあるので、かな・漢字を含むときだけ画面を残す
        keep.cast = record(id, key, `${label} ${result.decided ? `決定 ${result.decided}` : `候補と一致せず${hint}`}「${cast.text}」`)
            || keep.cast;
        if (result.decided && watch.lastSpoken !== result.decided) {
            watch.lastSpoken = result.decided;
            speakIfEnabled(result.decided);
        }
    };
    if (regions.enmity) {
        const list = await readCast(state.detector, state.recognizer, frame, regions.enmity, castCandidates(), { wholeIfNoLines: false });
        record('enmity', list.lines > 0 ? 'on' : 'off',
            `敵対リスト ${list.lines > 0 ? `表示あり（${list.lines} 行）` : '表示なし'}`);
        if (list.lines > 0 || watch.last.enmityCast) {
            castLog('enmityCast', '詠唱（敵対リスト）', list);
        }
    }
    if (regions.cast) {
        castLog('cast', '詠唱（詠唱バー）', await readCast(state.detector, state.recognizer, frame, regions.cast, castCandidates()));
    }

    $('watch-status').textContent = `読み取り中…（1 回 ${(performance.now() - started).toFixed(0)} ms、フレームが届いてから読み始めるまで ${delay} ms）`;
    // カウントダウンを読めたとき・技名らしい文字を読んだときの画面を、確認用に一覧へ加える
    const kind = ['countdown', 'cast'].find((k) => keep[k] && watch.snapshots[k] < WATCH_MAX_SNAPSHOTS);
    if (kind) {
        watch.snapshots[kind]++;
        addImage(`自動 ${clockText(now)}`, frame, false);
    } else {
        frame.close();
    }
}

// ── 小窓（Document Picture-in-Picture）の試験 ──
// ゲームの上に表示を出せるか、ゲームが前面でも時計が止まらず動くか、読み上げが鳴るかを確かめる。
// 時計は小窓の requestAnimationFrame で動かす（このページはゲームが前面だと隠れ扱いになり、タイマーが間引かれる）。
const pip = { win: null, lines: [] };

async function openPip() {
    if (!('documentPictureInPicture' in window)) {
        $('watch-status').textContent = 'このブラウザは小窓（Document Picture-in-Picture）に対応していません。Chrome か Edge の新しい版で開いてください。';
        $('watch-status').className = 'status ng';
        return;
    }
    pip.win?.close();
    const win = await documentPictureInPicture.requestWindow({ width: 440, height: 300 });
    pip.win = win;
    const link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('css/app.css', location.href).href;
    win.document.head.append(link);
    win.document.body.innerHTML = `
        <div class="pip">
            <div class="pip-clock" id="pip-clock">--:--:--.-</div>
            <ol class="pip-lines" id="pip-lines"></ol>
            <div class="row">
                <button type="button" id="pip-speak">読み上げの試験</button>
                <label><input type="checkbox" id="pip-tts" checked> 戦闘開始と決まった技名を読み上げる</label>
            </div>
        </div>`;
    const clock = win.document.getElementById('pip-clock');
    const tick = () => {
        if (win.closed) {
            return;
        }
        clock.textContent = clockText();
        win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
    win.document.getElementById('pip-speak').addEventListener('click', () => speak('読み上げの試験です'));
    win.addEventListener('pagehide', () => {
        pip.win = null;
    });
    renderPipLines();
}

function speak(text) {
    // 読み上げは小窓の側から鳴らす（小窓は表示されているので止められにくい）
    const w = pip.win ?? window;
    const utterance = new w.SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    w.speechSynthesis.speak(utterance);
}

function speakIfEnabled(text) {
    if (pip.win?.document.getElementById('pip-tts')?.checked) {
        speak(text);
    }
}

function pipNotify(line) {
    pip.lines = [...pip.lines, line].slice(-5);
    renderPipLines();
}

function renderPipLines() {
    const list = pip.win?.document.getElementById('pip-lines');
    if (!list) {
        return;
    }
    list.replaceChildren(...pip.lines.map((line) => {
        const li = pip.win.document.createElement('li');
        li.textContent = line;
        return li;
    }));
}

async function copyLog() {
    const log = $('watch-log');
    try {
        await navigator.clipboard.writeText(log.value);
        $('watch-status').textContent = 'ログをコピーしました。';
    } catch {
        // クリップボードが使えないときは、選択して手でコピーしてもらう
        log.focus();
        log.select();
        $('watch-status').textContent = 'ログを選択しました。Ctrl+C でコピーしてください。';
    }
}

// ── 初期化 ──
async function init() {
    setupRegionPicker();

    try {
        const res = await fetch('data/contents.json');
        state.defaultCandidates = (await res.json()).contents.map((c) => c.name);
    } catch {
        state.defaultCandidates = [];
    }
    $('candidates').value = load(STORE_CANDIDATES, state.defaultCandidates).join('\n');
    $('candidates').addEventListener('change', () => {
        save(STORE_CANDIDATES, candidates());
        readAll();
    });
    $('cast-candidates').value = load(STORE_CAST_CANDIDATES, []).join('\n');
    $('cast-candidates').addEventListener('change', () => {
        save(STORE_CAST_CANDIDATES, castCandidates());
        readAll();
    });
    $('candidates-reset').addEventListener('click', () => {
        $('candidates').value = state.defaultCandidates.join('\n');
        save(STORE_CANDIDATES, state.defaultCandidates);
        readAll();
    });

    $('file-input').addEventListener('change', async (ev) => {
        for (const file of ev.target.files) {
            addImage(file.name, await createImageBitmap(file));
        }
        ev.target.value = '';
    });
    $('capture-start').addEventListener('click', startCapture);
    $('capture-grab').addEventListener('click', grabFrame);
    $('capture-stop').addEventListener('click', stopCapture);
    $('read-all').addEventListener('click', readAll);
    $('watch-start').addEventListener('click', startWatch);
    $('watch-stop').addEventListener('click', stopWatch);
    $('watch-copy').addEventListener('click', copyLog);
    $('pip-open').addEventListener('click', openPip);
    $('watch-clear').addEventListener('click', () => {
        $('watch-log').value = '';
        watch.last = {};
    });

    loadModel();
}

init();
