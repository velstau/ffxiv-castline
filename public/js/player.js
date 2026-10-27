import { ContentPresence, MISSING_CLEAR_MS, MISSING_CLEAR_COMBAT_MS, acceptContentName } from './content-presence.js';
// 再生画面: ゲーム画面を読み、タイムライン（これから来る技と発動までの秒）を流して読み上げる。
import './storage-migrate.js';
import { FrameSource, captureSession } from './capture.js';
import { OcrClient } from './ocr-client.js';
import { combineCandidates } from './readers.js';
import { isBlackFrame } from './blackout.js';
import { falseStart } from './cast-recorder.js';
import { needsKillConfirmation, isDutyCompleteText, ClearNoticeTracker } from './combat-end.js';
import { TimelineEngine } from './timeline-engine.js';
import { parseTimelineXml } from './timeline-xml.js';
import { upcomingRows, iconProblems } from './timeline-view.js';
import { STORE_LOCAL, loadTimelineIndex, fetchTimeline, loadLocalTimelines } from './timeline-source.js';
import { groupTimelines } from './timeline-order.js';
import { RegionAutoFinder, castNamesOf, foundDetail } from './region-auto.js';
import { REGION_KINDS, STORE_REGIONS, regionsFor, missingRegions, screenKey, savedScreens as listSavedScreens } from './regions.js';
import { GUIDE_STEPS, guideSteps } from './player-guide.js';
import { icon } from './icons.js';
import { Pip, pipSupported } from './pip.js';
import { Speech, DEFAULT_SPEECH, japaneseVoices, voicevoxStyles } from './speech.js';

const STORE_SETTINGS = 'castline.player.settings';
const INTERVAL_MS = 500;
const CONTENT_EVERY_MS = 1000; // コンテンツ名は戦闘外だけ、間引いて読む
const CONTENT_RETRY_MS = 1000; // まだ決まっていない間は、これごとに読む
const CONTENT_COMBINE = 5; // 1 回で決まらない読み取りを、直近これだけ足し合わせて決める
// コンテンツ名の範囲があるのにこれだけ読めなければ、範囲がずれているかもしれないとログに出す（範囲があると自動では探さないため）
const CONTENT_MISS_WARN_MS = 60000;
const RENDER_EVERY_MS = 100;
const SPEAK_LATE_MAX_S = 2; // 読み上げる時刻をこれ以上過ぎた予定は読まない（同期で時刻が飛んだとき）
const UPCOMING_COUNT = 6;

const $ = (id) => document.getElementById('player-' + id);
let autoRequested = false;
let starting = false;
const state = {
    ocr: null,
    source: null,
    running: false,
    contents: [], // コンテンツ名の候補（data/contents.json）
    contentInfo: [], // data/contents.json の contents（配信の一覧の並べ替えに使う）
    cloud: [], // { file, content, title, timeline? }
    cloudError: '',
    cloudBase: '', // 一覧を読めた置き場所（タイムラインの XML も同じ所から読む）
    local: [], // { name, xml, timeline }
    resolvedChoice: '',
    choice: 'auto', // 'auto' | 'cloud:<file>' | 'local:<name>'
    timeline: null,
    timelineLabel: '',
    engine: null,
    regions: null,
    regionsKey: '',
    detectedContent: null,
    contentPresence: new ContentPresence(),
    contentBlocked: false,
    contentMuted: false, // 戦闘中にコンテンツ名が読めず、読み上げだけ止めている
    contentReads: [], // 1 回では決まらなかったコンテンツ名の読み取り（combineCandidates で足し合わせる）
    heldContent: null, // 戦闘中に読んだ別のコンテンツ名（ログを 1 回だけ出すため）
    lastContentAt: 0,
    contentMissSince: null,
    contentMissWarned: false,
    regionsLogged: '',
    lastCast: {}, // 読み取り元ごとに、最後に記録した技名（ログは変わったときだけ）
    lastEnmity: null,
    endDiagnosticKey: null,
    clearNotice: new ClearNoticeTracker(),
    clearNoticeFight: null,
    lastClearReadAt: 0,
    lastBlack: false, // 前のフレームが暗転だったか（ログは変わったときだけ）
    spoken: new Set(),
    spokenStartAt: null,
    lastRender: 0,
    lastPrepare: 0,
    ocrError: false,
    timelineError: '',
    ttsTested: null, // 読み上げの試験の結果（'ok' | 'ng'）
    guideKey: '',
};
const settings = { tts: true, lead: 5, autoRegions: true, ...load(STORE_SETTINGS, {}) };
settings.speech = { ...DEFAULT_SPEECH, ...(settings.speech ?? {}) };
const pip = new Pip();
const voice = new Speech(() => settings.speech);
const PREPARE_EVERY_MS = 1000;
const PREPARE_AHEAD_S = 40; // VOICEVOX で先に作っておく範囲（発動までの秒。1 つ作るのに 1 秒前後かかる）

