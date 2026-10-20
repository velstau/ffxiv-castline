// 別スレッドの文字認識（ocr-worker.js）を呼ぶ側。再生画面はこれを通して読む（ページのスレッドを止めないため）。
// 画面の画像は依頼ごとに複製して渡す（渡した画像は Worker 側で閉じる）。範囲を読む依頼は、その範囲だけを切り出して渡し
// （画面全体を毎回複製しない）、返ってきた座標を画面の座標に戻す。
import { tilesOf, contentRegionFrom } from './screen-reader.js';

export class OcrClient {
    /**
     * @param {{rec:string, dict:string, det:string}} urls モデルの URL（Worker からは相対 URL の基準が変わるので絶対 URL）
     * @param {(name:string, received:number, total:number) => void} [onProgress]
     */
    static async load(urls, onProgress = () => {}) {
        const client = new OcrClient(onProgress);
        await client.call('load', null, urls);
        return client;
    }

    constructor(onProgress) {
        this.onProgress = onProgress;
        this.pending = new Map();
        this.seq = 0;
        this.worker = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
            if (data.progress) {
                this.onProgress(data.progress.name, data.progress.received, data.progress.total);
                return;
            }
            const call = this.pending.get(data.id);
            this.pending.delete(data.id);
            if (data.error) {
                call?.reject(new Error(data.error));
            } else {
                call?.resolve(data.result);
            }
        };
        // Worker 自体が動かない（読み込みに失敗した）ときは、待っている依頼を全部失敗にする
        this.worker.onerror = (e) => {
            e.preventDefault?.();
            const error = new Error(`文字認識のスレッドが止まりました（${e.message || '読み込みの失敗'}）`);
            this.pending.forEach((call) => call.reject(error));
            this.pending.clear();
        };
    }

    call(op, frame, ...args) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, op, frame, args }, frame ? [frame] : []);
        });
    }

    async crop(frame, area) {
        return createImageBitmap(frame, area.x, area.y, area.w, area.h);
    }

    async readFrame(frame, regions, want) {
        return this.call('readFrame', await createImageBitmap(frame), regions, want);
    }

    /** 範囲の中の文字の行を全部読む（screen-reader.js の scanLines） */
    async scanLines(frame, area, castCandidates = []) {
        const lines = await this.call('scanLines', await this.crop(frame, area), { x: 0, y: 0, w: area.w, h: area.h }, castCandidates);
        return lines.map((l) => ({ ...l, x: l.x + area.x, y: l.y + area.y }));
    }

    /** 範囲を 1 つ試しに読む（screen-reader.js の checkRegion） */
    async checkRegion(frame, id, rect, names) {
        return this.call('checkRegion', await this.crop(frame, rect), id, { x: 0, y: 0, w: rect.w, h: rect.h }, names);
    }

    /**
     * 画面全体からコンテンツ名を探す（screen-reader.js の findContent と同じ順・同じ結果）。
     * 区画ごとに依頼するので、探している間もほかの依頼（読み取り）が間に入れる。
     */
    async findContent(frame, names, onProgress = () => {}) {
        const tiles = tilesOf(frame);
        for (const [i, tile] of tiles.entries()) {
            onProgress(i, tiles.length);
            const found = await this.call('readContentLines', await this.crop(frame, tile), { x: 0, y: 0, w: tile.w, h: tile.h }, names);
            if (found) {
                onProgress(tiles.length, tiles.length);
                const box = { ...found.box, x: found.box.x + tile.x, y: found.box.y + tile.y };
                return { name: found.name, box, rect: contentRegionFrom(box, found.name, names, frame.width, frame.height) };
            }
        }
        onProgress(tiles.length, tiles.length);
        return null;
    }
}
