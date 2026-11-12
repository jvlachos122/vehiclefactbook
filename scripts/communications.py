#!/usr/bin/env python3
"""NHTSA manufacturer communications (TSB flat files).

The datasets page publishes two shapes in static.nhtsa.gov/odi/ffdd/tsbs/.
MFR_COMMS_RECEIVED_*.zip is a CSV with document id, make, model, year, and a
short summary. It has no date and no component. TSBS_RECEIVED_*.zip is the
tab-separated flat file described by TSBS.txt: one row per communication, per
product, per component, with the NHTSA ID, the manufacturer communication date,
the component, and the summary.

TSBS_RECEIVED_2025-2025.zip is not in the source list. Every NHTSA ID in that
zip is also in TSBS_RECEIVED_2025-2026.zip, which NHTSA updates in its place.

Published pages store the distinct NHTSA ID count and the newest few rows.
data/site/communication-ids.json stores every matched ID so a test can
recompute the count without keeping every summary.
"""

from __future__ import annotations

import json
import re
import zipfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path, PurePosixPath

from lib_norm import norm_make, norm_model
from sources import MFR_COMMS_SOURCES

COMMUNICATION_ROW_CAP = 8
SUMMARY_LIMIT = 220
COMPONENT_LIMIT = 160
YEAR_MIN = 2000
YEAR_MAX = 2035
DATE_YEAR_MIN = 1995
DATE_YEAR_MAX = 2027

VIN_RE = re.compile(r"\b[A-HJ-NPR-Z0-9]{17}\b", re.IGNORECASE)
SPACE_RE = re.compile(r"\s+")


def log(message: str) -> None:
    print(message, flush=True)


def clean_text(value: str, limit: int = SUMMARY_LIMIT) -> str:
    text = SPACE_RE.sub(" ", (value or "").replace("\x00", " ")).strip()
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:")
    return (cut or text[: limit - 1]) + "…"


def redact_vehicle_identifiers(value: str) -> str:
    return VIN_RE.sub("a vehicle identifier", value or "")


def ymd_int(value: str) -> int:
    text = (value or "").strip()
    if len(text) != 8 or not text.isdigit() or text == "00000000":
        return 0
    year = int(text[0:4])
    month = int(text[4:6])
    day = int(text[6:8])
    if year < DATE_YEAR_MIN or year > DATE_YEAR_MAX:
        return 0
    try:
        datetime(year, month, day)
    except ValueError:
        return 0
    return int(text)


def stamp_to_iso(stamp: int) -> str:
    value = abs(int(stamp or 0))
    if not value:
        return ""
    text = f"{value:08d}"
    return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"


def merge_stamp(old: int, comm: int, added: int) -> int:
    """Prefer a real manufacturer date over the date NHTSA added the row.

    A positive stamp is a manufacturer communication date. A negative stamp is
    only the date added. When both rows have the same kind of date, the earlier
    day is kept.
    """
    if comm:
        candidate = comm
    elif added:
        candidate = -added
    else:
        candidate = 0
    if not old:
        return candidate
    if not candidate:
        return old
    old_comm = old > 0
    new_comm = candidate > 0
    if new_comm and not old_comm:
        return candidate
    if old_comm and not new_comm:
        return old
    if abs(candidate) < abs(old):
        return candidate
    return old


def id_sort_key(value: str):
    text = str(value or "")
    if text.isdigit():
        return (0, int(text), text)
    return (1, 0, text)


def row_sort_key(row: dict):
    date = str(row.get("date") or "")
    nid = str(row.get("id") or "")
    return (1 if date else 0, date, *id_sort_key(nid))


def limit_communication_rows(rows: list[dict], cap: int = COMMUNICATION_ROW_CAP) -> list[dict]:
    ordered = sorted(rows, key=row_sort_key, reverse=True)
    seen = set()
    kept = []
    for row in ordered:
        nid = str(row.get("id") or "")
        if not nid or nid in seen:
            continue
        seen.add(nid)
        kept.append(
            {
                "id": nid,
                "date": str(row.get("date") or ""),
                "component": str(row.get("component") or ""),
                "summary": str(row.get("summary") or ""),
            }
        )
        if len(kept) >= cap:
            break
    return kept


def merge_payloads(payloads: list[dict]) -> dict:
    seen = set()
    ids = []
    rows = {}
    for payload in payloads:
        if not payload:
            continue
        for nid in payload.get("ids") or []:
            text = str(nid)
            if text and text not in seen:
                seen.add(text)
                ids.append(text)
        for row in payload.get("rows") or []:
            nid = str(row.get("id") or "")
            if nid:
                rows[nid] = row
    ids.sort(key=id_sort_key)
    return {"ids": ids, "rows": limit_communication_rows(list(rows.values()))}


