#!/usr/bin/env bash
# Download the public source archives.
# Zips stay in $VF_RAW. Text is extracted to $VF_RAW/extracted and is not committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${VF_RAW:-/tmp/vf-raw}"
mkdir -p "$DEST"

download() {
  local url="$1"
  local name="$2"
  echo "fetch $name"
  curl -fL --retry 3 --retry-delay 2 --user-agent "VehicleFactbook/1.0" -o "$DEST/$name" "$url"
}

list="$(python3 "$ROOT/extract_sources.py" --list)"
while IFS=$'\t' read -r url name; do
  [ -n "${url}" ] || continue
  download "$url" "$name"
done <<< "$list"

python3 "$ROOT/extract_sources.py" --root "$DEST"
echo "fetch done"
