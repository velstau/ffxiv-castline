// vel.works/top/assets/theme.js の写し。ライト（既定）／ダークの切り替え。選んだテーマはこのブラウザに記憶する（localStorage 'vw-theme'）。
// 保存できない環境（プライベートブラウズ等）でも動き、その場合は毎回ライトで開く。
// ページを開いた瞬間のちらつきを防ぐため、記憶したテーマの反映は各ページの <head> の短いスクリプトが先に行う。
(() => {
    const KEY = 'vw-theme';
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');

    const apply = (theme) => {
        if (theme === 'dark') {
            root.dataset.theme = 'dark';
        } else {
            delete root.dataset.theme;
        }
        if (meta) {
            meta.content = theme === 'dark' ? '#1a1a1a' : '#ffffff';
        }
        for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
            btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        }
    };

    apply(root.dataset.theme === 'dark' ? 'dark' : 'light');

    for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
        btn.addEventListener('click', () => {
            const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
            apply(next);
            try {
                localStorage.setItem(KEY, next);
            } catch {
                // 保存できなくても、このページの表示は切り替わる
            }
        });
    }
})();
