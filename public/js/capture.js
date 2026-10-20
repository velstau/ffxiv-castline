// 画面の取り込み。届いたフレームのうち最新の 1 枚だけを持ち、読みたいときに取り出す。
//
// ゲームを前面にするとブラウザのページは「非表示」とみなされ、タイマーは 1 秒に 1 回まで間引かれ、
// <video> 要素の映像も更新が止まったり遅れたりする（実測で、16 秒のカウントダウンが 9 秒に縮んで記録された）。
// そこで MediaStreamTrackProcessor でフレームを直接受け取り、届いた時刻をフレームの時刻として使う。
// 使えないブラウザでは <video> 要素から取り出す（ページが隠れると時刻がずれる）。

export class FrameSource {
    /** @param {() => void} [onEnded] 利用者がブラウザの「共有を停止」で止めたとき */
    static async start(onEnded) {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
        const source = new FrameSource(stream, onEnded);
        await source.ready;
        return source;
    }

    constructor(stream, onEnded) {
        this.stream = stream;
        this.track = stream.getVideoTracks()[0];
        this.latest = null; // { frame: VideoFrame, at: number }
        this.waiters = [];
        this.stopped = false;
        this.track.addEventListener('ended', () => {
            this.stop();
            onEnded?.();
        });

        let reader = null;
        if (typeof MediaStreamTrackProcessor === 'function') {
            try {
                reader = new MediaStreamTrackProcessor({ track: this.track }).readable.getReader();
            } catch {
                reader = null;
            }
        }
        if (reader) {
            this.method = 'MediaStreamTrackProcessor';
            this.reader = reader;
            this.ready = Promise.resolve();
            this.pump();
        } else {
            this.method = 'video 要素（ページが隠れると時刻がずれます）';
            this.video = document.createElement('video');
            this.video.muted = true;
            this.video.srcObject = stream;
            this.ready = this.video.play();
        }
    }

    async pump() {
        try {
            for (;;) {
                const { value, done } = await this.reader.read();
                if (done) {
                    break;
                }
                if (this.stopped) {
                    value.close();
                    break;
                }
                this.latest?.frame.close();
                this.latest = { frame: value, at: Date.now() };
                const ready = this.waiters.filter((w) => this.latest.at >= w.minAt);
                this.waiters = this.waiters.filter((w) => this.latest.at < w.minAt);
                ready.forEach((w) => w.resolve());
            }
        } catch {
            // stop() で読み取りを打ち切ったとき
        }
    }

    /**
     * minAt（Date.now() の値）以降に届いたフレームを待って ImageBitmap にして返す。止めたあとは null。
     * タイマーではなくフレームの到着で待つので、ページが隠れても間引かれない。
     * @returns {Promise<{bitmap: ImageBitmap, at: number}|null>}
     */
    async grab(minAt = 0) {
        if (this.video) {
            const wait = minAt - Date.now();
            if (wait > 0) {
                await new Promise((resolve) => setTimeout(resolve, wait));
            }
            return this.stopped ? null : { bitmap: await createImageBitmap(this.video), at: Date.now() };
        }
        while (!this.stopped && !(this.latest && this.latest.at >= minAt)) {
            await new Promise((resolve) => this.waiters.push({ minAt, resolve }));
        }
        if (this.stopped) {
            return null;
        }
        // 次のフレームが届くと latest は閉じられるので、複製してから画像にする
        const { frame, at } = this.latest;
        const copy = frame.clone();
        try {
            return { bitmap: await createImageBitmap(copy), at };
        } finally {
            copy.close();
        }
    }

    stop() {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.reader?.cancel().catch(() => {});
        this.stream.getTracks().forEach((t) => t.stop());
        this.latest?.frame.close();
        this.latest = null;
        this.waiters.forEach((w) => w.resolve());
        this.waiters = [];
    }
}
