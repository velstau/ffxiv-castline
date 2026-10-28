// 最前面の小窓（Document Picture-in-Picture）と読み上げ。
// 2026-10-20 に試験ページで、ゲームの上に出ること・時計が止まらないこと・読み上げが鳴ることを確かめた作りをそのまま使う。
// ゲームが前面のあいだ元のページは隠れ扱いで requestAnimationFrame が止まるので、描画は小窓の requestAnimationFrame で回す。

export const pipSupported = () => 'documentPictureInPicture' in window;

// 小窓の文字（利用者が選ぶ。2026-10-29）。小窓の中の大きさは rem で書いてあるので、小窓の html の文字の大きさで全体が変わる
export const PIP_SCALE = { min: 80, max: 200, step: 10, default: 100 };
// 書体は利用者の PC に入っているものだけ使える（Web フォントは配らない）。Windows に最初から入っているものを並べる
export const PIP_FONTS = [
    { id: '', label: '既定（ブラウザの書体）', css: '' },
    { id: 'biz-ud', label: 'BIZ UDPゴシック', css: '"BIZ UDPGothic", "BIZ UDPゴシック"' },
    { id: 'meiryo', label: 'メイリオ', css: 'Meiryo, "メイリオ"' },
    { id: 'yu-gothic', label: '游ゴシック', css: '"Yu Gothic UI", "Yu Gothic", YuGothic, "游ゴシック"' },
    { id: 'ud-kyokasho', label: 'UD デジタル 教科書体', css: '"UD Digi Kyokasho NK-R", "UD デジタル 教科書体 NK-R"' },
    { id: 'custom', label: 'ほかの書体（名前で指定）', css: '' },
];

/** 選んだ大きさ（%）を、範囲内の刻みに丸める */
export function pipScale(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return PIP_SCALE.default;
    }
    return Math.min(PIP_SCALE.max, Math.max(PIP_SCALE.min, Math.round(n / PIP_SCALE.step) * PIP_SCALE.step));
}

/** 書体の CSS（font-family の値）。既定なら ''。入れた名前は引用符で囲み、CSS を崩す文字を外す */
export function pipFontFamily(font, customName = '') {
    const css = font === 'custom'
        ? (() => {
            const name = String(customName).replace(/["'\\;{}<>]/g, '').trim().slice(0, 60);
            return name ? `"${name}"` : '';
        })()
        : PIP_FONTS.find((f) => f.id === font)?.css ?? '';
    return css ? `${css}, var(--tblr-font-sans-serif)` : '';
}

/** 小窓の文書に、文字の大きさと書体を当てる */
export function applyPipStyle(doc, { scale, font, fontName }) {
    const root = doc.documentElement;
    root.style.fontSize = `${pipScale(scale)}%`;
    const family = pipFontFamily(font, fontName);
    if (family) {
        root.style.setProperty('--tblr-body-font-family', family);
    } else {
        root.style.removeProperty('--tblr-body-font-family');
    }
}

export class Pip {
    constructor() {
        this.win = null;
    }

    get isOpen() {
        return Boolean(this.win && !this.win.closed);
    }

    /**
     * 小窓を開く。html を body に入れ、onFrame(win) を小窓の描画のたびに呼ぶ。
     * @returns {Promise<Window>}
     */
    async open({ width, height, html, onFrame, onClose }) {
        // Repeated clicks must not recreate a window the user has already positioned.
        if (this.isOpen) {
            this.win.focus();
            return this.win;
        }
        // Position restoration is controlled by the browser; sites cannot set PiP coordinates.
        const win = await documentPictureInPicture.requestWindow({ width, height, preferInitialWindowPlacement: false });
        this.win = win;
        const link = win.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('css/app.css', location.href).href;
        win.document.head.append(link);
        const tabler = win.document.createElement('link');
        tabler.rel = 'stylesheet';
        tabler.href = new URL('vendor/tabler/tabler.min.css', location.href).href;
        win.document.head.prepend(tabler);
        win.document.documentElement.dataset.bsTheme = 'dark'; // ゲームに重ねるので、ページのテーマに関係なく暗い表示にする
        win.document.body.innerHTML = html;
        const tick = () => {
            if (win.closed) {
                return;
            }
            onFrame?.(win);
            win.requestAnimationFrame(tick);
        };
        win.requestAnimationFrame(tick);
        win.addEventListener('pagehide', () => {
            if (this.win === win) {
                this.win = null;
            }
            onClose?.();
        });
        return win;
    }

    close() {
        this.win?.close();
        this.win = null;
    }
}
