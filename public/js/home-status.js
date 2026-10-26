// ホームの「このブラウザの状態」。共有・読む範囲・タイムライン・読み上げ・小窓を、済み／まだ／使えないの印と文で出す
// （2026-10-27 に旧 home.js の一覧を戻した。初めての人が、何が済んでいて何がまだかを 1 か所で見られるように）
import { REGION_KINDS, regionsFor, savedScreens } from './regions.js';
import { loadTimelineIndex, loadLocalTimelines } from './timeline-source.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const STORE_SETTINGS = 'castline.player.settings';
let cloudCount = null; // 配信の件数。読めなければ -1
let cloudLoading = false; // 一覧は 1 回だけ取りに行く

/** dd の中身を、状態のアイコン＋文の行で作る（kind: ok / ng / todo） */
function lines(id, rows) {
    $(id).replaceChildren(...rows.map(([kind, text]) => {
        const row = document.createElement('span');
        row.className = `status-line ${kind}`;
        row.append(icon(kind === 'ok' ? 'check_circle' : kind === 'ng' ? 'error' : 'radio_button_unchecked'),
            Object.assign(document.createElement('span'), { textContent: text }));
        return row;
    }));
}

function loadSettings() {
    try {
        return JSON.parse(localStorage.getItem(STORE_SETTINGS) ?? '{}') ?? {};
    } catch {
        return {};
    }
}

function renderRegions(size) {
    const screens = savedScreens();
    const key = size ? `${size.width}x${size.height}` : null;
    if (screens.length === 0) {
        lines('home-st-regions', [['todo', 'まだ決めていません（「1 初期設定」で決めます）']]);
        return;
    }
    const rows = screens.map((s) => {
        // missingRegions() はカウントダウン・敵対リストが両方無いと 1 項目にまとめるので、保存した範囲から直接数える
        const [w, h] = s.key.split('x').map(Number);
        const regions = regionsFor(w, h);
        const missing = REGION_KINDS.filter((k) => !regions[k.id]).map((k) => k.label.replace(/（.*）/, ''));
        const have = REGION_KINDS.length - missing.length;
        return [s.usable ? 'ok' : 'todo', `画面 ${s.key}: ${have} / ${REGION_KINDS.length} 項目${missing.length > 0 ? `（まだ: ${missing.join('・')}）` : ''}`
            + (s.key === key ? '（共有中の画面）' : '')];
    });
    if (key && !screens.some((s) => s.key === key)) {
        rows.unshift(['todo', `共有中の画面 ${key} はまだ決めていません（画面の大きさごとに決めます）`]);
    }
    lines('home-st-regions', rows);
}

function renderSpeech() {
    const s = loadSettings();
    const sp = s.speech ?? {};
    if (s.tts === false) {
        lines('home-st-speech', [['todo', '読み上げない設定です（再生の画面の「読み上げ」で変えられます）']]);
        return;
    }
    const volume = `音量 ${Math.round((sp.volume ?? 1) * 100)}%`;
    lines('home-st-speech', [['ok', sp.engine === 'voicevox'
        ? `VOICEVOX${sp.voicevoxName ? `（${sp.voicevoxName}）` : ''}・${volume}`
        : `ブラウザの声${sp.voice ? `（${sp.voice}）` : ''}・${volume}`]]);
}

function renderTimelines() {
    const local = loadLocalTimelines().length;
    const localText = local > 0 ? `・手元の XML ${local} 件` : '';
    lines('home-st-timelines', cloudCount === null ? [['todo', `一覧を読み込んでいます…${localText}`]]
        : cloudCount < 0 ? [['ng', `配信の一覧を読めませんでした${localText}`]]
            : [['ok', `配信 ${cloudCount} 件${localText}。コンテンツ名を読み取ると自動で選びます`]]);
}

/** @param {{source: object|null, size: {width:number,height:number}|null}} capture 画面共有の状態 */
export function renderHomeStatus(capture) {
    const supported = Boolean(navigator.mediaDevices?.getDisplayMedia);
    lines('home-st-capture', [!supported ? ['ng', 'このブラウザでは使えません（パソコンの Chrome か Edge で開いてください）']
        : capture.source ? ['ok', `共有中です（${capture.size ? `${capture.size.width} × ${capture.size.height}` : '大きさを確かめています'}）`]
            : ['todo', 'まだ共有していません（上の「画面を共有」でゲームのウィンドウを選びます）']]);
    renderRegions(capture.source ? capture.size : null);
    renderTimelines();
    renderSpeech();
    const pip = 'documentPictureInPicture' in window;
    lines('home-st-pip', [pip ? ['ok', '使えます（再生の画面の「小窓で開く」で、ゲームの上に重ねて見られます）']
        : ['ng', '使えません（Chrome か Edge の 116 以降で使えます。再生の画面でタイムラインを見てください）']]);
    if (cloudCount === null && !cloudLoading) {
        cloudLoading = true;
        loadTimelineIndex().then((index) => { cloudCount = index.error ? -1 : index.items.length; }, () => { cloudCount = -1; })
            .finally(renderTimelines);
    }
}
