#!/usr/bin/env python3
"""Hojoring 用タイムラインの文言（表示と読み上げ）を、FFLogs から作った Castline のタイムラインに重ねる。運営者が手元で使う。

Hojoring の時刻は技が当たった時刻（「Xの「Y」」のログ）なので、そのままでは詠唱バーでの同期に使えない。
詠唱の開始・長さ・フェーズは FFLogs から作った骨組み（tools/skeletons/）を正とし、Hojoring からは文言だけを取る。

- 照合の相手は FFLogs の同じ戦闘の全部の技（補助の敵も含む。tools/fflogs-events.py で抜き出した *.events.json）。
  Hojoring 本体と同じく、技が合うたびにずれを合わせ直す（記録した戦闘ごとにフェーズの進み方が違うため）。
  窓は Hojoring の sync-s / sync-e（既定は <default>）。区間の最初のずれは、同じ技名の差が最も多くそろう値
- 合った技が骨組みの予定（同名で、詠唱の終わりから AFTER_CAST_MAX 秒以内に当たったもの）なら、text を text（表示だけ）、notice を tts として付ける。
  Hojoring と同じく読み上げるのは notice だけ。notice の無い予定と、「@」の入った notice（Hojoring の置き換えの印）には tts を書かない
  Hojoring で「(A|B)」と書かれた技は、骨組みの技名を「A|B」に広げる（ログには片方しか残らないため）
- 骨組みに無い技（補助の敵の技など）・台詞・ログ ID・バフで合わせているもの・同期なしの行は、
  その時刻に表示だけの予定（sync="false"）として足す
- 同期の目印だけの行（text が 同期 など）、<t> のトリガー、v-notice、icon は使わない（件数を報告する）

    python3 tools/hojoring-overlay.py tools/skeletons/aac-heavyweight-m1-savage.xml "sources/AAC_Heavyweight_M1_(Savage).xml" \\
        public/timelines/aac-heavyweight-m1-savage.xml --events p1=tools/skeletons/aac-heavyweight-m1-savage.events.json --title "…"

元ファイル（sources/）は第三者の作を含むので公開しない（.gitignore）。
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
ROLE_MERGE_S = 1.0  # 担当ごとの同じ行を 1 つにまとめる時刻の差（担当ごとの区間のずれの差）
SKELETON_TOLERANCE = 1.5  # FFLogs の技と骨組みの予定（詠唱開始＋詠唱時間）を同じものとみなす差
AFTER_CAST_MAX = 6.0  # 詠唱の終わりからこれ以内に当たった同名の技は、その詠唱の予定に付ける（2 撃目・遅れて当たる技）
JUMP_MIN_SUPPORT = 2  # 窓の外へ合わせ直すのは、続く 3 行のうちこれだけそろうとき
SYNC_WINDOW_DEFAULT = 10  # Castline の既定の同期の窓（これより広い指定だけ window に移す）
ENTRY_ORDER = ["t", "text", "castname", "duration", "sync", "tts", "window", "gimmick_icon", "skills_icon"]  # timeline-xml.js の toTimelineXml と同じ順
MARKER_TEXTS = {'同期', '同期待ち', '開始待ち'}
# 台詞・分岐の目印で、画面に出しても意味の無い text（2026-10-27 のユーザーの了承。「セリフ1」「同期(車両2)」「シェア用タイムライン」など）
MARKER_PATTERN = re.compile(r'^(セリフ(技)?\d*|.+のセリフ|同期待ち\d*|強制同期|同期\(.+\)|.+用タイムライン|.+フェーズへ)$')
RAZOR_ROLES = {'TANK': 'タンク', 'HEALER': 'ヒーラー', 'DPS': 'DPS'}


def razor_role(line):
    """「@if (Model.Player.InRole("DPS", "HEALER")) {」「@if (Model.Player.InJob("PLD")) {」の条件を担当名（DPS・ヒーラー、PLD）にする"""
    names = re.findall(r'"([^"]+)"', line)
    return '・'.join(RAZOR_ROLES.get(n.upper(), n) for n in names) or '条件付き'

HIT = re.compile(r'^(?P<who>[^:「」^]+?)の「(?P<what>.+)」$')
CAST = re.compile(r'^(?P<who>[^:「」^]+?)は「(?P<what>.+)」の構え。?$')
# 魔法の詠唱開始（「ウォーリア・オブ・ライトは「五連魔」を唱えた。」。話者の無い「「サンダガ」を唱えた」も。2026-10-28）
CAST_SPELL = re.compile(r'^(?:(?P<who>[^:「」^]+?)は)?「(?P<what>[^」]+)」を唱えた。?$')
SPELL_SYNC = True  # --no-spell-sync で、「唱えた」を前のように同期に使わない
SAY = re.compile(r'^(?P<who>[^:「」^]+?):(?P<what>.+)$')
# 古い書き方（ACT のログの行そのもの）: 「ボス名:[0-9A-F]{4}:技名」は技の発動、「ボス名 starts using 技名 on 対象.」は詠唱開始
HIT_ID = re.compile(r'^(?P<who>[^:「」^]+?):\[0-9A-F\]\{4\}:(?P<what>[^:]+)$')
CAST_EN = re.compile(r'^(?P<who>[^:「」^]+?) starts using (?P<what>.+?)(?: on .*)?\.?$')
# 技名の後ろだけの書き方（「インプロージョン」の構え」で、ホリゾンタル・ヴァーティカルの両方に当てる）。名前は頭に * を付けて返し、infer_names で技名にする
CAST_TAIL = re.compile(r'^(?P<what>[^:「」^]+)」の構え。?$')
# 技名の前だけの書き方（「イフリートの「フレイムクラッ」）。名前は後ろに * を付けて返す
HIT_HEAD = re.compile(r'^(?P<who>[^:「」^]+?)の「(?P<what>[^」]+)$')


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
    for kind, rx in (('cast', CAST), ('cast', CAST_SPELL if SPELL_SYNC else None), ('hit', HIT), ('hit', HIT_ID), ('cast', CAST_EN)):
        if rx is None:
            continue
        m = rx.match(sync)
        if m:
            return kind, expand(m.group('what'))
    m = CAST_TAIL.match(sync)
    if m:
        return 'cast', ['*' + n for n in expand(m.group('what'))]
    m = HIT_HEAD.match(sync)
    if m:
        return 'hit', [n + '*' for n in expand(m.group('what'))]
    if SAY.match(sync):
        return 'say', []
    return 'log', []


def num(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


RAZOR_IF = re.compile(r'^\s*@if\b.*\{\s*$')
RAZOR_ELSE = re.compile(r'^\s*\}\s*else(\s+if\b.*)?\s*\{\s*$')
RAZOR_CLOSE = re.compile(r'^\s*\}\s*$')
RAZOR_ASSIGN = re.compile(r'^\s*(?:var\s+|int\s+|double\s+)?([A-Za-z_]\w*)\s*=\s*([^;]+);')
SAFE_EXPR = re.compile(r'^[\w\s.+\-*/()]+$')


def razor_eval(expr, variables):
    """数と変数と四則演算だけの式を計算する（それ以外は None）"""
    expr = expr.strip()
    if not SAFE_EXPR.match(expr):
        return None
    names = set(re.findall(r'[A-Za-z_]\w*', expr))
    if not names <= set(variables):
        return None
    try:
        return float(eval(expr, {'__builtins__': {}}, dict(variables)))  # 文字の種類を絞った式だけ
    except Exception:
        return None


def balanced(text, start, open_ch, close_ch):
    """text[start] の open_ch に対応する close_ch の位置"""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == open_ch:
            depth += 1
        elif text[i] == close_ch:
            depth -= 1
            if depth == 0:
                return i
    return len(text) - 1


def strip_razor(text):
    """Hojoring の Razor（C#）の書き方を、XML として読める形にする。
    @{ … } のコードは取り除き、その中の「変数 = 数式;」だけを覚える。@( … ) は覚えた変数で計算して数に置き換える（できなければ空）。
    @if / else の行は取り除き、中身は両方残す（中は担当ごとのトリガー <t> がほとんどで、使わない。予定 <a> には担当名を付ける）"""
    text = re.sub(r'@\*.*?\*@', '', text, flags=re.S)
    # ロール・ジョブの条件（InRole・InJob）は、その位置に <castline-if role="担当名"/> を置いて残す（load_hojoring が表示に担当名を付ける）
    lines, conds = [], []
    mark = lambda: '<castline-if role=' + quoteattr(conds[-1] if conds else '') + '/>'
    for line in text.split('\n'):
        if RAZOR_IF.match(line):
            conds.append(razor_role(line))
            lines.append(mark())
            continue
        if conds and RAZOR_ELSE.match(line):
            conds[-1] = razor_role(line) if re.search(r'\bif\b', line) else 'その他'
            lines.append(mark())
            continue
        if conds and RAZOR_CLOSE.match(line):
            conds.pop()
            lines.append(mark())
            continue
        lines.append(line)
    text = '\n'.join(lines)
    out, variables, i = [], {}, 0
    while True:
        j = text.find('@', i)
        if j < 0 or j + 1 >= len(text):
            out.append(text[i:])
            break
        out.append(text[i:j])
        nxt = text[j + 1]
        if nxt == '{':
            end = balanced(text, j + 1, '{', '}')
            for stmt in re.split(r'[;\n]', text[j + 2:end]):
                m = RAZOR_ASSIGN.match(stmt + ';')
                if m:
                    value = razor_eval(m.group(2), variables)
                    if value is not None:
                        variables[m.group(1)] = value
            i = end + 1
        elif nxt == '(':
            end = balanced(text, j + 1, '(', ')')
            value = razor_eval(text[j + 2:end], variables)
            out.append('' if value is None else f'{value:g}')
            i = end + 1
        else:
            out.append('@')
            i = j + 1
    return ''.join(out)


def parse_hojoring(path):
    with open(path, encoding='utf-8-sig') as f:
        return ET.fromstring(strip_razor(f.read()))


def hojoring_length(path):
    """Hojoring の長さのめやす（秒）。区間の時刻は区間ごとなので、各区間の最後の時刻を足す"""
    root = parse_hojoring(path)
    last = lambda el: max([num(a.get('time'), 0.0) for a in el.findall('a')] or [0.0])
    return last(root) + sum(last(s) for s in root.findall('s'))


def load_hojoring(path):
    root = parse_hojoring(path)
    meta = {k: (root.findtext(k) or '').strip() for k in ('name', 'author', 'license', 'rev')}
    defaults = {d.get('target-attr'): d.get('value') for d in root.findall('default')}
    dropped = {'trigger': [], 'v-notice': 0, 'icon': 0}

    def items(parent):
        out = []
        cond = None  # いまのロール・ジョブの条件（strip_razor が置いた <castline-if>）
        for child in parent:
            if child.tag == 'castline-if':
                cond = child.get('role') or None
                continue
            if child.tag != 'a':
                continue
            a = child
            kind, names = classify(a.get('sync'))
            dropped['v-notice'] += len(a.findall('v-notice'))
            dropped['icon'] += 1 if a.get('icon') else 0
            out.append({
                'cond_role': cond,
                # <pre> は Hojoring の変数（トリガーで決まるデバフなど）の条件。Castline では判定できない
                'conditional': a.find('expressions/pre') is not None,
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
        # 先頭の情報は 1 行ずつの子要素
        'head': {k: (root.findtext(k) or '').strip() for k in ('format', 'content', 'title', 'sync-window')},
        'note': (root.findtext('note') or '').strip(),
        'phases': [],
    }
    for p in root.findall('phase'):
        entries = []
        for e in p.findall('entry'):
            d = dict(e.attrib)
            # XML の castname・text を、この道具の中では name・label として扱う
            d['name'] = d.pop('castname', '')
            if 'text' in d:
                d['label'] = d.pop('text')
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


def join_phases(skeleton, fid, starts):
    """戦闘のフェーズを通しの 1 つ（id は戦闘 ID）にまとめる。予定の時刻は戦闘の始まりからの秒にする（split_phases で戻す）"""
    members = []
    entries = []
    for p in skeleton['phases']:
        start = starts.get(p['attrs']['id'])
        if start is None:
            continue
        for e in p['entries']:
            e['_t'] += start
            e['_hit'] += start
        members.append((start, p))
        entries += p['entries']
    whole = {'attrs': {'id': fid}, 'entries': sorted(entries, key=lambda e: e['_t']), 'next': [], '_members': sorted(members, key=lambda m: m[0])}
    skeleton['phases'].append(whole)
    return whole


def split_phases(skeleton, fid):
    """join_phases でまとめたものを、元のフェーズに戻す。足した予定は、その時刻のフェーズへ"""
    whole = next(p for p in skeleton['phases'] if p['attrs']['id'] == fid)
    skeleton['phases'].remove(whole)
    members = whole['_members']
    for start, p in members:
        p['entries'] = []
    for e in whole['entries']:
        start, p = members[0]
        for m in members:
            if e['_t'] >= m[0]:
                start, p = m
        e['_t'] -= start
        e['_hit'] -= start
        p['entries'].append(e)


TEXT_SPLIT = re.compile(r'[+＋/／()（）【】「」\s]')


def infer_names(sections, names):
    """同期の指定（sync）が無い行で、表示の文言に技名があれば、その技の発動で合わせる。
    技名の後ろだけ・前だけの同期（classify の * 付きの名前）は、その後ろで終わる・前で始まる技名すべてにする"""
    part = lambda n, m: m.endswith(n[1:]) if n.startswith('*') else m.startswith(n[:-1]) if n.endswith('*') else m == n
    for sec in sections:
        for it in sec['items']:
            if any(n.startswith('*') or n.endswith('*') for n in it['names']):
                it['names'] = sorted({m for n in it['names'] for m in names if part(n, m)}) or [n.strip('*') for n in it['names']]
            if it['kind'] != 'none' or not it['text']:
                continue
            found = [w for w in TEXT_SPLIT.split(it['text']) if w in names]
            if found:
                it['kind'], it['names'] = 'hit', found[:1]


AUTO_MIN_SUPPORT = 2  # 自動の対応づけで、そろう行がこれ未満の区間は使わない


def auto_phases(sections, events):
    """区間ごとに、ずれの推定で最も多くの行がそろうフェーズ（同点なら前のフェーズ）"""
    out = {}
    for sec in sections:
        best = (0, 'none')
        for pid, evs in events.items():
            _, support = estimate_offset(sec['items'], evs, -1e9)
            if support > best[0]:
                best = (support, pid)
        out[sec['name']] = best[1] if best[0] >= AUTO_MIN_SUPPORT else 'none'
    return out


def overlay(skeleton, sections, defaults, phase_of, events_of, roles, any_order={}):
    report = []
    min_offsets = {}  # フェーズごとの、前の区間のずれ（区間は文書の順に進むとみなす）
    used_roles = set()  # 表示に付けた担当名（--role とロールの条件）
    section_ends = {}  # フェーズごとの、前の区間の終わり（--any-order の区間のずれの下限）
    for sec in sections:
        phase_id = phase_of(sec['name'])
        phase = next((p for p in skeleton['phases'] if p['attrs']['id'] == phase_id), None)
        events = events_of(phase_id)
        if phase is None or events is None:
            report.append(f'区間 {sec["name"]}: フェーズ {phase_id} またはその技の一覧（--events）がありません。飛ばします')
            continue
        entries = phase['entries']
        # どの順にも来る区間は、直前の（順に進む）区間の終わりより後にある。下限の秒の指定（TYPE C@200）があればそれ
        if sec['name'] in any_order:
            low = section_ends.get(phase_id, -1e9) if any_order[sec['name']] is None else any_order[sec['name']]
        else:
            low = min_offsets.get(phase_id, -1e9)
        offset, support = estimate_offset(sec['items'], events, low)
        if offset is None:
            report.append(f'区間 {sec["name"]}: 技名の合う技がなく、ずれを決められません。飛ばします')
            continue
        first_offset = offset
        if sec['name'] not in any_order:
            # どの順にも来る区間（--any-order）は、後の区間のずれの下限にしない（絶アルテマのラスト 3 体は文書の順と討伐の順が違う）
            min_offsets[phase_id] = offset
        used, last = set(), -1e9
        labeled, resyncs, wide, loose, inserted, missed, jumped = 0, [], [], [], [], [], []
        sec_roles, dropped_tts, conditional = roles.get(sec['name'], []), 0, 0
        for idx, it in enumerate(sec['items']):
            label = '' if it['text'] in MARKER_TEXTS or MARKER_PATTERN.match(it['text']) else it['text']
            notice = it['notice']
            role, variant = next(((r, v) for start, r, v in reversed(sec_roles) if it['time'] >= start), (None, False))
            role = it['cond_role'] or role
            role_info = None
            if role:
                # 担当ごとの区間・ロールの条件の行: どの担当でも同じ画面に出るので、表示に担当名を付け、読み上げはしない。
                # ロールの条件の行は読み上げの文（「右上えー」など向きの指示）が要なので、表示に添える
                used_roles.add(role)
                said = f'（{notice}）' if it['cond_role'] and label and notice and notice != label else ''
                # 全担当で同じ文言・読み上げの行は、後で担当名を外して 1 つにする（collapse_roles）。そのための元の文言と読み上げ
                if not said and label and notice and squash(notice) not in squash(label) and squash(label) not in squash(notice):
                    said = f'（{notice}）'  # 読み上げの文が表示と違う指示なら、読み上げない代わりに表示に添える（絶バハ P5 の「散開。」）
                role_info = None if it['cond_role'] else (role, f'{role}: {label or notice}{said}', label or notice, notice)
                variant = variant and not it['cond_role']
                label = f'{role}: {label or notice}{said}' if label or notice else ''
                dropped_tts += 1 if notice else 0
                conditional += 1 if it['cond_role'] else 0
                notice = ''
            elif it['conditional']:
                # 変数の条件の行（絶アレキの雷・水デバフ、絶アルテマの誘導の向きなど）: どれに当たるか分からないので、読み上げずに表示する。
                # text は「次の誘導3」のような目印のことが多いので、指示である読み上げの文を表示にする
                label = notice or label
                conditional += 1
                notice = ''
            ev = None
            # 型（--variant）の行は、詠唱バーに出る技（詠唱開始の記録）でだけ合わせる。詠唱の無い技は型によって順が違い、
            # この討伐の別の型の技に合うとずれる（絶バハ P5 のルナダイナモとレイヴンダイブ）。担当（--role）はボスの技が同じなので合わせる
            if it['kind'] == 'cast' or (it['kind'] == 'hit' and not variant):
                before, after = hojoring_window(it, defaults)
                target = it['time'] + offset

                def find(types, before, after):
                    cands = [e for e in events if e[1] in types and e[2] in it['names']
                             and target - before <= e[0] <= target + after and e[0] >= last - 0.5]
                    return min(cands, key=lambda e: abs(e[0] - target), default=None)

                # 「構え」でも FFLogs に詠唱開始の記録が無い技（分身が使う技など）は、発動の記録で探す
                types = ['b'] if variant else ['b', 'c'] if it['kind'] == 'cast' else ['c']
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
                    else:
                        # 記録した戦闘が技のまとまりを飛ばした・順番が違うとき: 窓の外の同名の技で、続く行がそろうなら、そこへ合わせ直す
                        rest = sec['items'][idx + 1:]
                        here = lookahead(rest, events, defaults, offset, last)
                        # 詠唱開始の行は、後の行が今のずれのまま合う技へは飛ばない（極アビサルフラクチャー: この討伐に無い 349 秒の
                        # フレアスパークの予告が、426 秒の行の詠唱へ飛んでいた。2026-10-28）。発動の行は前のまま（絶バハのプラメット）
                        later = lambda e: it['kind'] == 'cast' and any(r['kind'] in ('hit', 'cast') and e[2] in r['names'] and e[1] == event_type(r['kind'])
                                              and abs(r['time'] + offset - e[0]) <= FALLBACK_WINDOW for r in rest)
                        jumps = [(lookahead(rest, events, defaults, e[0] - it['time'], e[0]), e) for e in events
                                 if e[1] in types and e[2] in it['names'] and e[0] >= last - 0.5 and not later(e)]
                        score, ev = max(jumps, key=lambda j: (j[0], -abs(j[1][0] - target)), default=(0, None))
                        if ev is not None and score >= JUMP_MIN_SUPPORT and score > here:
                            jumped.append(f'{it["time"]:g} {ev[2]} {ev[0] - target:+.1f}')
                            offset, last = ev[0] - it['time'], ev[0]
                        else:
                            ev = None
                            if label or notice:
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
            if hit is not None and variant and hit.get('sync') == 'false':
                # 型ごとの区間の、詠唱の無い技: 型によって順が違う（絶バハ P5 のルナダイナモとレイヴンダイブ）ので、
                # この討伐の時刻に合わせず元ファイルの時刻で足し、担当名の無い元の予定は外す
                hit['_shadowed'] = True
                hit, at = None, it['time'] + offset
            if hit is not None:
                used.add((id(hit), kind))  # 同じ詠唱の「構え」と発動は、どちらも同じ予定に付けてよい
                labeled += 1
                if len(it['names']) > 1:
                    names = hit['name'].split('|')
                    hit['name'] = '|'.join(it['names'] + [n for n in names if n not in it['names']])
                add_text(hit, 'label', label, ' / ')
                if role_info:
                    hit.setdefault('_roles', {})[role_info[0]] = role_info[1:]
                hit.setdefault('_notices', [])
                if notice and notice not in hit['_notices']:
                    hit['_notices'].append(notice)
                w = castline_window(it) if hit.get('sync') != 'false' else None
                if w and not hit.get('window'):
                    hit['window'] = w
                continue
            # 骨組みに無い: 表示だけの予定として足す
            name = '|'.join(it['names']) if it['names'] else label or notice
            new = {'t': f'{at:.1f}', 'name': name, 'sync': 'false', '_t': at, '_hit': at, '_added': True}
            if label and label != name:
                new['label'] = label
            new['_notices'] = [notice] if notice else []
            new['_no_name'] = not it['names']  # 技名が無い（台詞・同期なしの行）
            new['_sec'] = sec['name']  # --split で区間ごとのフェーズに振り分ける
            if role_info:
                new['_roles'] = {role_info[0]: role_info[1:]}
            entries.append(new)
            inserted.append(f'{it["time"]:g}→{at:.1f} {name}（{it["kind"]}{"・FFLogs で確認" if ev else ""}）')
        entries.sort(key=lambda e: e['_t'])
        if sec['name'] not in any_order:
            # 区間の終わりは、最後に合わせ直したずれで（Hojoring の時刻と討伐が数秒ずれていく区間がある。極ヴァリガルマンダ P3T は 8.6 秒）
            section_ends[phase_id] = offset + max((it['time'] for it in sec['items']), default=0.0)
        report.append(f'区間 {sec["name"]} → フェーズ {phase_id}: 最初のずれ {first_offset:+.1f} 秒（{support} 行がそろう）、'
                      f'骨組みに付けた {labeled} 行、表示だけで足した {len(inserted)} 行、FFLogs で見つからない {len(missed)} 行'
                      + (f'、担当「{"・".join(r for _, r, _ in sec_roles)}」として読み上げを外した {dropped_tts} 行' if sec_roles else '')
                      + (f'、条件付き（ロール・デバフ）で表示だけにした {conditional} 行' if conditional else ''))
        report += [f'    合わせ直し（2 秒超）: {x}' for x in resyncs]
        report += [f'    広い窓で見つけた: {x}' for x in wide]
        report += [f'    離れた所で合わせ直した: {x}' for x in jumped]
        report += [f'    FFLogs に無いが同名の予定に付けた: {x}' for x in loose]
        report += [f'    見つからない: {x}' for x in missed]
        report += [f'    足した: {x}' for x in inserted]
    # 読み上げは Hojoring と同じく notice だけ。text は表示だけに使う。
    # 再生画面は tts に文がある予定だけ読む（2026-10-21 のユーザーの指定）ので、読まない予定には tts を書かない（2026-10-27 のユーザーの指定）。
    # 「@ANTI_KNOCKBACK」のような Hojoring の置き換えの印が入った notice は、そのまま読むと意味が通らないので使わない（同日のユーザーの指定）
    # 担当ごとの区間の文言がどの担当でも同じなら（絶オメガ P3 の「アクション1開始」、絶バハ P5 の「次は、ギガフレア」など）、
    # 担当名を付けずに 1 つだけ出し、読み上げも戻す
    family = {r for rs in roles.values() for _, r, _ in rs}
    if len(family) < 2:
        family = set()  # 担当が 1 つだけなら、その担当の行は担当専用（全担当で同じとはいえない）
    for phase in skeleton['phases']:
        phase['entries'] = [e for e in phase['entries'] if not (e.get('_shadowed') and not e.get('label') and not e.get('_notices'))]
        if family:
            collapse_roles(phase, family)
        # 同じ時刻・技名・表示の予定が重なったら 1 つにする（表示だけで足した予定が、骨組みの予定や別の区間の行と重なったもの）。
        # 同期する予定を残し、読み上げは合わせる
        kept, order = {}, []
        for e in phase['entries']:
            key = (round(e['_t'], 1), e['name'], e.get('label'))  # t の文字はフェーズの中の秒のことがあるので、通しの秒で比べる
            if key not in kept:
                kept[key] = e
                order.append(key)
                continue
            keep, drop = (e, kept[key]) if kept[key].get('sync') == 'false' and e.get('sync') != 'false' else (kept[key], e)
            for n in drop.get('_notices', []):
                if n not in keep.setdefault('_notices', []):
                    keep['_notices'].append(n)
            kept[key] = keep
        phase['entries'] = [kept[k] for k in order]
        for e in phase['entries']:
            notices = [n for n in e.get('_notices', []) if '@' not in n]
            if notices:
                e['tts'] = '、'.join(notices)
    return report


def squash(text):
    """表示と読み上げの文を比べるときの形（句読点・長音・「+」「と」を除く）"""
    return re.sub(r'[、。ー＋+と\s]', '', text)


def collapse_roles(phase, family):
    """担当（--role）の全部で同じ文言・同じ読み上げの行を、担当名の無い 1 つにする。
    1 つの予定に全担当の文言が付いたもの（「シェア: X / サークル: X」）と、担当ごとに別の予定として足したものの両方"""
    def unrole(e, tag, base, said):
        if e['name'] == tag:
            e['name'] = base
        parts = [base if p == tag else p for p in (e.get('label') or '').split(' / ') if p]
        parts = [p for i, p in enumerate(parts) if p not in parts[:i]]
        if parts and parts != [e['name']]:
            e['label'] = ' / '.join(parts)
        else:
            e.pop('label', None)
        if said and said not in e.setdefault('_notices', []):
            e['_notices'].append(said)

    for e in phase['entries']:
        got = e.get('_roles', {})
        if set(got) == family and len({v[1:] for v in got.values()}) == 1:
            for tag, base, said in got.values():
                unrole(e, tag, base, said)
            e.pop('_roles')
    # 担当ごとに別の予定になったもの: 同じ技名・文言・読み上げで、時刻が ROLE_MERGE_S 秒以内（区間ごとのずれの差）
    groups = {}
    for e in phase['entries']:
        got = e.get('_roles', {})
        if len(got) == 1:
            (tag, base, said), = got.values()
            name = base if e['name'] == tag else e['name']
            groups.setdefault((name, base, said), []).append(e)
    clusters = []
    for (_, base, said), es in groups.items():
        es.sort(key=lambda e: e['_t'])
        cur = []
        for e in es:
            if cur and (e['_t'] - cur[0]['_t'] > ROLE_MERGE_S or any(r in e['_roles'] for c in cur for r in c['_roles'])):
                clusters.append((base, said, cur))
                cur = []
            cur.append(e)
        clusters.append((base, said, cur))
    drop = set()
    for base, said, es in clusters:
        if sorted(r for e in es for r in e['_roles']) != sorted(family):
            continue
        keep = es[0]
        unrole(keep, next(iter(keep.pop('_roles').values()))[0], base, said)
        for e in es[1:]:
            drop.add(id(e))
            if not keep.get('gimmick_icon') and e.get('gimmick_icon'):
                keep['gimmick_icon'] = e['gimmick_icon']
    phase['entries'] = [e for e in phase['entries'] if id(e) not in drop]


def apply_cast_durations(skeleton, path, file):
    """画面の詠唱バーの長さが FFLogs と違う技の duration を差し替える（tools/cast-durations.tsv）。照合の後に呼ぶ。報告の行を返す
    （2026-10-22 クルーザー級2: ランドスケープは FFLogs 0.7 秒・画面 7.7 秒で、詠唱中なのにタイムラインでは発動済みになっていた）"""
    table = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            cols = line.rstrip('\n').split('\t')
            if line.startswith('#') or len(cols) < 4 or cols[0] != file:
                continue
            table[(cols[1], f'{float(cols[2]):.1f}')] = float(cols[3])
    count = {key: 0 for key in table}
    for p in skeleton['phases']:
        for e in p['entries']:
            key = (e['name'], f'{float(e["duration"]):.1f}') if e.get('duration') else None
            if key in table:
                e['duration'] = table[key]
                count[key] += 1
    return [f'詠唱時間を画面に合わせる: {name} {old} → {table[(name, old)]:.1f} 秒（{n} 件）' if n else
            f'詠唱時間の表に当たる予定がありません: {name} {old} 秒（骨組みを作り直して FFLogs の値が変わった可能性）'
            for (name, old), n in count.items()]


SPLIT_SPEC = re.compile(r'([^@]+)@([^=]+)=([^:#]+)(?::([^#]*))?(?:#(.+))?')


def own_cast(rule, phase, phases):
    """移る技が phase の中にもあるとき（B の後へ移る「ほのお」が A にもある）は、移り先の予定のうち phase に無い最初の技で移る"""
    if not rule.get('cast'):
        return rule
    here = {n for e in phase['entries'] if e.get('sync') != 'false' for n in e['name'].split('|')}
    if not here & set(rule['cast'].split('|')):
        return rule
    target = phases[rule['to']]
    e = next((e for e in target['entries'] if e.get('sync') != 'false' and not here & set(e['name'].split('|'))), None)
    if e is None:
        raise SystemExit(f'{phase["attrs"]["id"]} → {rule["to"]}: 移り先に {phase["attrs"]["id"]} に無い技がありません')
    return {**rule, 'cast': e['name'], 'at': f'{e["_t"]:.1f}'}


def synced_names(phase):
    return {n for e in phase['entries'] if e.get('sync') != 'false' for n in e['name'].split('|')}


def backup_rule(src, dst, avoid=frozenset()):
    """控えの移り: src から dst へ移る技を読み逃したとき、dst にだけある最初の技（src と avoid に無い技）で dst のその時刻へ移る。
    分かれ目では avoid にもう片方の枝の技を入れる（アルファ編1 の開幕のダミングイーディクトを読み逃すと、A の中のインプロージョンで B へ移ってしまうため）"""
    skip = synced_names(src) | set(avoid)
    e = next((e for e in dst['entries'] if e.get('sync') != 'false' and e['_t'] > 0 and not skip & set(e['name'].split('|'))), None)
    if e is None or any(n.get('to') == dst['attrs']['id'] and n.get('cast') == e['name'] for n in src['next']):
        return None
    rule = {'to': dst['attrs']['id'], 'at': f'{e["_t"]:.1f}', 'cast': e['name']}
    src['next'].append(rule)
    return rule


def swap_branches(skeleton, specs, no_backup=frozenset()):
    """--swap: 「A~B」は、--split で作った A →（合間）→ B の並びに、B' →（合間'）→ A' の逆の順の道筋を足す（写しを作る）。
    両方を必ず通り、順だけが入れ替わる型（極ヴァリガルマンダ P3 の雷・氷）。合間が無く A の次が B でもよい（極ハイデリンの杖・踊）。
    A の前のフェーズから、B の最初の技で B' へ移る。no_backup の技は控えの移りに使わない（--no-backup）。報告の行を返す"""
    phases = {p['attrs']['id']: p for p in skeleton['phases']}
    rule_to = lambda p, target: next(n for n in p['next'] if n.get('to') == target)
    report = []
    for spec in specs:
        a_id, b_id = spec.split('~')
        pred = next(p for p in skeleton['phases'] if any(n.get('to') == a_id for n in p['next']))
        a = phases[a_id]
        mid = phases[a['next'][0]['to']] if a['next'][0]['to'] != b_id else None
        b = phases[mid['next'][0]['to']] if mid else phases[b_id]
        if b['attrs']['id'] != b_id:
            raise SystemExit(f'--swap {spec}: {a_id} の次の次が {b_id} ではありません（{b["attrs"]["id"]}）')
        cast_a, cast_b = rule_to(pred, a_id)['cast'], rule_to(mid or a, b_id)['cast']
        clone = lambda p, nxt: {'attrs': {**p['attrs'], 'id': p['attrs']['id'] + '-2nd' if p is a else p['attrs']['id'] + '-alt',
                                          'name': (p['attrs'].get('name') or p['attrs']['id']) + ('（後）' if p is a else '（先）' if p is b else '（逆の順）')},
                                'entries': [dict(e) for e in p['entries']], 'next': nxt}
        a2 = clone(a, [own_cast(dict(n), a, phases) for n in b['next']])  # 2 番目の A の後は、元の B の後と同じ所へ
        phases[a2['attrs']['id']] = a2
        after_b = a2
        if mid:
            mid2 = clone(mid, [own_cast({'to': a2['attrs']['id'], 'at': '0.0', 'cast': cast_a}, mid, phases)])
            phases[mid2['attrs']['id']] = mid2
            after_b = mid2
            cast_next = rule_to(a, mid['attrs']['id'])['cast']
        else:
            cast_next = cast_a
        b2 = clone(b, [own_cast({'to': after_b['attrs']['id'], 'at': '0.0', 'cast': cast_next}, b, phases)])
        phases[b2['attrs']['id']] = b2
        pred['next'].append(own_cast({'to': b2['attrs']['id'], 'at': '0.0', 'cast': cast_b}, pred, phases))
        at = skeleton['phases'].index(b) + 1
        added = [b2, mid2, a2] if mid else [b2, a2]
        skeleton['phases'][at:at] = added
        path = ' → '.join(f'「{n["cast"]}」{n["to"]}' if n.get('cast') else f'{n.get("time")} 秒で {n["to"]}' for n in (pred['next'][-1], *(p['next'][0] for p in added[:-1]), *a2['next']))
        report.append(f'逆の順の道筋: {pred["attrs"]["id"]} → {path}')
        backups = [(pred, a, synced_names(b)), (pred, b2, synced_names(a))]
        backups += [(a, mid, ()), (mid, b, ()), (b2, mid2, ()), (mid2, a2, ())] if mid else [(a, b, ()), (b2, a2, ())]
        backups += [(a2, phases[n['to']], ()) for n in a2['next'] if n.get('cast') and n['to'] in phases]  # A（後）の次へも（B の次と同じ）
        skeleton.setdefault('_backed', set()).update((src['attrs']['id'], dst['attrs']['id']) for src, dst, _ in backups)
        for src, dst, avoid in backups:
            rule = backup_rule(src, dst, set(avoid) | set(no_backup))
            if rule:
                report.append(f'控えの移り: {src["attrs"]["id"]} →「{rule["cast"]}」{rule["to"]} の {rule["at"]} 秒')
    return report


HUB_DECIDE = 2  # 見分け待ちで、各区間を決める技の数（1 つ目を読み逃しても 2 つ目で入れる）
HUB_MARGIN_S = 5.0  # 見分ける技が、ほかの区間でこの秒より前に出ないこと（ほかの区間を決める技の後、少しの余裕）


def hub_branches(skeleton, spec):
    """--hub: 「待ち=区間:終わりの技,区間:終わりの技,…,区間」は、どの順にも来る区間を、待ちのフェーズから最初の技で選ぶ
    （極ウォーリア・オブ・ライトの後半 5 種。2026-10-28）。区間は終わりの技で待ちへ戻る。終わりの技の無い区間は最後（戻らない）。
    区間の途中にもほかの区間の最初の技が出る（幻光召喚・リミットチャージ）ので、--split の #組 のように区間どうしを直接つながない。
    最初の技が同じ区間（魔法剣で始まる忍者と召喚士・狂戦士）は、共通の頭だけを置いた見分け待ちのフェーズへ移り、
    ほかの区間には（ほかの区間を決める技より前には）出ない技で、その区間のその時刻へ移る。報告の行を返す"""
    phases = {p['attrs']['id']: p for p in skeleton['phases']}
    hub_id, _, rest = spec.partition('=')
    hub = phases[hub_id]
    members = []
    for part in rest.split(','):
        mid, _, end = part.partition(':')
        members.append((phases[mid], end or None))
    synced = lambda p: [e for e in p['entries'] if e.get('sync') != 'false']
    names = lambda es: {n for e in es for n in e['name'].split('|')}
    report = []
    # 区間の外（前の中継）の表示だけの行が、骨組みの討伐の時刻で区間のフェーズへこぼれたものは、区間に置かない。
    # 待ちに同じ技の詠唱があればその予定に文言を付ける（中継の最後の「全体攻撃」は、待ちの頭のアルティメット・クロスオーバー。
    # この討伐では Hojoring より 22 秒早く来ていて、忍者の頭に入っていた。2026-10-28）
    member_secs = {m['attrs'].get('name') for m, _ in members}
    for m, _ in members:
        keep = []
        for e in m['entries']:
            if not (e.get('_added') and e.get('_sec') and e['_sec'] not in member_secs):
                keep.append(e)
                continue
            target = next((h for h in synced(hub) if names([h]) & names([e])), None)
            if target is not None:
                add_text(target, 'label', e.get('label'), ' / ')
                target.setdefault('_notices', []).extend(n for n in e.get('_notices', []) if n not in target['_notices'])
            report.append(f'待ち {hub_id}: {m["attrs"]["id"]} にこぼれた {e["_sec"]} の行「{e.get("label") or e["name"]}」を'
                          + (f'待ちの「{target["name"]}」に付けた' if target is not None else '外した'))
        m['entries'] = keep
    hub['next'] = []
    groups = {}
    for m, end in members:
        groups.setdefault(synced(m)[0]['name'], []).append(m)
        if end:
            # 骨組みの討伐で最後に来た区間には終わりの技が無い（最後の種の後はエンドオールなしで最後へ進む）ので、そのときは技名だけで
            e = next((e for e in reversed(synced(m)) if end in e['name'].split('|')), None)
            m['next'] = [{'to': hub_id, 'at': '0.0', 'cast': e['name'] if e else end}]
        else:
            m['next'] = []
    entry_of = {}  # 待ちから、その最初の技で入る先（区間か見分け待ち）
    decide = []  # 見分け待ちから区間へ移る技のうち、ほかのフェーズの控えにも使うもの（区間, 技, 時刻）
    waits = {}  # 見分け待ちの id → その区間
    at = skeleton['phases'].index(hub) + 1
    for first, ms in groups.items():
        if len(ms) == 1:
            hub['next'].append({'to': ms[0]['attrs']['id'], 'at': '0.0', 'cast': first})
            entry_of[first] = ms[0]
            continue
        # 共通の頭: どの区間にも、同じ名前の同期する予定が 2 秒以内にある間
        head = []
        for e in synced(ms[0]):
            if all(any(o['name'] == e['name'] and abs(o['_t'] - e['_t']) <= 2.0 for o in synced(x)) for x in ms[1:]):
                head.append({k: v for k, v in e.items() if k not in ('label', '_notices', '_roles')})
            else:
                break
        head_end = head[-1]['_t']
        after = lambda x: [e for e in synced(x) if e['_t'] > head_end + 0.5 and not names(head) & set(e['name'].split('|'))]
        unique = {id(x): [e for e in after(x) if not any(names(synced(y)) & set(e['name'].split('|')) for y in ms if y is not x)][:HUB_DECIDE]
                  for x in ms}
        until = {id(x): max((e['_t'] for e in unique[id(x)]), default=float('inf')) + HUB_MARGIN_S for x in ms}
        wait_id = f'{hub_id}-{"-".join(x["attrs"]["id"] for x in ms)}'
        wait = {'attrs': {'id': wait_id, 'name': '・'.join((x['attrs'].get('name') or x['attrs']['id']) for x in ms) + '（見分け待ち）'},
                'entries': head, 'next': []}
        for x in ms:
            ok = [e for e in after(x)
                  if not any(set(e['name'].split('|')) & names(o for o in synced(y) if o['_t'] < until[id(y)]) for y in ms if y is not x)]
            ok = [e for i, e in enumerate(ok) if e['name'] not in {o['name'] for o in ok[:i]}]  # 2 回目の同じ技は、1 回目で移るので要らない
            if not ok:
                raise SystemExit(f'--hub: {x["attrs"]["id"]} をほかの区間と見分ける技がありません')
            for e in ok[:HUB_DECIDE]:
                rule = {'to': x['attrs']['id'], 'at': f'{e["_t"]:.1f}', 'cast': e['name']}
                # 区間に 2 回出る技は、1 回目のころだけで移る（1 回目を逃して 2 回目で移ると、時計が 2 回目との差だけ遅れる。
                # パーフェクトデシメートは 28.1 秒と 40.3 秒。見分け待ちの時計は区間と同じ頭から数えるので、区間の秒で書ける。3c の 307a003）
                again_t = [o['_t'] for o in synced(x) if o['name'] == e['name'] and o['_t'] > e['_t']]
                if again_t:
                    rule['until'] = f'{min(e["_t"] + HUB_MARGIN_S, again_t[0] - 0.5):.1f}'
                wait['next'].append(rule)
                if not any(set(e['name'].split('|')) & names(synced(y)) for y, _ in members if y not in ms):
                    decide.append((x, e['name'], f'{e["_t"]:.1f}'))  # 組の外の区間に出ない技は、ほかのフェーズからの控えにも使う
            report.append(f'見分け待ち {wait_id} →「{"」「".join(e["name"] for e in ok[:HUB_DECIDE])}」{x["attrs"]["id"]}')
        hub['next'].append({'to': wait_id, 'at': '0.0', 'cast': first})
        skeleton['phases'].insert(at, wait)
        phases[wait_id] = wait
        entry_of[first] = wait
        waits[wait_id] = ms
    # 控えの移り: 技を 1 つ読み逃しても、後の技で正しい区間へ移る。区間の終わりの技（最後に来た区間には無い）、
    # 待ちから入る最初の技、見分け待ちの最初の技を逃したとき（2026-10-28 に討伐 6 件で 1 つずつ抜いて確かめた）。
    # 使う技は、区間の最初の技・見分け待ちで決める技（組の外の区間に出ないもの。エンシェントドラゴンダイブは五連魔の終わりの技）・
    # その区間にしか出ない技（暗黒騎士のアブソリュートホーリー）。
    # 移る前のフェーズに出る技と、同じ技で別の先へ移るものは使わない（最初の技を優先。リミットチャージは暗黒騎士の最初の技で、
    # 白黒魔道士を決める技でもある。サモン・ウィルムは召喚士・狂戦士と白黒魔道士を決める技）
    own = {}
    for m, _ in members:
        for e in synced(m):
            if all(not set(e['name'].split('|')) & names(synced(x)) for x, _ in members if x is not m):
                own.setdefault((id(m), e['name']), (m, e['name'], f'{e["_t"]:.1f}'))
    later = decide + list(own.values())
    # 区間から戻る待ちは、予定の無い別のフェーズにする（待ちの頭の予定は、前のフェーズから初めて入るときだけのもの。Codex 指摘 10-28）
    hub_name = hub['attrs'].get('name') or hub_id
    again_name = f'{hub_name[:-1]}・2 回目から）' if hub_name.endswith('）') else f'{hub_name}（2 回目から）'
    again = {'attrs': {'id': f'{hub_id}-again', 'name': again_name},
             'entries': [], 'next': [dict(r) for r in hub['next']]}
    skeleton['phases'].insert(skeleton['phases'].index(hub) + 1, again)
    for m, _ in members:
        for r in m['next']:
            if r['to'] == hub_id:
                r['to'] = again['attrs']['id']
    # 待ちに入るきっかけの技を逃しても、区間の技で移る（p1 のアルティメット・クロスオーバー）
    before = [p for p in skeleton['phases'] if any(r.get('to') == hub_id for r in p.get('next', []))]
    dsts = {}
    for dst, cast, _ in later:
        dsts.setdefault(cast, set()).add(id(dst))
    cands = [(dst, first, '0.0') for first, dst in entry_of.items()] + [c for c in later if len(dsts[c[1]]) == 1]
    for p in [*before, hub, again, *(m for m, end in members if end), *(phases[w] for w in waits)]:
        to = {r['cast']: r['to'] for r in p['next'] if r.get('cast')}
        mine = names(synced(p))  # 表示だけの予定は、そのフェーズで出る技とはみなさない（Codex 指摘 10-28）
        inside = {x['attrs']['id'] for x in waits.get(p['attrs']['id'], [])}  # 見分け待ちは、自分の区間へは自分の決める技で移る
        for dst, cast, t in cands:
            d = dst['attrs']['id']
            if d != p['attrs']['id'] and d not in inside and not mine & set(cast.split('|')) and to.setdefault(cast, d) == d \
                    and not any(r.get('cast') == cast and r['to'] == d for r in p['next']):
                p['next'].append({'to': d, 'at': t, 'cast': cast})
    ids = {hub_id, again['attrs']['id'], *(m['attrs']['id'] for m, _ in members)}
    skeleton.setdefault('_backed', set()).update((a, b) for a in ids for b in ids)
    report.append(f'待ち {hub_id}: {"・".join(m["attrs"]["id"] for m, _ in members)}')
    return report


def split_branches(skeleton, specs):
    """--split: 文言を重ねた後で、フェーズを技で切り分ける（ボス側の分岐。2026-10-28）。報告の行を返す。
    「p5@アルテマ=p5b:名前」は、p5 の最初のアルテマ（同期する予定）から後を p5b に移し、p5 から p5b へ「アルテマ」で移る。
    名前が Hojoring の区間名なら、その区間から足した行は時刻にかかわらずそのフェーズへ移す（区間の頭の行が切る技より前にあっても）。
    「#組」を付けたものは、どの順にも来る区間の組（絶アルテマのラスト 3 体）。組の直前のフェーズと各区間から、組のほかの区間へ移れる。
    区間を決める技は、移る前のフェーズに無い技にする（エンジンはフェーズ中のいつでも next の技で移るため）"""
    phases = {p['attrs']['id']: p for p in skeleton['phases']}
    parsed = [SPLIT_SPEC.fullmatch(spec).groups() for spec in specs]
    names = {name for *_, name, _ in parsed if name}
    groups, report = {}, []
    for i, (src, cast, new_id, name, group) in enumerate(parsed):
        later = {spec[3] for spec in parsed[i:] if spec[3]}  # このフェーズか、この後に分けるフェーズの区間（その区間の行は一緒に移す）
        p = phases[src]
        cast, _, nth = cast.partition('*')  # 「幻光召喚*2」は、そのフェーズの 2 回目の幻光召喚で切る
        hits = [e for e in p['entries'] if e.get('sync') != 'false' and cast in e['name'].split('|')]
        cut = hits[int(nth or 1) - 1] if len(hits) >= int(nth or 1) else None
        if cut is None:
            raise SystemExit(f'--split {src}@{cast}: {src} に同期する「{cast}」の予定がありません')
        t0 = cut['_t']
        mine = lambda e: e.get('_sec') in later or (e['_t'] >= t0 and e.get('_sec') not in names)
        moved = [e for e in p['entries'] if mine(e)]
        p['entries'] = [e for e in p['entries'] if not mine(e)]
        for e in moved:
            # 区間の頭の行が切る技より前にあるときは、移った瞬間に出す（技を読むまではどの区間か分からない）
            e['_hit'] -= t0 - min(0.0, e['_t'] - t0)
            e['_t'] = max(0.0, e['_t'] - t0)
        moved.sort(key=lambda e: e['_t'])
        shift = lambda n: {**n, 'time': f'{float(n["time"]) - t0:g}'} if n.get('time') else n
        new = {'attrs': {'id': new_id, **({'name': name} if name else {})}, 'entries': moved, 'next': [shift(n) for n in p['next']]}
        p['next'] = [{'to': new_id, 'at': '0.0', 'cast': cut['name']}]  # 別名（--alias）があればそれでも移る
        skeleton['phases'].insert(skeleton['phases'].index(p) + 1, new)
        phases[new_id] = new
        report.append(f'フェーズを分ける: {src} の {t0:.1f} 秒「{cast}」から後を {new_id}（{len(moved)} 件）')
        if group:
            groups.setdefault(group, []).append((new_id, cut['name'], src))
        else:
            skeleton.setdefault('_split_pairs', []).append((src, new_id))
    for group, members in groups.items():
        rule = lambda m: {'to': m[0], 'at': '0.0', 'cast': m[1]}
        after = phases[members[-1][0]]['next']  # 組の後に続く移り方（いちばん後の区間が受け継いでいる）
        phases[members[0][2]]['next'] = [rule(m) for m in members]
        for mid, _, _ in members:
            phases[mid]['next'] = [rule(m) for m in members if m[0] != mid] + after
        report.append(f'どの順にも来る区間の組「{group}」: {"・".join(m[0] for m in members)}')
    return report


def write_castline(skeleton, path, title, note, author='', license=''):
    head = {**skeleton['head'], 'author': author, 'license': license}
    if title:
        head['title'] = title
    attr = lambda d, keys: ''.join(f' {k}={quoteattr(d[k])}' for k in keys if d.get(k) is not None and d[k] != '')
    lines = ['<?xml version="1.0" encoding="utf-8"?>',
             '<timeline>']
    lines += [f'  <{k}>{escape(head[k])}</{k}>' for k in ('format', 'content', 'title', 'author', 'license', 'sync-window') if head.get(k)]
    lines += [f'  <note>{escape(note)}</note>']
    for p in skeleton['phases']:
        lines.append(f'  <phase{attr(p["attrs"], ["id", "name"])}>')
        for e in p['entries']:
            out = {**e, 'castname': e['name'], 'text': e.get('label'), 't': f'{e["_t"]:.1f}',
                   'duration': f'{float(e["duration"]):.1f}' if e.get('duration') else None}  # t・duration は必ず小数点以下 1 桁
            lines.append(f'    <entry{attr(out, ENTRY_ORDER)}/>')
        for n in p['next']:
            lines.append(f'    <next{attr(n, ["to", "at", "cast", "from", "until", "hp", "time", "hp-lost"])}/>')
        lines.append('  </phase>')
    lines += ['</timeline>', '']
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('skeleton')
    ap.add_argument('hojoring')
    ap.add_argument('out')
    ap.add_argument('--title')
    ap.add_argument('--author', help='タイムラインの作者（省略時は元ファイルの author）')
    ap.add_argument('--events', action='append', default=[], metavar='フェーズID=PATH',
                    help='そのフェーズの FFLogs の技の一覧（tools/fflogs-events.py の出力）')
    ap.add_argument('--role', action='append', default=[], metavar='区間[@秒]=担当名',
                    help='担当ごとの区間（例: RED=赤）。表示に担当名を付け、読み上げはしない。'
                         '「P3@47=無職」は区間の 47 秒以降の行だけ（区間の途中から担当ごとに分かれるとき）')
    ap.add_argument('--variant', action='append', default=[], metavar='区間[@秒]=型の名前',
                    help='ボスの処理の型ごとの区間（例: 絶バハ P5 のダイナモ・ダイブ）。表示は --role と同じ。'
                         '型によって詠唱の無い技の順が違うので、その技にはこの討伐の時刻で合わせない')
    ap.add_argument('--split', action='append', default=[], metavar='フェーズ@技=新しいID[:名前][#組]',
                    help='文言を重ねた後で、フェーズをその技で切り分ける（ボス側の分岐）。書き方は split_branches')
    ap.add_argument('--swap', action='append', default=[], metavar='A~B',
                    help='--split で作った A →合間→ B に、逆の順の道筋を足す（両方を通り順だけが入れ替わる区間）')
    ap.add_argument('--no-backup', action='append', default=[], metavar='技',
                    help='控えの移り（--split・--swap で、移る技を読み逃したときの移り）に使わない技。控えは骨組みの討伐 1 本から選ぶので、別の順の討伐で枝の前にも出る技を外す'
                         '（極ヴァリガルマンダの氷先は、氷の始まりの 9 秒前にノーザンクロスが来る）')
    ap.add_argument('--no-spell-sync', action='store_true',
                    help='「〜を唱えた。」の同期文を同期に使わない（煉獄編4。扉ボスの区間はこの討伐に無いものがあり、'
                         '唱えたの技名が別の所に合って区間がずれる。古いコンテンツなので分岐は作らず、前の出力のままにする）')
    ap.add_argument('--hub', action='append', default=[], metavar='待ち=区間:終わりの技,…,区間',
                    help='どの順にも来る区間を、待ちのフェーズから最初の技で選ぶ（極ウォーリア・オブ・ライトの後半）。書き方は hub_branches')
    ap.add_argument('--loop', action='append', default=[], metavar='フェーズ@技',
                    help='そのフェーズの頭からやり直すことがある（アルファ編4 の前半の開幕は、削りが足りないと繰り返す）。'
                         'その技を読んだら、フェーズの中のその技の時刻へ戻る。技はフェーズの中に 1 回だけのものにする')
    ap.add_argument('--alias', action='append', default=[], metavar='技|技',
                    help='同じ所に来る別の技名（アルファ編1 のホリゾンタル・ヴァーティカルインプロージョン）。'
                         'どれかの名前の予定に全部の名前を付け、どれの詠唱でも合う・移るようにする')
    ap.add_argument('--any-order', action='append', default=[], metavar='区間[@秒]',
                    help='どの順にも来る区間。後の区間のずれの下限にしない。'
                         '@秒 はずれの下限（省略時は直前の区間の終わり。元ファイルの区間の並びと討伐の順が違うとき）')
    ap.add_argument('--events-all', metavar='PATH',
                    help='全フェーズの技の一覧（tools/skeleton-from-fflogs.mjs の出力）。--phase の無い区間は、技が最も多くそろうフェーズに自動で対応させる')
    ap.add_argument('--phase', action='append', default=[], metavar='区間=フェーズID',
                    help='Hojoring の区間を骨組みのフェーズに対応させる（省略時は最初のフェーズ。--events-all があれば自動）')
    ap.add_argument('--cast-durations', metavar='PATH',
                    help='画面の詠唱バーの長さが FFLogs と違う技の表（tools/cast-durations.tsv）。出力のファイル名の行だけ使う')
    args = ap.parse_args()
    global SPELL_SYNC
    SPELL_SYNC = not args.no_spell_sync

    meta, defaults, sections, dropped = load_hojoring(args.hojoring)
    skeleton = load_skeleton(args.skeleton)
    mapping = dict(m.split('=', 1) for m in args.phase)
    first = skeleton['phases'][0]['attrs']['id']
    events = {}
    for spec in args.events:
        pid, path = spec.split('=', 1)
        with open(path, encoding='utf-8') as f:
            events[pid] = [tuple(e) for e in json.load(f)['events']]
    fights = {}
    if args.events_all:
        with open(args.events_all, encoding='utf-8') as f:
            data = json.load(f)
        if 'fights' in data:
            # 戦闘ごとに通しで照合する（Hojoring の区間は FFLogs のフェーズとずれていることが多いため）。フェーズの指定はフェーズ ID か戦闘 ID（all・a・b）
            for fid, fight in data['fights'].items():
                fights[fid] = join_phases(skeleton, fid, fight['starts'])
                events[fid] = [tuple(e) for e in fight['events']]
        else:
            for pid, p in data['phases'].items():
                events[pid] = [tuple(e) for e in p['events']]
        infer_names(sections, {e[2] for evs in events.values() for e in evs})
        mapping = {**auto_phases(sections, {k: v for k, v in events.items() if not fights or k in fights}), **mapping}
    roles = {}
    for r, variant in [(r, False) for r in args.role] + [(r, True) for r in args.variant]:
        where, name = r.split('=', 1)
        sec, _, start = where.partition('@')
        roles.setdefault(sec, []).append((float(start or 0), name, variant))
    any_order = {}
    for spec in args.any_order:
        name, _, low = spec.partition('@')
        any_order[name] = float(low) if low else None
    report = overlay(skeleton, sections, defaults, lambda name: mapping.get(name, first), events.get,
                     {sec: sorted(rs) for sec, rs in roles.items()}, any_order)
    for fid in fights:
        split_phases(skeleton, fid)
    if args.cast_durations:
        report += apply_cast_durations(skeleton, args.cast_durations, re.sub(r'\.xml$', '', args.out.rsplit('/', 1)[-1]))
    for group in args.alias:
        group = group.split('|')
        for p in skeleton['phases']:
            for e in p['entries']:
                names = e['name'].split('|')
                if set(names) & set(group):
                    e['name'] = '|'.join(names + [n for n in group if n not in names])
    if args.split:
        report += split_branches(skeleton, args.split)
    if args.swap:
        report += swap_branches(skeleton, args.swap, set(args.no_backup))
    for spec in args.hub:
        report += hub_branches(skeleton, spec)
    # --split の移りにも控えの移りを付ける（2 体フェーズの頭のガードプログラムを読み逃すと、後の技で戻れず、
    # 開幕の繰り返しの技で開幕へ巻き戻っていた。Codex の指摘）。分かれ目は swap_branches が、もう片方の枝の技を避けて付けた
    phases = {p['attrs']['id']: p for p in skeleton['phases']}
    for src, dst in skeleton.get('_split_pairs', []):
        if (src, dst) not in skeleton.get('_backed', set()):
            rule = backup_rule(phases[src], phases[dst], set(args.no_backup))
            if rule:
                report.append(f'控えの移り: {src} →「{rule["cast"]}」{dst} の {rule["at"]} 秒')
    for spec in args.loop:
        pid, cast = spec.split('@')
        p = next(p for p in skeleton['phases'] if p['attrs']['id'] == pid)
        e = next(e for e in p['entries'] if e.get('sync') != 'false' and cast in e['name'].split('|'))
        p['next'].append({'to': pid, 'at': f'{e["_t"]:.1f}', 'cast': e['name']})
        report.append(f'繰り返し: {pid} で「{cast}」を読んだら {e["_t"]:.1f} 秒へ戻る')

    # note に元ファイル（Hojoring）の名前は書かない。利用者は Hojoring のファイルを扱わないため（2026-10-20 のユーザーの決定）。
    # タイムラインの作者とライセンスは <author> <license> に書く（2026-10-21 のユーザーの決定）
    note = (f'{skeleton["note"]} text は表示、tts は読み上げの文言。'
            f'sync="false" の予定には、補助の敵の技や台詞など、詠唱バーで合わせられないものも含む')
    author = args.author or ', '.join(a.strip() for a in re.split(r'[\n\t,]+|\s{2,}', meta['author']) if a.strip())
    write_castline(skeleton, args.out, args.title, note, author, ' '.join(meta['license'].split()))

    for line in report:
        print(line)
    print(f'使わなかったもの: <t> のトリガー {len(dropped["trigger"])} 件（{" / ".join(dropped["trigger"])}）、'
          f'v-notice {dropped["v-notice"]} 件、icon {dropped["icon"]} 件')
    return 0


if __name__ == '__main__':
    sys.exit(main())
