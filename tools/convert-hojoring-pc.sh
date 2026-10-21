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
        docker run --rm -u "$(id -u):$(id -g)" -e FFLOGS_CLIENT_ID -e FFLOGS_CLIENT_SECRET -v "$PWD":/w -w /w node:24-alpine \
            node tools/skeleton-from-fflogs.mjs "$file" "$enc" --difficulty "$diff" < /dev/null
    else
        title=$(python3 -c 'import json,sys; print(next(c["name"] for c in json.load(open("public/data/contents.json"))["contents"] if c["file"] == sys.argv[1]))' "$file")
        # shellcheck disable=SC2086
        python3 tools/hojoring-overlay.py "tools/skeletons/$file.xml" "sources/hojoring-pc/$src" "public/timelines/$file.xml" \
            --events-all "tools/skeletons/$file.events.json" --title "$title" $extra
    fi
    echo
done
