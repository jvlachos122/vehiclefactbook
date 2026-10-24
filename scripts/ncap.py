#!/usr/bin/env python3
"""Cache NHTSA 5-Star Safety Ratings for model years 2011 through the newest year the API lists.

Weekly refreshes should pass --latest 3 so only the three newest model years are fetched again.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "ncap"
API = "https://api.nhtsa.gov/SafetyRatings"
WORKERS = 4
UA = "VehicleFactbook/1.0 (safety-ratings cache; +https://vehiclefactbook.com/methodology/)"

KEEP = {
    "overall": "OverallRating",
    "front": "OverallFrontCrashRating",
    "frontDriver": "FrontCrashDriversideRating",
    "frontPassenger": "FrontCrashPassengersideRating",
    "side": "OverallSideCrashRating",
    "sideDriver": "SideCrashDriversideRating",
    "sidePassenger": "SideCrashPassengersideRating",
    "pole": "SidePoleCrashRating",
    "rollover": "RolloverRating",
    "esc": "NHTSAElectronicStabilityControl",
    "fcw": "NHTSAForwardCollisionWarning",
    "ldw": "NHTSALaneDepartureWarning",
}


def get_json(url: str):
    delay = 1.0
    last = None
    for _ in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.load(response)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            time.sleep(delay)
            delay = min(delay * 2, 20)
    raise RuntimeError(f"{url} failed: {last}")


def q(part: str) -> str:
    # Keep slashes. The API treats IMPREZA WRX/STI as two path segments and
    # returns 400 if the slash is percent-encoded.
    return urllib.parse.quote(str(part), safe="/")


def blank(value):
    if value is None:
        return ""
    text = str(value).strip()
    if text.lower() in {"not rated", "n/a", "na", "none"}:
        return text if text.lower() == "not rated" else ""
    return text


def photo_url(row: dict) -> str:
    for key in ("FrontCrashPicture", "SideCrashPicture", "SidePolePicture"):
        value = row.get(key) or ""
        if isinstance(value, str) and value.startswith("https://static.nhtsa.gov/"):
            return value
    return ""


def slim(make: str, model: str, row: dict) -> dict:
    item = {
        "make": make,
        "model": model,
        "description": row.get("VehicleDescription") or "",
        "vehicleId": row.get("VehicleId"),
        "photo": photo_url(row),
    }
    for dest, src in KEEP.items():
        item[dest] = blank(row.get(src))
    poss = row.get("RolloverPossibility")
    if isinstance(poss, (int, float)):
        item["rolloverPossibility"] = poss
    elif isinstance(poss, str) and poss.strip():
        try:
            item["rolloverPossibility"] = float(poss)
        except ValueError:
            item["rolloverPossibility"] = None
    else:
        item["rolloverPossibility"] = None
    return item


def fetch_variant(make: str, model: str, vehicle_id: int) -> dict:
    data = get_json(f"{API}/VehicleId/{vehicle_id}")
    results = data.get("Results") or []
    if not results:
        raise RuntimeError(f"empty VehicleId {vehicle_id}")
    return slim(make, model, results[0])


def fetch_year(year: int) -> dict:
    failures = 0
    makes_doc = get_json(f"{API}/modelyear/{year}")
    makes = [row.get("Make") for row in makes_doc.get("Results") or [] if row.get("Make")]
    model_rows = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(get_json, f"{API}/modelyear/{year}/make/{q(make)}"): make for make in makes
        }
        for future in as_completed(futures):
            make = futures[future]
            try:
                doc = future.result()
            except Exception as exc:  # noqa: BLE001 — skip one make and keep the year
                failures += 1
                print(f"  make {make} failed: {exc}", file=sys.stderr)
                continue
            for row in doc.get("Results") or []:
                model = row.get("Model")
                if model:
                    model_rows.append((make, model))

    id_rows = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(
                get_json,
                f"{API}/modelyear/{year}/make/{q(make)}/model/{q(model)}",
            ): (make, model)
            for make, model in model_rows
        }
        for future in as_completed(futures):
            make, model = futures[future]
            try:
                doc = future.result()
            except Exception as exc:  # noqa: BLE001 — skip one model and keep the year
                failures += 1
                print(f"  model {make} {model} failed: {exc}", file=sys.stderr)
                continue
            for row in doc.get("Results") or []:
                vehicle_id = row.get("VehicleId")
                if vehicle_id:
                    id_rows.append((make, model, int(vehicle_id)))

    variants = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(fetch_variant, make, model, vehicle_id): vehicle_id
            for make, model, vehicle_id in id_rows
        }
        for future in as_completed(futures):
            try:
                variants.append(future.result())
            except Exception as exc:  # noqa: BLE001 — keep the year, record the gap
                failures += 1
                print(f"  vehicle {futures[future]} failed: {exc}", file=sys.stderr)
    variants.sort(key=lambda item: (item["make"], item["model"], item["description"], item["vehicleId"] or 0))
    return {
        "year": year,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "makes": len(makes),
        "models": len(model_rows),
        "variants": variants,
        "failures": failures,
    }


def available_years() -> list[int]:
    doc = get_json(API)
    years = []
    for row in doc.get("Results") or []:
        try:
            years.append(int(row.get("ModelYear")))
        except (TypeError, ValueError):
            continue
    return sorted(set(years))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--latest", type=int, default=0, help="Re-fetch only the N newest model years")
    parser.add_argument("--year", type=int, action="append", dest="years")
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    listed = available_years()
    newest = max(listed) if listed else 0
    wanted = [year for year in listed if 2011 <= year <= newest]
    if args.years:
        wanted = [year for year in args.years if year in listed]
    elif args.latest:
        wanted = wanted[-args.latest :]
    print(f"NCAP years to fetch: {wanted[0]}–{wanted[-1]} ({len(wanted)} years)" if wanted else "NCAP: no years")
    for year in wanted:
        dest = OUT_DIR / f"{year}.json"
        if dest.exists() and not args.latest and not args.years:
            doc = json.loads(dest.read_text())
            print(f"NCAP {year}: cached {len(doc.get('variants') or [])} variants")
            continue
        started = time.time()
        doc = fetch_year(year)
        if dest.exists():
            previous = json.loads(dest.read_text())
            same = (
                previous.get("variants") == doc["variants"]
                and previous.get("failures") == doc["failures"]
                and previous.get("makes") == doc["makes"]
                and previous.get("models") == doc["models"]
            )
            if same:
                print(f"NCAP {year}: unchanged ({len(doc['variants'])} variants)")
                continue
        dest.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
        print(
            f"NCAP {year}: {doc['makes']} makes, {doc['models']} models, "
            f"{len(doc['variants'])} variants, {doc['failures']} failures, {time.time() - started:.0f}s"
        )
        if doc["variants"] and doc["failures"] > max(5, 0.05 * (len(doc["variants"]) + doc["failures"])):
            raise SystemExit(f"NCAP {year} failure rate too high")


if __name__ == "__main__":
    main()
