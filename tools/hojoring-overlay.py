#!/usr/bin/env python3
"""Hojoring 用タイムラインの文言（表示と読み上げ）を、FFLogs から作った Castline のタイムラインに重ねる。運営者が手元で使う。

Hojoring の時刻は技が当たった時刻（「Xの「Y」」のログ）なので、そのままでは詠唱バーでの同期に使えない。
詠唱の開始・長さ・フェーズは FFLogs から作った骨組み（tools/skeletons/）を正とし、Hojoring からは文言だけを取る。

- 照合の相手は FFLogs の同じ戦闘の全部の技（補助の敵も含む。tools/fflogs-events.py で抜き出した *.events.json）。
  Hojoring 本体と同じく、技が合うたびにずれを合わせ直す（記録した戦闘ごとにフェーズの進み方が違うため）。
  窓は Hojoring の sync-s / sync-e（既定は <default>）。区間の最初のずれは、同じ技名の差が最も多くそろう値
- 合った技が骨組みの予定（同名で、詠唱の終わりから AFTER_CAST_MAX 秒以内に当たったもの）なら、text を label、notice を tts として付ける。
  Hojoring で「(A|B)」と書かれた技は、骨組みの技名を「A|B」に広げる（ログには片方しか残らないため）
- 骨組みに無い技（補助の敵の技など）・台詞・ログ ID・バフで合わせているもの・同期なしの行は、
  その時刻に表示だけの予定（sync="false"）として足す
- 同期の目印だけの行（text が 同期 など）、<t> のトリガー、v-notice、icon は使わない（件数を報告する）

    python3 tools/hojoring-overlay.py tools/skeletons/heavy1.xml "sources/AAC_Heavyweight_M1_(Savage).xml" \\
        public/timelines/heavy1.xml --events p1=tools/skeletons/heavy1.events.json --author Vel --title "…"

元ファイル（sources/）は第三者の作を含むので公開しない（.gitignore）。出力の note に作者とライセンスを書く。
"""
import argparse
import json
import re
import statistics
import sys
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape, quoteattr

MIN_WINDOW = 3.0  # 照合の窓の最小（Hojoring の時刻は整数秒）
FALLBACK_WINDOW = 6.0  # Hojoring の窓で見つからないとき、FFLogs の技を探す広さ
LOOSE_WINDOW = 10.0  # FFLogs でも見つからない技を、同名の予定に付けてよい差
OFFSET_TOLERANCE = 1.5  # 区間の最初のずれの推定で「そろっている」とみなす差
SKELETON_TOLERANCE = 1.5  # FFLogs の技と骨組みの予定（詠唱開始＋詠唱時間）を同じものとみなす差
AFTER_CAST_MAX = 6.0  # 詠唱の終わりからこれ以内に当たった同名の技は、その詠唱の予定に付ける（2 撃目・遅れて当たる技）
SYNC_WINDOW_DEFAULT = 10  # Castline の既定の同期の窓（これより広い指定だけ window に移す）
MARKER_TEXTS = {'同期', '同期待ち', '開始待ち'}

HIT = re.compile(r'^(?P<who>[^:「」^]+?)の「(?P<what>.+)」$')
CAST = re.compile(r'^(?P<who>[^:「」^]+?)は「(?P<what>.+)」の構え。?$')
SAY = re.compile(r'^(?P<who>[^:「」^]+?):(?P<what>.+)$')


def expand(pattern):
    """「(アグリゲート|スプレッド)ソニック」のような入れ子の無い選択を、名前の一覧に広げる"""
    m = re.search(r'\(([^()]*)\)', pattern)
    if not m:
        return [pattern]
    out = []
    for alt in m.group(1).split('|'):
        out += expand(pattern[:m.start()] + alt + pattern[m.end():])
    return out


def classify(sync):
    """sync の文字列の種類: hit（技の発動）/ cast（詠唱開始）/ say（台詞）/ log（ログ ID・バフ）/ none"""
    if not sync:
        return 'none', []
    if sync.startswith('^'):
        return 'log', []
    for kind, rx in (('cast', CAST), ('hit', HIT)):
        m = rx.match(sync)
        if m:
            return kind, expand(m.group('what'))
    if SAY.match(sync):
        return 'say', []
    return 'log', []