def empty_payload() -> dict:
    return {"ids": [], "rows": []}


def communication_paths(raw_dir: Path, zip_dir: Path) -> list[Path]:
    paths = []
    missing = []
    for _key, url, zip_name, text_name in MFR_COMMS_SOURCES:
        text = raw_dir / text_name
        zip_path = zip_dir / zip_name
        if text.is_file() and text.stat().st_size > 0:
            paths.append(text)
        elif zip_path.is_file() and zip_path.stat().st_size > 0:
            paths.append(zip_path)
        else:
            missing.append(f"{text_name} from {url}")
    if missing:
        raise SystemExit("Missing manufacturer communications files: " + "; ".join(missing))
    return paths


def _iter_lines(path: Path):
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            names = [info.filename for info in archive.infolist() if not info.is_dir()]
            expected = path.with_suffix(".txt").name
            matches = [name for name in names if PurePosixPath(name.replace("\\", "/")).name == expected]
            if len(matches) == 1:
                chosen = matches[0]
            elif len(names) == 1:
                chosen = names[0]
            else:
                raise SystemExit(f"{path.name} does not contain one {expected} member: {', '.join(names)}")
            with archive.open(chosen, "r") as raw:
                for bline in raw:
                    yield bline.decode("latin1", errors="replace")
        return
    with path.open(encoding="latin1", errors="replace") as handle:
        yield from handle


def _years(value: str) -> list[int]:
    years = []
    for piece in (value or "").split(","):
        text = piece.strip()
        if not text.isdigit():
            continue
        year = int(text)
        if YEAR_MIN <= year <= YEAR_MAX:
            years.append(year)
    return years


def scan_communication_files(paths: list[Path], target_keys: set[tuple[str, str, int]]) -> dict:
    """Return {(make_norm, model_norm, year): {ids, rows}} for keys in target_keys.

    `ids` is every distinct NHTSA ID on that name. `rows` is the newest
    COMMUNICATION_ROW_CAP communications, with components merged.
    """
    buckets: dict[tuple[str, str, int], dict[int, int]] = defaultdict(dict)
    rows_read = 0
    short_rows = 0
    non_numeric_ids = 0
    all_ids: set[int] = set()
    added_min = 0
    added_max = 0
    comm_min = 0
    comm_max = 0

    def note_span(value: int, low: int, high: int) -> tuple[int, int]:
        if not value:
            return low, high
        if not low or value < low:
            low = value
        if value > high:
            high = value
        return low, high

    for path in paths:
        log(f"manufacturer communications {path.name}")
        file_rows = 0
        for line in _iter_lines(path):
            parts = line.rstrip("\n").split("\t")
            if parts and parts[0].strip().strip('"') == "NHTSA ID Number":
                continue
            rows_read += 1
            file_rows += 1
            if len(parts) < 14:
                short_rows += 1
                continue
            raw_id = parts[0].strip()
            if not raw_id.isdigit():
                if raw_id:
                    non_numeric_ids += 1
                continue
            nid = int(raw_id)
            all_ids.add(nid)
            added = ymd_int(parts[2])
            comm = ymd_int(parts[4])
            added_min, added_max = note_span(added, added_min, added_max)
            comm_min, comm_max = note_span(comm, comm_min, comm_max)
            make_norm = norm_make(parts[7])
            model_norm = norm_model(parts[8])
            if not make_norm or not model_norm:
                continue
            for year in _years(parts[9]):
                key = (make_norm, model_norm, year)
                if key not in target_keys:
                    continue
                bucket = buckets[key]
                bucket[nid] = merge_stamp(bucket.get(nid, 0), comm, added)
        log(f"  {path.name}: {file_rows:,} rows")

    wanted: dict[tuple[str, str, int, int], dict] = {}
    prepared: dict[tuple[str, str, int], dict] = {}
    matched = 0
    for key, id_map in buckets.items():
        ranked = sorted(id_map.items(), key=lambda item: (1 if item[1] else 0, abs(item[1]), item[0]), reverse=True)
        ids = [str(nid) for nid, _stamp in sorted(id_map.items(), key=lambda item: item[0])]
        slot = {"ids": ids, "pending": {}}
        prepared[key] = slot
        matched += len(ids)
        for nid, stamp in ranked[:COMMUNICATION_ROW_CAP]:
            pending = {
                "id": str(nid),
                "date": stamp_to_iso(stamp),
                "components": [],
                "summary_raw": "",
                "summary_len": -1,
            }
            slot["pending"][nid] = pending
            wanted[(*key, nid)] = pending
    del buckets

    if wanted:
        for path in paths:
            for line in _iter_lines(path):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 14:
                    continue
                raw_id = parts[0].strip()
                if not raw_id.isdigit():
                    continue
                nid = int(raw_id)
                make_norm = norm_make(parts[7])
                model_norm = norm_model(parts[8])
                if not make_norm or not model_norm:
                    continue
                component = parts[10].strip()
                summary = "\t".join(parts[13:])
                for year in _years(parts[9]):
                    pending = wanted.get((make_norm, model_norm, year, nid))
                    if pending is None:
                        continue
                    if component and component not in pending["components"]:
                        pending["components"].append(component)
                    length = len(summary.strip())
                    if length > pending["summary_len"]:
                        pending["summary_raw"] = summary
                        pending["summary_len"] = length

    found = {}
    for key, slot in prepared.items():
        rows = []
        for pending in slot["pending"].values():
            component = clean_text("; ".join(sorted(pending["components"])), COMPONENT_LIMIT)
            summary = clean_text(redact_vehicle_identifiers(pending["summary_raw"]), SUMMARY_LIMIT)
            rows.append(
                {
                    "id": pending["id"],
                    "date": pending["date"],
                    "component": redact_vehicle_identifiers(component),
                    "summary": summary,
                }
            )
        found[key] = {"ids": slot["ids"], "rows": limit_communication_rows(rows)}

    log(
        f"manufacturer communications rows {rows_read:,}; distinct IDs {len(all_ids):,}; "
        f"matched name rows {matched:,} across {len(found):,} names; "
        f"short rows {short_rows:,}; non-numeric IDs {non_numeric_ids:,}"
    )
    return {
        "by_key": found,
        "rows": rows_read,
        "ids": len(all_ids),
        "matched": matched,
        "matchedNames": len(found),
        "shortRows": short_rows,
        "nonNumericIds": non_numeric_ids,
        "addedMin": stamp_to_iso(added_min),
        "addedMax": stamp_to_iso(added_max),
        "commMin": stamp_to_iso(comm_min),
        "commMax": stamp_to_iso(comm_max),
    }


