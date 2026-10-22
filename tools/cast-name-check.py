#!/usr/bin/env python3
"""tools/measure-cast-bars.py --dump の各バーの技名を PP-OCRv5 で読み、予定の技名と合うか確かめる（運営者の手元の道具）。

読み方は public/js/ocr.js の TextRecognizer と同じ（高さ 48・BGR・(x/127.5-1)・CTC の貪欲復号）。
バーごとに 2 コマ（出始め＋0.3 秒と、長さの 6 割）を読み、タイムラインの全部の技名のうち、読んだ文字のどこか一部分との
編集距離が最も小さい名前を探す。予定の技名がそれで、違いが文字数の半分以下なら「確かめた」とする。
古い 720p の動画では文字が崩れて正しいバーも落ちることがあるが、表の値を誤らないよう、迷ったら採らない側に倒す。

    tools/cast-name-check.sh が切り出しと実行をする。直接使うときは:
    python3 tools/cast-name-check.py <models> <dump.json> <切り出した画像のディレクトリ> <timeline.xml> <out.json>
    （画像は <番号>_0.png・<番号>_1.png。onnxruntime・numpy・pillow が要る）
"""
import json
import os
import sys
import xml.etree.ElementTree as ET

import numpy as np
import onnxruntime as ort
from PIL import Image

HEIGHT = 48
MAX_MISS = 0.5  # 予定の技名と読んだ文字の違いが、技名の文字数のこの割合以下なら合うとみなす


class Reader:
    def __init__(self, model, dict_path):
        self.session = ort.InferenceSession(model, providers=['CPUExecutionProvider'])
        lines = open(dict_path, encoding='utf-8').read().replace('\r', '').split('\n')
        if lines and lines[-1] == '':
            lines.pop()
        self.chars = [''] + lines + [' ']  # 0 番は CTC の空白記号、末尾は半角スペース（PaddleOCR の決まり）

    def read(self, image):
        image = image.convert('RGB')
        width = max(16, int(np.ceil(HEIGHT * image.width / image.height)))
        pixels = np.asarray(image.resize((width, HEIGHT), Image.BILINEAR), dtype=np.float32)
        feed = (pixels[:, :, ::-1] / 127.5 - 1).transpose(2, 0, 1)[None]  # BGR・NCHW
        out = self.session.run(None, {self.session.get_inputs()[0].name: feed})[0][0]
        text, prev = '', 0
        for c in out.argmax(axis=1):
            if c != 0 and c != prev:
                text += self.chars[c]
            prev = c
        return text


def partial_distance(name, text):
    """name と、text のどこか一部分との編集距離の最小"""
    prev = [0] * (len(text) + 1)
    for i, a in enumerate(name, 1):
        cur = [i] + [0] * len(text)
        for j, b in enumerate(text, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a != b))
        prev = cur
    return min(prev)


def main():
    models, dump, crops, timeline, out = sys.argv[1:6]
    reader = Reader(f'{models}/ppocrv5_rec.onnx', f'{models}/ppocrv5_dict.txt')
    names = sorted({n for e in ET.parse(timeline).getroot().iter('entry') for n in (e.get('castname') or '').split('|') if n})
    result = []
    for i, m in enumerate(json.load(open(dump, encoding='utf-8'))):
        texts = [reader.read(Image.open(f'{crops}/{i}_{k}.png')) for k in (0, 1) if os.path.exists(f'{crops}/{i}_{k}.png')]
        score = {n: min(partial_distance(n, t) for t in texts) / len(n) for n in names} if texts else {}
        own = m['name'].split('|')
        want = min((score[n] for n in own if n in score), default=9)
        # 予定の技名で始まるほかの名前（「針飛ばし」と「針飛ばし(終了)」など）は競合とみなさない
        other = min((v for n, v in score.items() if n not in own and not n.startswith(tuple(own))), default=9)
        result.append({**m, 'texts': texts, 'ok': want <= MAX_MISS and want <= other,
                       'miss': round(want, 2), 'nearest': min(score, key=score.get) if score else ''})
    json.dump(result, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print(f'技名を確かめたバー {sum(m["ok"] for m in result)}/{len(result)}')
    for m in result:
        if not m['ok']:
            print(f'  合わない: 動画 {m["start"]:.2f} 予定 {m["name"]}（読んだ文字 {" / ".join(m["texts"])} → 近いのは {m["nearest"]}）')


if __name__ == '__main__':
    main()