def num(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def load_hojoring(path):
    root = ET.parse(path).getroot()
    meta = {k: (root.findtext(k) or '').strip() for k in ('name', 'author', 'license', 'rev')}
    defaults = {d.get('target-attr'): d.get('value') for d in root.findall('default')}
    dropped = {'trigger': [], 'v-notice': 0, 'icon': 0}

    def items(parent):
        out = []
        for a in parent.findall('a'):
            kind, names = classify(a.get('sync'))
            dropped['v-notice'] += len(a.findall('v-notice'))
            dropped['icon'] += 1 if a.get('icon') else 0
            out.append({
                'time': num(a.get('time'), 0.0),
                'text': (a.get('text') or '').strip(),
                'notice': (a.get('notice') or '').strip(),
                'sync': a.get('sync') or '',
                'kind': kind,
                'names': names,
                'sync_s': a.get('sync-s'),
                'sync_e': a.get('sync-e'),
            })
        for t in parent.findall('t'):
            if t.find('load') is None:
                dropped['trigger'].append(t.get('notice') or t.get('sync') or '')
        return out

    sections = []
    top = items(root)
    if top:
        sections.append({'name': '(最上位)', 'items': top})
    for s in root.findall('s'):
        sections.append({'name': s.get('name'), 'items': items(s)})
    return meta, defaults, sections, dropped


def load_skeleton(path):
    root = ET.parse(path).getroot()
    tl = {
        'attrs': dict(root.attrib),
        'note': (root.findtext('note') or '').strip(),
        'phases': [],
    }
    for p in root.findall('phase'):
        entries = []
        for e in p.findall('entry'):
            d = dict(e.attrib)
            d['_t'] = float(d['t'])
            d['_hit'] = d['_t'] + num(d.get('duration'), 0.0)
            entries.append(d)
        tl['phases'].append({'attrs': dict(p.attrib), 'entries': entries, 'next': [dict(n.attrib) for n in p.findall('next')]})
    return tl


def key_time(entry, kind):
    return entry['_t'] if kind == 'cast' else entry['_hit']


def same_name(entry, names):
    return any(n in names for n in entry['name'].split('|'))


def event_type(kind):
    return 'b' if kind == 'cast' else 'c'


def estimate_offset(items, events, min_offset):
    """同じ技名の組み合わせで、差が最も多くそろう値（同点なら小さいほう）。そろった差の中央値を返す"""
    pairs = []  # (Hojoring の行の番号, 差)
    for i, it in enumerate(items):
        if it['kind'] not in ('hit', 'cast'):
            continue
        for t, typ, name in events:
            if typ == event_type(it['kind']) and name in it['names'] and t - it['time'] >= min_offset - 5:
                pairs.append((i, t - it['time']))
    best = None
    for _, c in pairs:
        support = len({i for i, d in pairs if abs(d - c) <= OFFSET_TOLERANCE})
        if best is None or support > best[0] or (support == best[0] and c < best[1]):
            best = (support, c)
    if best is None:
        return None, 0
    return statistics.median(d for _, d in pairs if abs(d - best[1]) <= OFFSET_TOLERANCE), best[0]


def add_text(entry, key, value, sep):
    if not value:
        return
    parts = entry[key].split(sep) if entry.get(key) else []
    if value not in parts:
        parts.append(value)
    entry[key] = sep.join(parts)


def hojoring_window(it, defaults):
    """Hojoring の照合の窓（前, 後の秒）"""
    s = num(it['sync_s'] if it['sync_s'] is not None else defaults.get('sync-s'), -MIN_WINDOW)
    e = num(it['sync_e'] if it['sync_e'] is not None else defaults.get('sync-e'), MIN_WINDOW)
    return max(-s, MIN_WINDOW), max(e, MIN_WINDOW)


def castline_window(it):
    """Hojoring で明示した広い窓だけ、Castline の window に移す"""
    if it['sync_s'] is None and it['sync_e'] is None:
        return None
    before, after = max(-num(it['sync_s'], 0), SYNC_WINDOW_DEFAULT), max(num(it['sync_e'], 0), SYNC_WINDOW_DEFAULT)
    return None if before == after == SYNC_WINDOW_DEFAULT else f'{before:g} {after:g}'


def lookahead(items, events, defaults, offset, after_time, count=3):
    """続く count 行（技名のある行）のうち、ずれ offset で FFLogs の技が Hojoring の窓に入る行の数"""
    score = 0
    for it in [x for x in items if x['kind'] in ('hit', 'cast')][:count]:
        before, after = hojoring_window(it, defaults)
        target = it['time'] + offset
        types = ('b', 'c') if it['kind'] == 'cast' else ('c',)
        if any(e[1] in types and e[2] in it['names'] and target - before <= e[0] <= target + after and e[0] >= after_time - 0.5
               for e in events):
            score += 1
    return score


def overlay(skeleton, sections, defaults, phase_of, events_of, roles):
    report = []
    min_offsets = {}  # フェーズごとの、前の区間のずれ（区間は文書の順に進むとみなす）
    for sec in sections:
        phase_id = phase_of(sec['name'])
        phase = next((p for p in skeleton['phases'] if p['attrs']['id'] == phase_id), None)
        events = events_of(phase_id)
        if phase is None or events is None:
            report.append(f'区間 {sec["name"]}: フェーズ {phase_id} またはその技の一覧（--events）がありません。飛ばします')
            continue
        entries = phase['entries']
        offset, support = estimate_offset(sec['items'], events, min_offsets.get(phase_id, -1e9))
        if offset is None:
            report.append(f'区間 {sec["name"]}: 技名の合う技がなく、ずれを決められません。飛ばします')
            continue
        first_offset = min_offsets[phase_id] = offset
        used, last = set(), -1e9
        labeled, resyncs, wide, loose, inserted, missed = 0, [], [], [], [], []
        role, dropped_tts = roles.get(sec['name']), 0
        for idx, it in enumerate(sec['items']):
            label = '' if it['text'] in MARKER_TEXTS else it['text']
            notice = it['notice']
            if role:
                # 担当ごとの区間: どの担当でも同じ画面に出るので、表示に担当名を付け、読み上げはしない
                label = f'{role}: {label}' if label else ''
                dropped_tts += 1 if notice else 0
                notice = ''
            ev = None
            if it['kind'] in ('hit', 'cast'):
                before, after = hojoring_window(it, defaults)
                target = it['time'] + offset

                def find(types, before, after):
                    cands = [e for e in events if e[1] in types and e[2] in it['names']
                             and target - before <= e[0] <= target + after and e[0] >= last - 0.5]
                    return min(cands, key=lambda e: abs(e[0] - target), default=None)

                # 「構え」でも FFLogs に詠唱開始の記録が無い技（分身が使う技など）は、発動の記録で探す
                types = ['b', 'c'] if it['kind'] == 'cast' else ['c']
                ev = find(types[:1], before, after) or (find(types[1:], before, after) if len(types) > 1 else None)
                if ev is not None:
                    if abs(ev[0] - target) > 2:
                        resyncs.append(f'{it["time"]:g} {ev[2]} {ev[0] - target:+.1f}')
                    offset, last = ev[0] - it['time'], ev[0]
                else:
                    # Hojoring の窓の外でも近ければ文言を付ける（Hojoring を記録した戦闘と数秒ずれている所がある）
                    ev = find(types, FALLBACK_WINDOW, FALLBACK_WINDOW)
                    if ev is not None:
                        # 続く行がよく合うほうのずれを採る（Hojoring 側の時刻が外れている 1 行で全体を狂わせない）
                        rest = sec['items'][idx + 1:]
                        new_offset = ev[0] - it['time']
                        resync = lookahead(rest, events, defaults, new_offset, ev[0]) > lookahead(rest, events, defaults, offset, ev[0])
                        wide.append(f'{it["time"]:g} {ev[2]} {ev[0] - target:+.1f}{"（合わせ直す）" if resync else ""}')
                        if resync:
                            offset = new_offset
                        last = ev[0]
                    elif label or notice:
                        missed.append(f'{it["time"]:g} {"|".join(it["names"])}')
                kind = 'cast' if ev is not None and ev[1] == 'b' else 'hit'
            else:
                kind = it['kind']
            if not label and not notice:
                continue
            at = ev[0] if ev is not None else it['time'] + offset
            hit = None
            if ev is not None:
                cands = [e for e in entries if (id(e), kind) not in used and not e.get('_added') and same_name(e, it['names'])
                         and -SKELETON_TOLERANCE <= at - key_time(e, kind)
                         <= (AFTER_CAST_MAX if kind == 'hit' and num(e.get('duration'), 0) > 0 else SKELETON_TOLERANCE)]
                # 詠唱バーに出る予定（sync が false でない）を、後に続く詠唱なしの追撃より優先する
                hit = min(cands, key=lambda e: (e.get('sync') == 'false', abs(key_time(e, kind) - at)), default=None)
            elif it['names']:
                # FFLogs で見つからない技でも、同名の予定が近くにあればそれに付ける（同じ技の行を二重にしない）
                cands = [e for e in entries if (id(e), kind) not in used and not e.get('_added') and same_name(e, it['names'])
                         and abs(key_time(e, kind) - at) <= LOOSE_WINDOW]
                hit = min(cands, key=lambda e: (e.get('sync') == 'false', abs(key_time(e, kind) - at)), default=None)
                if hit is not None:
                    loose.append(f'{it["time"]:g} {"|".join(it["names"])} {key_time(hit, kind) - at:+.1f}')
            if hit is not None:
                used.add((id(hit), kind))  # 同じ詠唱の「構え」と発動は、どちらも同じ予定に付けてよい
                labeled += 1
                if len(it['names']) > 1:
                    names = hit['name'].split('|')
                    hit['name'] = '|'.join(it['names'] + [n for n in names if n not in it['names']])
                add_text(hit, 'label', label, ' / ')
                add_text(hit, 'tts', notice, '、')
                w = castline_window(it) if hit.get('sync') != 'false' else None
                if w and not hit.get('window'):
                    hit['window'] = w
                continue
            # 骨組みに無い: 表示だけの予定として足す
            name = '|'.join(it['names']) if it['names'] else label or notice
            new = {'t': f'{at:.1f}', 'name': name, 'sync': 'false', '_t': at, '_hit': at, '_added': True}
            if label and label != name:
                new['label'] = label
            if notice:
                new['tts'] = notice
            entries.append(new)
            inserted.append(f'{it["time"]:g}→{at:.1f} {name}（{it["kind"]}{"・FFLogs で確認" if ev else ""}）')
        entries.sort(key=lambda e: e['_t'])
        report.append(f'区間 {sec["name"]} → フェーズ {phase_id}: 最初のずれ {first_offset:+.1f} 秒（{support} 行がそろう）、'
                      f'骨組みに付けた {labeled} 行、表示だけで足した {len(inserted)} 行、FFLogs で見つからない {len(missed)} 行'
                      + (f'、担当「{role}」として読み上げを外した {dropped_tts} 行' if role else ''))
        report += [f'    合わせ直し（2 秒超）: {x}' for x in resyncs]
        report += [f'    広い窓で見つけた: {x}' for x in wide]
        report += [f'    FFLogs に無いが同名の予定に付けた: {x}' for x in loose]
        report += [f'    見つからない: {x}' for x in missed]
        report += [f'    足した: {x}' for x in inserted]
    return report


def write_castline(skeleton, path, title, note):
    a = dict(skeleton['attrs'])
    if title:
        a['title'] = title
    attr = lambda d, keys: ''.join(f' {k}={quoteattr(d[k])}' for k in keys if d.get(k) not in (None, ''))
    lines = ['<?xml version="1.0" encoding="utf-8"?>',
             f'<timeline{attr(a, ["format", "content", "title", "sync-window"])}>',
             f'  <note>{escape(note)}</note>']
    for p in skeleton['phases']:
        lines.append(f'  <phase{attr(p["attrs"], ["id", "name"])}>')
        for e in p['entries']:
            lines.append(f'    <entry{attr(e, ["t", "duration", "name", "label", "tts", "sync", "window"])}/>')
        for n in p['next']:
            lines.append(f'    <next{attr(n, ["to", "at", "cast", "hp", "time", "hp-lost"])}/>')
        lines.append('  </phase>')
    lines += ['</timeline>', '']
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('skeleton')
    ap.add_argument('hojoring')
    ap.add_argument('out')
    ap.add_argument('--author', help='note に書く作者（省略時は元ファイルの author）')
    ap.add_argument('--title')
    ap.add_argument('--events', action='append', default=[], metavar='フェーズID=PATH',
                    help='そのフェーズの FFLogs の技の一覧（tools/fflogs-events.py の出力）')
    ap.add_argument('--role', action='append', default=[], metavar='区間=担当名',
                    help='担当ごとの区間（例: RED=赤）。表示に担当名を付け、読み上げはしない')
    ap.add_argument('--phase', action='append', default=[], metavar='区間=フェーズID',
                    help='Hojoring の区間を骨組みのフェーズに対応させる（省略時は最初のフェーズ）')
    args = ap.parse_args()

    meta, defaults, sections, dropped = load_hojoring(args.hojoring)
    skeleton = load_skeleton(args.skeleton)
    mapping = dict(m.split('=', 1) for m in args.phase)
    first = skeleton['phases'][0]['attrs']['id']
    events = {}
    for spec in args.events:
        pid, path = spec.split('=', 1)
        with open(path, encoding='utf-8') as f:
            events[pid] = [tuple(e) for e in json.load(f)['events']]
    report = overlay(skeleton, sections, defaults, lambda name: mapping.get(name, first), events.get,
                     dict(r.split('=', 1) for r in args.role))

    author = args.author or meta['author']
    note = (f'{skeleton["note"]} 表示（label）と読み上げ（tts）の文言は、{author} さんの Hojoring 用タイムライン'
            f'「{meta["name"]}」{meta["rev"]}（{meta["license"]}）から取った。'
            f'表示だけの予定（sync="false"）には、補助の敵の技や台詞など、詠唱バーで合わせられないものも含む')
    write_castline(skeleton, args.out, args.title, note)

    for line in report:
        print(line)
    print(f'使わなかったもの: <t> のトリガー {len(dropped["trigger"])} 件（{" / ".join(dropped["trigger"])}）、'
          f'v-notice {dropped["v-notice"]} 件、icon {dropped["icon"]} 件')
    return 0


if __name__ == '__main__':
    sys.exit(main())
