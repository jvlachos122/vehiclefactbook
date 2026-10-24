#!/usr/bin/env python3
"""Fail the build if spot-check model years disagree with NHTSA's API, or if output JSON uses a PII field name."""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = "VehicleFactbook/1.0 (qa; +https://vehiclefactbook.com/methodology/)"
FORBIDDEN = {"vin", "city", "operator", "dealer", "vehicle_operator"}
SPOTS = [
    ("honda", "accord", 2018),
    ("honda", "civic", 2016),
    ("ford", "escape", 2017),
    ("nissan", "altima", 2015),
    ("toyota", "rav4", 2020),
]


def fail(message: str) -> None:
    print(f"QA FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def walk_keys(value, path: str):
    if isinstance(value, dict):
        for key, child in value.items():
            folded = str(key).casefold()
            if folded in FORBIDDEN:
                fail(f"forbidden field {key!r} in {path}")
            walk_keys(child, path)
    elif isinstance(value, list):
        for child in value:
            walk_keys(child, path)


def scan_tree(folder: Path) -> None:
    for path in folder.rglob("*"):
        if path.suffix == ".json" and path.is_file():
            walk_keys(json.loads(path.read_text()), str(path.relative_to(ROOT)))


def get_json(url: str):
    delay = 1.0
    last = None
    for _ in range(4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except Exception as exc:  # noqa: BLE001 — retry then fail the spot check
            last = exc
            time.sleep(delay)
            delay *= 2
    fail(f"{url} failed: {last}")


def api_count(kind: str, make: str, model: str, year: int) -> int:
    query = urllib.parse.urlencode({"make": make, "model": model, "modelYear": year})
    if kind == "recalls":
        doc = get_json(f"https://api.nhtsa.gov/recalls/recallsByVehicle?{query}")
        count = doc.get("Count")
    else:
        doc = get_json(f"https://api.nhtsa.gov/complaints/complaintsByVehicle?{query}")
        count = doc.get("count")
    if not isinstance(count, int):
        fail(f"{kind} {make} {model} {year} returned no count")
    return count


def close_enough(ours: int, api: int) -> bool:
    return abs(ours - api) <= max(2, round(api * 0.01))


def spot(make: str, model: str, year: int) -> None:
    summary = json.loads((ROOT / "data" / "site" / "summary.json").read_text())
    make_row = next(item for item in summary["makes"] if item["slug"] == make)
    model_row = next(item for item in make_row["models"] if item["slug"] == model)
    year_row = next(item for item in model_row["years"] if item["y"] == year)
    if not year_row.get("headlineExact"):
        fail(f"{year} {make} {model} is not an exact-name headline, so it cannot be checked against the API model name")
    recalls = api_count("recalls", make, model, year)
    complaints = api_count("complaints", make, model, year)
    print(
        f"QA {year} {make} {model}: recalls file {year_row['recalls']} api {recalls}; "
        f"complaints file {year_row['complaints']} api {complaints}"
    )
    if not close_enough(year_row["recalls"], recalls):
        fail(f"{year} {make} {model} recalls {year_row['recalls']} != API {recalls}")
    if not close_enough(year_row["complaints"], complaints):
        fail(f"{year} {make} {model} complaints {year_row['complaints']} != API {complaints}")


def main() -> None:
    scan_tree(ROOT / "data")
    for make, model, year in SPOTS:
        spot(make, model, year)
    print("QA OK")


if __name__ == "__main__":
    main()
