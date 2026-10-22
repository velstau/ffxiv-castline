// 画面共有のコマを、記録を始めてからの秒つきで順に渡す（タイムラインを記録する画面用。video-source.js と同じ使い方）。
// コマの取り込みは capture.js の FrameSource（ゲームを前面にしてページが隠れても間引かれない）。時刻はコマが届いた時刻。
// 動画ファイルと違って再生を遅くできないので、読み取りが追いつかないコマは飛ばす（コマの間隔が広がり、出始め・消えたの時刻が粗くなる）。
// 「止める」（stop）は読み取りだけを止め、共有は続ける（続けて次の挑戦を記録できる）。共有を終えるのは close かブラウザの「共有を停止」。
import { FrameSource } from './capture.js';

export class ScreenFrameSource {
    /** 共有する画面を選んでもらい、最初のコマで大きさを決める。ボタンを押した直後に呼ぶ（共有の確認はクリックの中でしか出せない）
     * @param {() => void} [onEnded] ブラウザの「共有を停止」で止めたとき */
    static async open(onEnded) {
        const capture = await FrameSource.start(onEnded);
        const first = await capture.grab();
        if (!first) {
            throw new Error('画面を共有できませんでした');
        }
        const { width, height } = first.bitmap;
        first.bitmap.close();
        return new ScreenFrameSource(capture, width, height);
    }

    constructor(capture, width, height) {
        this.capture = capture;
        this.method = capture.method;
        this.width = width;
        this.height = height;
        this.duration = Infinity;
        this.stopped = false;
        this.wake = null;
    }

    get ended() {
        return this.capture.stopped;
    }

    /**
     * stop() か共有の終わりまで、届いたコマを onFrame に渡す（1 つずつ。前の onFrame が終わるまで次は渡さない）。
     * @param {(bitmap: ImageBitmap, at: number) => Promise<void>} onFrame at は記録を始めてからの秒。bitmap は呼び出し側で閉じない（ここで閉じる）
     * @param {{onProgress?:(at:number, fps:number) => void}} options fps は直近の読み取りの速さ（コマ/秒）
     */
    async run(onFrame, { onProgress = () => {} } = {}) {
        this.stopped = false;
        const halt = new Promise((resolve) => {
            this.wake = resolve;
        });
        let origin = null;
        let lastAt = 0;
        let fps = 0;
        while (!this.stopped) {
            const grabbing = this.capture.grab(lastAt + 1);
            const got = await Promise.race([grabbing, halt]);
            if (!got) {
                // 止めた（共有はそのまま。あとから届くコマは閉じる）か、共有が終わった
                grabbing.then((late) => late?.bitmap.close());
                break;
            }
            try {
                if (got.bitmap.width !== this.width || got.bitmap.height !== this.height) {
                    throw new Error(`共有している画面の大きさが変わりました（${this.width}x${this.height} → ${got.bitmap.width}x${got.bitmap.height}）。ゲームの画面の大きさを戻すか、共有し直してください`);
                }
                origin ??= got.at;
                await onFrame(got.bitmap, (got.at - origin) / 1000);
            } finally {
                got.bitmap.close();
            }
            if (lastAt > 0) {
                const now = 1000 / Math.max(1, got.at - lastAt);
                fps = fps === 0 ? now : 0.8 * fps + 0.2 * now;
            }
            lastAt = got.at;
            onProgress((got.at - origin) / 1000, fps);
        }
        this.wake = null;
    }

    stop() {
        this.stopped = true;
        this.wake?.(null);
    }

    close() {
        this.stop();
        this.capture.stop();
    }
}
