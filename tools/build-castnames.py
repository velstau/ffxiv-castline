#!/usr/bin/env python3
"""技名の一覧（public/data/castnames.json）を、配信のタイムライン（public/timelines/*.xml）の詠唱のある技から作る。

タイムラインを記録する画面（recorder.html）が、新しいタイムラインの下書きで読んだ技名を寄せる先に使う。
タイムラインを作り直したら実行し直す（tools/build-timelines.sh・convert-hojoring-pc.sh は最後に実行する。
古いままだと tests/castnames.test.mjs が落ちる）。

    python3 tools/build-castnames.py
"""
import json
import pathlib
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent


def cast_names():
    names = set()
    for path in sorted((ROOT / 'public/timelines').glob('*.xml')):
        if path.name == 'index.xml':
            continue
        for e in ET.parse(path).getroot().iter('entry'):
            if float(e.get('duration') or 0) > 0:
                names.update(n.strip() for n in (e.get('castname') or '').split('|') if n.strip())
    return sorted(names)


def main():
    names = cast_names()
    out = ROOT / 'public/data/castnames.json'
    out.write_text(json.dumps({'note': '配信のタイムラインの詠唱のある技名（tools/build-castnames.py が作る。手で直さない）', 'names': names},
                              ensure_ascii=False, indent=0) + '\n', encoding='utf-8')
    print(f'{out.relative_to(ROOT)}: {len(names)} 個')


if __name__ == '__main__':
    main()
