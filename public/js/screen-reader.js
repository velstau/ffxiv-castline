// 取り込んだ 1 フレームを範囲ごとに読み、タイムラインに渡す観測にまとめる（再生画面用）。
// 読み方は試験ページの連続読み取り（lab.js の watchTick）と同じ。範囲は regions.js が画面の大きさごとに保存したもの。
import { pickCandidate, readCast, readCountdown, parseHpPercent } from './readers.js';


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
        out.content = await readContent(ocr, frame, regions.content, want.content);
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

// ── コンテンツ名 ──

const LINE_MIN_ASPECT = 3; // 1 行の文字らしい横長（幅が高さの 3 倍以上）だけを読む

/**
 * 範囲の中の文字の行を探して読み、候補のどれかに決まった行を返す。範囲は長い名前も入るよう広めに取るので、
 * 範囲全体を 1 行として読むと背景の模様まで読んでしまう。行が見つからなければ範囲全体を 1 行として読む。
 * @returns {Promise<{text:string, decided:string|null}>}
 */
export async function readContent(ocr, frame, rect, names) {
    const boxes = (await ocr.detector.detect(frame, rect)).boxes.filter((b) => b.w >= b.h * LINE_MIN_ASPECT);
    let text = '';
    for (const box of boxes.length > 0 ? boxes : [rect]) {
        const read = await ocr.recognizer.read(frame, box);
        if (read.text === '') {
            continue;
        }
        const decided = pickCandidate(ocr.recognizer, read, names).decided;
        if (decided) {
            return { text: read.text, decided };
        }
        text ||= read.text;
    }
    return { text, decided: null };
}

const FIND_TILE = 960; // 検出のモデルは 1 辺 960px まで縮めずに読める
const FIND_OVERLAP = 64;

/**
 * 画面全体からコンテンツ名（「コンテンツ情報」の下の行）を探す。既定の位置の右上から順に、見つかったところで止める。
 * @param {(done:number, total:number) => void} [onProgress]
 * @returns {Promise<{name:string, box:{x,y,w,h}, rect:{x,y,w,h}}|null>} rect は保存する範囲（長い名前も入るよう広げたもの）
 */
export async function findContent(ocr, frame, names, onProgress = () => {}) {
    const tiles = [];
    for (let y = 0; y < frame.height; y += FIND_TILE - FIND_OVERLAP) {
        for (let x = 0; x < frame.width; x += FIND_TILE - FIND_OVERLAP) {
            tiles.push({ x, y, w: Math.min(FIND_TILE, frame.width - x), h: Math.min(FIND_TILE, frame.height - y) });
        }
    }
    tiles.sort((a, b) => a.y - b.y || b.x - a.x); // 上の段から、右から
    for (const [i, tile] of tiles.entries()) {
        onProgress(i, tiles.length);
        const boxes = (await ocr.detector.detect(frame, tile)).boxes.filter((b) => b.w >= b.h * LINE_MIN_ASPECT);
        for (const box of boxes) {
            const read = await ocr.recognizer.read(frame, box);
            const decided = read.text === '' ? null : pickCandidate(ocr.recognizer, read, names).decided;
            if (decided) {
                onProgress(tiles.length, tiles.length);
                return { name: decided, box, rect: contentRegionFrom(box, decided, names, frame.width, frame.height) };
            }
        }
    }
    onProgress(tiles.length, tiles.length);
    return null;
}

/**
 * 見つけた名前の行から、保存する範囲を作る。いまの名前の幅しかないので、いちばん長い名前も入るよう横に広げる。
 * コンテンツ情報は既定で右寄せ（長い名前は左へ伸びる）なので左へ広げ、右は 1 文字分だけ。
 * 縦は検出の余白込みの行の高さに上下 1 割（すぐ下に残り時間の行がある）。
 */
export function contentRegionFrom(box, name, names, width, height) {
    const length = Math.max(1, [...name].length);
    const longest = Math.max(length, ...names.map((n) => [...n].length));
    const charWidth = box.w / length;
    const left = Math.max(0, box.x - (longest - length + 1) * charWidth);
    const right = Math.min(width, box.x + box.w + charWidth);
    const top = Math.max(0, box.y - box.h * 0.1);
    const bottom = Math.min(height, box.y + box.h * 1.1);
    return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

// ── 範囲の設定のときの試し読み ──

/**
 * 範囲を 1 つ試しに読み、指定の良し悪しが分かる短い文にする（範囲の設定画面に出す）。
 * ok: true 読めた / false 指定を直したほうがよい / null いまの画面では判断できない（その場面でしか出ない表示）
 * @returns {Promise<{ok:boolean|null, text:string}>}
 */
export async function checkRegion(ocr, frame, id, rect, names = []) {
    if (id === 'content') {
        const read = await readContent(ocr, frame, rect, names);
        if (read.decided) {
            return { ok: true, text: `読めた: ${read.decided}` };
        }
        return read.text
            ? { ok: false, text: `「${read.text}」と読めましたが、コンテンツ名の一覧にありません。名前の行だけが入るように直してください` }
            : { ok: false, text: '文字が読めません。コンテンツの中で、コンテンツ名の行を囲んでください' };
    }
    if (id === 'countdown') {
        const cd = (await readCountdown(ocr.detector, ocr.recognizer, frame, rect)).countdown;
        if (cd?.started) {
            return { ok: true, text: '読めた: 戦闘開始！' };
        }
        return cd ? { ok: true, text: `読めた: 残り ${cd.seconds} 秒` } : { ok: null, text: 'カウントダウン中だけ読めます（いまの画面では確かめられません）' };
    }
    const boxes = (await ocr.detector.detect(frame, rect)).boxes;
    const texts = [];
    for (const box of boxes) {
        const text = (await ocr.recognizer.read(frame, box)).text;
        if (text) {
            texts.push(text);
        }
    }
    if (id === 'hp') {
        const hp = parseHpPercent(texts.join(''));
        if (hp !== null) {
            return { ok: true, text: `読めた: HP ${hp}%` };
        }
        return texts.length > 0
            ? { ok: false, text: `「${texts.join(' ')}」と読めましたが、% の数字ではありません` }
            : { ok: null, text: 'ターゲットしているときだけ読めます（いまは文字がありません）' };
    }
    if (id === 'cast') {
        if (texts.length === 0) {
            return { ok: null, text: '詠唱中だけ読めます（いまは文字がありません）' };
        }
        return texts.length > 1
            ? { ok: false, text: `${texts.length} 行入っています（「${texts.join('」「')}」）。技名の 1 行だけにしてください` }
            : { ok: true, text: `読めた: ${texts[0]}` };
    }
    if (id === 'enmity') {
        return texts.length > 0
            ? { ok: true, text: `${texts.length} 行読めた: ${texts.join('／')}` }
            : { ok: null, text: '敵がいるときだけ読めます（いまは文字がありません）' };
    }
    return { ok: null, text: '' };
}
