// 再生画面: ゲーム画面を読み、タイムライン（これから来る技と発動までの秒）を流して読み上げる。
import './storage-migrate.js';
import { FrameSource } from './capture.js';
import { OcrClient } from './ocr-client.js';
import { TimelineEngine, castNames } from './timeline-engine.js';
import { parseTimelineXml } from './timeline-xml.js';
import { STORE_LOCAL, loadTimelineIndex, fetchTimeline, loadLocalTimelines } from './timeline-source.js';
import { RegionAutoFinder, castNamesOf, foundDetail } from './region-auto.js';
import { REGION_KINDS, STORE_REGIONS, regionsFor, missingRegions, screenKey } from './regions.js';
import { Pip, pipSupported } from './pip.js';
import { Speech, DEFAULT_SPEECH, japaneseVoices, voicevoxStyles } from './speech.js';

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
    lastPrepare: 0,
};
const settings = { tts: true, lead: 5, autoRegions: true, ...load(STORE_SETTINGS, {}) };
settings.speech = { ...DEFAULT_SPEECH, ...(settings.speech ?? {}) };
const pip = new Pip();
const voice = new Speech(() => settings.speech);
const PREPARE_EVERY_MS = 1000;
const PREPARE_AHEAD_S = 40; // VOICEVOX で先に作っておく範囲（発動までの秒。1 つ作るのに 1 秒前後かかる）

// 読み上げる（小窓が開いていれば小窓の側から鳴らす。小窓は表示されているので止められにくい）
function say(text) {
    voice.speak(text, pip.isOpen ? pip.win : window).catch((e) => log(`読み上げられませんでした（${e.message}）`));
}
const ttsText = (e) => e.tts ?? showName(e.name); // text は表示だけ。tts が無ければ技名を読む（Hojoring の notice と text と同じ分け方）

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
        const url = (path) => new URL(path, location.href).href;
        state.ocr = await OcrClient.load(
            { rec: url('models/ppocrv5_rec.onnx'), dict: url('models/ppocrv5_dict.txt'), det: url('models/ppocrv5_det.onnx') },
            (name, received, size) => onProgress(name)(received, size),
        );
        progress.hidden = true;
        setStatus('model-status', '文字認識の準備ができました。', 'ok');
    } catch (e) {
        setStatus('model-status', `文字認識のモデルを読み込めませんでした: ${e.message}`, 'ng');
    }
    updateButtons();
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

const cloudTimeline = (item) => fetchTimeline(item, state.cloudBase);

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

// ── 読む範囲 ──

// 指定していない範囲と、そのためにできないこと（取り込み中の画面の大きさで見る。範囲の指定は初期設定の画面 setup.html）
function renderMissing() {
    const size = state.frameSize;
    const el = $('regions-missing');
    if (!size) {
        el.textContent = '取り込みを始めると、その画面の大きさで指定した範囲を確かめます。';
        el.className = 'status';
        return;
    }
    const key = screenKey(size.width, size.height);
    const missing = missingRegions(regionsFor(size.width, size.height));
    el.textContent = missing.length === 0
        ? `画面 ${key} の範囲はすべて指定してあります。`
        : `画面 ${key} で未指定: ${missing.map((m) => `${m.label}（${m.lost}）`).join('、')}。`
            + (settings.autoRegions ? '取り込み中に画面に出れば、自動で探します。' : '初期設定の画面で指定してください。');
    // 開始を検知できないときだけ誤り。ほかは使えるが一部の働きが欠ける（注意）
    el.className = `status ${missing.length === 0 ? 'ok' : missing.some((m) => m.id === 'start') ? 'ng' : 'warn'}`;
}

function regionsChanged() {
    state.regionsKey = ''; // 次のフレームで読み直す
    renderMissing();
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
    // 自動で探すかは初期設定の画面で切り替える（別のタブで変えたものを使う）
    settings.autoRegions = load(STORE_SETTINGS, {}).autoRegions ?? true;
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
    const inCombat = engine?.status(at).state === 'combat';
    const wantContent = !inCombat && at - state.lastContentAt >= CONTENT_EVERY_MS;
    if (wantContent) {
        state.lastContentAt = at;
    }
    const obs = await state.ocr.readFrame(frame, state.regions, {
        content: wantContent ? state.contents : null,
        countdown: !inCombat,
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
    if (!settings.tts || !engine) {
        return;
    }
    const s = engine.status(now).state;
    // VOICEVOX は 1 つ作るのに 1 秒前後かかるので、カウントダウン中から先に作っておく
    if ((s === 'combat' || s === 'countdown') && now - state.lastPrepare >= PREPARE_EVERY_MS) {
        state.lastPrepare = now;
        voice.prepare(engine.upcoming(now, 20)
            .filter((u) => u.hitIn <= PREPARE_AHEAD_S && !state.spoken.has(u.entry) && u.entry.tts !== '')
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
        if (late <= SPEAK_LATE_MAX_S && e.tts !== '') {
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
    $('tts-test').addEventListener('click', () => say('読み上げの試験です'));
    setupVoiceSettings();
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
    // 初期設定の画面（別のタブ）で範囲を変えたら、次のフレームから使う
    window.addEventListener('storage', (ev) => {
        if (ev.key === STORE_REGIONS) {
            regionsChanged();
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