// 読み上げる。読み上げ・音の再生は、利用者が一度でも操作した窓からしか鳴らせない（Chrome。操作していない窓では not-allowed）。
// 小窓は表示されているので止められにくいが、小窓の中を操作していなければ元の窓から鳴らす。小窓で拒まれたら元の窓で鳴らし直す
// （2026-10-21 の動画: 小窓から鳴らそうとして not-allowed が続いた）。
// 失敗（読み始めない・エラー）は記録に出す（同じものは続けて出さない）。report なら、読み始めたことも使った声とともに出す（試験のボタン）
const activated = (w) => w.navigator.userActivation?.hasBeenActive ?? true;
const notAllowed = (e) => /not-allowed|NotAllowedError/i.test(`${e.name} ${e.message}`);
let lastSpeechError = '';
function say(text, report = false) {
    const target = pip.isOpen && activated(pip.win) ? pip.win : window;
    voice.speak(text, target)
        .catch((e) => (notAllowed(e) && target !== window && !state.contentBlocked ? voice.speak(text, window) : Promise.reject(e)))
        .then((name) => {
            lastSpeechError = '';
            if (report) {
                state.ttsTested = 'ok';
                log(`読み上げ「${text}」を${name ? ` ${name} で` : ''}読み始めました`);
            }
        })
        .catch((e) => {
            if (report) {
                state.ttsTested = 'ng';
            }
            const message = notAllowed(e) && !activated(window) ? `${e.message}。再生画面を一度クリックしてください` : e.message;
            if (message !== lastSpeechError) {
                lastSpeechError = message;
                log(`読み上げられませんでした（${message}）`);
            }
        });
}
// 読み上げるのは tts に文があるものだけ（tts が無い・空の予定は読まない。2026-10-21 のユーザーの指定。以前は技名を読んでいた）
const ttsText = (e) => e.tts?.trim() ?? '';

// 文字認識は別スレッド（ocr-client.js）で、依頼の届いた順に 1 つずつ行う。画面全体を読む自動の範囲指定も区画ごとに
// 依頼するので、その間に読み取りの依頼が入れる

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
        window.dispatchEvent(new StorageEvent('storage', { key }));
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
    $(id).className = `read-status ${kind}`.trim();
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
        const url = (path) => new URL(path, location.href).href;
        state.ocr = await OcrClient.load(
            { rec: url('models/ppocrv5_rec.onnx'), dict: url('models/ppocrv5_dict.txt'), det: url('models/ppocrv5_det.onnx') },
            (name, received, size) => onProgress(name)(received, size),
        );
        progress.hidden = true;
        setStatus('model-status', '文字認識の準備ができました。', 'ok');
    } catch (e) {
        state.ocrError = true;
        setStatus('model-status', `文字認識のモデルを読み込めませんでした: ${e.message}`, 'ng');
    }
    updateButtons();
    if (autoRequested && state.ocr && captureSession.source) { void start(); }
}

// ── タイムライン ──
async function loadCloudIndex() {
    const index = await loadTimelineIndex();
    state.cloud = index.items;
    state.cloudBase = index.base;
    state.cloudError = index.error;
    if (!index.error && index.failures.length > 0) {
        log(`GitHub の一覧を読めなかったので（${index.failures.join(' / ')}）、サイトの写しを使います。最新でない場合があります。`);
    }
}

function loadLocal() {
    state.local = loadLocalTimelines();
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
    for (const { label, items } of groupTimelines(state.cloud, state.contentInfo)) {
        const g = Object.assign(document.createElement('optgroup'), { label: `配信: ${label}` });
        g.append(...items.map((t) => option(`cloud:${t.file}`, t.title)));
        groups.push(g);
    }
    select.replaceChildren(option('auto', '読み取ったコンテンツ名から自動で選ぶ'), ...groups);
    if (![...select.options].some((o) => o.value === state.choice)) { state.choice = 'auto'; }
    syncTimelineSelection();
}

function syncTimelineSelection() {
    const select = $('timeline-select');
    const value = state.choice === 'auto' ? state.resolvedChoice || 'auto' : state.choice;
    select.value = [...select.options].some((o) => o.value === value) ? value : 'auto';
    $('timeline-selection-mode').textContent = state.choice === 'auto'
        ? '自動選択中：コンテンツが変わると、対応するタイムラインに切り替わります。'
        : '手動選択中：選んだタイムラインを使います。';
    $('timeline-auto').hidden = state.choice === 'auto';
    $('local-remove').disabled = !state.choice.startsWith('local:');
}

const cloudTimeline = (item) => fetchTimeline(item, state.cloudBase);

// 選択（または読み取ったコンテンツ名）から使うタイムラインを決める。手元のファイルを配信より優先する
async function resolveTimeline() {
    let found = null;
    try {
        if (state.choice === 'auto') {
            const local = state.local.find((t) => t.timeline.content === state.detectedContent);
            const cloud = state.cloud.find((t) => t.content === state.detectedContent);
            if (local) {
                found = { choice: `local:${local.name}`, timeline: local.timeline, label: `${local.timeline.title ?? local.timeline.content}（手元のファイル ${local.name}）` };
            } else if (cloud) {
                found = { choice: `cloud:${cloud.file}`, timeline: await cloudTimeline(cloud), label: `${cloud.title}（配信）` };
            }
        } else if (state.choice.startsWith('local:')) {
            const local = state.local.find((t) => `local:${t.name}` === state.choice);
            found = local && { choice: `local:${local.name}`, timeline: local.timeline, label: `${local.timeline.title ?? local.timeline.content}（手元のファイル ${local.name}）` };
        } else {
            const cloud = state.cloud.find((t) => `cloud:${t.file}` === state.choice);
            found = cloud && { choice: `cloud:${cloud.file}`, timeline: await cloudTimeline(cloud), label: `${cloud.title}（配信）` };
        }
    } catch (e) {
        state.timelineError = e.message;
        setStatus('timeline-status', e.message, 'ng');
        return;
    }
    state.timelineError = '';
    state.resolvedChoice = found?.choice ?? '';
    syncTimelineSelection();
    if (found?.timeline === state.timeline && state.engine) {
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
        iconProblems(state.timeline).forEach((problem) => log(`アイコン: ${problem}`));
    }
    renderTimelineStatus();
}

