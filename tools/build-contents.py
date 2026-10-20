#!/usr/bin/env python3
"""コンテンツ名の候補（public/data/contents.json）を、ゲームデータの日本語名から作る。

出典は XIVAPI v2 の ContentFinderCondition シート（ゲームのコンテンツファインダーの名前＝画面の
「コンテンツ情報」に出る名前）。ボスのタイムラインを流す対象になる種類だけを残す。
パッチで新しいコンテンツが増えたら実行し直す。

    python3 tools/build-contents.py
"""
import json
import pathlib
import urllib.parse
import urllib.request

API = 'https://v2.xivapi.com/api/sheet/ContentFinderCondition'
# ContentType の行番号 → 表示名（ContentType シートの日本語名）
TYPES = {
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
            'fields': 'Name,ClassJobLevelRequired,ContentType@as(raw)',
            'language': 'ja',
            'limit': '500',
        }
        if after is not None:
            params['after'] = str(after)
        # Python 標準の User-Agent は 403 で弾かれる
        req = urllib.request.Request(
            f'{API}?{urllib.parse.urlencode(params)}',
            headers={'User-Agent': 'ocr-timeline-build-contents (vel.works)'},
        )
        with urllib.request.urlopen(req, timeout=60) as res:
            rows = json.load(res)['rows']
        if not rows:
            return
        yield from rows
        after = rows[-1]['row_id']


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
            'type': TYPES[type_id],
            'level': f.get('ClassJobLevelRequired'),
        })
    contents.sort(key=lambda c: (-(c['level'] or 0), c['id']))
    OUT.write_text(json.dumps({
        '_readme': 'コンテンツ名の候補。tools/build-contents.py が XIVAPI（ContentFinderCondition の日本語名）から作る。手で書き換えない。id は ContentFinderCondition の行番号',
        'contents': contents,
    }, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(contents)} 件を {OUT} に書きました')


if __name__ == '__main__':
    main()
