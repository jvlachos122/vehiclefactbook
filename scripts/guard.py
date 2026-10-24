#!/usr/bin/env python3
"""Compare downloaded zip hashes to data/sources.json.

Prints a final line of `unchanged` or `changed` for the weekly workflow.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_data import SOURCES, sha256_file  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    zips = Path(os.environ.get("VF_ZIPS", os.environ.get("VF_RAW", "/tmp/vf-raw")))
    previous_path = ROOT / "data" / "sources.json"
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    changed = False
    for key, _url, zipname, _text in SOURCES:
        path = zips / zipname
        if not path.exists():
            print(f"missing {zipname}")
            changed = True
            continue
        digest = sha256_file(path)
        old = (previous.get(key) or {}).get("sha256")
        if digest != old:
            print(f"changed {key}")
            changed = True
        else:
            print(f"same {key} {digest[:12]}")
    print("changed" if changed else "unchanged")


if __name__ == "__main__":
    main()
