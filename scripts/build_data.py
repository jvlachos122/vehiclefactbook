#!/usr/bin/env python3
"""Build the compact site data from EPA and NHTSA flat files.

Reads the extracted sources (see scripts/fetch.sh). Writes data/site, data/sources.json,
data/unmatched.csv, data/recent.json, and data/campaign-index.json.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

from lib_norm import assign_year, load_manual, norm_make, norm_model, slug

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "data" / "site"
MODELS = SITE / "models"
CROSSWALK = ROOT / "data" / "model-crosswalk.csv"
UA = "VehicleFactbook/1.0 (data pipeline; +https://vehiclefactbook.com/methodology/)"

SOURCES = [
    ("recalls_post_2010", "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip", "FLAT_RCL_POST_2010.zip", "FLAT_RCL_POST_2010.txt"),
    ("recalls_pre_2010", "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip", "FLAT_RCL_PRE_2010.zip", "FLAT_RCL_PRE_2010.txt"),
    ("complaints", "https://static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip", "FLAT_CMPL.zip", "FLAT_CMPL.txt"),
    ("investigations", "https://static.nhtsa.gov/odi/ffdd/inv/FLAT_INV.zip", "FLAT_INV.zip", "FLAT_INV.txt"),
    ("epa", "https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip", "vehicles.csv.zip", "vehicles.csv"),
]


def log(message: str) -> None:
    print(message, flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def header_value(url: str, name: str) -> str:
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.headers.get(name, "")


def file_day(last_modified: str) -> str:
    if not last_modified:
        return ""
    try:
        return parsedate_to_datetime(last_modified).date().isoformat()
    except (TypeError, ValueError, IndexError):
        return ""


def clean_text(value: str, limit: int = 300) -> str:
    text = re.sub(r"\s+", " ", (value or "").replace("\x00", " ")).strip()
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:")
    return (cut or text[: limit - 1]) + "…"


def iso_day(value: str) -> str:
    text = (value or "").strip()
    if len(text) == 8 and text.isdigit() and text != "00000000":
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"
    return ""


def as_int(value: str) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def positive_number(value: str):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    if number.is_integer():
        return int(number)
    return round(number, 4)


def score_value(value: str):
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return None if number < 0 else number


def yes(value: str) -> bool:
    return (value or "").strip().lower() == "yes"


def prefer(current: str | None, current_year: int, candidate: str, year: int) -> tuple[str, int]:
    if current is None or year > current_year:
        return candidate, year
    if year == current_year and sum(ch.isupper() for ch in candidate) > sum(ch.isupper() for ch in current):
        return candidate, year
    return current, current_year


def open_tsv(path: Path):
    return path.open(encoding="latin1", errors="replace")


def load_sources(raw_dir: Path, zip_dir: Path) -> dict:
    sources = {}
    for key, url, zip_name, text_name in SOURCES:
        zip_path = zip_dir / zip_name
        text_path = raw_dir / text_name
        if not text_path.exists():
            raise SystemExit(f"Missing extracted file {text_path}")
        last_modified = header_value(url, "Last-Modified")
        sources[key] = {
            "url": url,
            "sha256": sha256_file(zip_path) if zip_path.exists() else "",
            "bytes": zip_path.stat().st_size if zip_path.exists() else text_path.stat().st_size,
            "lastModified": last_modified,
            "fileDate": file_day(last_modified),
            "textFile": text_name,
        }
        log(f"source {key}: {sources[key]['fileDate']} {sources[key]['sha256'][:12]}")
    return sources


def load_epa(path: Path):
    grouped = {}
    rows_2000 = 0
    raw_makes = set()
    raw_models = set()
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        for row in csv.DictReader(handle):
            try:
                year = int(row["year"])
            except (TypeError, ValueError):
                continue
            if year < 2000 or year > 2035:
                continue
            rows_2000 += 1
            make = (row["make"] or "").strip()
            base = (row["baseModel"] or "").strip()
            if not make or not base:
                continue
            raw_makes.add(make)
            raw_models.add((make, base))
            make_norm = norm_make(make)
            model_norm = norm_model(base)
            key = (make_norm, model_norm)
            bucket = grouped.get(key)
            if bucket is None:
                bucket = {
                    "make_norm": make_norm,
                    "model_norm": model_norm,
                    "make": make,
                    "make_year": year,
                    "model": base,
                    "model_year": year,
                    "years": {},
                }
                grouped[key] = bucket
            bucket["make"], bucket["make_year"] = prefer(bucket["make"], bucket["make_year"], make, year)
            bucket["model"], bucket["model_year"] = prefer(bucket["model"], bucket["model_year"], base, year)
            config = {
                "model": (row["model"] or "").strip(),
                "vclass": (row["VClass"] or "").strip(),
                "displ": positive_number(row["displ"]),
                "cylinders": score_value(row["cylinders"]),
                "drive": (row["drive"] or "").strip(),
                "trany": (row["trany"] or "").strip(),
                "fuel": (row["fuelType1"] or "").strip(),
                "atv": (row["atvType"] or "").strip(),
                "cityMpg": positive_number(row["city08"]),
                "hwy": positive_number(row["highway08"]),
                "comb": positive_number(row["comb08"]),
                "kwh": positive_number(row["combE"]),
                "range": positive_number(row["range"]),
                "cost": positive_number(row["fuelCost08"]),
                "co2": positive_number(row["co2TailpipeGpm"]),
                "fe": score_value(row["feScore"]),
                "ghg": score_value(row["ghgScore"]),
            }
            year_bucket = bucket["years"].setdefault(year, [])
            signature = tuple(sorted(config.items()))
            if signature not in {tuple(sorted(item.items())) for item in year_bucket}:
                year_bucket.append(config)
    # The signature check above is quadratic per year. Rebuild deduped once more, cheaply.
    for bucket in grouped.values():
        for year, configs in list(bucket["years"].items()):
            seen = set()
            kept = []
            for config in configs:
                signature = tuple(config.items())
                if signature in seen:
                    continue
                seen.add(signature)
                kept.append(config)
            bucket["years"][year] = kept
    return grouped, rows_2000, len(raw_makes), len(raw_models)


def spine_from_groups(grouped: dict):
    makes = {}
    for bucket in grouped.values():
        make_slug = slug(bucket["make"])
        model_slug = slug(bucket["model"])
        if model_slug in {"years", "index", "recalls", "tools", "guides", "about", "compare"}:
            raise SystemExit(f"Model slug {model_slug!r} collides with a static path ({bucket['make']} {bucket['model']})")
        make = makes.setdefault(make_slug, {"name": bucket["make"], "norm": bucket["make_norm"], "models": {}})
        if bucket["make_year"] > make.get("name_year", -1) or (
            bucket["make_year"] == make.get("name_year", -1)
            and sum(ch.isupper() for ch in bucket["make"]) > sum(ch.isupper() for ch in make["name"])
        ):
            make["name"] = bucket["make"]
            make["name_year"] = bucket["make_year"]
        if model_slug in make["models"] and make["models"][model_slug]["norm"] != bucket["model_norm"]:
            raise SystemExit(f"Slug collision {make_slug}/{model_slug}")
        make["models"][model_slug] = {
            "name": bucket["model"],
            "norm": bucket["model_norm"],
            "years": bucket["years"],
        }
    return makes


def scan_keys(raw_dir: Path):
    """Distinct normalized NHTSA make/model/year keys, plus file-level counts."""
    keys = defaultdict(set)
    raw_names = defaultdict(set)
    stats = {
        "recall_rows_post": 0,
        "recall_rows_pre": 0,
        "recall_rows_pre_short": 0,
        "vehicle_campaigns_post_2010": set(),
        "vehicle_campaigns_pre_2010": set(),
        "complaint_rows": 0,
        "complaint_vehicle_rows": 0,
        "complaint_vehicle_odino": set(),
        "investigation_rows": 0,
        "investigation_actions": set(),
    }

    def add(make: str, model: str, year: int):
        make_norm = norm_make(make)
        model_norm = norm_model(model)
        if not make_norm or not model_norm or year < 2000 or year > 2035:
            return
        keys[(make_norm, year)].add(model_norm)
        names = raw_names[(make_norm, model_norm, year)]
        if len(names) < 8:
            names.add(model.strip())

    def scan_recalls(path: Path, pre: bool):
        with open_tsv(path) as handle:
            for line in handle:
                parts = line.rstrip("\n").split("\t")
                if pre:
                    stats["recall_rows_pre"] += 1
                else:
                    stats["recall_rows_post"] += 1
                if len(parts) < 29:
                    if pre:
                        stats["recall_rows_pre_short"] += 1
                    continue
                if parts[10] != "V":
                    continue
                camp = parts[1].strip()
                if pre:
                    stats["vehicle_campaigns_pre_2010"].add(camp)
                else:
                    stats["vehicle_campaigns_post_2010"].add(camp)
                try:
                    year = int(parts[4])
                except ValueError:
                    continue
                add(parts[2], parts[3], year)

    scan_recalls(raw_dir / "FLAT_RCL_POST_2010.txt", False)
    scan_recalls(raw_dir / "FLAT_RCL_PRE_2010.txt", True)
    log(
        f"recall rows post {stats['recall_rows_post']:,} pre {stats['recall_rows_pre']:,}; "
        f"vehicle campaigns post-2010 {len(stats['vehicle_campaigns_post_2010']):,}"
    )

    with open_tsv(raw_dir / "FLAT_CMPL.txt") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            stats["complaint_rows"] += 1
            if len(parts) != 51 or parts[45] != "V":
                continue
            stats["complaint_vehicle_rows"] += 1
            odino = parts[1].strip()
            if odino.isdigit():
                stats["complaint_vehicle_odino"].add(int(odino))
            try:
                year = int(parts[5])
            except ValueError:
                continue
            add(parts[3], parts[4], year)
    log(
        f"complaint rows {stats['complaint_rows']:,}; vehicle rows {stats['complaint_vehicle_rows']:,}; "
        f"distinct vehicle ODINO {len(stats['complaint_vehicle_odino']):,}"
    )

    with open_tsv(raw_dir / "FLAT_INV.txt") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            stats["investigation_rows"] += 1
            if len(parts) < 11:
                continue
            action = parts[0].strip()
            if action:
                stats["investigation_actions"].add(action)
            try:
                year = int(parts[3])
            except ValueError:
                continue
            add(parts[1], parts[2], year)
    log(f"investigation rows {stats['investigation_rows']:,}; actions {len(stats['investigation_actions']):,}")
    return keys, raw_names, stats


def build_targets(makes: dict, keys, manual: dict):
    target = {}
    meta = {}
    unmatched_rows = []
    method_counts = defaultdict(int)
    matched = 0
    total = 0
    for make_slug, make in makes.items():
        manual_for = {}
        for model_slug, model in make["models"].items():
            manual_for[model["norm"]] = set(manual.get((make["norm"], model["norm"]), set()))
        years = sorted({year for model in make["models"].values() for year in model["years"]})
        for year in years:
            epa_models = [
                (model_slug, model["norm"])
                for model_slug, model in make["models"].items()
                if year in model["years"]
            ]
            assigned, methods, _unused = assign_year(
                make["norm"],
                epa_models,
                keys.get((make["norm"], year), set()),
                manual_for,
            )
            for model_slug, _norm in epa_models:
                total += 1
                names = assigned.get(model_slug) or []
                method = methods.get(model_slug, "none")
                meta[(make_slug, model_slug, year)] = {"method": method, "names": names}
                if names:
                    matched += 1
                    method_counts[method] += 1
                    for name in names:
                        target[(make["norm"], name, year)] = (make_slug, model_slug)
                else:
                    model = make["models"][model_slug]
                    unmatched_rows.append((make["name"], model["name"], year, make["norm"], model["norm"]))
    log(f"MMY spine {total:,}; matched {matched:,}; unmatched {total - matched:,}")
    for method, count in sorted(method_counts.items(), key=lambda item: (-item[1], item[0])):
        log(f"  match {method}: {count:,}")
    return target, meta, unmatched_rows, method_counts, matched, total


def empty_year(method: str, names: list[str]) -> dict:
    return {
        "match": method,
        "nhtsaModels": names,
        "configs": [],
        "byName": {},
        "ncap": [],
    }


def init_details(makes, match_meta):
    details = {}
    for make_slug, make in makes.items():
        for model_slug, model in make["models"].items():
            years = {}
            for year, configs in model["years"].items():
                info = match_meta[(make_slug, model_slug, year)]
                year_row = empty_year(info["method"], info["names"])
                year_row["configs"] = configs
                years[year] = year_row
            details[(make_slug, model_slug)] = {
                "make": make["name"],
                "makeSlug": make_slug,
                "makeNorm": make["norm"],
                "model": model["name"],
                "modelSlug": model_slug,
                "modelNorm": model["norm"],
                "years": years,
            }
    return details


def aggregate(raw_dir: Path, makes, target, details, raw_names):
    advisories = {}
    campaign_dates = {}
    takata_camps = set()

    def recall_pass(path: Path):
        with open_tsv(path) as handle:
            for line in handle:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 29 or parts[10] != "V":
                    continue
                camp = parts[1].strip()
                if not camp:
                    continue
                try:
                    year = int(parts[4])
                except ValueError:
                    year = 0
                date = iso_day(parts[15]) or iso_day(parts[16])
                if date and (camp not in campaign_dates or date < campaign_dates[camp]):
                    campaign_dates[camp] = date
                text = " ".join((parts[6], parts[19], parts[20], parts[22]))
                is_takata = "TAKATA" in text.upper()
                dnd = yes(parts[27])
                park = yes(parts[28])
                if is_takata:
                    takata_camps.add(camp)
                make_raw = parts[2].strip()
                model_raw = parts[3].strip()
                model_norm = norm_model(model_raw)
                spine = target.get((norm_make(make_raw), model_norm, year)) if year else None
                recent_enough = bool(date) and date >= "2025-01-01"
                if dnd or park or is_takata or spine or recent_enough:
                    item = advisories.get(camp)
                    if item is None:
                        item = {
                            "camp": camp,
                            "date": date,
                            "component": clean_text(parts[6], 120),
                            "summary": clean_text(parts[19], 300),
                            "dnd": dnd,
                            "park": park,
                            "takata": is_takata,
                            "vehicles": set(),
                            "examples": [],
                        }
                        advisories[camp] = item
                    else:
                        item["dnd"] = item["dnd"] or dnd
                        item["park"] = item["park"] or park
                        item["takata"] = item["takata"] or is_takata
                        if date and (not item["date"] or date < item["date"]):
                            item["date"] = date
                        if not item["summary"]:
                            item["summary"] = clean_text(parts[19], 300)
                    if year and (make_raw, model_raw, year) not in item["vehicles"]:
                        item["vehicles"].add((make_raw, model_raw, year))
                        if spine and len(item["examples"]) < 12:
                            item["examples"].append(
                                {
                                    "make": make_raw,
                                    "model": model_raw,
                                    "year": year,
                                    "href": f"/{spine[0]}/{spine[1]}/{year}/",
                                }
                            )
                if not spine:
                    continue
                year_row = details[spine]["years"][year]
                named = year_row["byName"].setdefault(model_norm, {"recalls": {}, "complaints": None, "investigations": {}})
                recall = named["recalls"].get(camp)
                component = clean_text(parts[6], 160)
                if recall is None:
                    named["recalls"][camp] = {
                        "camp": camp,
                        "date": date,
                        "component": component,
                        "summary": clean_text(parts[19], 300),
                        "dnd": dnd,
                        "park": park,
                    }
                else:
                    recall["dnd"] = recall["dnd"] or dnd
                    recall["park"] = recall["park"] or park
                    if (
                        component
                        and component not in recall["component"].split("; ")
                        and len(recall["component"]) < 180
                    ):
                        recall["component"] = "; ".join(part for part in (recall["component"], component) if part)
                    if date and (not recall["date"] or date < recall["date"]):
                        recall["date"] = date

    log("aggregating recalls")
    recall_pass(raw_dir / "FLAT_RCL_POST_2010.txt")
    recall_pass(raw_dir / "FLAT_RCL_PRE_2010.txt")

    complaints = {}
    log("aggregating complaints")
    with open_tsv(raw_dir / "FLAT_CMPL.txt") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 51 or parts[45] != "V":
                continue
            try:
                year = int(parts[5])
            except ValueError:
                continue
            model_norm = norm_model(parts[4])
            spine = target.get((norm_make(parts[3]), model_norm, year))
            if not spine:
                continue
            odino = parts[1].strip()
            if not odino:
                continue
            key = (spine[0], spine[1], year, model_norm)
            bucket = complaints.get(key)
            if bucket is None:
                bucket = [{}, defaultdict(set)]
                complaints[key] = bucket
            received = parts[16][:4] if len(parts[16]) >= 4 and parts[16][:4].isdigit() else ""
            crash = 1 if parts[6] == "Y" else 0
            fire = 1 if parts[8] == "Y" else 0
            injured = as_int(parts[9])
            deaths = as_int(parts[10])
            current = bucket[0].get(odino)
            if current is None:
                bucket[0][odino] = [received, crash, fire, injured, deaths]
            else:
                if not current[0]:
                    current[0] = received
                current[1] = max(current[1], crash)
                current[2] = max(current[2], fire)
                current[3] = max(current[3], injured)
                current[4] = max(current[4], deaths)
            component = clean_text(parts[11], 160) or "Component not named in the NHTSA file"
            bucket[1][component].add(odino)

    log("aggregating investigations")
    action_has_close = {}
    with open_tsv(raw_dir / "FLAT_INV.txt") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 11:
                continue
            action = parts[0].strip()
            closed = iso_day(parts[7])
            if action:
                action_has_close[action] = action_has_close.get(action, False) or bool(closed)
            try:
                year = int(parts[3])
            except ValueError:
                continue
            model_norm = norm_model(parts[2])
            spine = target.get((norm_make(parts[1]), model_norm, year))
            if not spine or not action:
                continue
            year_row = details[spine]["years"][year]
            named = year_row["byName"].setdefault(model_norm, {"recalls": {}, "complaints": None, "investigations": {}})
            current = named["investigations"].get(action)
            component = clean_text(parts[4], 160)
            if current is None:
                named["investigations"][action] = {
                    "action": action,
                    "subject": clean_text(parts[9], 200),
                    "opened": iso_day(parts[6]),
                    "closed": closed,
                    "closeDateInFile": bool(closed),
                    "component": component,
                }
            else:
                if component and component not in current["component"].split("; "):
                    current["component"] = "; ".join(part for part in (current["component"], component) if part)
                if not current["subject"]:
                    current["subject"] = clean_text(parts[9], 200)
                if closed and not current["closed"]:
                    current["closed"] = closed
                    current["closeDateInFile"] = True
    open_actions = {action for action, has_close in action_has_close.items() if not has_close}
    log(f"investigation actions with no close date: {len(open_actions):,}")

    for (make_slug, model_slug, year, model_norm), bucket in complaints.items():
        odinos, comps = bucket
        by_year = defaultdict(int)
        crash = fire = injured = deaths = 0
        for received, c_flag, f_flag, inj, dead in odinos.values():
            crash += c_flag
            fire += f_flag
            injured += inj
            deaths += dead
            if received:
                by_year[int(received)] += 1
        top = sorted(((name, len(ids)) for name, ids in comps.items()), key=lambda item: (-item[1], item[0]))[:10]
        named = details[(make_slug, model_slug)]["years"][year]["byName"].setdefault(
            model_norm, {"recalls": {}, "complaints": None, "investigations": {}}
        )
        named["complaints"] = {
            "n": len(odinos),
            "crash": crash,
            "fire": fire,
            "injured": injured,
            "deaths": deaths,
            "top": [{"component": name, "n": count} for name, count in top],
            "byYear": [{"year": y, "n": by_year[y]} for y in sorted(by_year)],
        }
    return advisories, campaign_dates, takata_camps, open_actions


def display_names(info_names: list[str], make_norm: str, year: int, raw_names) -> list[str]:
    shown = []
    for name in info_names:
        raw = sorted(raw_names.get((make_norm, name, year), set()))
        shown.append(raw[0] if raw else name)
    return shown


def attach_raw_names(details, match_meta, raw_names):
    for (make_slug, model_slug), doc in details.items():
        for year, year_row in doc["years"].items():
            info = match_meta[(make_slug, model_slug, year)]
            year_row["nhtsaModels"] = display_names(info["names"], doc["makeNorm"], year, raw_names)


def empty_counts():
    return {"n": 0, "crash": 0, "fire": 0, "injured": 0, "deaths": 0, "top": [], "byYear": []}


def pack_name(model_norm: str, label: str, exact: bool, named: dict) -> dict:
    recalls = list(named.get("recalls", {}).values())
    recalls.sort(key=lambda item: (item["date"], item["camp"]), reverse=True)
    investigations = list(named.get("investigations", {}).values())
    investigations.sort(key=lambda item: (item["opened"], item["action"]))
    return {
        "norm": model_norm,
        "name": label,
        "exact": exact,
        "recalls": recalls,
        "complaints": named.get("complaints") or empty_counts(),
        "investigations": investigations,
    }


def finalize_year_lists(details, match_meta, raw_names):
    """Headline counts follow the NHTSA name that equals the EPA model when that name exists.

    Other matched names (a hybrid name, a trim suffix) stay on the page but do not
    change the headline, so an API lookup of the EPA model name stays comparable.
    """
    for (make_slug, model_slug), doc in details.items():
        for year, year_row in doc["years"].items():
            info = match_meta[(make_slug, model_slug, year)]
            labels = {
                norm: display_names([norm], doc["makeNorm"], year, raw_names)[0]
                for norm in year_row["byName"]
            }
            packed = [
                pack_name(norm, labels.get(norm, norm), norm == doc["modelNorm"], named)
                for norm, named in sorted(year_row["byName"].items())
            ]
            exact = [item for item in packed if item["exact"]]
            if doc["modelNorm"] in info["names"]:
                headline = exact[0] if exact else pack_name(doc["modelNorm"], doc["model"], True, {})
                also = [item for item in packed if not item["exact"]]
                year_row["headlineExact"] = True
                year_row["splitNames"] = False
            else:
                headline = merge_names(packed, doc["model"])
                headline["complaints"]["top"] = []
                also = packed
                year_row["headlineExact"] = False
                year_row["splitNames"] = True
            year_row["recalls"] = headline["recalls"]
            year_row["complaints"] = headline["complaints"]
            year_row["investigations"] = headline["investigations"]
            year_row["also"] = also
            year_row["nhtsaModels"] = display_names(info["names"], doc["makeNorm"], year, raw_names)


def merge_names(packed: list[dict], label: str) -> dict:
    recalls = {}
    investigations = {}
    complaints = empty_counts()
    seen = set()
    by_year = defaultdict(int)
    top = defaultdict(int)
    for item in packed:
        for recall in item["recalls"]:
            recalls.setdefault(recall["camp"], recall)
        for inv in item["investigations"]:
            investigations.setdefault(inv["action"], inv)
        for odino_year in item["complaints"]["byYear"]:
            by_year[odino_year["year"]] += odino_year["n"]
        for comp in item["complaints"]["top"]:
            top[comp["component"]] += comp["n"]
        complaints["n"] += item["complaints"]["n"]
        complaints["crash"] += item["complaints"]["crash"]
        complaints["fire"] += item["complaints"]["fire"]
        complaints["injured"] += item["complaints"]["injured"]
        complaints["deaths"] += item["complaints"]["deaths"]
        seen.add(item["norm"])
    complaints["byYear"] = [{"year": year, "n": by_year[year]} for year in sorted(by_year)]
    complaints["top"] = [
        {"component": name, "n": count}
        for name, count in sorted(top.items(), key=lambda item: (-item[1], item[0]))[:10]
    ]
    recall_list = sorted(recalls.values(), key=lambda item: (item["date"], item["camp"]), reverse=True)
    inv_list = sorted(investigations.values(), key=lambda item: (item["opened"], item["action"]))
    return {
        "norm": "",
        "name": label,
        "exact": False,
        "recalls": recall_list,
        "complaints": complaints,
        "investigations": inv_list,
        "names": sorted(seen),
    }


def summary_numbers(configs: list[dict]):
    mpg = [config["comb"] for config in configs if config["atv"] != "EV" and config["comb"]]
    mpge = [config["comb"] for config in configs if config["atv"] == "EV" and config["comb"]]
    kwh = [config["kwh"] for config in configs if config["kwh"]]
    ranges = [config["range"] for config in configs if config["range"]]
    costs = [config["cost"] for config in configs if config["cost"]]
    ev_only = bool(configs) and all(config["atv"] == "EV" for config in configs)

    def span(values):
        if not values:
            return None, None
        return min(values), max(values)

    mpg_min, mpg_max = span(mpg)
    mpge_min, mpge_max = span(mpge)
    kwh_min, kwh_max = span(kwh)
    cost_min, cost_max = span(costs)
    return {
        "mpgMin": mpg_min,
        "mpgMax": mpg_max,
        "mpgeMin": mpge_min,
        "mpgeMax": mpge_max,
        "kwhMin": kwh_min,
        "kwhMax": kwh_max,
        "rangeMax": max(ranges) if ranges else None,
        "costMin": cost_min,
        "costMax": cost_max,
        "evOnly": ev_only,
    }


def star_span(variants: list[dict]):
    nums = []
    for variant in variants:
        overall = str(variant.get("overall") or "")
        if overall.isdigit():
            nums.append(int(overall))
    if not nums:
        return None, None
    return min(nums), max(nums)


def year_summary(year: int, year_row: dict) -> dict:
    complaints = year_row["complaints"] or empty_counts()
    recalls = year_row["recalls"]
    investigations = year_row["investigations"]
    also_complaints = 0 if year_row.get("splitNames") else sum(item["complaints"]["n"] for item in year_row.get("also") or [])
    also_recalls = 0 if year_row.get("splitNames") else sum(len(item["recalls"]) for item in year_row.get("also") or [])
    numbers = summary_numbers(year_row["configs"])
    star_min, star_max = star_span(year_row["ncap"])
    has_nhtsa = year_row["match"] != "none" and (
        recalls or complaints.get("n") or investigations
    )
    return {
        "y": year,
        "recalls": len(recalls),
        "dnd": sum(1 for item in recalls if item["dnd"]),
        "park": sum(1 for item in recalls if item["park"]),
        "complaints": complaints.get("n", 0),
        "crash": complaints.get("crash", 0),
        "fire": complaints.get("fire", 0),
        "injured": complaints.get("injured", 0),
        "deaths": complaints.get("deaths", 0),
        "investigations": len(investigations),
        "invOpen": sum(1 for item in investigations if not item["closeDateInFile"]),
        "starMin": star_min,
        "starMax": star_max,
        "match": year_row["match"],
        "headlineExact": bool(year_row.get("headlineExact")),
        "alsoComplaints": also_complaints,
        "alsoRecalls": also_recalls,
        "hasNhtsa": bool(has_nhtsa),
        **numbers,
    }


def write_models(details):
    if MODELS.exists():
        for path in MODELS.rglob("*.json"):
            path.unlink()
    makes_summary = []
    lookup_makes = []
    config_doc = {}
    mmy_count = 0
    years_pages = 0
    for (make_slug, model_slug), doc in sorted(details.items()):
        out_dir = MODELS / make_slug
        out_dir.mkdir(parents=True, exist_ok=True)
        serial_years = {}
        summary_years = []
        lookup_years = []
        for year in sorted(doc["years"]):
            year_row = doc["years"][year]
            split = bool(year_row.get("splitNames"))
            serial_years[str(year)] = {
                "match": year_row["match"],
                "nhtsaModels": year_row["nhtsaModels"],
                "configs": year_row["configs"],
                "headlineExact": bool(year_row.get("headlineExact")),
                "splitNames": split,
                "recalls": [] if split else year_row["recalls"],
                "complaints": empty_counts() if split else (year_row["complaints"] or empty_counts()),
                "investigations": [] if split else year_row["investigations"],
                "also": year_row.get("also") or [],
                "ncap": year_row["ncap"],
            }
            summary = year_summary(year, year_row)
            summary_years.append(summary)
            lookup_years.append(
                {
                    "y": year,
                    "rc": summary["recalls"],
                    "cm": summary["complaints"],
                    "mpg": [summary["mpgMin"], summary["mpgMax"]],
                    "mpge": [summary["mpgeMin"], summary["mpgeMax"]],
                    "cost": [summary["costMin"], summary["costMax"]],
                    "kwh": [summary["kwhMin"], summary["kwhMax"]],
                    "range": summary["rangeMax"],
                    "star": [summary["starMin"], summary["starMax"]],
                    "ev": 1 if summary["evOnly"] else 0,
                }
            )
            config_doc[f"{make_slug}/{model_slug}/{year}"] = [
                [
                    config["model"],
                    config["displ"],
                    config["cylinders"],
                    config["trany"],
                    config["drive"],
                    config["fuel"],
                    config["atv"],
                    config["cityMpg"],
                    config["hwy"],
                    config["comb"],
                    config["kwh"],
                    config["range"],
                    config["cost"],
                ]
                for config in year_row["configs"]
            ]
            mmy_count += 1
        nhtsa_years = sum(1 for item in summary_years if item["hasNhtsa"])
        years_page = nhtsa_years >= 3
        if years_page:
            years_pages += 1
        payload = {
            "make": doc["make"],
            "makeSlug": make_slug,
            "makeNorm": doc["makeNorm"],
            "model": doc["model"],
            "modelSlug": model_slug,
            "modelNorm": doc["modelNorm"],
            "yearsPage": years_page,
            "years": serial_years,
        }
        (out_dir / f"{model_slug}.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")
        makes_summary.append((make_slug, doc["make"], model_slug, doc["model"], summary_years, years_page))
        lookup_makes.append((make_slug, doc["make"], model_slug, doc["model"], lookup_years))
    return makes_summary, lookup_makes, config_doc, mmy_count, years_pages


def nest_summaries(makes_summary, lookup_makes):
    makes = {}
    for make_slug, make_name, model_slug, model_name, years, years_page in makes_summary:
        make = makes.setdefault(make_slug, {"slug": make_slug, "name": make_name, "models": []})
        make["models"].append({"slug": model_slug, "name": model_name, "yearsPage": years_page, "years": years})
    lookup = {}
    for make_slug, make_name, model_slug, model_name, years in lookup_makes:
        make = lookup.setdefault(make_slug, {"s": make_slug, "n": make_name, "models": []})
        make["models"].append({"s": model_slug, "n": model_name, "years": years})
    make_list = sorted(makes.values(), key=lambda item: item["name"].lower())
    for make in make_list:
        make["models"].sort(key=lambda item: item["name"].lower())
    lookup_list = sorted(lookup.values(), key=lambda item: item["n"].lower())
    for make in lookup_list:
        make["models"].sort(key=lambda item: item["n"].lower())
    return make_list, lookup_list


def advisory_public(item: dict) -> dict:
    return {
        "camp": item["camp"],
        "date": item["date"],
        "component": item["component"],
        "summary": item["summary"],
        "dnd": item["dnd"],
        "park": item["park"],
        "takata": item["takata"],
        "vehicles": len(item["vehicles"]),
        "examples": item["examples"],
    }


def write_advisories(advisories: dict, campaign_dates: dict):
    SITE.mkdir(parents=True, exist_ok=True)
    dated = [item for item in advisories.values() if item["date"]]
    vehicle_dates = [date for date in campaign_dates.values() if date]
    newest = max(vehicle_dates) if vehicle_dates else ""
    window_start = ""
    week = []
    if newest:
        start = datetime.strptime(newest, "%Y-%m-%d").date() - timedelta(days=6)
        window_start = start.isoformat()
        week = [item for item in advisories.values() if item["date"] and item["date"] >= window_start]
    def sort_key(item):
        return (item["date"] or "", item["camp"])
    dnd = [advisory_public(item) for item in advisories.values() if item["dnd"]]
    park = [advisory_public(item) for item in advisories.values() if item["park"]]
    takata = [advisory_public(item) for item in advisories.values() if item["takata"]]
    for group in (dnd, park, takata, week):
        group.sort(key=sort_key, reverse=True)
    recent = {
        "newestReportDate": newest,
        "windowStart": window_start,
        "rule": "Vehicle campaigns whose NHTSA report date (RCDATE) falls in the 7 days ending on the newest RCDATE in the recall files.",
        "campaigns": [advisory_public(item) for item in week],
    }
    (SITE / "advisories.json").write_text(
        json.dumps({"doNotDrive": dnd, "parkOutside": park, "takata": takata}, separators=(",", ":")) + "\n"
    )
    (ROOT / "data" / "recent.json").write_text(json.dumps(recent, separators=(",", ":")) + "\n")
    index = dict(sorted(campaign_dates.items()))
    (ROOT / "data" / "campaign-index.json").write_text(json.dumps(index, separators=(",", ":")) + "\n")
    log(
        f"advisories do-not-drive {len(dnd):,}; park-outside {len(park):,}; "
        f"takata {len(takata):,}; this-week {len(week):,} ({window_start}–{newest})"
    )
    return {"doNotDrive": len(dnd), "parkOutside": len(park), "takata": len(takata), "thisWeek": len(week)}


def load_ncap_variants():
    folder = ROOT / "data" / "ncap"
    by_year = defaultdict(lambda: defaultdict(set))
    rows = defaultdict(list)
    per_year = {}
    if not folder.exists():
        return by_year, rows, per_year
    for path in sorted(folder.glob("*.json")):
        doc = json.loads(path.read_text())
        year = int(doc["year"])
        variants = doc.get("variants") or []
        per_year[year] = {
            "variants": len(variants),
            "makes": doc.get("makes"),
            "models": doc.get("models"),
            "failures": doc.get("failures", 0),
            "fetchedAt": doc.get("fetchedAt"),
        }
        for variant in variants:
            make_norm = norm_make(variant.get("make") or "")
            model_norm = norm_model(variant.get("model") or "")
            by_year[(make_norm, year)][model_norm].add(variant.get("model") or "")
            rows[(make_norm, model_norm, year)].append(variant)
    return by_year, rows, per_year


def attach_ncap(makes, details, manual):
    by_year, rows, per_year = load_ncap_variants()
    if not per_year:
        log("NCAP cache empty; star tables left blank")
        return per_year
    attached = 0
    for make_slug, make in makes.items():
        manual_for = {model["norm"]: set(manual.get((make["norm"], model["norm"]), set())) for model in make["models"].values()}
        years = sorted({year for model in make["models"].values() for year in model["years"]})
        for year in years:
            if year < 2011:
                continue
            nhtsa_models = set(by_year.get((make["norm"], year), {}))
            if not nhtsa_models:
                continue
            epa_models = [
                (model_slug, model["norm"])
                for model_slug, model in make["models"].items()
                if year in model["years"]
            ]
            assigned, _methods, _unused = assign_year(make["norm"], epa_models, nhtsa_models, manual_for)
            for model_slug, names in assigned.items():
                variants = []
                seen = set()
                for name in names:
                    for variant in rows.get((make["norm"], name, year), []):
                        vehicle_id = variant.get("vehicleId")
                        if vehicle_id in seen:
                            continue
                        seen.add(vehicle_id)
                        variants.append(
                            {
                                "description": variant.get("description") or "",
                                "vehicleId": vehicle_id,
                                "overall": variant.get("overall") or "",
                                "front": variant.get("front") or "",
                                "frontDriver": variant.get("frontDriver") or "",
                                "frontPassenger": variant.get("frontPassenger") or "",
                                "side": variant.get("side") or "",
                                "sideDriver": variant.get("sideDriver") or "",
                                "sidePassenger": variant.get("sidePassenger") or "",
                                "pole": variant.get("pole") or "",
                                "rollover": variant.get("rollover") or "",
                                "rolloverPossibility": variant.get("rolloverPossibility"),
                                "esc": variant.get("esc") or "",
                                "fcw": variant.get("fcw") or "",
                                "ldw": variant.get("ldw") or "",
                                "photo": variant.get("photo") or "",
                            }
                        )
                variants.sort(key=lambda item: item["description"])
                details[(make_slug, model_slug)]["years"][year]["ncap"] = variants
                attached += len(variants)
    for year, info in sorted(per_year.items()):
        log(
            f"NCAP {year}: {info['variants']} variants"
            + (f" ({info['failures']} failures)" if info["failures"] else "")
        )
    log(f"NCAP variants attached to spine model years: {attached:,}")
    return per_year


def write_outputs(sources, stats, makes, details, match_meta, raw_names, method_counts, matched, total, raw_makes, raw_models, rows_2000, open_actions, advisory_counts, per_year):
    finalize_year_lists(details, match_meta, raw_names)
    makes_summary, lookup_makes, config_doc, mmy_count, years_pages = write_models(details)
    make_list, lookup_list = nest_summaries(makes_summary, lookup_makes)
    dates = {
        "recalls": sources["recalls_post_2010"]["fileDate"],
        "complaints": sources["complaints"]["fileDate"],
        "investigations": sources["investigations"]["fileDate"],
        "epa": sources["epa"]["fileDate"],
    }
    meta = {
        "generatedAt": f"{max(dates.values())}T00:00:00Z",
        "dates": dates,
        "counts": {
            "epaRowsMy2000": rows_2000,
            "rawMakes": raw_makes,
            "rawModels": raw_models,
            "publishedMakes": len(make_list),
            "publishedModels": sum(len(make["models"]) for make in make_list),
            "mmySpine": total,
            "publishedMmy": mmy_count,
            "matchedMmy": matched,
            "unmatchedMmy": total - matched,
            "matchMethods": dict(method_counts),
            "yearsPages": years_pages,
            "recallRowsPost": stats["recall_rows_post"],
            "recallRowsPre": stats["recall_rows_pre"],
            "vehicleCampaignsPost2010": len(stats["vehicle_campaigns_post_2010"]),
            "vehicleCampaignsPre2010": len(stats["vehicle_campaigns_pre_2010"]),
            "complaintRows": stats["complaint_rows"],
            "complaintVehicleRows": stats["complaint_vehicle_rows"],
            "complaintVehicleOdino": stats.get("complaintVehicleOdino", len(stats["complaint_vehicle_odino"])),
            "investigationRows": stats["investigation_rows"],
            "investigationActions": len(stats["investigation_actions"]),
            "investigationActionsNoCloseDate": len(open_actions),
            **advisory_counts,
        },
        "ncap": {str(year): info for year, info in sorted(per_year.items())},
    }
    SITE.mkdir(parents=True, exist_ok=True)
    (SITE / "summary.json").write_text(json.dumps({"dates": dates, "makes": make_list}, separators=(",", ":")) + "\n")
    (SITE / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    (SITE / "lookup.json").write_text(json.dumps({"dates": dates, "makes": lookup_list}, separators=(",", ":")) + "\n")
    (SITE / "configs.json").write_text(json.dumps(config_doc, separators=(",", ":")) + "\n")
    (ROOT / "data" / "sources.json").write_text(json.dumps(sources, indent=2) + "\n")
    log(
        f"published makes {meta['counts']['publishedMakes']:,}; models {meta['counts']['publishedModels']:,}; "
        f"MMY {mmy_count:,}; years pages {years_pages:,}"
    )
    log(
        f"BUILD vehicle campaigns post-2010 {meta['counts']['vehicleCampaignsPost2010']:,}; "
        f"MMY spine {total:,}; matched {matched:,}; raw makes {raw_makes:,}; raw models {raw_models:,}"
    )
    return meta


def write_unmatched(rows):
    path = ROOT / "data" / "unmatched.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["epa_make", "epa_model", "year", "make_norm", "model_norm"])
        writer.writerows(sorted(rows))
    log(f"wrote {path} ({len(rows):,} rows)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--match-only", action="store_true")
    parser.add_argument("--raw", default=os.environ.get("VF_RAW", "/tmp/vf-raw/extracted"))
    parser.add_argument("--zips", default=os.environ.get("VF_ZIPS", "/tmp/vf-raw"))
    args = parser.parse_args()
    raw_dir = Path(args.raw)
    zip_dir = Path(args.zips)
    started = time.time()
    sources = load_sources(raw_dir, zip_dir)
    grouped, rows_2000, raw_makes, raw_models = load_epa(raw_dir / "vehicles.csv")
    makes = spine_from_groups(grouped)
    log(f"EPA MY≥2000 rows {rows_2000:,}; raw makes {raw_makes:,}; raw models {raw_models:,}; slug makes {len(makes):,}")
    keys, raw_names, stats = scan_keys(raw_dir)
    manual = load_manual(CROSSWALK)
    target, match_meta, unmatched_rows, method_counts, matched, total = build_targets(makes, keys, manual)
    write_unmatched(unmatched_rows)
    if args.match_only:
        # Show one luxury sample so a bad class rule is obvious in the log.
        sample = match_meta.get(("mercedes-benz", "c-class", 2018))
        log(f"sample 2018 Mercedes-Benz C-Class: {sample}")
        log(f"match-only done in {time.time() - started:.0f}s")
        return
    stats["complaintVehicleOdino"] = len(stats["complaint_vehicle_odino"])
    stats["complaint_vehicle_odino"] = set()
    details = init_details(makes, match_meta)
    advisories, campaign_dates, _takata, open_actions = aggregate(raw_dir, makes, target, details, raw_names)
    del target, keys
    stats["complaint_vehicle_odino_count_holder"] = stats["complaint_vehicle_odino"]
    per_year = attach_ncap(makes, details, manual)
    advisory_counts = write_advisories(advisories, campaign_dates)
    write_outputs(
        sources,
        stats,
        makes,
        details,
        match_meta,
        raw_names,
        method_counts,
        matched,
        total,
        raw_makes,
        raw_models,
        rows_2000,
        open_actions,
        advisory_counts,
        per_year,
    )
    log(f"data build finished in {time.time() - started:.0f}s")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