def norms_for_year(doc: dict, row: dict) -> list[str]:
    seen = set()
    norms = []

    def add(value: str) -> None:
        text = str(value or "")
        if text and text not in seen:
            seen.add(text)
            norms.append(text)

    if row.get("headlineExact"):
        add(doc.get("modelNorm"))
    for group in row.get("also") or []:
        add(group.get("norm"))
    for shown in row.get("nhtsaModels") or []:
        add(norm_model(shown))
    return norms


def display_label(doc: dict, row: dict, model_norm: str) -> str:
    if model_norm == doc.get("modelNorm") and doc.get("model"):
        return doc["model"]
    for group in row.get("also") or []:
        if group.get("norm") == model_norm and group.get("name"):
            return group["name"]
    for shown in row.get("nhtsaModels") or []:
        if norm_model(shown) == model_norm:
            return shown
    return model_norm


def apply_public(target: dict, payload: dict | None) -> None:
    target.pop("communicationCount", None)
    target.pop("communications", None)
    ids = (payload or {}).get("ids") or []
    if not ids:
        return
    target["communicationCount"] = len(ids)
    target["communications"] = (payload or {}).get("rows") or []


def headline_payload(doc: dict, row: dict, by_norm: dict[str, dict]) -> dict:
    norms = norms_for_year(doc, row)
    if row.get("splitNames"):
        return merge_payloads([by_norm.get(norm) for norm in norms])
    return by_norm.get(doc.get("modelNorm")) or empty_payload()


def index_entry(doc: dict, row: dict, by_norm: dict[str, dict]) -> dict[str, list[str]]:
    entry = {}
    if row.get("headlineExact"):
        payload = by_norm.get(doc.get("modelNorm")) or empty_payload()
        if payload["ids"]:
            entry[doc["modelNorm"]] = payload["ids"]
    for group in row.get("also") or []:
        payload = by_norm.get(group.get("norm")) or empty_payload()
        if payload["ids"]:
            entry[group["norm"]] = payload["ids"]
    return entry


