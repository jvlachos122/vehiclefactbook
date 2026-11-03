#!/usr/bin/env python3
"""Extract NHTSA and EPA flat files to the names the build expects.

`scripts/fetch.sh` downloads the zips, then runs this. A renamed or missing
member exits with a message that names the source URL and the expected file.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sources import download_list, extract_all, raw_root  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true", help="Print url and zip name, tab separated")
    parser.add_argument("--root", default=None, help="Directory of downloaded zips (default: $VF_RAW)")
    args = parser.parse_args()
    if args.list:
        for url, zip_name in download_list():
            print(f"{url}\t{zip_name}", flush=True)
        return
    root = Path(args.root) if args.root else raw_root()
    extract_all(root)


if __name__ == "__main__":
    main()
