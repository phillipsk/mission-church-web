#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SHORTS_DIR="$PROJECT_DIR/public/assets/shorts"
mkdir -p "$SHORTS_DIR"

REEL_IDS=(
  "1174440914928847"
  "1650803123756413"
  "2142592296349453"
  "1885402276284840"
  "1836718757568031"
  "1478756640850112"
  "4471641409714022"
  "2548908615616237"
)

for id in "${REEL_IDS[@]}"; do
  mp4_path="$SHORTS_DIR/reel_${id}.mp4"
  jpg_path="$SHORTS_DIR/reel_${id}.jpg"
  url="https://www.facebook.com/reel/${id}/"

  if [[ ! -s "$mp4_path" ]]; then
    echo "==> Downloading Facebook Reel $id..."
    yt-dlp \
      --no-warnings \
      -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" \
      --merge-output-format mp4 \
      -o "$mp4_path" \
      "$url" || echo "WARN: failed to download $id"
  else
    echo "==> Skipping existing $mp4_path"
  fi

  if [[ -s "$mp4_path" && ! -s "$jpg_path" ]]; then
    echo "==> Extracting poster thumbnail for $id..."
    ffmpeg -y -loglevel error -ss 00:00:01 -i "$mp4_path" -frames:v 1 -q:v 3 "$jpg_path" || \
      ffmpeg -y -loglevel error -ss 00:00:00 -i "$mp4_path" -frames:v 1 -q:v 3 "$jpg_path" || true
  fi
done

echo "==> Completed Facebook Shorts sync:"
ls -lh "$SHORTS_DIR"
