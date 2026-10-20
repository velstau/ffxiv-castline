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
    // 2026-10-21: 範囲は試験ページ専用ではなくなったので castline.lab.regions → castline.regions
    const oldRegions = localStorage.getItem('castline.lab.regions');
    if (oldRegions !== null) {
        if (localStorage.getItem('castline.regions') === null) {
            localStorage.setItem('castline.regions', oldRegions);
        }
        localStorage.removeItem('castline.lab.regions');
    }
} catch {
    // 保存が使えない環境では移すものも無い
}
