#!/bin/sh
# OCR のモデル（認識・検出）と文字辞書を public/models/ に取ってくる（リポジトリには含めない。合わせて 21MB あるため）
#   認識・検出モデル: PP-OCRv5 mobile rec / det の ONNX 変換版（Apache-2.0）
#   文字辞書:   PaddleOCR 公式の ppocrv5_dict.txt（Apache-2.0）
set -eu
cd "$(dirname "$0")/../public/models"

curl -fL -o ppocrv5_rec.onnx \
  https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_rec.onnx
curl -fL -o ppocrv5_det.onnx \
  https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_det.onnx
curl -fL -o ppocrv5_dict.txt \
  https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_dict.txt

# 取り違えの検出（モデルの出力クラス数 18385 = 空白記号 + 辞書 18383 行 + 半角スペース）
lines=$(wc -l < ppocrv5_dict.txt)
[ "$lines" -eq 18383 ] || { echo "辞書の行数が想定と違う: $lines" >&2; exit 1; }
ls -l ppocrv5_rec.onnx ppocrv5_det.onnx ppocrv5_dict.txt
