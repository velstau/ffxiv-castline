// 最前面の小窓（Document Picture-in-Picture）と読み上げ。
// 2026-10-20 に試験ページで、ゲームの上に出ること・時計が止まらないこと・読み上げが鳴ることを確かめた作りをそのまま使う。
// ゲームが前面のあいだ元のページは隠れ扱いで requestAnimationFrame が止まるので、描画は小窓の requestAnimationFrame で回す。

export const pipSupported = () => 'documentPictureInPicture' in window;

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
