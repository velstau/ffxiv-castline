#!/usr/bin/env python3
"""コンテンツ名の候補（public/data/contents.json）を、ゲームデータの日本語名から作る。

出典は XIVAPI v2 の ContentFinderCondition シート（ゲームのコンテンツファインダーの名前＝画面の
「コンテンツ情報」に出る名前）。ボスのタイムラインを流す対象になる種類だけを残す。
パッチで新しいコンテンツが増えたら実行し直す。

file はタイムラインのファイル名（拡張子なし）。英語の正式名から難易度の括弧を外して小文字・ハイフンにし、
難易度を後ろに付ける（AAC Heavyweight M1 (Savage) → aac-heavyweight-m1-savage。括弧の無いものは normal）。
難易度の英語名: ノーマル Normal / 零式 Savage / 絶 Ultimate / 極 Extreme / 滅 Chaotic（2026-10-20 のユーザーの指定）

    python3 tools/build-contents.py
"""
import json
import pathlib
import re
import unicodedata
import urllib.parse
import urllib.request

API = 'https://v2.xivapi.com/api/sheet/ContentFinderCondition'
# ContentType の行番号 → 表示名（ContentType シートの日本語名）
TYPES = {
    2: 'ダンジョン',
    4: '討伐・討滅戦',
    5: 'レイド',
    28: '絶レイド',
    37: '滅アライアンスレイド',
}
OUT = pathlib.Path(__file__).resolve().parent.parent / 'public' / 'data' / 'contents.json'


def fetch_rows():
    after = None
    while True:
        params = {
            'fields': 'Name,Name@lang(en),ClassJobLevelRequired,ContentType@as(raw),TerritoryType@as(raw)',
            'language': 'ja',
            'limit': '500',
        }
        if after is not None:
            params['after'] = str(after)
        # Python 標準の User-Agent は 403 で弾かれる
        req = urllib.request.Request(
            f'{API}?{urllib.parse.urlencode(params)}',
            headers={'User-Agent': 'castline-build-contents (vel.works)'},
        )
        with urllib.request.urlopen(req, timeout=60) as res:
            rows = json.load(res)['rows']
        if not rows:
            return
        yield from rows
        after = rows[-1]['row_id']


def file_name(english):
    """英語の正式名から、難易度つきのファイル名（拡張子なし）を作る"""
    # 難易度の括弧は名前の途中にもある（the Second Coil of Bahamut (Savage) - Turn 1）
    m = re.search(r'\s*\((\w+)\)', english)
    base, difficulty = (english[:m.start()] + english[m.end():], m.group(1).lower()) if m else (english, 'normal')
    # 極の一部は括弧ではなく「The Minstrel's Ballad: 名前」（極ハーデス・極エターナルクイーンなど）
    ballad = re.match(r"^the minstrel['’]s ballad:\s*(.+)$", base, re.IGNORECASE)
    if ballad:
        base, difficulty = ballad.group(1), 'extreme'
    base = unicodedata.normalize('NFKD', base).encode('ascii', 'ignore').decode()
    base = re.sub(r"['’]", '', base.lower())
    return f"{re.sub(r'[^a-z0-9]+', '-', base).strip('-')}-{difficulty}"


def main():
    contents = []
    seen = set()
    for row in fetch_rows():
        f = row['fields']
        name = (f.get('Name') or '').strip()
        type_id = f.get('ContentType@as(raw)')
        if not name or type_id not in TYPES or name in seen:
            continue
        seen.add(name)
        contents.append({
            'id': row['row_id'],
            'name': name,
            'en': (f.get('Name@lang(en)') or '').strip(),
            'type': TYPES[type_id],
            'level': f.get('ClassJobLevelRequired'),
            # 場所（TerritoryType）の行番号。FFLogs の fights.gameZone.id・cactbot の zoneId と同じ番号で、そこからコンテンツ名を引く
            'territory': f.get('TerritoryType@as(raw)'),
        })
    for c in contents:
        c['file'] = file_name(c['en']) if c['en'] else None
    # 日本語名の目印と英語名の難易度が食い違うものを知らせる
    marks = (('絶', 'ultimate'), ('極', 'extreme'), ('滅', 'chaotic'), ('零式', 'savage'))
    for c in contents:
        want = next((d for k, d in marks if c['name'].startswith(k) or k == '零式' and k in c['name']), None)
        if want and c['file'] and not c['file'].endswith('-' + want):
            print(f'難易度の食い違い: {c["name"]} / {c["en"]} → {c["file"]}')
    files = [c['file'] for c in contents if c['file']]
    dups = sorted({f for f in files if files.count(f) > 1})
    if dups:
        print(f'ファイル名が重なるもの: {dups}')
    contents.sort(key=lambda c: (-(c['level'] or 0), c['id']))
    OUT.write_text(json.dumps({
        '_readme': 'コンテンツ名の候補。tools/build-contents.py が XIVAPI（ContentFinderCondition の日本語名）から作る。手で書き換えない。en は英語の正式名、file はタイムラインのファイル名（英語名＋難易度）、id は ContentFinderCondition の行番号、territory は TerritoryType の行番号（FFLogs の gameZone.id と同じ）',
        'contents': contents,
    }, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(contents)} 件を {OUT} に書きました')


if __name__ == '__main__':
    main()
