#!/usr/bin/env bash
# Download the five public source archives. Text is unzipped under $VF_RAW and is not committed.
set -euo pipefail

DEST="${VF_RAW:-/tmp/vf-raw}"
mkdir -p "$DEST/extracted"

download() {
  local url="$1"
  local name="$2"
  echo "fetch $name"
  curl -fL --retry 3 --retry-delay 2 --user-agent "VehicleFactbook/1.0" -o "$DEST/$name" "$url"
  unzip -o -q "$DEST/$name" -d "$DEST/extracted"
}

download "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip" "FLAT_RCL_POST_2010.zip"
download "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip" "FLAT_RCL_PRE_2010.zip"
download "https://static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip" "FLAT_CMPL.zip"
download "https://static.nhtsa.gov/odi/ffdd/inv/FLAT_INV.zip" "FLAT_INV.zip"
download "https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip" "vehicles.csv.zip"
echo "fetch done"
