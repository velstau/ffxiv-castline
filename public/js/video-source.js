// 動画ファイルのコマを、動画の中の時刻つきで順に渡す（タイムラインを記録する画面用）。
// 再生しながら requestVideoFrameCallback で表示されたコマを受け取り、時刻は動画の中の時刻（mediaTime）を使う
// （壁時計の時刻は使わない。読み取りが遅れても記録の時刻はずれない）。
// 読み取りが追いつかないコマは飛ばし、コマどうしの間隔が step 秒に収まるよう再生の速さを読み取りの速さに合わせる。

const RATE_MIN = 0.1;
const RATE_MAX = 4;

export class VideoFrameSource {
    /** @param {File|Blob} file */
    static async open(file) {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.src = URL.createObjectURL(file);
        await new Promise((resolve, reject) => {
            video.addEventListener('loadedmetadata', resolve, { once: true });
            video.addEventListener('error', () => reject(new Error('この動画は再生できません（ブラウザが対応していない形式です）')), { once: true });
        });
        if (typeof video.requestVideoFrameCallback !== 'function') {
            throw new Error('このブラウザは動画のコマを受け取れません（Chrome か Edge で開いてください）');
        }
        return new VideoFrameSource(video);
    }

    constructor(video) {
        this.video = video;
        this.width = video.videoWidth;
        this.height = video.videoHeight;
        this.duration = video.duration;
        this.stopped = false;
    }

    /**
     * from 秒から to 秒まで再生し、受け取ったコマを onFrame に渡す（1 つずつ。前の onFrame が終わるまで次は渡さない）。
     * @param {(bitmap: ImageBitmap, at: number) => Promise<void>} onFrame at は動画の中の秒。bitmap は呼び出し側で閉じる
     * @param {{from?:number, to?:number, step?:number, onProgress?:(at:number, rate:number) => void}} options
     *        step: コマどうしの間隔（動画の秒）の目安
     */
    async run(onFrame, { from = 0, to = this.duration, step = 0.1, onProgress = () => {} } = {}) {
        const { video } = this;
        this.stopped = false;
        video.currentTime = from;
        await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
        let rate = 1;
        let busy = false;
        let lastAt = -Infinity;
        let failure = null;
        let ended = false;
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (!done) {
                    done = true;
                    video.pause();
                    resolve();
                }
            };
            const onVideoFrame = async (now, meta) => {
                if (this.stopped || failure || ended || meta.mediaTime >= to) {
                    finish();
                    return;
                }
                if (!busy && meta.mediaTime > lastAt) {
                    busy = true;
                    lastAt = meta.mediaTime;
                    const started = performance.now();
                    try {
                        const bitmap = await createImageBitmap(video);
                        try {
                            await onFrame(bitmap, meta.mediaTime);
                        } finally {
                            bitmap.close();
                        }
                    } catch (e) {
                        failure = e;
                    }
                    // 1 コマの読み取りにかかった時間で、次のコマまでに動画が step 秒だけ進む速さにする
                    const spent = (performance.now() - started) / 1000;
                    rate = Math.min(RATE_MAX, Math.max(RATE_MIN, 0.7 * rate + 0.3 * (step / Math.max(spent, 1e-3))));
                    video.playbackRate = rate;
                    onProgress(meta.mediaTime, rate);
                    busy = false;
                    if (ended || this.stopped || failure) {
                        finish();
                        return;
                    }
                }
                video.requestVideoFrameCallback(onVideoFrame);
            };
            // 最後まで再生した。読んでいるコマがあれば、読み終えてから終える（先に終えると、最後の詠唱と表示が後から書き換わる）
            video.addEventListener('ended', () => {
                ended = true;
                if (!busy) {
                    finish();
                }
            }, { once: true });
            video.requestVideoFrameCallback(onVideoFrame);
            video.playbackRate = rate;
            video.play().catch((e) => {
                failure = e;
                finish();
            });
        });
        if (failure) {
            throw failure;
        }
    }

    /** at 秒のコマを画像にする（範囲を指定するための 1 枚など） */
    async frameAt(at) {
        const { video } = this;
        video.currentTime = at;
        await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
        return createImageBitmap(video);
    }

    stop() {
        this.stopped = true;
        this.video.pause();
    }

    close() {
        this.stop();
        URL.revokeObjectURL(this.video.src);
    }
}
