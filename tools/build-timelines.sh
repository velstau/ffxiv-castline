#!/bin/sh
# 配信するタイムライン（public/timelines/heavyN.xml）を作り直す。運営者が手元で使う。
# 骨組み（tools/skeletons/heavyN.xml。生成画面で FFLogs から作ったもの）に、Hojoring 用タイムラインの文言を重ねる。
# 元ファイル（sources/）は公開しないので、リポジトリだけでは実行できない。
set -eu
cd "$(dirname "$0")/.."
overlay() { python3 tools/hojoring-overlay.py "$@"; echo; }

echo '== ヘビー級1'
overlay tools/skeletons/heavy1.xml 'sources/AAC_Heavyweight_M1_(Savage).xml' public/timelines/heavy1.xml \
    --events p1=tools/skeletons/heavy1.events.json \
    --title '至天の座アルカディア零式：ヘビー級1（FFLogs ＋ Hojoring 用タイムラインの文言）'
echo '== ヘビー級2'
overlay tools/skeletons/heavy2.xml 'sources/AAC_Heavyweight_M2_(Savage).xml' public/timelines/heavy2.xml \
    --events p1=tools/skeletons/heavy2.events.json --role RED=赤 --role BLUE=青 \
    --title '至天の座アルカディア零式：ヘビー級2（FFLogs ＋ Hojoring 用タイムラインの文言）'
echo '== ヘビー級3'
overlay tools/skeletons/heavy3.xml 'sources/AAC_Heavyweight_M3_(Savage).xml' public/timelines/heavy3.xml \
    --events p1=tools/skeletons/heavy3.events.json \
    --title '至天の座アルカディア零式：ヘビー級3（FFLogs ＋ Hojoring 用タイムラインの文言）'
echo '== ヘビー級4（前半 P1〜P5、後半 P11〜P12。P0 は分岐待ちだけ）'
overlay tools/skeletons/heavy4.xml 'sources/AAC_Heavyweight_M4_(Savage).xml' public/timelines/heavy4.xml \
    --events a-p1=tools/skeletons/heavy4-a.events.json --events b-p1=tools/skeletons/heavy4-b.events.json \
    --phase P0=none --phase P1=a-p1 --phase P2=a-p1 --phase P3=a-p1 --phase P4=a-p1 --phase P5=a-p1 \
    --phase P11=b-p1 --phase P12=b-p1 \
    --title '至天の座アルカディア零式：ヘビー級4（FFLogs ＋ Hojoring 用タイムラインの文言）'
