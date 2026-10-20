// 取り込んだ 1 フレームを範囲ごとに読み、タイムラインに渡す観測にまとめる（再生画面用）。
// 読み方は試験ページの連続読み取り（lab.js の watchTick）と同じ。範囲は試験ページで選んだものを使う。
import { pickCandidate, readCast, readCountdown, parseHpPercent } from './readers.js';

// 範囲は試験ページが解像度（"幅x高さ"）ごとに保存したもの
export const STORE_REGIONS = 'ocr-timeline.lab.regions';

export function loadRegions(width, height) {
    try {
        return JSON.parse(localStorage.getItem(STORE_REGIONS) ?? '{}')[`${width}x${height}`] ?? {};
    } catch {
        return {};
    }
}

/**
 * @param {{detector: import('./ocr.js').TextDetector, recognizer: import('./ocr.js').TextRecognizer}} ocr
 * @param {{content?: string[]|null, countdown?: boolean, castCandidates?: string[]}} want
 *        content: コンテンツ名の候補（null なら読まない）、countdown: カウントダウンを読むか、castCandidates: 照合する技名
 * @returns {Promise<{
 *   content?: {text:string, decided:string|null},
 *   countdown?: {seconds:number}|{started:true}|null,
 *   hp?: number|null,
 *   enmity?: boolean,
 *   casts: {source:'bar'|'list', text:string, decided:string|null}[],
 * }>} 範囲が無い・読まなかった項目は含めない
 */
export async function readFrame(ocr, frame, regions, want) {
    const out = { casts: [] };
    const castCandidates = want.castCandidates ?? [];
    if (regions.content && want.content) {
        const read = await ocr.recognizer.read(frame, regions.content);
        out.content = {
            text: read.text,
            decided: read.text === '' ? null : pickCandidate(ocr.recognizer, read, want.content).decided,
        };
    }
    if (regions.countdown && want.countdown) {
        out.countdown = (await readCountdown(ocr.detector, ocr.recognizer, frame, regions.countdown)).countdown;
    }
    if (regions.hp) {
        out.hp = parseHpPercent((await ocr.recognizer.read(frame, regions.hp)).text);
    }
    if (regions.enmity) {
        if (castCandidates.length === 0) {
            out.enmity = (await ocr.detector.detect(frame, regions.enmity)).boxes.length > 0;
        } else {
            // 敵対リストの各行には、詠唱中の技名が途中で切れて出る（「テトラフレア・コ…」）
            const list = await readCast(ocr.detector, ocr.recognizer, frame, regions.enmity, castCandidates,
                { wholeIfNoLines: false, truncated: true });
            out.enmity = list.lines > 0;
            out.casts.push({ source: 'list', text: list.text, decided: list.result.decided });
        }
    }
    if (regions.cast && castCandidates.length > 0) {
        const bar = await readCast(ocr.detector, ocr.recognizer, frame, regions.cast, castCandidates);
        out.casts.push({ source: 'bar', text: bar.text, decided: bar.result.decided });
    }
    return out;
}
