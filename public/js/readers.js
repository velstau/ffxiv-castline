// 読み取った文字列の解釈（コンテンツ名・技名の決定、カウントダウン、HP）。再生画面と試験ページで共用する。

// 1 位と 2 位の対数尤度の差がこれ未満なら自動で決めない（e^5 ≒ 150 倍の差）
export const CANDIDATE_MARGIN_MIN = 5;

export function levenshtein(a, b) {
    const x = [...a];
    const y = [...b];
    let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
        const cur = [i];
        for (let j = 1; j <= y.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[y.length];
}

/**
 * 読んだ文字を候補（コンテンツ名・技名）から決める。
 * 1 位が 2 位より十分に確からしく、かつ読み取った文字列とも大きくは違わない（一覧に無いものを
 * 一覧のどれかと取り違えないため）ときだけ決める。決まらなければ null（コンテンツ名なら利用者に選んでもらう）。
 * @param {import('./ocr.js').TextRecognizer} recognizer
 * @returns {{decided:string|null, ranked:{text:string,logP:number}[], margin:number, distance:number|null}}
 */
export function pickCandidate(recognizer, read, candidates) {
    const ranked = recognizer.score(read.output, candidates);
    if (ranked.length === 0) {
        return { decided: null, ranked, margin: 0, distance: null };
    }
    const best = ranked[0];
    const margin = ranked.length > 1 ? best.logP - ranked[1].logP : Infinity;
    const distance = levenshtein(read.text, best.text);
    const close = distance <= Math.max(2, Math.floor([...best.text].length * 0.3));
    return {
        decided: close && margin >= CANDIDATE_MARGIN_MIN ? best.text : null,
        ranked,
        margin,
        distance,
    };
}

// 詠唱の技名: 減点（ocr.js の spot）がこの値以内の候補だけを当てはまるとみなす（e^6 ≒ 400 倍まで）
export const CAST_PENALTY_MAX = 6;
// 同じ長さの候補どうしで、減点の差がこれ未満なら決めない
export const CAST_MARGIN_MIN = 3;
// 途中で切れた技名を頭の部分で照合するとき、最低これだけの文字数が要る。短い部分は 1 文字の欠けでも別の技に当たりうるので、
// 減点も CAST_PREFIX_PENALTY_MAX までしか許さない
export const CAST_PREFIX_MIN = 4;
export const CAST_PREFIX_PENALTY_MAX = 3;

/**
 * 詠唱バーで読んだ文字から技名を決める。範囲にはボス名やバーの模様も入るので、読んだ文字のどこか一部分に
 * 候補が含まれているかで見る（spot）。当てはまる候補が複数あれば長いほうを採る（「コンシーヴ」より
 * 「オクタフレア・コンシーヴ」）。同じ長さで僅差の候補があれば決めない。
 * truncated: 敵対リストは長い技名を「テトラフレア・コ…」と途中で切って出すので、頭の部分（CAST_PREFIX_MIN 文字以上）でも照合する。
 * 頭の部分が同じ候補が複数あってどれか決まらないときは決めない。
 * @returns {{decided:string|null, ranked:{text:string,penalty:number,matched:string}[]}}
 *          ranked は候補ごとに最も当てはまった部分（matched）の減点
 */
export function pickCast(recognizer, read, candidates, { truncated = false } = {}) {
    // 照合する文字列（候補そのもの、truncated なら頭の部分も）→ その文字列で始まる候補
    const owners = new Map();
    const whole = new Set(candidates);
    for (const text of candidates) {
        const chars = [...text];
        const from = truncated ? Math.min(CAST_PREFIX_MIN, chars.length) : chars.length;
        for (let n = from; n <= chars.length; n++) {
            const part = chars.slice(0, n).join('');
            owners.set(part, [...new Set([...(owners.get(part) ?? []), text])]);
        }
    }
    const length = (c) => [...c.matched].length;
    const spotted = recognizer.spot(read.output, [...owners.keys()]);
    const ranked = rankByCandidate(spotted, owners);
    const fits = spotted
        .map(({ text, penalty }) => ({ matched: text, owners: owners.get(text), penalty }))
        .filter((c) => c.penalty >= -(whole.has(c.matched) ? CAST_PENALTY_MAX : CAST_PREFIX_PENALTY_MAX))
        .sort((a, b) => length(b) - length(a) || b.penalty - a.penalty);
    if (fits.length === 0) {
        return { decided: null, ranked };
    }
    const best = fits[0];
    const rival = best.owners.length > 1 || fits.some((c) => c !== best && length(c) === length(best)
        && c.owners[0] !== best.owners[0] && best.penalty - c.penalty < CAST_MARGIN_MIN);
    return { decided: rival ? null : best.owners[0], ranked };
}

// 確認用: 候補ごとに、最も当てはまった部分の減点（減点の小さい順）
function rankByCandidate(spotted, owners) {
    const best = new Map();
    for (const { text, penalty } of spotted) {
        for (const owner of owners.get(text)) {
            if (!best.has(owner) || penalty > best.get(owner).penalty) {
                best.set(owner, { text: owner, penalty, matched: text });
            }
        }
    }
    return [...best.values()].sort((a, b) => b.penalty - a.penalty);
}

/**
 * 詠唱バーの範囲を読んで技名を決める。範囲にはボス名の行も入りやすく、2 行を 1 行として読むと
 * 「ア人A熾炎创火」のように混ざって崩れるので、文字検出で行を分けてから 1 行ずつ照合し、最も当てはまる行を採る。
 * 敵対リスト（各行に「敵の名前　詠唱中の技名」が出る）にも使う。
 * @param {{wholeIfNoLines?:boolean, truncated?:boolean}} options wholeIfNoLines: 行が見つからないとき範囲全体を 1 行として読むか
 *        （敵対リストでは読まない）。truncated: 途中で切れた技名を頭の部分で照合する（敵対リスト。pickCast を参照）
 * @returns {Promise<{text:string, lines:number, result:{decided:string|null, ranked:{text:string,penalty:number}[]}, ms:number}>}
 *          text は読んだ行を「 / 」でつないだもの（確認用）、lines は見つかった行の数
 */
export async function readCast(detector, recognizer, source, rect, candidates, { wholeIfNoLines = true, truncated = false } = {}) {
    const found = await detector.detect(source, rect);
    let ms = found.ms;
    const texts = [];
    let best = null;
    const topPenalty = (result) => result.ranked[0]?.penalty ?? -Infinity;
    const lines = found.boxes.length > 0 || !wholeIfNoLines ? found.boxes : [rect];
    for (const line of lines) {
        const read = await recognizer.read(source, line);
        ms += read.ms;
        if (read.text === '') {
            continue;
        }
        texts.push(read.text);
        const result = pickCast(recognizer, read, candidates, { truncated });
        // 決まった行を優先し、どちらも同じなら減点の小さい行
        if (!best
            || (result.decided && !best.decided)
            || (Boolean(result.decided) === Boolean(best.decided) && topPenalty(result) > topPenalty(best))) {
            best = result;
        }
    }
    return { text: texts.join(' / '), lines: found.boxes.length, result: best ?? { decided: null, ranked: [] }, ms };
}

/**
 * カウントダウンの吹き出し（「戦闘開始まで16秒！」「戦闘開始！」）を解釈する。
 * 「戦」を「則」と読むような誤読があるので、「(数字)秒」と「開始」だけを見る。
 * 「まで」か「秒」があれば残り秒数の吹き出しで、数字が読めなければ何も返さない（「開始」だけを見て戦闘開始にしない。2026-10-21）
 * @returns {{seconds:number}|{started:true}|null}
 */
export function parseCountdown(text) {
    const t = text
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/(?<=\d)[OoＯ〇]|[OoＯ〇](?=\d)/g, '0');
    const m = t.match(/(\d{1,2})\s*秒/);
    if (m) {
        return { seconds: Number(m[1]) };
    }
    if (/まで|秒/.test(t)) {
        return null;
    }
    if (/開始/.test(t)) {
        return { started: true };
    }
    return null;
}

