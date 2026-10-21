// 文字認識（PaddleOCR PP-OCRv5 mobile の認識モデル）。
// 切り出した 1 行の画像を読む。文字の位置を探す検出モデルは使わない（読む範囲は利用者が指定する）。
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';
import { LINE_END_CHARS, logLikelihood, spottingPenalty } from './ctc.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
// マルチスレッドには COOP/COEP ヘッダが要る。1 行の認識は単一スレッドで数十 ms なので使わない
ort.env.wasm.numThreads = 1;

const INPUT_HEIGHT = 48;
const MIN_WIDTH = 8;

async function fetchBytes(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`${url} を取得できませんでした（HTTP ${res.status}）`);
    }
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !onProgress) {
        return new Uint8Array(await res.arrayBuffer());
    }
    const reader = res.body.getReader();
    const parts = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        parts.push(value);
        received += value.length;
        onProgress(received, total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}

// source の rect の範囲を width x height に縮小・拡大して RGBA の画素を返す
function pixelsOf(source, rect, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
}

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const DET_THRESH = 0.3; // 文字らしさの確率がこれを超える画素を文字とみなす
const DET_BOX_THRESH = 0.6; // 箱の中の確率の平均がこれ未満の箱は捨てる
const DET_UNCLIP = 1.5; // 箱を広げる度合い（PaddleOCR の DB 後処理と同じ式）
const DET_MAX_SIDE = 960;
const roundTo32 = (v) => Math.max(32, Math.round(v / 32) * 32);

/**
 * 文字検出（PaddleOCR PP-OCRv5 mobile の検出モデル）。範囲の中から文字の行を探す。
 * 認識モデルは 1 行しか読めないので、吹き出しの行数や幅が変わるカウントダウンなどは、
 * 広めに取った範囲からこれで行を見つけてから読む。
 */
export class TextDetector {
    static async load(modelUrl, onProgress) {
        const model = await fetchBytes(modelUrl, onProgress);
        return new TextDetector(await ort.InferenceSession.create(model, { executionProviders: ['wasm'] }));
    }

    constructor(session) {
        this.session = session;
    }

    /**
     * @returns {Promise<{boxes:{x:number,y:number,w:number,h:number,score:number}[], ms:number}>}
     *          boxes は source の座標で、認識に渡せるよう余白を足してある。上から順
     */
    async detect(source, rect) {
        // 縦横を 32 の倍数に（拡大はしない。拡大すると箱が細かく割れる）
        const scale = Math.min(1, DET_MAX_SIDE / Math.max(rect.w, rect.h));
        const width = roundTo32(rect.w * scale);
        const height = roundTo32(rect.h * scale);
        const pixels = pixelsOf(source, rect, width, height);
        const n = width * height;
        const input = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) {
            // BGR の順で正規化（PaddleOCR 公式の前処理）
            input[i] = (pixels[i * 4 + 2] / 255 - DET_MEAN[0]) / DET_STD[0];
            input[n + i] = (pixels[i * 4 + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
            input[2 * n + i] = (pixels[i * 4] / 255 - DET_MEAN[2]) / DET_STD[2];
        }
        const started = performance.now();
        const feeds = { [this.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) };
        const prob = (await this.session.run(feeds))[this.session.outputNames[0]].data; // [1,1,H,W]
        const ms = performance.now() - started;

        const sx = rect.w / width;
        const sy = rect.h / height;
        const sourceWidth = source.width ?? source.videoWidth;
        const sourceHeight = source.height ?? source.videoHeight;
        const boxes = [];
        for (const c of connectedComponents(prob, width, height)) {
            const w = c.x1 - c.x0;
            const h = c.y1 - c.y0;
            if (Math.min(w, h) < 3 || c.score < DET_BOX_THRESH) {
                continue;
            }
            const d = (w * h * DET_UNCLIP) / (2 * (w + h));
            const x0 = rect.x + Math.max(0, c.x0 - d) * sx;
            const y0 = rect.y + Math.max(0, c.y0 - d) * sy;
            const x1 = rect.x + Math.min(width, c.x1 + d) * sx;
            const y1 = rect.y + Math.min(height, c.y1 + d) * sy;
            // 認識に渡す前に左右へ高さの 0.3、上下へ 0.1 の余白を足す（末尾の「！」などが切れないように）
            const lineHeight = y1 - y0;
            const box = {
                x: Math.max(0, Math.round(x0 - lineHeight * 0.3)),
                y: Math.max(0, Math.round(y0 - lineHeight * 0.1)),
                score: c.score,
            };
            box.w = Math.min(sourceWidth, Math.round(x1 + lineHeight * 0.3)) - box.x;
            box.h = Math.min(sourceHeight, Math.round(y1 + lineHeight * 0.1)) - box.y;
            if (box.w >= 2 && box.h >= 2) {
                boxes.push(box);
            }
        }
        boxes.sort((a, b) => a.y - b.y || a.x - b.x);
        return { boxes, ms };
    }
}

// 確率マップを DET_THRESH で 2 値化し、8 近傍でつながった塊ごとに外接矩形と確率の平均を返す
function connectedComponents(prob, width, height) {
    const visited = new Uint8Array(width * height);
    const components = [];
    const stack = [];
    for (let s = 0; s < width * height; s++) {
        if (prob[s] <= DET_THRESH || visited[s]) {
            continue;
        }
        visited[s] = 1;
        stack.push(s);
        let x0 = width;
        let y0 = height;
        let x1 = -1;
        let y1 = -1;
        let sum = 0;
        let count = 0;
        while (stack.length) {
            const q = stack.pop();
            const y = (q / width) | 0;
            const x = q - y * width;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
            sum += prob[q];
            count++;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                        continue;
                    }
                    const nq = ny * width + nx;
                    if (prob[nq] > DET_THRESH && !visited[nq]) {
                        visited[nq] = 1;
                        stack.push(nq);
                    }
                }
            }
        }
        components.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, score: sum / count });
    }
    return components;
}

