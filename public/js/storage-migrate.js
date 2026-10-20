// 2026-10-20 に名前を ocr-timeline から Castline に変えた。このブラウザに保存した範囲・手元のタイムラインなどを
// 新しい名前（castline.〜）へ一度だけ移す。各ページの最初に読み込む
try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith('ocr-timeline.')) {
            const renamed = `castline.${key.slice('ocr-timeline.'.length)}`;
            if (localStorage.getItem(renamed) === null) {
                localStorage.setItem(renamed, localStorage.getItem(key));
            }
            localStorage.removeItem(key);
        }
    }
} catch {
    // 保存が使えない環境では移すものも無い
}
