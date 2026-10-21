// トップ（index.html）。このブラウザの状態（対応しているか・保存した範囲・タイムライン・読み上げ）を出し、次に開く画面を勧める。
import './storage-migrate.js';
import { REGION_KINDS, loadAll, missingRegions } from './regions.js';
import { loadTimelineIndex, loadLocalTimelines } from './timeline-source.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const STORE_SETTINGS = 'castline.player.settings';

/** dd の中身を、状態のアイコン＋文の行で作る（kind: ok / ng / todo） */
function lines(id, rows) {
    $(id).replaceChildren(...rows.map(([kind, text]) => {
        const row = document.createElement('span');
        row.className = `kv-line ${kind}`;
        row.append(icon(kind === 'ok' ? 'check_circle' : kind === 'ng' ? 'error' : 'radio_button_unchecked'),
            Object.assign(document.createElement('span'), { textContent: text }));
        return row;
    }));
}

function chip(id, kind, text) {
    $(id).className = `chip ${kind}`;
    $(id).textContent = text;
}

function loadSettings() {
    try {
        return JSON.parse(localStorage.getItem(STORE_SETTINGS) ?? '{}') ?? {};
    } catch {
        return {};
    }
}

function renderBrowser() {
    const capture = Boolean(navigator.mediaDevices?.getDisplayMedia);
    const pip = 'documentPictureInPicture' in window;
    const frames = typeof MediaStreamTrackProcessor === 'function';
    const rows = [[capture ? 'ok' : 'ng', capture ? '画面の取り込み: 使えます' : '画面の取り込み: 使えません（パソコンの Chrome か Edge で開いてください）']];
    rows.push([pip ? 'ok' : 'todo', pip ? '小窓: 使えます' : '小窓: 使えません（Chrome か Edge の 116 以降で使えます）']);
    if (capture && !frames) {
        rows.push(['todo', 'ゲームを前面にすると読み取りが遅れることがあります（Chrome か Edge を勧めます）']);
    }
    lines('st-browser', rows);
    return capture;
}

// 初期設定が済んだ画面の大きさ（コンテンツ名と、戦闘の開始を知る範囲があれば再生できる）
function renderRegions() {
    const screens = Object.entries(loadAll()).filter(([, r]) => r && Object.keys(r).length > 0);
    const usable = screens.filter(([, r]) => r.content && !missingRegions(r).some((m) => m.id === 'start'));
    if (screens.length === 0) {
        lines('st-regions', [['todo', 'まだありません（初期設定で決めます）']]);
    } else {
        lines('st-regions', screens.map(([key, r]) => {
            const have = REGION_KINDS.filter((k) => r[k.id]).length;
            const missing = REGION_KINDS.filter((k) => !r[k.id]).map((k) => k.label.replace(/（.*）/, ''));
            return [usable.some(([k]) => k === key) ? 'ok' : 'todo',
                `画面 ${key}: ${have} / ${REGION_KINDS.length}${missing.length > 0 ? `（未: ${missing.join('・')}）` : ''}`];
        }));
    }
    return usable.length > 0;
}

function renderSpeech() {
    const s = loadSettings();
    const sp = s.speech ?? {};
    if (s.tts === false) {
        lines('st-speech', [['todo', '読み上げない']]);
        return;
    }
    const volume = `音量 ${Math.round((sp.volume ?? 1) * 100)}%`;
    lines('st-speech', [['ok', sp.engine === 'voicevox'
        ? `VOICEVOX${sp.voicevoxName ? `（${sp.voicevoxName}）` : ''}・${volume}`
        : `ブラウザの声${sp.voice ? `（${sp.voice}）` : ''}・${volume}`]]);
}

async function renderTimelines() {
    const local = loadLocalTimelines().length;
    const localText = local > 0 ? `・手元の XML ${local} 件` : '';
    lines('st-timelines', [['todo', `読み込んでいます…${localText}`]]);
    const index = await loadTimelineIndex();
    lines('st-timelines', index.error
        ? [['ng', `配信の一覧を読めませんでした${localText}`]]
        : [['ok', `配信 ${index.items.length} 件${localText}`]]);
}

function recommend(setupDone, canCapture) {
    // 次に開く画面のボタンを塗りにする（済んでいない初期設定、済んでいれば再生画面）
    $('setup-link').classList.toggle('primary', !setupDone);
    $('player-link').classList.toggle('primary', setupDone);
    $('launch-setup').classList.toggle('next', !setupDone);
    $('launch-player').classList.toggle('next', setupDone);
    if (!canCapture) {
        chip('setup-chip', 'ng', 'このブラウザでは使えません');
        chip('player-chip', 'ng', 'このブラウザでは使えません');
        return;
    }
    chip('setup-chip', setupDone ? 'ok' : 'next', setupDone ? '済み' : 'まずはこちら');
    chip('player-chip', setupDone ? 'next' : 'todo', setupDone ? '次はこちら' : '初期設定のあと');
}

const canCapture = renderBrowser();
const setupDone = renderRegions();
renderSpeech();
recommend(setupDone, canCapture);
renderTimelines();
