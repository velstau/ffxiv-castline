import './storage-migrate.js';
import { captureSession } from './capture.js';
import { savedScreens, STORE_REGIONS } from './regions.js';

const $ = (id) => document.getElementById(id);
const views = new Set(['home', 'setup', 'player', 'manage', 'recorder', 'generator', 'lab', 'timeline', 'voice']);
const wizardRoutes = ['home', 'setup', 'player'];
const modules = new Map();
let current = 'home';
let routeVersion = 0;

function message(text = '') {
    $('app-message').textContent = text;
    $('app-message').hidden = !text;
}

function renderStatus() {
    const sharing = Boolean(captureSession.source);
    const size = captureSession.size;
    $('capture-status').textContent = sharing ? '画面を共有中 · 画面切り替え後も継続' : '画面は共有されていません';
    $('capture-status').className = `status status-${sharing ? 'green' : 'secondary'}`;
    $('capture-size').textContent = size ? `${size.width} × ${size.height}` : '';
    $('capture-start').hidden = sharing;
    $('capture-stop').hidden = !sharing;
    const saved = savedScreens();
    const key = size ? `${size.width}x${size.height}` : null;
    const complete = saved.filter((s) => s.complete);
    const ready = key ? complete.some((s) => s.key === key) : complete.length > 0;
    const partial = key ? saved.some((s) => s.key === key) : saved.length > 0;
    const badge = ready ? '設定済み' : partial ? '設定途中' : '未設定';
    for (const id of ['setup-summary-badge', 'setup-nav-badge']) {
        $(id).textContent = badge;
        $(id).className = `badge ${id === 'setup-nav-badge' ? 'ms-2 ' : ''}bg-${ready ? 'green' : 'yellow'}-lt`;
    }
    $('setup-summary-title').textContent = ready ? '初期設定は済んでいます' : '初期設定：読む場所を決めます';
    $('setup-summary').textContent = ready
        ? `保存済みの設定（${(key ? [key] : complete.map((s) => s.key)).join('・')}）を使えます。設定をやり直す必要はありません。画面を共有して再生へ進んでください。`
        : key && saved.length > 0
            ? `共有中の画面（${key}）の設定がまだ揃っていません。保存済みの画面サイズは ${saved.map((s) => s.key).join('・')} です。初期設定で確認してください。`
            : '初回だけ、コンテンツ名・カウントダウン・HP・詠唱バー・敵対リストを読む場所を確認します。設定はこのブラウザに保存されます。';
    $('home-next').href = ready ? '#player' : '#setup';
    $('home-next').textContent = ready ? '保存済み設定で次へ進む' : partial ? '初期設定の続きを行う' : '画面共有後、初期設定へ進む';
    $('home-review').hidden = !ready;
    renderWizard();
}

function wizardIndex() {
    return wizardRoutes.indexOf(location.hash.slice(1) || 'home');
}
function configured() {
    const size = captureSession.size;
    return savedScreens().some((s) => s.complete && (!size || s.key === `${size.width}x${size.height}`));
}
function renderWizard() {
    const index = wizardIndex();
    $('wizard-progress').hidden = index < 0;
    $('wizard-controls').hidden = index < 0;
    if (index < 0) { return; }
    for (const marker of document.querySelectorAll('[data-wizard-marker]')) {
        const own = Number(marker.dataset.wizardMarker);
        marker.classList.toggle('active', own === index);
        const link = marker.querySelector('a');
        if (own === index) { link.setAttribute('aria-current', 'step'); }
        else { link.removeAttribute('aria-current'); }
        link.textContent = ['画面を共有','読み取り範囲','設定・自動再生'][own]
            + (own === 1 && configured() ? '（設定済み）' : '');
    }
    for (const pane of document.querySelectorAll('[data-wizard-pane]')) {
        const own = Number(pane.dataset.wizardPane);
        pane.hidden = index !== 2;
    }
    $('view-player').classList.remove('wizard-stage');
    $('view-player').querySelector('h1').textContent = '3. タイムライン・読み上げ・自動再生';
    $('wizard-back').disabled = index === 0;
    $('wizard-next').hidden = index === 2;
    $('wizard-next').textContent = index === 0 && configured() ? '保存済み設定で自動再生へ →' : '次へ →';
    $('wizard-count').textContent = `${index + 1} / 3`;
}
function wizardGo(index) {
    // Timeline selection and voice preferences can be prepared before sharing.
    // Sharing and range requirements apply when advancing through the wizard.
    location.hash = wizardRoutes[index];
}
function advanceWizard(index) {
    message();
    if (!captureSession.source) {
        message('先に「画面を共有」でゲームのウィンドウを選んでください。');
        $('capture-start').focus(); return;
    }
    if (index > 1 && !configured()) {
        if (location.hash === '#setup') {
            message('読む範囲の設定がまだ完了していません。現在の手順を進め、右側の確認欄で検出結果を確かめてください。');
        } else { location.hash = 'setup'; }
        return;
    }
    wizardGo(index);
}
$('home-next').addEventListener('click', (ev) => { ev.preventDefault(); advanceWizard(configured() ? 2 : 1); });
$('wizard-back').addEventListener('click', () => wizardGo(Math.max(0, wizardIndex() - 1)));
$('wizard-next').addEventListener('click', () => {
    const index = wizardIndex();
    advanceWizard(index === 0 && configured() ? 2 : Math.min(2, index + 1));
});
for (const link of document.querySelectorAll('[data-wizard-link]')) {
    link.addEventListener('click', (ev) => { ev.preventDefault(); wizardGo(Number(link.dataset.wizardLink)); });
}