def assign_year_payloads(doc: dict, row: dict, by_norm: dict[str, dict]) -> dict[str, list[str]]:
    """Write public communication fields onto one model-year record.

    Returns the per-norm ID lists for the sidecar. Headline exact counts are
    the EPA model's own NHTSA name. A split headline is the distinct IDs
    across the matched names.
    """
    norms = norms_for_year(doc, row)
    if row.get("splitNames"):
        groups = list(row.get("also") or [])
        present = {group.get("norm"): group for group in groups}
        for norm in norms:
            payload = by_norm.get(norm) or empty_payload()
            group = present.get(norm)
            if group is None:
                if not payload["ids"]:
                    continue
                group = {
                    "norm": norm,
                    "name": display_label(doc, row, norm),
                    "exact": norm == doc.get("modelNorm"),
                    "recalls": [],
                    "complaints": {"n": 0, "crash": 0, "fire": 0, "injured": 0, "deaths": 0, "top": [], "byYear": []},
                    "investigations": [],
                }
                groups.append(group)
                present[norm] = group
            apply_public(group, payload)
        row["also"] = groups
    else:
        for group in row.get("also") or []:
            apply_public(group, by_norm.get(group.get("norm")))
    apply_public(row, headline_payload(doc, row, by_norm))
    return index_entry(doc, row, by_norm)


def load_target_keys(models_root: Path) -> set[tuple[str, str, int]]:
    keys = set()
    for path in sorted(models_root.rglob("*.json")):
        doc = json.loads(path.read_text())
        make_norm = doc.get("makeNorm") or ""
        for year, row in (doc.get("years") or {}).items():
            try:
                year_num = int(year)
            except (TypeError, ValueError):
                continue
            for model_norm in norms_for_year(doc, row):
                if make_norm and model_norm:
                    keys.add((make_norm, model_norm, year_num))
    return keys


def payloads_for_model(doc: dict, found: dict) -> dict[tuple[int, str], dict]:
    make_norm = doc.get("makeNorm") or ""
    out = {}
    for year in doc.get("years") or {}:
        try:
            year_num = int(year)
        except (TypeError, ValueError):
            continue
        for model_norm in norms_for_year(doc, doc["years"][year]):
            payload = found.get((make_norm, model_norm, year_num))
            if payload and payload.get("ids"):
                out[(year_num, model_norm)] = payload
    return out


def write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")


def year_has_nhtsa(year: dict, communication_count: int) -> bool:
    if year.get("match") == "none":
        return False
    return bool(year.get("recalls") or year.get("complaints") or year.get("investigations") or communication_count)


def insert_summary_count(year: dict, count: int) -> dict:
    rebuilt = {}
    for key, value in year.items():
        if key == "communications":
            continue
        rebuilt[key] = value
        if key == "invOpen":
            rebuilt["communications"] = count
    if "communications" not in rebuilt:
        rebuilt["communications"] = count
    rebuilt["hasNhtsa"] = year_has_nhtsa(rebuilt, count)
    return rebuilt


def apply_published_documents(models_root: Path, found: dict) -> tuple[dict, dict, int]:
    """Attach scanned communications to the committed model JSON files.

    Returns the sidecar object, a map of (make_slug, model_slug, year) counts,
    and the number of model files rewritten.
    """
    index = {}
    counts = {}
    rewritten = 0
    for path in sorted(models_root.rglob("*.json")):
        doc = json.loads(path.read_text())
        available = payloads_for_model(doc, found)
        by_year: dict[int, dict[str, dict]] = defaultdict(dict)
        for (year_num, model_norm), payload in available.items():
            by_year[year_num][model_norm] = payload
        entry_for_model = {}
        original = json.dumps(doc, separators=(",", ":"))
        for year, row in (doc.get("years") or {}).items():
            try:
                year_num = int(year)
            except (TypeError, ValueError):
                continue
            entry = assign_year_payloads(doc, row, by_year.get(year_num) or {})
            if entry:
                entry_for_model[str(year_num)] = entry
            counts[(doc["makeSlug"], doc["modelSlug"], year_num)] = int(row.get("communicationCount") or 0)
        if entry_for_model:
            index[f"{doc['makeSlug']}/{doc['modelSlug']}"] = entry_for_model
        serial = json.dumps(doc, separators=(",", ":"))
        if serial != original:
            path.write_text(serial + "\n")
            rewritten += 1
    return index, counts, rewritten


def sync_years_pages(models_root: Path, summary: dict) -> int:
    """Copy yearsPage from the summary onto model files when the flag changed."""
    rewritten = 0
    for make in summary.get("makes") or []:
        for model in make.get("models") or []:
            path = models_root / make["slug"] / f"{model['slug']}.json"
            doc = json.loads(path.read_text())
            if doc.get("yearsPage") == model["yearsPage"]:
                continue
            doc["yearsPage"] = model["yearsPage"]
            path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
            rewritten += 1
    return rewritten
