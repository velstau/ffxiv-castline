#!/bin/sh
# 配信するタイムライン（public/timelines/<英語名>-<難易度>.xml）を作り直す。運営者が手元で使う。
# 骨組み（tools/skeletons/ の同じ名前。生成画面で FFLogs から作ったもの）に、Hojoring 用タイムラインの文言を重ねる。
# 元ファイル（sources/）は公開しないので、リポジトリだけでは実行できない。
set -eu
cd "$(dirname "$0")/.."
overlay() { python3 tools/hojoring-overlay.py "$@" --cast-durations tools/cast-durations.tsv; echo; }

echo '== ヘビー級1'
overlay tools/skeletons/aac-heavyweight-m1-savage.xml 'sources/hojoring-pc/AAC_Heavyweight_M1_(Savage).xml' public/timelines/aac-heavyweight-m1-savage.xml \
    --events p1=tools/skeletons/aac-heavyweight-m1-savage.events.json \
    --title '至天の座アルカディア零式：ヘビー級1' --author Vel
echo '== ヘビー級2'
overlay tools/skeletons/aac-heavyweight-m2-savage.xml 'sources/hojoring-pc/AAC_Heavyweight_M2_(Savage).xml' public/timelines/aac-heavyweight-m2-savage.xml \
    --events p1=tools/skeletons/aac-heavyweight-m2-savage.events.json --role RED=赤 --role BLUE=青 \
    --title '至天の座アルカディア零式：ヘビー級2' --author Vel
echo '== ヘビー級3'
overlay tools/skeletons/aac-heavyweight-m3-savage.xml 'sources/hojoring-pc/AAC_Heavyweight_M3_(Savage).xml' public/timelines/aac-heavyweight-m3-savage.xml \
    --events p1=tools/skeletons/aac-heavyweight-m3-savage.events.json \
    --title '至天の座アルカディア零式：ヘビー級3' --author Vel
echo '== ヘビー級4（前半 P1〜P5、後半 P11〜P12。P0 は分岐待ちだけ）'
overlay tools/skeletons/aac-heavyweight-m4-savage.xml 'sources/hojoring-pc/AAC_Heavyweight_M4_(Savage).xml' public/timelines/aac-heavyweight-m4-savage.xml \
    --events a-p1=tools/skeletons/aac-heavyweight-m4-savage.part-a.events.json --events b-p1=tools/skeletons/aac-heavyweight-m4-savage.part-b.events.json \
    --phase P0=none --phase P1=a-p1 --phase P2=a-p1 --phase P3=a-p1 --phase P4=a-p1 --phase P5=a-p1 \
    --phase P11=b-p1 --phase P12=b-p1 \
    --title '至天の座アルカディア零式：ヘビー級4' --author Vel


# Hojoring の手元のファイル（sources/hojoring-pc）からの分は tools/convert-hojoring-pc.sh（一覧は tools/hojoring-pc.tsv）

# 技名の一覧（タイムラインを記録する画面が使う）を作り直す
python3 tools/build-castnames.py

# ギミックのアイコンを表示の文のキーワードから付ける（作り直すと消えるため）
python3 tools/apply-gimmick-icons.py
