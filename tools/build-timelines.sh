#!/bin/sh
# 配信するタイムライン（public/timelines/<英語名>-<難易度>.xml）を作り直す。運営者が手元で使う。
# 骨組み（tools/skeletons/ の同じ名前。生成画面で FFLogs から作ったもの）に、Hojoring 用タイムラインの文言を重ねる。
# 元ファイル（sources/）は公開しないので、リポジトリだけでは実行できない。
set -eu
cd "$(dirname "$0")/.."
overlay() { python3 tools/hojoring-overlay.py "$@"; echo; }

echo '== ヘビー級1'
overlay tools/skeletons/aac-heavyweight-m1-savage.xml 'sources/AAC_Heavyweight_M1_(Savage).xml' public/timelines/aac-heavyweight-m1-savage.xml \
    --events p1=tools/skeletons/aac-heavyweight-m1-savage.events.json \
    --title '至天の座アルカディア零式：ヘビー級1'
echo '== ヘビー級2'
overlay tools/skeletons/aac-heavyweight-m2-savage.xml 'sources/AAC_Heavyweight_M2_(Savage).xml' public/timelines/aac-heavyweight-m2-savage.xml \
    --events p1=tools/skeletons/aac-heavyweight-m2-savage.events.json --role RED=赤 --role BLUE=青 \
    --title '至天の座アルカディア零式：ヘビー級2'
echo '== ヘビー級3'
overlay tools/skeletons/aac-heavyweight-m3-savage.xml 'sources/AAC_Heavyweight_M3_(Savage).xml' public/timelines/aac-heavyweight-m3-savage.xml \
    --events p1=tools/skeletons/aac-heavyweight-m3-savage.events.json \
    --title '至天の座アルカディア零式：ヘビー級3'
echo '== ヘビー級4（前半 P1〜P5、後半 P11〜P12。P0 は分岐待ちだけ）'
overlay tools/skeletons/aac-heavyweight-m4-savage.xml 'sources/AAC_Heavyweight_M4_(Savage).xml' public/timelines/aac-heavyweight-m4-savage.xml \
    --events a-p1=tools/skeletons/aac-heavyweight-m4-savage.part-a.events.json --events b-p1=tools/skeletons/aac-heavyweight-m4-savage.part-b.events.json \
    --phase P0=none --phase P1=a-p1 --phase P2=a-p1 --phase P3=a-p1 --phase P4=a-p1 --phase P5=a-p1 \
    --phase P11=b-p1 --phase P12=b-p1 \
    --title '至天の座アルカディア零式：ヘビー級4'

# Hojoring の手元のファイル（sources/hojoring-pc）から。骨組みは tools/skeleton-from-fflogs.mjs（FFLogs の公開ランキングの討伐の記録）、
# 区間とフェーズの対応は自動（--events-all）
pc() { overlay "tools/skeletons/$1.xml" "sources/hojoring-pc/$2" "public/timelines/$1.xml" --events-all "tools/skeletons/$1.events.json" "${@:3}"; }
echo '== クルーザー級1'
pc aac-cruiserweight-m1-savage 'AAC_Cruiserweight_M1_(Savage).xml' --title '至天の座アルカディア零式：クルーザー級1'
echo '== 極ゼレニア'
pc recollection-extreme 'Recollection(Extreme).xml' --title '極ゼレニア討滅戦'
echo '== 絶もうひとつの未来'
pc futures-rewritten-ultimate 'Futures_Rewritten_(Ultimate).xml' --title '絶もうひとつの未来'