function renderTimelineStatus() {
    if (state.contentBlocked) {
        setStatus('timeline-status', 'コンテンツ情報の確認待ちです。前のコンテンツによる自動再生は停止しました。コンテンツ名を再確認すると再開します。', 'warn');
        return;
    }
    const content = state.detectedContent ? `読み取ったコンテンツ名: ${state.detectedContent}` : 'コンテンツ名はまだ読み取れていません';
    if (state.cloudError && !state.timeline) {
        setStatus('timeline-status', `${content}。${state.cloudError}`, 'ng');
    } else if (state.timeline) {
        // タイムラインの作者とライセンス
        const { author, license } = state.timeline;
        const credit = author ? `。作者: ${author}${license ? `（${license}）` : ''}` : '';
        setStatus('timeline-status', `${content}。使うタイムライン: ${state.timelineLabel}${credit}`, 'ok');
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
    // 「次にすること」の取り込みの段は、いまできる操作だけを出す（共有前は「画面を共有」、共有後は開始、読み取り中は停止）
    const shared = Boolean(captureSession.source);
    $('share').hidden = shared;
    $('start').hidden = !shared || state.running;
    $('start').disabled = !state.ocr;
    $('stop').hidden = !state.running;
    $('stop').disabled = !state.running;
    $('reset').disabled = !state.engine;
}

// ── 読む範囲 ──

// 再生できる範囲を保存してある画面の大きさ（コンテンツ名と、戦闘の開始を知る範囲がある。ホームの app.js と同じ判定）
const savedScreens = () => listSavedScreens().filter((s) => s.usable).map((s) => s.key);

// 指定していない範囲と、そのためにできないこと（取り込み中の画面の大きさで見る。範囲の指定は初期設定の画面 #setup）
function renderMissing() {
    const size = state.frameSize;
    const el = $('regions-missing');
    if (!size) {
        const saved = savedScreens();
        el.textContent = saved.length > 0
            ? `済み（画面 ${saved.join('・')}）。取り込みを始めると、その画面の大きさで確かめます。`
            : 'まだ決めていません。';
        el.className = `read-status ${saved.length > 0 ? 'ok' : ''}`.trim();
        return;
    }
    const key = screenKey(size.width, size.height);
    const missing = missingRegions(regionsFor(size.width, size.height));
    el.textContent = missing.length === 0
        ? `画面 ${key} の範囲はすべて指定してあります。`
        : `画面 ${key} で未指定: ${missing.map((m) => `${m.label}（${m.lost}）`).join('、')}。`
            + (settings.autoRegions ? '取り込み中に画面に出れば、自動で探します。' : '初期設定の画面で指定してください。');
    // 開始を検知できないときだけ誤り。ほかは使えるが一部の働きが欠ける（注意）
    el.className = `read-status ${missing.length === 0 ? 'ok' : missing.some((m) => m.id === 'start') ? 'ng' : 'warn'}`;
}

function regionsChanged() {
    state.regionsKey = ''; // 次のフレームで読み直す
    renderMissing();
}

async function start() {
    if (state.running || starting) { return; }
    starting = true;
    if (!navigator.mediaDevices?.getDisplayMedia) {
        starting = false;
        setStatus('run-status', 'このページでは画面を取り込めません。https か localhost で開いてください。', 'ng');
        return;
    }
    try {
        state.source = await FrameSource.start(stop);
    } catch (e) {
        starting = false;
        setStatus('run-status', `取り込みを始められませんでした（${e.name}）`, 'ng');
        return;
    }
    // 自動で探すかは初期設定の画面で切り替える（別のタブで変えたものを使う）
    settings.autoRegions = load(STORE_SETTINGS, {}).autoRegions ?? true;
    starting = false;
    state.contentPresence.reset();
    state.running = true;
    state.regionsKey = '';
    state.lastContentAt = 0;
    Object.assign(state, { contentMissSince: null, contentMissWarned: false, contentMuted: false, regionsLogged: '', contentReads: [], heldContent: null });
    updateButtons();
    setStatus('run-status', '読み取り中です。', 'ok');
    log(`── 読み取り開始（取り込み ${state.source.method}）`);
    autoFindLoop(state.source);

    // このループが使う取り込み。止めてすぐ始め直したとき、古いループが新しい取り込みで回り続けないように比べる
    const source = state.source;
    let nextAt = 0;
    while (state.running && state.source === source) {
        // 前回のフレームから 0.5 秒以上あとに届いたフレームを待つ（ゲームが前面だとタイマーが間引かれるので使わない）
        const grabbed = await source.grab(nextAt);
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
    autoRequested = false;
    if (!state.running) {
        return;
    }
    state.running = false;
    voice.cancel(); // 作りかけ・読みかけの文言も止める
    state.source?.stop();
    state.source = null;
    state.frameSize = null; // 範囲の設定は、止めたあとは指定に使っている画面の大きさで見る
    updateButtons();
    renderMissing();
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
                ? `画面 ${key} の範囲はまだありません。初期設定の画面で指定してください（画面に出たものから、ここでも自動で探します）。`
                : `画面 ${key} の範囲がありません。初期設定の画面で指定してください。`, 'ng');
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
    if (engine) {
        // 開始はコンテンツ名を読めている間だけ（表示のための status() からも、カウントダウンの予想時刻で始めない）
        engine.startAllowed = state.contentPresence.canStart(at);
    }
    const inCombat = engine?.status(at).state === 'combat';
    const black = isBlackFrame(frame); // 全滅の暗転（読み取りの前に見る）
    const wantContent = at - state.lastContentAt >= (state.detectedContent ? CONTENT_EVERY_MS : CONTENT_RETRY_MS);
    if (wantContent) {
        state.lastContentAt = at;
    }
    const obs = await state.ocr.readFrame(frame, state.regions, {
        content: wantContent ? state.contents : null,
        // 戦闘中でも、敵が見えないときはカウントダウンを読む（全滅の暗転を読み逃したときの次の戦闘）
        countdown: !inCombat || (engine.hasEnmity && !engine.enmityShown),
        // 技名は戦闘中だけ、いまの時刻の前後にある技に絞って照合する
        castCandidates: inCombat ? engine.castCandidates(at) : [],
    });
    // 読んでいる間に範囲が変わった（消した・自動で指定した）ら、古い範囲で読んだ結果は使わない
    // （消す前の範囲で読んだ「敵対リストあり」が、リセットのあとに戦闘開始として届くことがあった）
    if (state.regionsKey !== key) {
        return;
    }

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
    if (wantContent && !obs.content?.text?.trim()) {
        state.contentReads = [];
    }
    if (obs.content) {
        let combined = null;
        if (!obs.content.decided && obs.content.ranked) {
            state.contentReads = [...state.contentReads, obs.content].slice(-CONTENT_COMBINE);
            combined = combineCandidates(state.contentReads);
        }
        const accepted = acceptContentName({ single: obs.content.decided, combined, current: state.detectedContent, inCombat });
        if (accepted === null && obs.content.decided && obs.content.decided !== state.heldContent) {
            state.heldContent = obs.content.decided;
            log(`コンテンツ名を ${obs.content.decided} と読んだが、戦闘中なので ${state.detectedContent} のまま続けます`, at);
        }
        if (accepted !== null && !obs.content.decided && accepted !== state.detectedContent) {
            log(`コンテンツ名を ${state.contentReads.length} 回の読み取りを合わせて決めました`, at);
        }
        obs.content.decided = accepted;
    }
    if (wantContent) {
        // 確認できたとみなすのは採った名前だけ（戦闘中に読んだ別の名前で、消音・解除の判定を止めない）
        state.contentPresence.observe(at, Boolean(obs.content?.decided));
    }
    if (obs.content?.decided) {
        state.heldContent = null;
        state.contentReads = [];
        state.contentBlocked = false;
    }
    if (obs.content?.decided && (obs.content.decided !== state.detectedContent || !state.engine)) {
        state.detectedContent = obs.content.decided;
        log(`コンテンツ名 ${obs.content.decided}`, at);
        await resolveTimeline();
        renderTimelineStatus();
    }
    const recentHp = engine?.lastHpAt !== null && engine?.lastHpAt !== undefined && at - engine.lastHpAt <= 3000;
    const recentCast = engine && [...engine.castSeenAt.values()].some((time) => at - time <= 5000);
    const combatEvidence = inCombat && (Number.isFinite(obs.hp) && obs.hp > 0
        || obs.casts.some((cast) => Boolean(cast.decided)) || recentHp || recentCast);
    // カウントダウン中は解除しない（解除するとカウントダウンの予想時刻も消える。2026-10-27 ヘビー級1 零式で、戦闘開始の 4 秒後に
    // 解除されて開始を 35 秒逃した）。予想時刻を過ぎても始まらなければ、エンジンがカウントダウンを取り消すので、その後に解除する
    const countingDown = state.engine?.status(at).state === 'countdown';
    if (!countingDown && state.contentPresence.shouldClear(at, combatEvidence, inCombat)) {
        if (!state.contentBlocked) {
            log('コンテンツ名を確認できず、HP・詠唱も確認できないため自動再生を解除。コンテンツ情報の再確認まで待機します', at);
        }
        state.contentBlocked = true;
        state.contentMuted = false;
        state.detectedContent = null;
        state.contentReads = [];
        state.engine = null;
        voice.cancel();
        state.spoken.clear();
        if (state.choice === 'auto') {
            state.timeline = null;
            state.timelineLabel = '';
            state.resolvedChoice = '';
        }
        syncTimelineSelection();
        renderTimelineStatus();
    }
    // 戦闘中にコンテンツ名・HP・詠唱が読めない間（ムービー、または気づかないうちに出た）は、解除までは待つが読み上げは止める
    const muted = inCombat && state.engine !== null && state.contentPresence.shouldMute(at, combatEvidence);
    if (muted !== state.contentMuted) {
        state.contentMuted = muted;
        if (muted) {
            voice.cancel();
        }
        log(muted
            ? `コンテンツ名を ${MISSING_CLEAR_MS / 1000} 秒読めず、HP・詠唱も確認できないため読み上げを止めます（ムービーなら戦闘の時刻は保ったまま。${MISSING_CLEAR_COMBAT_MS / 1000} 秒続けば解除）`
            : '読み上げを再開しました', at);
    }
    // An enemy-list-shaped text block in Party Finder is not permission to pull.
    const allowObservation = state.contentPresence.canStart(at) || inCombat && !state.contentBlocked;
    if (state.engine) {
        state.engine.startAllowed = state.contentPresence.canStart(at);
    }
    if (engine && engine === state.engine && allowObservation) {
        if (black !== state.lastBlack && engine.status(at).state === 'combat') {
            log(black ? '画面が暗転しました' : '画面の暗転が終わりました', at);
        }
        state.lastBlack = black;
        engine.blackout(at, black);
        if (obs.countdown?.started) {
            engine.started(at);
        } else if (obs.countdown) {
            engine.countdown(at, obs.countdown.seconds);
        }
        if ('hp' in obs) {
            engine.hpPercent(at, obs.hp);
        }
        if ('enmity' in obs) {
            if (obs.enmity !== state.lastEnmity) {
                state.lastEnmity = obs.enmity;
                const hpAge = engine.lastHpAt === null ? '未読' : `${((at - engine.lastHpAt) / 1000).toFixed(1)}秒前`;
                log(`${obs.enmity ? '敵対リストが出た' : '敵対リストが消えた'}（最終HP: ${engine.hp === null ? '未読' : `${engine.hp}%`}、HP観測: ${hpAge}、フェーズ: ${engine.phase?.id ?? '未確定'}）`, at);
            }
            engine.enmity(at, obs.enmity);
        }
        for (const cast of obs.casts) {
            if (cast.decided && state.lastCast[cast.source] !== cast.decided) {
                // 読んだ文字もそのまま残す（読み違いで同期がずれたときに、何をどう読んだかを確かめるため）
                log(`詠唱（${cast.source === 'bar' ? '詠唱バー' : '敵対リスト'}） ${cast.decided}（読んだ文字: ${cast.text}）`, at);
            }
            state.lastCast[cast.source] = cast.decided;
            if (cast.decided) {
                engine.cast(at, cast.decided);
            }
        }
        const offSince = engine.enmityOffSince;
        if (state.clearNoticeFight !== engine.startAt) {
            state.clearNoticeFight = engine.startAt;
            state.clearNotice.reset();
            state.lastClearReadAt = 0;
        }
        if (engine.state === 'combat' && !engine.enmityShown && offSince !== null
            && at - offSince >= 1000 && at - state.lastClearReadAt >= 1000) {
            state.lastClearReadAt = at;
            const area = { x: Math.round(frame.width * 0.2), y: Math.round(frame.height * 0.15),
                w: Math.round(frame.width * 0.6), h: Math.round(frame.height * 0.45) };
            const lines = await state.ocr.scanLines(frame, area);
            if (engine !== state.engine || !state.running || state.regionsKey !== key) { return; }
            if (state.clearNotice.observe(at, isDutyCompleteText(lines))) {
                engine.end(at, '敵対リストの消失後、画面中央のコンテンツクリア表示を複数フレームで確認。討伐');
            }
        } else if (engine.enmityShown || engine.state !== 'combat') {
            state.clearNotice.reset();
        }
        if (engine.state === 'combat' && !engine.enmityShown && offSince !== null && at - offSince >= 3000) {
            const key = `${engine.startAt}:${offSince}`;
            if (key !== state.endDiagnosticKey) {
                state.endDiagnosticKey = key;
                log(`敵対リスト消失後の終了確認: 最終HP ${engine.hp === null ? '未読' : `${engine.hp}%`}、最終フェーズ ${Boolean(engine.phase && (engine.phase.next ?? []).length === 0)}、コンテンツ情報の範囲 ${Boolean(state.regions.content)}。低HPと画面表示を確認できなければ、ムービー・フェーズ移行との区別のため終了を保留`, at);
            }
        }
        if (needsKillConfirmation(engine, at, Boolean(state.regions.content))) {
            const confirmation = await state.ocr.readFrame(frame, { content: state.regions.content }, { content: state.contents });
            if (engine === state.engine && state.running && state.regionsKey === key
                && confirmation.content?.text?.trim()) {
                engine.end(at, `最後のフェーズで HP ${engine.hp}% の後に敵対リストが消え、コンテンツ情報は表示中。討伐`);
            }
        } else {
            const casts = [...engine.castSeenAt.values()].filter((time) => time >= engine.startAt).length;
            if (falseStart(engine, at, casts)) {
                engine.end(at, 'HPも詠唱も確認できないまま敵対リストが消えた。開始の誤判定として解除');
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
async function autoFindLoop(source) {
    const finder = new RegionAutoFinder({
        ocr: state.ocr,
        contents: () => state.contents,
        casts: () => castNamesOf(state.timeline),
        status: (at) => state.engine?.status(at).state ?? null,
    });
    const live = () => state.running && state.source === source && settings.autoRegions;
    let nextAt = 0;
    while (state.running && state.source === source) {
        const grabbed = await source.grab(nextAt);
        if (!grabbed) {
            break;
        }
        nextAt = grabbed.at + AUTO_EVERY_MS;
        try {
            if (settings.autoRegions) {
                const found = await finder.step(grabbed.bitmap, grabbed.at, live);
                if (found.length > 0) {
                    log(`範囲を自動で指定: ${found.map((f) => f.label).join('・')}`, grabbed.at);
                    found.forEach((f) => log(`　${foundDetail(f)}`, grabbed.at));
                    regionsChanged();
                }
            }
        } catch (e) {
            log(`範囲の自動指定でエラー: ${e.message}`);
        } finally {
            grabbed.bitmap.close();
        }
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
        if (state.contentBlocked) { return { head: 'コンテンツ情報の確認待ち', sub: 'コンテンツ外、またはコンテンツ名を読み取れないため、自動再生を停止しています', items: [] }; }
        return { head: 'タイムラインがありません', sub: '一覧で選ぶか、コンテンツ名を認識すると動作待機します', items: [] };
    }
    const s = engine.status(now);
    let sub = '';
    if (s.state === 'idle') {
        sub = 'カウントダウンか敵対リストで始まります';
    } else if (s.state === 'countdown') {
        sub = s.predictedStart ? `開始まで ${secondsText(Math.max(0, (s.predictedStart - now) / 1000))} 秒` : '';
    } else if (s.state === 'combat') {
        // ボスが何体もいるタイムラインでは、最初に読めた技でボスが決まるまで予定を出さない（道中の戦闘は決まらないまま）
        const phases = !s.phase ? '・どのボスか判定中（ボスの技を読むと決まります）'
            : engine.timeline.phases.length > 1 ? `・${s.phase.name ?? s.phase.id}` : '';
        sub = `${combatClock(s.combatTime)}${phases}`;
    } else if (engine.holdUntilEnmityOff) {
        sub = 'カウントダウンか敵対リストの再表示で始まります'; // 敵対リストは一度消えてからまた出たとき
    } else {
        sub = '次のカウントダウンか敵対リストで始まります';
    }
    // 表示は text があれば text だけ、無ければ技名。同じ攻撃が続くときは 1 行にまとめて「x4」（2026-10-21 のユーザーの指定）
    const items = upcomingRows(engine.upcoming(now, UPCOMING_COUNT * 3), engine.timeline).slice(0, UPCOMING_COUNT).map((row) => ({
        in: row.hitIn > 0 ? secondsText(row.hitIn) : '発動',
        name: row.count > 1 ? `${row.name} x${row.count}` : row.name,
        icons: row.icons,
        kind: row.hitIn <= 0 ? 'done' : row.castIn <= 0 ? 'casting' : '',
    }));
    return { head: s.state === 'ended' && engine.holdUntilEnmityOff ? '止めました' : STATE_TEXT[s.state], sub, items, status: s };
}

const PANEL_HTML = `
    <div class="tl-panel">
        <div class="tl-head"><span><span data-k="head"></span> <span class="tl-sub" data-k="sub"></span></span><button type="button" class="tl-halt" data-k="halt" hidden>止める</button></div>
        <ol class="tl-list" data-k="list"></ol>
    </div>`;

function renderPanel(doc, view) {
    const panel = doc.querySelector('.tl-panel');
    if (!panel) {
        return;
    }
    panel.querySelector('[data-k="head"]').textContent = view.head;
    panel.querySelector('[data-k="sub"]').textContent = view.sub;
    panel.querySelector('[data-k="halt"]').hidden = !['countdown', 'combat'].includes(view.status?.state);
    // アイコンは時刻の左。行ごとに数が違っても時刻の列がそろうよう、アイコンの欄の幅を見えている行の最大に合わせる
    const list = panel.querySelector('[data-k="list"]');
    const iconCount = Math.max(0, ...view.items.map((item) => item.icons?.length ?? 0));
    list.style.setProperty('--tl-icons', String(iconCount));
    list.replaceChildren(...view.items.map((item) => {
        const li = doc.createElement('li');
        li.className = item.kind;
        const icons = doc.createElement('span');
        icons.className = 'tl-icons';
        icons.hidden = iconCount === 0; // どの行にもアイコンが無ければ欄ごと出さない
        icons.append(...(item.icons ?? []).map((icon) => Object.assign(doc.createElement('img'), {
            src: icon.url, alt: icon.alt, title: icon.alt, className: 'tl-icon', decoding: 'async',
        })));
        const time = doc.createElement('span');
        time.className = 'tl-in';
        time.textContent = item.in;
        const name = doc.createElement('span');
        name.textContent = item.name;
        li.append(icons, time, name);
        return li;
    }));
}

function speech(now) {
    const engine = state.engine;
    // 読み取りを止めたら読まない（画面の時計だけで戦闘中のまま読み続けないように）
    if (!settings.tts || !engine || !state.running || state.contentMuted) {
        return;
    }
    const s = engine.status(now).state;
    // VOICEVOX は 1 つ作るのに 1 秒前後かかるので、カウントダウン中から先に作っておく
    if ((s === 'combat' || s === 'countdown') && now - state.lastPrepare >= PREPARE_EVERY_MS) {
        state.lastPrepare = now;
        voice.prepare(engine.upcoming(now, 20)
            .filter((u) => u.hitIn <= PREPARE_AHEAD_S && !state.spoken.has(u.entry) && ttsText(u.entry))
            .map((u) => ttsText(u.entry)));
    }
    if (s !== 'combat') {
        return;
    }
    if (engine.startAt !== state.spokenStartAt) {
        // 新しい戦闘
        state.spokenStartAt = engine.startAt;
        state.spoken = new Set();
        say('戦闘開始');
    }
    for (const u of engine.upcoming(now, 20)) {
        const e = u.entry;
        const late = settings.lead - u.hitIn; // 読み上げる時刻（発動の lead 秒前）を何秒過ぎたか
        if (state.spoken.has(e) || late < 0) {
            continue;
        }
        state.spoken.add(e);
        if (late <= SPEAK_LATE_MAX_S && ttsText(e)) {
            say(ttsText(e));
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
    renderGuide(now);
    const view = buildView(now);
    renderPanel(document, view);
    if (pip.isOpen) {
        renderPanel(pip.win.document, view);
    }
    speech(now);
}

// 「次にすること」。変わったときだけ書き換える（毎回作り直すとボタンのフォーカスや読み上げソフトの読みが乱れる）
function renderGuide(now) {
    const size = state.running ? state.frameSize : null;
    const { steps } = guideSteps({
        savedScreens: state.running ? [] : savedScreens(),
        frame: size ? { key: screenKey(size.width, size.height), missing: missingRegions(regionsFor(size.width, size.height)) } : null,
        autoRegions: settings.autoRegions,
        choice: state.choice,
        timelineLabel: state.timeline ? state.timelineLabel : '',
        detectedContent: state.detectedContent,
        timelineError: state.timelineError || (!state.timeline && state.cloudError) || '',
        tts: settings.tts,
        ttsTested: state.ttsTested,
        ocr: state.ocr ? 'ready' : state.ocrError ? 'error' : 'loading',
        ocrProgress: Number($('model-progress').value) || null,
        running: state.running,
        shared: Boolean(captureSession.source),
        pipSupported: pipSupported(),
        pipOpen: pip.isOpen,
        engineState: state.engine?.status(now).state ?? null,
    });
    const key = JSON.stringify(steps);
    if (key === state.guideKey) {
        return;
    }
    state.guideKey = key;
    for (const step of steps) {
        const li = $(`guide-${step.id}`);
        li.className = [step.current ? 'current' : step.kind === 'done' ? 'done' : 'todo', step.kind === 'ng' ? 'ng' : '', step.optional ? 'optional' : '',
            'keepActions' in li.dataset ? 'keep-actions' : '']
            .filter(Boolean).join(' ');
        // 青いボタンは「いまの手順」のものだけにする（次に押すボタンを 1 つに絞る）
        for (const btn of li.querySelectorAll('[data-primary]')) { btn.classList.toggle('btn-primary', step.current); }
        li.querySelector('.step-mark').replaceChildren(step.kind === 'done' ? icon('check_circle') : step.kind === 'ng' ? icon('error') : li.dataset.step);
        const own = li.querySelector('[data-guide-state]'); // 取り込み・範囲は元からある状態の欄を使う
        if (own) {
            own.textContent = step.text;
            own.className = `read-status step-state ${step.kind === 'done' ? 'ok' : step.kind === 'ng' ? 'ng' : ''}`.trim();
        }
    }
}

async function openPip() {
    if (!pipSupported()) {
        setStatus('run-status', 'このブラウザは小窓（Document Picture-in-Picture）に対応していません。Chrome か Edge の新しい版で開いてください。', 'ng');
        return;
    }
    const win = await pip.open({ width: 380, height: 300, html: PANEL_HTML, onFrame: () => update() });
    bindPanel(win.document);
    update(true);
}

function bindPanel(doc) {
    doc.querySelector('[data-k="halt"]').addEventListener('click', halt);
}

// タイムラインを手で止める。敵対リストが出たままでもすぐには始め直さず、次のカウントダウンか、敵対リストが一度消えてから始まる
function halt() {
    state.engine?.halt(Date.now());
    voice.cancel();
    state.spoken = new Set();
    state.spokenStartAt = null;
    log('タイムラインを手で止めました');
    update(true);
}

// ── 読み上げの声 ──
function saveSpeech(patch) {
    Object.assign(settings.speech, patch);
    save(STORE_SETTINGS, settings);
}

function renderVoiceSettings() {
    const s = settings.speech;
    $('tts-engine').value = s.engine;
    $('voice-browser').hidden = s.engine !== 'browser';
    $('voice-voicevox').hidden = s.engine !== 'voicevox';
    const select = $('tts-voice');
    const voices = japaneseVoices();
    select.replaceChildren(
        Object.assign(document.createElement('option'), { value: '', textContent: '既定の日本語の声' }),
        ...voices.map((v) => Object.assign(document.createElement('option'), {
            value: v.name, textContent: `${v.name}${v.local ? '' : '（オンライン）'}`,
        })),
    );
    select.value = voices.some((v) => v.name === s.voice) ? s.voice : '';
    $('tts-volume').value = s.volume;
    $('tts-rate').value = s.rate;
    $('tts-volume-value').textContent = `${Math.round(s.volume * 100)}%`;
    $('tts-rate-value').textContent = `${Number(s.rate).toFixed(1)} 倍`;
    $('voicevox-url').value = s.voicevoxUrl;
    $('voicevox-origin').textContent = location.origin;
    $('voicevox-credit').textContent = s.engine === 'voicevox' && s.voicevoxName ? `VOICEVOX:${s.voicevoxName}` : '';
}

async function connectVoicevox() {
    const url = $('voicevox-url').value.trim() || DEFAULT_SPEECH.voicevoxUrl;
    saveSpeech({ voicevoxUrl: url });
    setStatus('voicevox-status', '接続しています…');
    try {
        const styles = await voicevoxStyles(url);
        const select = $('voicevox-speaker');
        select.replaceChildren(...styles.map((st) => Object.assign(document.createElement('option'), { value: String(st.id), textContent: st.label })));
        const current = styles.find((st) => st.id === settings.speech.voicevoxSpeaker) ?? styles[0];
        if (current) {
            select.value = String(current.id);
            saveSpeech({ voicevoxSpeaker: current.id, voicevoxName: current.name });
        }
        select.disabled = styles.length === 0;
        setStatus('voicevox-status', `つながりました（声 ${styles.length} 種類）。`, 'ok');
        voice.prepare(['戦闘開始', '読み上げの試験です']);
    } catch (e) {
        setStatus('voicevox-status', `VOICEVOX につながりませんでした（${e.message}）。VOICEVOX を起動しているか、`
            + 'このページからの接続を許可しているかを確かめてください（手順はすぐ下の「VOICEVOX を使う準備」）。', 'ng');
    }
    renderVoiceSettings();
}

function setupVoiceSettings() {
    $('tts-engine').addEventListener('change', (ev) => {
        saveSpeech({ engine: ev.target.value });
        renderVoiceSettings();
        if (ev.target.value === 'voicevox' && $('voicevox-speaker').options.length === 0) {
            connectVoicevox();
        }
    });
    $('tts-voice').addEventListener('change', (ev) => saveSpeech({ voice: ev.target.value }));
    $('tts-volume').addEventListener('input', (ev) => {
        saveSpeech({ volume: Number(ev.target.value) });
        renderVoiceSettings();
    });
    $('tts-rate').addEventListener('input', (ev) => {
        saveSpeech({ rate: Number(ev.target.value) });
        renderVoiceSettings();
    });
    $('voicevox-connect').addEventListener('click', connectVoicevox);
    $('voicevox-speaker').addEventListener('change', (ev) => {
        const option = ev.target.selectedOptions[0];
        saveSpeech({ voicevoxSpeaker: Number(ev.target.value), voicevoxName: option.textContent.replace(/（.*$/, '') });
        renderVoiceSettings();
    });
    // 声の一覧は後から読み込まれることがある
    speechSynthesis.addEventListener?.('voiceschanged', renderVoiceSettings);
    renderVoiceSettings();
    if (settings.speech.engine === 'voicevox') {
        connectVoicevox();
    }
}

// ── 初期化 ──
async function init() {
    $('panel').innerHTML = PANEL_HTML;
    bindPanel(document);
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
    $('tts-test').addEventListener('click', () => say('読み上げの試験です', true));
    for (const g of GUIDE_STEPS) {
        $(`guide-${g.id}`).querySelector('.step-title').textContent = g.optional ? `${g.title}（しなくてもよい）` : g.title;
    }
    $('guide-tts-test').addEventListener('click', () => say('読み上げの試験です', true));
    // 手元の XML: 「使うタイムライン」の折りたたみを開いて、そのままファイルを選ぶ窓を出す（読み込みは local-file の change で行う）
    $('guide-xml').addEventListener('click', () => {
        $('local-file').closest('details').open = true;
        $('local-file').click();
    });
    $('guide-timeline-go').addEventListener('click', () => {
        $('timeline-select').scrollIntoView({ block: 'center' });
        $('timeline-select').focus();
    });
    setupVoiceSettings();
    $('share').addEventListener('click', () => document.getElementById('capture-start').click());
    window.addEventListener('castline:capture', updateButtons);
    $('start').addEventListener('click', start);
    $('stop').addEventListener('click', stop);
    $('reset').addEventListener('click', halt);
    $('pip-open').addEventListener('click', openPip);
    $('timeline-auto').addEventListener('click', async () => {
        state.choice = 'auto';
        await resolveTimeline();
        updateButtons();
    });
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
    // 初期設定の画面（別のタブ）で範囲を変えたら、次のフレームから使う
    window.addEventListener('storage', (ev) => {
        if (ev.key === STORE_REGIONS) {
            regionsChanged();
        } else if (ev.key === STORE_LOCAL) {
            loadLocal(); renderSelect(); resolveTimeline();
        }
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
        state.contentInfo = (await (await fetch('data/contents.json')).json()).contents;
    } catch {
        state.contentInfo = [];
    }
    state.contents = state.contentInfo.map((c) => c.name);
    renderMissing();
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

export const ready = init();

// Returning to the view must preserve the active combat engine and selected timeline.
export function refresh() { regionsChanged(); renderTimelineStatus(); }

export function activateAuto() {
    autoRequested = true;
    if (state.ocr && captureSession.source) { void start(); }
}
export function deactivateAuto() { autoRequested = false; }
