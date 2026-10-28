// 画面全体の暗転（全滅のとき。HUD も消える）を見分ける。2026-10-21 のユーザーの確認: 全滅すると画面がブラックアウトし、
// 敵対リスト・HP バーも残らない。「全滅」の表示は出ない。
// 暗い戦場でも HUD（ホットバー・HP バー・文字）は明るいので、ほぼ全部の点が真っ黒のときだけ暗転とみなす。

const SAMPLE_W = 128; // 縮小して見る（1 点が元の 20 点ほど。ホットバーのアイコンや文字の行は 1 点より大きい）
const SAMPLE_H = 72;
const BLACK_LEVEL = 24; // 明るさ（0〜255）がこれ未満の点を黒とみなす
const BLACK_SHARE = 0.995; // 黒い点がこれ以上の割合なら暗転
// 討伐の瞬間は、HUD（パーティリスト・チャット）を残したまま画面が暗くなる（2026-10-28 ヘビー級1 零式の録画: 黒い点が 85%、
// 戦闘中の暗い演出は最大 32%）。黒い点がこれ以上の割合なら「暗くなった」とみなす
const DIM_SHARE = 0.6;

/** RGBA の並び（ImageData.data）が暗転か */
export function isBlackPixels(data) {
    const total = data.length / 4;
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= BLACK_LEVEL) {
            bright++;
            if (bright > total * (1 - BLACK_SHARE)) {
                return false;
            }
        }
    }
    return true;
}

/** RGBA の並びが「暗くなった」か（HUD が残っていてもよい。真っ黒の暗転も含む） */
export function isDimPixels(data) {
    const total = data.length / 4;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < BLACK_LEVEL) {
            dark++;
        }
    }
    return dark >= total * DIM_SHARE;
}

let canvas = null;

function sample(frame) {
    canvas ??= new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(frame, 0, 0, SAMPLE_W, SAMPLE_H);
    return g.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
}

/** 取り込んだ 1 フレーム（ImageBitmap など）が暗転か */
export function isBlackFrame(frame) {
    return isBlackPixels(sample(frame));
}

/** 取り込んだ 1 フレームが「暗くなった」か（討伐の瞬間） */
export function isDimFrame(frame) {
    return isDimPixels(sample(frame));
}
