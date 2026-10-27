#!/bin/bash
# tools/hojoring-pc.tsv の一覧を変換する（運営者の手元で）。
#   skeletons: FFLogs から骨組みを作る（FFLOGS_CLIENT_ID・FFLOGS_CLIENT_SECRET が要る。node のコンテナで実行）
#   overlay:   Hojoring の文言を重ねて public/timelines/ に出す（python3）。報告は標準出力
#   どちらも、file を並べるとその分だけ
set -u
cd "$(dirname "$0")/.."
mode=${1:?skeletons か overlay}; shift
want=" $* "
grep -v '^#' tools/hojoring-pc.tsv | while IFS=$'\t' read -r file enc diff src extra; do
    [ -z "$file" ] && continue
    [ "$want" != "  " ] && [[ "$want" != *" $file "* ]] && continue
    echo "== $file"
    if [ "$mode" = skeletons ]; then
        # Hojoring の長さ（≒時間切れ）の 1.2 倍より長い討伐の記録は使わない。区間の時刻は区間ごとなので、各区間の最後の時刻を足す
        max=$(python3 -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("overlay", "tools/hojoring-overlay.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(round(m.hojoring_length(sys.argv[1]) * 1.2))' "sources/hojoring-pc/$src")
        docker run --rm -u "$(id -u):$(id -g)" -e FFLOGS_CLIENT_ID -e FFLOGS_CLIENT_SECRET -v "$PWD":/w -w /w node:24-alpine \
            node tools/skeleton-from-fflogs.mjs "$file" "$enc" --difficulty "$diff" --max-length "$max" < /dev/null
    else
        title=$(python3 -c 'import json,sys; print(next(c["name"] for c in json.load(open("public/data/contents.json"))["contents"] if c["file"] == sys.argv[1]))' "$file")
        # 文言はどれも Vel が書いたもの。追加の引数は引用符で区切れる（区間名に空白があるとき。'--variant=P5 厄災の三重奏ダイブ=ダイブ'）
        eval "args=($extra)"
        python3 tools/hojoring-overlay.py "tools/skeletons/$file.xml" "sources/hojoring-pc/$src" "public/timelines/$file.xml" \
            --events-all "tools/skeletons/$file.events.json" --title "$title" --author Vel --cast-durations tools/cast-durations.tsv "${args[@]}"
    fi
    echo
done

# 技名の一覧（タイムラインを記録する画面が使う）を作り直す
python3 tools/build-castnames.py

# ギミックのアイコンを表示の文のキーワードから付ける（作り直すと消えるため）
python3 tools/apply-gimmick-icons.py
