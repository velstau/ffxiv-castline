// 認識モデルの出力（時刻ごとの文字の確率。CTC）と、候補文字列との照合。
// probs は [時刻 × 文字の種類] を並べた配列、0 番は空白記号。indices は候補文字列の各文字の番号。

const EPS = 1e-12;

// 行の終わりに来てよい文字（途中で切れた技名の後ろの「…」の読み方いろいろと空白）。spottingPenalty の tail に使う
export const LINE_END_CHARS = ['…', '‥', '.', '．', '・', '･', ' ', '　'];

function withBlanks(indices) {
    const labels = [0];
    for (const i of indices) {
        labels.push(i, 0);
    }
    return labels;
}

function logAdd(a, b) {
    if (a === -Infinity) {
        return b;
    }
    if (b === -Infinity) {
        return a;
    }
    return a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b));
}

/**
 * 読んだ画像全体が候補文字列である確率の対数（CTC の前向きアルゴリズム）。
 * 画像の文字全体を候補と比べるので、コンテンツ名のように範囲に他の文字が入らないものに使う。
 */
export function logLikelihood(probs, steps, classes, indices) {
    const labels = withBlanks(indices);
    const size = labels.length;
    const logProb = (t, s) => Math.log(probs[t * classes + labels[s]] + EPS);
    let alpha = new Array(size).fill(-Infinity);
    alpha[0] = logProb(0, 0);
    if (size > 1) {
        alpha[1] = logProb(0, 1);
    }
    for (let t = 1; t < steps; t++) {
        const next = new Array(size).fill(-Infinity);
        for (let s = 0; s < size; s++) {
            let v = alpha[s];
            if (s > 0) {
                v = logAdd(v, alpha[s - 1]);
            }
            if (s > 1 && labels[s] !== 0 && labels[s] !== labels[s - 2]) {
                v = logAdd(v, alpha[s - 2]);
            }
            next[s] = v + logProb(t, s);
        }
        alpha = next;
    }
    return size > 1 ? logAdd(alpha[size - 1], alpha[size - 2]) : alpha[0];
}

/**
 * 読んだ文字のどこか一部分が候補文字列であるとしたときの「減点」（0 以下）。
 * 候補に当てた時刻だけを、その時刻に最も確からしい文字と比べて減点し、前後の時刻は数えない。
 * 0 なら、モデルが自由に読んだ結果の中に候補がそのまま含まれている。
 * 範囲に技名以外の文字（ボス名・バーの模様）が入る詠唱バーに使う。
 * tail（文字の番号の配列）を渡すと、候補が行の終わりにある場合だけを数える。候補より後ろの時刻で最も確からしい文字が
 * すべて tail に含まれる位置だけを見る（途中で切れた技名「ヴァンプスト…」を、ボス名「ヴァンプ・ファタール」の頭に当てない）。
 */
export function spottingPenalty(probs, steps, classes, indices, tail = null) {
    const labels = withBlanks(indices);
    const size = labels.length;
    const best = new Float64Array(steps);
    const top = new Int32Array(steps);
    for (let t = 0; t < steps; t++) {
        let max = 0;
        for (let c = 0; c < classes; c++) {
            if (probs[t * classes + c] > max) {
                max = probs[t * classes + c];
                top[t] = c;
            }
        }
        best[t] = Math.log(max + EPS);
    }
    // endsAfter[t]: 時刻 t より後ろが行の終わり（tail の文字だけ）か
    const endsAfter = new Uint8Array(steps).fill(1);
    if (tail) {
        const allowed = new Set(tail);
        for (let t = steps - 2; t >= 0; t--) {
            endsAfter[t] = endsAfter[t + 1] && allowed.has(top[t + 1]) ? 1 : 0;
        }
    }
    let prev = new Array(size).fill(-Infinity);
    let result = -Infinity;
    for (let t = 0; t < steps; t++) {
        const cur = new Array(size).fill(-Infinity);
        for (let s = 0; s < size; s++) {
            let v = prev[s];
            if (s > 0) {
                v = Math.max(v, prev[s - 1]);
            }
            if (s > 1 && labels[s] !== 0 && labels[s] !== labels[s - 2]) {
                v = Math.max(v, prev[s - 2]);
            }
            if (s <= 1) {
                v = Math.max(v, 0); // ここまでの時刻は候補の外（減点しない）
            }
            cur[s] = v + Math.log(probs[t * classes + labels[s]] + EPS) - best[t];
        }
        if (endsAfter[t]) {
            result = Math.max(result, cur[size - 1], cur[size - 2]); // ここから後の時刻も候補の外
        }
        prev = cur;
    }
    return result;
}
