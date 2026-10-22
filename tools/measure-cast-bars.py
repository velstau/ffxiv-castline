#!/usr/bin/env python3
"""動画の詠唱バーの長さを測り、タイムラインの duration と比べる（運営者の手元の道具。tools/cast-durations.tsv の値を決めるため）。

FFLogs の詠唱時間は画面の詠唱バーの長さと違う技がある（2026-10-22 クルーザー級2 零式: ランドスケープ 0.7 秒・画面 7.7 秒）。
動画のフォーカスの詠唱バーの横 1 行（高さ 3 画素、中央の行を使う）をコマごとに取り出し、左から続く塗り（明るさ 228〜248）と
空き（70〜110）でバーの有無と進み具合を見る。技名の文字はバーの右側に重なるので、左端の 40 画素だけを使う。

1. バーの位置を 1 枚で確かめる（例は 1704x720 の動画）
2. 行を取り出す（120 秒ずつ。長い動画を 1 回で取り出すと途中で切れたことがある）:
     ffmpeg -ss 0 -t 120 -i 動画.mp4 -vf "crop=125:3:1115:61,format=gray" -f rawvideo seg0.raw
3. python3 tools/measure-cast-bars.py seg0.raw:0 seg120.raw:120 … --width 125 \\
       --timeline public/timelines/x.xml --phase p1=105.87-90.8 --phase p2=230.23
   --phase は「フェーズの 0 秒が動画の何秒か」（引き算も書ける）。分かっている詠唱の出始めから逆算する

測った長さは真の値より約 0.03 秒短く出る。同じ技を何回か測って値がそろうことを確かめてから表に書く。
"""
import argparse
import xml.etree.ElementTree as ET

FILL = (228, 248)
EMPTY = (70, 110)
LEFT = range(2, 40)


def segments(path, base, width, fps):
    data = open(path, 'rb').read()
    frame = width * 3
    found, cur = [], None
    for i in range(len(data) // frame):
        row = data[i * frame + width:i * frame + 2 * width]  # 中央の行
        cls = ''.join('F' if FILL[0] <= row[x] <= FILL[1] else 'E' if EMPTY[0] <= row[x] <= EMPTY[1] else '?' for x in LEFT)
        fill = len(cls) - len(cls.lstrip('F'))
        t = base + i / fps
        if cls.count('?') <= 2 and cls[fill:].count('F') <= 2:
            if cur is None:
                cur = [t, t, []]
            cur[1] = t
            cur[2].append((t, (fill + 2) / (width - 2)))
        elif cur is not None and t - cur[1] > 0.25:
            found.append(cur)
            cur = None
    if cur:
        found.append(cur)
    out = []
    for start, end, pts in found:
        if end - start < 0.5:
            continue
        mid = [(t, f) for t, f in pts if 0.04 < f < 0.3]
        speed = None
        if len(mid) > 10:
            mt = sum(t for t, _ in mid) / len(mid)
            mf = sum(f for _, f in mid) / len(mid)
            speed = sum((t - mt) * (f - mf) for t, f in mid) / sum((t - mt) ** 2 for t, _ in mid)
        out.append((start, end - start, 1 / speed if speed else None))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('raw', nargs='+', metavar='PATH:動画の秒')
    ap.add_argument('--width', type=int, default=125)
    ap.add_argument('--fps', type=float, default=60)
    ap.add_argument('--timeline')
    ap.add_argument('--phase', action='append', default=[], metavar='フェーズID=動画の秒')
    args = ap.parse_args()
    bars = []
    for spec in args.raw:
        path, base = spec.rsplit(':', 1)
        bars += segments(path, float(base), args.width, args.fps)
    if not args.timeline:
        for start, shown, cast in bars:
            print(f'動画 {start:.2f} 表示 {shown:.2f} 秒' + (f'（進み具合から {cast:.2f} 秒）' if cast else ''))
        return
    starts = {k: eval(v, {'__builtins__': {}}) for k, v in (p.split('=', 1) for p in args.phase)}
    used = set()
    for phase in ET.parse(args.timeline).getroot().iter('phase'):
        pid = phase.get('id')
        if pid not in starts:
            print(f'== {pid}（--phase が無いので飛ばす）')
            continue
        print(f'== {pid}')
        for e in phase.iter('entry'):
            if e.get('sync') == 'false' or not e.get('duration'):
                continue
            at = starts[pid] + float(e.get('t'))
            d = float(e.get('duration'))
            near = [b for b in bars if abs(b[0] - at) <= 1.5]
            if not near:
                print(f'  t={e.get("t"):>6} {e.get("castname")}  XML {d:.1f}  画面 測れず（動画 {at:.1f} 付近）')
                continue
            used.add(near[0])
            shown = near[0][1]
            mark = '' if abs(shown + 0.03 - d) < 0.25 else '  <<< 違う'
            print(f'  t={e.get("t"):>6} {e.get("castname")}  XML {d:.1f}  画面 {shown:.2f}（動画 {near[0][0]:.2f}）{mark}')
    rest = [b for b in bars if b not in used]
    if rest:
        print('== どの予定にも当たらないバー（途中で切れた・ほかの敵・フォーカスの切り替えなど）')
        for start, shown, _ in rest:
            print(f'  動画 {start:.2f} 表示 {shown:.2f} 秒')


if __name__ == '__main__':
    main()
