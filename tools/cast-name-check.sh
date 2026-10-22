#!/bin/bash
# tools/measure-cast-bars.py --dump の各バーの技名の部分を動画から切り出し、tools/cast-name-check.py で確かめる（運営者の手元で）。
#   tools/cast-name-check.sh <動画> <dump.json> <バー左端 x> <バーの幅> <塗りの行 y> <timeline.xml> <out.json>
# 切り出す範囲はバーの位置から決める（左右に幅の 1 割強、上に幅の 9%・下に 12%。1704x720 の幅 125 のバーで 150x26）。
# ffmpeg は FFMPEG_IMAGE（既定 movie-maker-worker:latest）、OCR は python:3.12-slim で動かす。
# Python の依存は初回に tools/cache/pyenv へ入れる（git の対象外）。モデルは public/models（ppocrv5_rec.onnx・ppocrv5_dict.txt）
set -eu
cd "$(dirname "$0")/.."
video=$1 dump=$(realpath "$2") left=$3 width=$4 y=$5 timeline=$(realpath "$6") out=$(realpath -m "$7")
image=${FFMPEG_IMAGE:-movie-maker-worker:latest}
crops=$(dirname "$out")/crops-$(basename "$out" .json)
mkdir -p "$crops"
read -r cx cw cy ch < <(python3 -c "w=$width; print(round($left-0.12*w), round(1.2*w), round($y-0.09*w), round(0.21*w))")
python3 -c "
import json
for i, m in enumerate(json.load(open('$dump', encoding='utf-8'))):
    print(i, 0, round(m['start'] + 0.3, 2))
    print(i, 1, round(m['start'] + max(0.3, 0.6 * m['shown']), 2))" > "$crops/times.txt"
docker run --rm -u "$(id -u):$(id -g)" -v "$(dirname "$video")":/v:ro -v "$crops":/o --entrypoint sh "$image" -c "
    while read -r i k t; do ffmpeg -v error -y -ss \$t -i \"/v/$(basename "$video")\" -frames:v 1 -vf crop=$cw:$ch:$cx:$cy /o/\${i}_\${k}.png </dev/null; done < /o/times.txt"
if [ ! -d tools/cache/pyenv/onnxruntime ]; then
    docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/tools/cache":/c python:3.12-slim pip install -q --target /c/pyenv onnxruntime numpy pillow
fi
docker run --rm -u "$(id -u):$(id -g)" -e PYTHONPATH=/env -v "$PWD/tools/cache/pyenv":/env:ro -v "$PWD/tools":/tools:ro -v "$PWD/public/models":/m:ro \
    -v "$(dirname "$dump")":/d:ro -v "$crops":/c:ro -v "$(dirname "$timeline")":/t:ro -v "$(dirname "$out")":/out python:3.12-slim \
    python /tools/cast-name-check.py /m "/d/$(basename "$dump")" /c "/t/$(basename "$timeline")" "/out/$(basename "$out")" 2>&1 | grep -v telemetry
