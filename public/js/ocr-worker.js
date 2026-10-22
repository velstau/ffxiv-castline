// 文字認識を別スレッドで行う（再生画面用）。onnxruntime の計算と前後の画素の処理は重く、ページのスレッドで行うと、
// 画面全体を読む間（数秒）スクロールや描画が止まるため。呼び出し側は ocr-client.js。
// 依頼は届いた順に 1 つずつ処理する（同じモデルを並行して使わない）。
import { TextDetector, TextRecognizer } from './ocr.js';
import { readFrame, readContentLines, scanLines, checkRegion } from './screen-reader.js';
import { readCastFree } from './readers.js';

let ocr = null;
let queue = Promise.resolve();

const ops = {
    async load(frame, { rec, dict, det }) {
        const onProgress = (name) => (received, total) => postMessage({ progress: { name, received, total } });
        const [recognizer, detector] = await Promise.all([
            TextRecognizer.load(rec, dict, onProgress('rec')),
            TextDetector.load(det, onProgress('det')),
        ]);
        ocr = { recognizer, detector };
        return true;
    },
    readFrame: (frame, regions, want) => readFrame(ocr, frame, regions, want),
    readContentLines: (frame, area, names) => readContentLines(ocr, frame, area, names),
    scanLines: (frame, area, castCandidates) => scanLines(ocr, frame, area, castCandidates),
    checkRegion: (frame, id, rect, names) => checkRegion(ocr, frame, id, rect, names),
    readCastFree: (frame, rect) => readCastFree(ocr.recognizer, frame, rect),
};

self.onmessage = ({ data: { id, op, frame, args } }) => {
    queue = queue.then(async () => {
        try {
            if (op !== 'load' && !ocr) {
                throw new Error('文字認識のモデルを読み込んでいません');
            }
            postMessage({ id, result: await ops[op](frame, ...args) });
        } catch (e) {
            postMessage({ id, error: e?.message ?? String(e) });
        } finally {
            frame?.close?.();
        }
    });
};