/**
 * カウントダウンの範囲を読む。吹き出しは「戦闘開始まで16秒！」の下に「（名前）」の行が付くことがあり、
 * 行数で縦の位置も、文言で幅も変わるので、範囲は広めに取ってもらい、文字検出で行を探して 1 行ずつ読む。
 * 範囲にはキャラクター名なども入るが、解釈は数字と「秒」「まで」「開始」だけを見るので、全部の行をつないで解釈する。
 * @param {import('./ocr.js').TextDetector} detector
 * @param {import('./ocr.js').TextRecognizer} recognizer
 * @returns {Promise<{text:string, countdown:{seconds:number}|{started:true}|null, ms:number}>}
 *          text は読んだ行を「 / 」でつないだもの（確認用）
 */
export async function readCountdown(detector, recognizer, source, rect) {
    const texts = [];
    const found = await detector.detect(source, rect);
    let ms = found.ms;
    for (const line of found.boxes) {
        const read = await recognizer.read(source, line);
        texts.push(read.text);
        ms += read.ms;
    }
    // 行を全部読んでからまとめて解釈する。「戦闘開始まで16秒！」が「戦闘開始」と「まで16秒！」に分かれて見つかることがあり、
    // 1 行目だけで判断すると戦闘開始と読んでしまう（2026-10-21、動画で 16 秒の吹き出しでいきなり開始した）
    return { text: texts.join(' / '), countdown: parseCountdown(texts.join(' ')), ms };
}

// HP の「99.0%」を数値にする。隣のアイコンが写り込んで末尾に文字が付くことがあるので、数字と % だけを拾う。
// % は全角の「％」に読めることがある（2026-10-20 実測）
export function parseHpPercent(text) {
    const m = text.match(/(\d{1,3}(?:\.\d)?)\s*[%％]/);
    if (!m) {
        return null;
    }
    const value = Number(m[1]);
    return value <= 100 ? value : null;
}
