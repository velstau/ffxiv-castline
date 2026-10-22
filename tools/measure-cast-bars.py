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
   --phase は「フェーズの 0 秒が動画の何秒か」（引き算も書ける）。省略したフェーズは自動で合わせる
   （予定の詠唱開始とバーの出始めが最も多くそろう位置。フェーズの中では予定ごとにずれを合わせ直す）。
   --file を付けると、表（tools/cast-durations.tsv）に書く候補をその形で出す

測った長さは真の値より約 0.03 秒短く出る。同じ技を何回か測って値がそろうことを確かめてから表に書く。
"""
import argparse
import math
import statistics
import xml.etree.ElementTree as ET

FILL = (228, 248)  # 1704x720 の動画（クルーザー級2）で測った値。動画で違えば --fill・--empty で変える
EMPTY = (70, 110)
LEFT_SHARE = 0.32  # バーの幅のうち、技名の文字が重ならない左側の割合（125 画素のバーで 40 画素）
MATCH_S = 0.4  # フェーズの開始を決めるとき、バーの出始めと予定の詠唱開始を同じとみなす差
ALIGN_SHARE = 0.4  # フェーズの開始を採るのは、予定の詠唱開始がこの割合以上そろうときだけ（動画に無いフェーズが偶然合わないように）
FOLLOW_S = 1.5  # フェーズの中で、予定から何秒までのバーをその予定のものとみなすか（ずれは予定ごとに合わせ直す）


def segments(path, base, width, fps, fill_range=FILL, empty_range=EMPTY):
    data = open(path, 'rb').read()
    frame = width * 3
    left = range(2, round(width * LEFT_SHARE))
    found, cur = [], None
    for i in range(len(data) // frame):
        row = data[i * frame + width:i * frame + 2 * width]  # 中央の行
        cls = ''.join('F' if fill_range[0] <= row[x] <= fill_range[1] else 'E' if empty_range[0] <= row[x] <= empty_range[1] else '?' for x in left)
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


def align(phase_entries, bars, after):
    """フェーズの 0 秒が動画の何秒かを、予定の詠唱開始とバーの出始めが最も多くそろう位置で決める（after より後）。(秒, そろった数)"""
    best = (None, 0)
    for b in bars:
        if b[0] < after:
            continue
        for e in phase_entries[:8]:
            offset = b[0] - e[0]
            hits = sum(any(abs(x[0] - offset - t) <= MATCH_S for x in bars) for t, *_ in phase_entries)
            if hits > best[1]:
                best = (offset, hits)
    return best


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('raw', nargs='+', metavar='PATH:動画の秒')
    ap.add_argument('--width', type=int, default=125)
    ap.add_argument('--fps', type=float, default=60)
    ap.add_argument('--fill', default='228-248', help='塗りの明るさの範囲')
    ap.add_argument('--empty', default='70-110', help='空きの明るさの範囲')
    ap.add_argument('--timeline')
    ap.add_argument('--phase', action='append', default=[], metavar='フェーズID=動画の秒')
    ap.add_argument('--file', help='表に書く候補を出すときのファイル名（contents.json の file）')
    ap.add_argument('--verbose', action='store_true', help='予定ごとの照合を全部出す')
    args = ap.parse_args()
    rng = lambda text: tuple(int(v) for v in text.split('-'))
    bars = []
    for spec in args.raw:
        path, base = spec.rsplit(':', 1)
        bars += segments(path, float(base), args.width, args.fps, rng(args.fill), rng(args.empty))
    bars.sort()
    if not args.timeline:
        for start, shown, cast in bars:
            print(f'動画 {start:.2f} 表示 {shown:.2f} 秒' + (f'（進み具合から {cast:.2f} 秒）' if cast else ''))
        return
    given = {k: eval(v, {'__builtins__': {}}) for k, v in (p.split('=', 1) for p in args.phase)}
    used, measured, cursor = set(), {}, 0.0
    for phase in ET.parse(args.timeline).getroot().iter('phase'):
        pid = phase.get('id')
        entries = sorted((float(e.get('t')), e.get('castname'), float(e.get('duration')))
                         for e in phase.iter('entry') if e.get('sync') != 'false' and e.get('duration'))
        if not entries:
            continue
        if pid in given:
            offset, note = given[pid], '指定'
        else:
            offset, hits = align(entries, [b for b in bars if b not in used], cursor)
            if offset is None or hits < max(min(3, len(entries)), math.ceil(len(entries) * ALIGN_SHARE)):
                print(f'== {pid}: 動画の中で見つからない（そろった予定 {hits} 件）')
                continue
            note = f'自動、{len(entries)} 件中 {hits} 件そろう'
        print(f'== {pid}: 0 秒＝動画 {offset:.2f} 秒（{note}）')
        for t, name, d in entries:
            near = sorted((b for b in bars if b not in used and abs(b[0] - offset - t) <= FOLLOW_S), key=lambda b: abs(b[0] - offset - t))
            if not near:
                if args.verbose:
                    print(f'  t={t:6.1f} {name}  XML {d:.1f}  画面 測れず（動画 {offset + t:.1f} 付近）')
                continue
            b = near[0]
            used.add(b)
            offset = b[0] - t  # 予定ごとに合わせ直す
            cursor = b[0]
            measured.setdefault((name, d), []).append(b[1])
            if args.verbose:
                mark = '' if abs(b[1] + 0.03 - d) < 0.25 else '  <<< 違う'
                print(f'  t={t:6.1f} {name}  XML {d:.1f}  画面 {b[1]:.2f}（動画 {b[0]:.2f}）{mark}')
    print('== 技ごと（画面の値は、そろった測定値の中央値＋0.03 秒。途中で切れたバーは短く出るだけなので、XML より長い値は 1 回でも採る）')
    for (name, d), shown in sorted(measured.items()):
        shown = sorted(shown)
        cluster = max((sorted(x for x in shown if abs(x - v) <= 0.1) for v in shown), key=lambda c: (len(c), c[-1]))
        value = round(statistics.median(cluster) + 0.03, 1)
        if abs(value - d) < 0.25:
            status = '合う'
        elif value > d:
            status = '長い'
        else:
            status = '短い（途中で切れたバーの疑い・要確認）'
        print(f'  {status}: {name} XML {d:.1f} 画面 {value:.1f}（{len(cluster)}/{len(shown)} 回そろう: {" ".join(f"{v + 0.03:.2f}" for v in shown)}）')
        if args.file and status == '長い':
            print(f'TSV\t{args.file}\t{name}\t{d:.1f}\t{value:.1f}\t動画 {" ".join(f"{v + 0.03:.2f}" for v in cluster)} 秒')
    rest = [b for b in bars if b not in used]
    if rest:
        print(f'== どの予定にも当たらないバー {len(rest)} 本（途中で切れた・ほかの敵・フォーカスの切り替えなど）'
              + ''.join(f'\n  動画 {s:.2f} 表示 {d:.2f} 秒' for s, d, _ in rest[:20] if args.verbose))


if __name__ == '__main__':
    main()
