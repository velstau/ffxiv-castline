#!/usr/bin/env python3
"""動画の詠唱バーの長さを測り、タイムラインの duration と比べる（運営者の手元の道具。tools/cast-durations.tsv の値を決めるため）。

FFLogs の詠唱時間は画面の詠唱バーの長さと違う技がある（2026-10-22 クルーザー級2 零式: ランドスケープ 0.7 秒・画面 7.7 秒）。
動画のフォーカス（無ければターゲット）の詠唱バーの横 1 行（高さ 3 画素、中央の行を使う）をコマごとに取り出し、左から続く塗りと
空きでバーの有無と進み具合を見る。技名の文字はバーの右側に重なるので、左側（--left、既定 32%）だけを使う。
使うのは、塗りが一定の速さで伸び、その速さから出した詠唱時間と出ていた長さが合うバーだけ（消えた後の暗い背景・途中で切れたバーを落とす）。

1. バーの位置（左端 x・幅・塗りの行 y）を拡大画像で決め、塗りと空きの明るさを 1 コマずつ見て --fill・--empty を決める（動画ごとに違う）
2. 行を取り出す（120 秒ずつ。長い動画を 1 回で取り出すと途中で切れたことがある）:
     ffmpeg -ss 0 -t 120 -i 動画.mp4 -vf "crop=幅:3:左端:y-1,format=gray" -f rawvideo seg0.raw
3. 予定とバーを対応させて書き出す:
     python3 tools/measure-cast-bars.py seg0.raw:0 seg120.raw:120 … --width 幅 --fill … --empty … --fps 60 \\
         --timeline public/timelines/x.xml --dump dump.json
   フェーズの 0 秒は自動で合わせる（予定の詠唱開始とバーの出始めが 4 割以上そろう位置。フェーズの中では予定ごとに合わせ直す）。
   合わないときは --phase フェーズID=動画の秒（引き算も書ける）で指定する
4. 技名を OCR で確かめる（時刻だけでは、近くに出たほかの技のバーを取り違える）: tools/cast-name-check.sh
5. 確かめたバーだけで集計する: 3 と同じ引数に --checked checked.json --file <file> を付ける。「TSV」で始まる行が表の候補

画面の値は、そろった測定値の中央値＋0.03 秒（測った値は真の値より約 0.03 秒短く出る）。表に書くのは XML より長い値だけ
（短い値は、バーが途中で切れた疑いを消せない）。2 回以上そろった値か、1 回でも予定の時刻と 0.4 秒以内で合ったもの。
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
FOLLOW_S = 1.0  # フェーズの中で、予定から何秒までのバーをその予定のものとみなすか（ずれは予定ごとに合わせ直す）


def segments(path, base, width, fps, fill_range=FILL, empty_range=EMPTY):
    """バーの区間 (出始め, 出ていた秒, 塗りの速さから出した詠唱秒, 使えるか) の一覧。
    使えるのは、塗りが出始めから一定の速さで伸び、その速さから出した詠唱時間と出ていた長さが合う区間だけ。
    バーが消えた後の暗い背景（塗りの無いバーに見える）・途中で切れたバー・ほかのバーとのつながりを落とすため"""
    data = open(path, 'rb').read()
    frame = width * 3
    left = range(2, round(width * LEFT_SHARE))
    found, cur, last_fill = [], None, 0
    for i in range(len(data) // frame):
        row = data[i * frame + width:i * frame + 2 * width]  # 中央の行
        cls = ''.join('F' if fill_range[0] <= row[x] <= fill_range[1] else 'E' if empty_range[0] <= row[x] <= empty_range[1] else '?' for x in left)
        fill = len(cls) - len(cls.lstrip('F'))
        t = base + i / fps
        ok = cls.count('?') <= 2 and cls[fill:].count('F') <= 2
        if ok and cur is not None and fill < last_fill - 3:
            found.append(cur)  # 塗りが戻った＝別のバー（または消えた後の背景）
            cur = None
        if ok:
            if cur is None:
                cur = [t, t, []]
            cur[1] = t
            cur[2].append((t, (fill + 2) / (width - 2)))
            last_fill = fill
        elif cur is not None and t - cur[1] > 0.25:
            found.append(cur)
            cur, last_fill = None, 0
    if cur:
        found.append(cur)
    out = []
    for start, end, pts in found:
        while pts and pts[-1][1] <= 0.02:  # 終わりの塗りの無いコマ（消えた後の背景）は数えない
            pts.pop()
        if not pts or pts[-1][0] - start < 0.5:
            continue
        end = pts[-1][0]
        top = LEFT_SHARE * 0.95
        mid = [(t, f) for t, f in pts if 0.03 < f < top]
        cast, good = None, False
        if len(mid) >= 8:
            mt = sum(t for t, _ in mid) / len(mid)
            mf = sum(f for _, f in mid) / len(mid)
            k = sum((t - mt) * (f - mf) for t, f in mid) / sum((t - mt) ** 2 for t, _ in mid)
            if k > 0:
                cast = 1 / k
                t0 = mt - mf / k
                resid = (sum((f - k * (t - t0)) ** 2 for t, f in mid) / len(mid)) ** 0.5
                shown = end - start
                good = abs(t0 - start) <= 0.25 and resid <= 0.03 and abs(shown - cast) <= max(0.35, 0.07 * shown)
        out.append((start, end - start, cast, good))
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
    ap.add_argument('--left', type=float, default=LEFT_SHARE, help='バーの幅のうち、技名の文字が重ならない左側の割合')
    ap.add_argument('--timeline')
    ap.add_argument('--phase', action='append', default=[], metavar='フェーズID=動画の秒')
    ap.add_argument('--file', help='表に書く候補を出すときのファイル名（contents.json の file）')
    ap.add_argument('--dump', help='予定とバーの対応を JSON で書き出す（技名の確かめ tools/cast-name-check.py に渡す）')
    ap.add_argument('--checked', help='技名を確かめた結果（cast-name-check.py の出力）。確かめられたバーだけで集計する')
    ap.add_argument('--verbose', action='store_true', help='予定ごとの照合を全部出す')
    args = ap.parse_args()
    globals()['LEFT_SHARE'] = args.left
    rng = lambda text: tuple(int(v) for v in text.split('-'))
    bars = []
    for spec in args.raw:
        path, base = spec.rsplit(':', 1)
        bars += segments(path, float(base), args.width, args.fps, rng(args.fill), rng(args.empty))
    every = sorted(bars)
    bars = [b for b in every if b[3]]  # 使えるバーだけで合わせる
    if not args.timeline:
        for start, shown, cast, good in every:
            print(f'動画 {start:.2f} 表示 {shown:.2f} 秒' + (f'（進み具合から {cast:.2f} 秒）' if cast else '') + ('' if good else ' ×'))
        return
    given = {k: eval(v, {'__builtins__': {}}) for k, v in (p.split('=', 1) for p in args.phase)}
    used, measured, cursor, dump = set(), {}, 0.0, []
    checked = None
    if args.checked:
        import json
        checked = {round(m['start'], 2) for m in json.load(open(args.checked, encoding='utf-8')) if m['ok']}
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
            offset_before = offset
            used.add(b)
            offset = b[0] - t  # 予定ごとに合わせ直す
            cursor = b[0]
            dump.append({'phase': pid, 't': t, 'name': name, 'duration': d, 'start': round(b[0], 2), 'shown': round(b[1], 2)})
            if checked is None or round(b[0], 2) in checked:
                measured.setdefault((name, d), []).append((b[1], abs(b[0] - (offset_before + t))))
            if args.verbose:
                mark = '' if abs(b[1] + 0.03 - d) < 0.25 else '  <<< 違う'
                print(f'  t={t:6.1f} {name}  XML {d:.1f}  画面 {b[1]:.2f}（動画 {b[0]:.2f}）{mark}')
    if args.dump:
        import json
        json.dump(dump, open(args.dump, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print('== 技ごと（画面の値は、そろった測定値の中央値＋0.03 秒。途中で切れたバーは短く出るだけなので、XML より長い値は 1 回でも採る）')
    for (name, d), got in sorted(measured.items()):
        shown = sorted(v for v, _ in got)
        cluster = max((sorted(x for x in shown if abs(x - v) <= 0.1) for v in shown), key=lambda c: (len(c), -abs(statistics.median(c) + 0.03 - d)))  # 同じ回数なら XML に近いほう
        value = round(statistics.median(cluster) + 0.03, 1)
        exact = min(gap for v, gap in got if v in cluster)
        if abs(value - d) < 0.25:
            status = '合う'
        elif len(cluster) >= 2 or exact <= 0.4:
            status = '長い' if value > d else '短い'
        else:
            status = '違う（1 回だけで時刻も離れている・要確認）'
        print(f'  {status}: {name} XML {d:.1f} 画面 {value:.1f}（{len(cluster)}/{len(shown)} 回そろう: {" ".join(f"{v + 0.03:.2f}" for v in shown)}、時刻の差 {exact:.2f} 秒）')
        if args.file and status in ('長い', '短い'):
            print(f'TSV\t{args.file}\t{name}\t{d:.1f}\t{value:.1f}\t動画 {" ".join(f"{v + 0.03:.2f}" for v in cluster)} 秒')
    rest = [b for b in bars if b not in used]
    if rest:
        print(f'== どの予定にも当たらないバー {len(rest)} 本（途中で切れた・ほかの敵・フォーカスの切り替えなど）'
              + ''.join(f'\n  動画 {s:.2f} 表示 {d:.2f} 秒' for s, d, *_ in rest[:20] if args.verbose))


if __name__ == '__main__':
    main()