export class TextRecognizer {
    /**
     * @param {string} modelUrl
     * @param {string} dictUrl 1 行 1 文字の辞書（ppocrv5_dict.txt）
     * @param {(received:number,total:number)=>void} [onProgress] モデルのダウンロードの進み具合
     */
    static async load(modelUrl, dictUrl, onProgress) {
        const [model, dictText] = await Promise.all([
            fetchBytes(modelUrl, onProgress),
            fetch(dictUrl).then((res) => {
                if (!res.ok) {
                    throw new Error(`${dictUrl} を取得できませんでした（HTTP ${res.status}）`);
                }
                return res.text();
            }),
        ]);
        const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
        const lines = dictText.replace(/\r/g, '').split('\n');
        if (lines[lines.length - 1] === '') {
            lines.pop();
        }
        // 0 番は CTC の空白記号、末尾は半角スペース（PaddleOCR の決まり）
        return new TextRecognizer(session, ['', ...lines, ' ']);
    }

    constructor(session, chars) {
        this.session = session;
        this.chars = chars;
        this.charIndex = new Map();
        chars.forEach((c, i) => {
            if (i > 0 && !this.charIndex.has(c)) {
                this.charIndex.set(c, i);
            }
        });
    }

    /**
     * source の rect の範囲を 1 行として読む。
     * @param {CanvasImageSource} source 画像・取り込んだ画面のフレームなど
     * @param {{x:number,y:number,w:number,h:number}} rect source の座標（px）
     * @returns {Promise<{text:string, output:object, ms:number}>} output は候補との照合（score）に渡す
     */
    async read(source, rect) {
        const width = Math.max(MIN_WIDTH, Math.ceil(INPUT_HEIGHT * rect.w / rect.h));
        const pixels = pixelsOf(source, rect, width, INPUT_HEIGHT);

        // NCHW・BGR の順・(x/255 - 0.5)/0.5 で正規化（PaddleOCR の前処理）
        const n = width * INPUT_HEIGHT;
        const input = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) {
            input[i] = pixels[i * 4 + 2] / 127.5 - 1;
            input[n + i] = pixels[i * 4 + 1] / 127.5 - 1;
            input[2 * n + i] = pixels[i * 4] / 127.5 - 1;
        }

        const started = performance.now();
        const feeds = { [this.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, INPUT_HEIGHT, width]) };
        const output = (await this.session.run(feeds))[this.session.outputNames[0]];
        const ms = performance.now() - started;
        if (output.dims[2] !== this.chars.length) {
            throw new Error(`モデルの出力（${output.dims[2]} 種類）と辞書（${this.chars.length} 文字）が合っていません`);
        }
        return { text: this.decode(output), output, ms };
    }

    // 各時刻で最も確からしい文字を取り、連続する同じ文字と空白記号を除く（CTC の貪欲復号）
    decode(output) {
        const [, steps, classes] = output.dims;
        const probs = output.data;
        let text = '';
        let prev = 0;
        for (let t = 0; t < steps; t++) {
            let best = 0;
            let bestProb = -1;
            for (let c = 0; c < classes; c++) {
                const p = probs[t * classes + c];
                if (p > bestProb) {
                    bestProb = p;
                    best = c;
                }
            }
            if (best !== 0 && best !== prev) {
                text += this.chars[best];
            }
            prev = best;
        }
        return text;
    }

    /**
     * 候補の文字列それぞれについて、読んだ画像全体がその文字列である確からしさ（CTC の対数尤度）を出し、高い順に返す。
     * 読み取った文字列を照合するより、誤読しやすい字（「零式」など）を含む候補どうしを見分けやすい。
     * 辞書に無い文字を含む候補は除く。
     * @returns {{text:string, logP:number}[]}
     */
    score(output, candidates) {
        const [, steps, classes] = output.dims;
        return this.mapCandidates(candidates, (indices) => logLikelihood(output.data, steps, classes, indices))
            .map(({ text, value }) => ({ text, logP: value }))
            .sort((a, b) => b.logP - a.logP);
    }

    /**
     * 候補の文字列それぞれについて、読んだ文字のどこか一部分がその文字列であるとしたときの減点（0 以下）を出し、
     * 減点の小さい順に返す。範囲に候補以外の文字が入る詠唱バーに使う。
     * atEnd: 候補が行の終わりにある場合だけを数える（途中で切れた技名の頭の部分。spottingPenalty の tail）
     * @returns {{text:string, penalty:number}[]}
     */
    spot(output, candidates, { atEnd = false } = {}) {
        const [, steps, classes] = output.dims;
        const tail = atEnd ? [0, ...LINE_END_CHARS.map((c) => this.charIndex.get(c)).filter((i) => i !== undefined)] : null;
        return this.mapCandidates(candidates, (indices) => spottingPenalty(output.data, steps, classes, indices, tail))
            .map(({ text, value }) => ({ text, penalty: value }))
            .sort((a, b) => b.penalty - a.penalty);
    }

    // 候補を文字の番号の列に直して fn にかける（辞書に無い文字を含む候補は除く）
    mapCandidates(candidates, fn) {
        const results = [];
        for (const text of candidates) {
            const indices = [...text].map((c) => this.charIndex.get(c));
            if (indices.length > 0 && !indices.includes(undefined)) {
                results.push({ text, value: fn(indices) });
            }
        }
        return results;
    }
}