async function navigate() {
    const version = ++routeVersion;
    if (['#timeline', '#voice'].includes(location.hash)) { history.replaceState(null, '', '#player'); }
    const route = views.has(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
    const next = ['timeline', 'voice'].includes(route) ? 'player' : route;
    if (current === 'setup' && next !== current) { modules.get('setup')?.leave?.(); }
    if (current === 'player' && next !== current) { modules.get('player')?.deactivateAuto(); }
    current = next;
    message();
    for (const el of document.querySelectorAll('[data-view]')) { el.hidden = el.dataset.view !== next; }
    for (const a of document.querySelectorAll('nav[aria-label="機能"] a')) {
        const active = a.hash === `#${route}` || route === 'voice' && a.hash === '#player' || a.hash === '#manage' && ['recorder', 'generator', 'lab'].includes(next);
        a.classList.toggle('active', active);
        if (active) { a.setAttribute('aria-current', 'page'); } else { a.removeAttribute('aria-current'); }
    }
    renderStatus();
    if (!['home', 'manage'].includes(next)) {
        try {
            if (!modules.has(next)) {
                const mod = await import(`./${next}.js`);
                modules.set(next, mod);
                await mod.ready;
            } else {
                await modules.get(next).refresh?.();
            }
            if (version === routeVersion && next === 'setup') { await modules.get('setup').attachShared(); }
            if (version === routeVersion && next === 'player') { modules.get('player').activateAuto(); }
        } catch (e) {
            if (version === routeVersion) { message(`画面の準備に失敗しました: ${e.message}。再読み込みしてお試しください。`); }
        }
    }
    if (version === routeVersion) {
        decorate();
        document.querySelector(`#view-${next} h1`)?.focus({ preventScroll: true });
    }
}

// Elements generated by the existing region editor and recorder use the same Tabler controls.
function decorate() {
    for (const b of document.querySelectorAll('button:not(.btn):not(.btn-close)')) { b.classList.add('btn'); }
    for (const e of document.querySelectorAll('select:not(.form-select)')) { e.classList.add('form-select'); }
    for (const e of document.querySelectorAll('input[type="number"]:not(.form-control),input[type="text"]:not(.form-control)')) { e.classList.add('form-control'); }
    for (const e of document.querySelectorAll('input[type="checkbox"]:not(.form-check-input),input[type="radio"]:not(.form-check-input)')) { e.classList.add('form-check-input'); }
}
const observer = new MutationObserver((changes) => {
    if (changes.some((c) => c.addedNodes.length)) { decorate(); }
});
observer.observe($('main'), { childList: true, subtree: true });

$('capture-start').addEventListener('click', async () => {
    message();
    $('capture-start').disabled = true;
    try {
        const source = await captureSession.acquire();
        try {
            const frame = await source.grab();
            frame?.bitmap.close();
        } finally { source.stop(); }
        renderStatus();
        if (current === 'setup') { await modules.get('setup')?.attachShared(); }
        if (current === 'player') { modules.get('player')?.activateAuto(); }
    } catch (e) {
        message(`画面を共有できませんでした（${e.name}）。HTTPSで開き、共有するゲームのウィンドウを選んでください。`);
    } finally { $('capture-start').disabled = false; }
});
$('capture-stop').addEventListener('click', () => captureSession.stop());
window.addEventListener('castline:capture', renderStatus);
window.addEventListener('storage', (ev) => { if (ev.key === STORE_REGIONS) { renderStatus(); } });
window.addEventListener('hashchange', navigate);
window.addEventListener('pagehide', () => captureSession.stop());
document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-focus]');
    if (!a) { return; }
    const focus = () => {
        const el = $(a.dataset.focus);
        for (let node = el?.parentElement; node; node = node.parentElement) {
            if (node.tagName === 'DETAILS') { node.open = true; }
        }
        el?.scrollIntoView({ block: 'center' });
        el?.focus();
    };
    if (location.hash === a.hash) { focus(); } else { window.addEventListener('hashchange', focus, { once: true }); }
});
let theme = 'dark';
try { theme = localStorage.getItem('castline.theme') === 'light' ? 'light' : 'dark'; } catch { /* optional preference */ }
function applyTheme() {
    document.documentElement.dataset.bsTheme = theme;
    $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? '明るい表示に切り替える' : '暗い表示に切り替える');
}
$('theme-toggle').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    try { localStorage.setItem('castline.theme', theme); } catch { /* optional preference */ }
});
applyTheme();
navigate();
