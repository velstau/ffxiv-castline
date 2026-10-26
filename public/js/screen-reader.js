// 取り込んだ 1 フレームを範囲ごとに読み、タイムラインに渡す観測にまとめる（再生画面用）。
// 読み方は試験ページの連続読み取り（lab.js の watchTick）と同じ。範囲は regions.js が画面の大きさごとに保存したもの。
import { pickCandidate, pickCast, readCast, readCountdown, parseHpPercent } from './readers.js';

/**
 * 敵対リストの範囲の文字が、敵の名前でありうるか。数字と記号だけなら名前ではない（2026-10-26 の録画: 極永遠の闇の討伐後、
 * 敵対リストの範囲に重なった戦利品の窓のアイテム数「83 70 16」を敵対リストと読み、戦闘開始になった。マーケットの値段も同じ）
 */
export function looksLikeEnemyName(text) {
    return /[^\d\s\p{P}\p{S}]/u.test(text ?? '');
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
            // 文字の箱があるときだけ読んで、名前かを確かめる（戦闘外はたいてい空なので、読むのはまれ）
            out.enmity = (await ocr.detector.detect(frame, regions.enmity)).boxes.length > 0
                && looksLikeEnemyName((await ocr.recognizer.read(frame, regions.enmity)).text);
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
const JOIN_GAP = 1.2; // 同じ行の隣り合う部分は、すき間が文字の高さのこれ倍までならつなぐ

/**
 * 文字検出が 1 行を途中で分けて見つけた部分（「至天の座アルカデイ」と「ア零式：ヘビー級1」など）を、1 つの行の枠にまとめる。
 * 縦の中心が近く（低いほうの高さの半分以内）、高さが同じくらいで、横のすき間が狭いものをつなぐ（2026-10-21、
 * 動画でコンテンツ名の前半だけを読んで決まらなかった）
 * @param {{x,y,w,h}[]} boxes
 * @returns {{x,y,w,h, parts:number}[]} 上から、左から
 */
export function joinLineBoxes(boxes) {
    const sorted = [...boxes].sort((a, b) => a.x - b.x);
    const lines = [];
    for (const b of sorted) {
        const line = lines.find((l) => {
            const h = Math.min(l.h, b.h);
            return Math.abs((l.y + l.h / 2) - (b.y + b.h / 2)) <= h / 2
                && Math.max(l.h, b.h) <= h * 1.5
                && b.x - (l.x + l.w) <= h * JOIN_GAP;
        });
        if (line) {
            const right = Math.max(line.x + line.w, b.x + b.w);
            const bottom = Math.max(line.y + line.h, b.y + b.h);
            line.y = Math.min(line.y, b.y);
            line.w = right - line.x;
            line.h = bottom - line.y;
            line.parts++;
        } else {
            lines.push({ x: b.x, y: b.y, w: b.w, h: b.h, parts: 1 });
        }
    }
    return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** 文字検出の枠を読む順に並べる: 行にまとめたもの、続いてまとめる前の部分（まとめたほうで決まらなかったとき用） */
function contentBoxes(boxes) {
    const joined = joinLineBoxes(boxes);
    const parts = joined.some((l) => l.parts > 1) ? boxes : [];
    return [...joined, ...parts].filter((b) => b.w >= b.h * LINE_MIN_ASPECT);
}

/**
 * 範囲の中の文字の行を探して読み、候補のどれかに決まった行を返す。範囲は長い名前も入るよう広めに取るので、
 * 範囲全体を 1 行として読むと背景の模様まで読んでしまう。行が見つからなければ範囲全体を 1 行として読む。
 * 決まらなければ、1 位と 2 位の差がいちばん大きかった行の上位の候補（ranked）を返す（何回かの読み取りを足し合わせて決めるため）。
 * lines は読んだ行の文字（決まった行まで。コンテンツ参加申請中の表示など、コンテンツ名でない文字を見分けるため）
 * @returns {Promise<{text:string, decided:string|null, ranked?:{text:string, logP:number}[], lines:string[]}>}
 */
export async function readContent(ocr, frame, rect, names) {
    const boxes = contentBoxes((await ocr.detector.detect(frame, rect)).boxes);
    let best = null;
    const lines = [];
    for (const box of boxes.length > 0 ? boxes : [rect]) {
        const read = await ocr.recognizer.read(frame, box);
        if (read.text === '') {
            continue;
        }
        lines.push(read.text);
        const pick = pickCandidate(ocr.recognizer, read, names);
        if (pick.decided) {
            return { text: read.text, decided: pick.decided, lines };
        }
        if (!best || pick.margin > best.margin) {
            best = { text: read.text, margin: pick.margin, ranked: pick.ranked.slice(0, CONTENT_KEEP) };
        }
    }
    return best ? { text: best.text, decided: null, ranked: best.ranked, lines } : { text: '', decided: null, lines };
}

const CONTENT_KEEP = 8; // 足し合わせるために返す上位の候補の数

const FIND_TILE = 960; // 検出のモデルは 1 辺 960px まで縮めずに読める
const FIND_OVERLAP = 64;

/** 範囲（既定は画面全体）を、検出のモデルが縮めずに読める区画に分ける。上の段から、右から */
export function tilesOf(frame, area = { x: 0, y: 0, w: frame.width, h: frame.height }) {
    const tiles = [];
    for (let y = area.y; y < area.y + area.h; y += FIND_TILE - FIND_OVERLAP) {
        for (let x = area.x; x < area.x + area.w; x += FIND_TILE - FIND_OVERLAP) {
            tiles.push({ x, y, w: Math.min(FIND_TILE, area.x + area.w - x), h: Math.min(FIND_TILE, area.y + area.h - y) });
            if (x + FIND_TILE >= area.x + area.w) {
                break;
            }
        }
        if (y + FIND_TILE >= area.y + area.h) {
            break;
        }
    }
    return tiles.sort((a, b) => a.y - b.y || b.x - a.x);
}

/**
 * 画面全体からコンテンツ名（「コンテンツ情報」の下の行）を探す。既定の位置の右上から順に、見つかったところで止める。
 * @param {(done:number, total:number) => void} [onProgress]
 * @param {{lock?: (fn) => Promise}} [options] lock: 区画ごとに文字認識を順番待ちさせる（再生中の読み取りを止めないため）
 * @returns {Promise<{name:string, box:{x,y,w,h}, rect:{x,y,w,h}}|null>} rect は保存する範囲（長い名前も入るよう広げたもの）
 */
export async function findContent(ocr, frame, names, onProgress = () => {}, { lock = (fn) => fn() } = {}) {
    const tiles = tilesOf(frame);
    for (const [i, tile] of tiles.entries()) {
        onProgress(i, tiles.length);
        const decided = await lock(() => readContentLines(ocr, frame, tile, names));
        if (decided) {
            onProgress(tiles.length, tiles.length);
            return { ...decided, rect: contentRegionFrom(decided.box, decided.name, names, frame.width, frame.height) };
        }
    }
    onProgress(tiles.length, tiles.length);
    return null;
}

/** 区画の中の行を順に読み、コンテンツ名に決まった最初の行を返す（findContent の 1 区画分） */
export async function readContentLines(ocr, frame, area, names) {
    const boxes = contentBoxes((await ocr.detector.detect(frame, area)).boxes);
    for (const box of boxes) {
        const read = await ocr.recognizer.read(frame, box);
        const name = read.text === '' ? null : pickCandidate(ocr.recognizer, read, names).decided;
        if (name) {
            return { name, box: { x: box.x, y: box.y, w: box.w, h: box.h } };
        }
    }
    return null;
}

/**
 * 区画の中の文字の行を全部探して読む（自動の範囲指定用。何の行かは region-finder.js が決める）。
 * castCandidates があれば、各行を詠唱バーとして照合した技名も付ける。
 * @returns {Promise<{x,y,w,h,text:string,cast:string|null}[]>}
 */
export async function scanLines(ocr, frame, area, castCandidates = []) {
    const lines = [];
    for (const box of (await ocr.detector.detect(frame, area)).boxes) {
        const read = await ocr.recognizer.read(frame, box);
        if (read.text === '') {
            continue;
        }
        const cast = castCandidates.length > 0 ? pickCast(ocr.recognizer, read, castCandidates).decided : null;
        lines.push({ x: box.x, y: box.y, w: box.w, h: box.h, text: read.text, cast });
    }
    return lines;
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
