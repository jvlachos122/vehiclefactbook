#!/usr/bin/env python3
"""Cache NHTSA 5-Star Safety Ratings for model years 2011 through the newest year the API lists.

Weekly refreshes should pass --latest 3 so only the three newest model years are fetched again.

The SafetyRatings API answers 403/429 when a client opens too many connections at once
(the 2026-10-26 scheduled run did this from GitHub Actions and then spent the retry
budget keeping the throttle open). Requests are paced, and those statuses pause every
worker before the URL is tried again. A year that still fails, comes back empty, or
would replace the committed file with a much smaller one is not written: the last
committed file stays and a warning is logged. The process exits 0 when committed
NCAP data is still on disk so the rest of the refresh can continue, and exits 1
only when there is nothing to keep. The 5% per-request failure guard and the 25%
shrink guard are not loosened.
"""

from __future__ import annotations

import argparse
import http.client
import json
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "ncap"
API = "https://api.nhtsa.gov/SafetyRatings"
WORKERS = 3
ATTEMPTS = 6
UA = "VehicleFactbook/1.0 (safety-ratings cache; +https://vehiclefactbook.com/methodology/)"

# More than 5 failed calls, and more than 5% of the calls that returned a variant
# or a failure. Same threshold as the first scheduled run. Do not loosen it.
FAILURE_FLOOR = 5
FAILURE_RATE = 0.05
# A fetched year more than 25% smaller than the committed file is discarded.
# An empty or truncated body must not replace the cache. Do not loosen this.
MAX_DROP = 0.25

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
RATING_KEYS = tuple(KEEP.values()) + ("VehicleDescription", "VehicleId")
RETRYABLE_STATUS = {403, 408, 409, 425, 429, 500, 502, 503, 504}


class RequestLimiter:
    """Space request starts, and hold every worker when the API throttles."""

    def __init__(self) -> None:
        self.min_interval = 0.15
        self.lock = threading.Lock()
        self.next_at = 0.0
        self.cooldown_until = 0.0
        self.backoff = 2.0
        self.last_notice = 0.0

    def wait(self) -> None:
        while True:
            with self.lock:
                now = time.monotonic()
                gate = max(self.next_at, self.cooldown_until)
                if now >= gate:
                    self.next_at = now + self.min_interval
                    return
                delay = gate - now
            _sleep(min(delay, 0.5))

    def penalize(self, pause: float | None, status: int | None) -> None:
        notify = False
        seconds = 0.0
        with self.lock:
            chosen = self.backoff if pause is None else pause
            chosen = min(max(float(chosen), 1.0), 90.0)
            # A little jitter keeps the workers from lining up on the same instant.
            chosen += random.random() * 0.4
            now = time.monotonic()
            extended = now + chosen > self.cooldown_until + 0.5
            self.cooldown_until = max(self.cooldown_until, now + chosen)
            self.backoff = min(max(self.backoff * 2, chosen), 60.0)
            if extended and status in {403, 429, 503} and now - self.last_notice > 5:
                self.last_notice = now
                notify = True
                seconds = chosen
        if notify and status is not None:
            warn(f"NCAP request limit: pausing {seconds:.0f}s after HTTP {status}")

    def relax(self) -> None:
        with self.lock:
            self.backoff = max(2.0, self.backoff / 2)


LIMITER = RequestLimiter()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def _urlopen(request: urllib.request.Request, timeout: float):
    return urllib.request.urlopen(request, timeout=timeout)


def warn(message: str) -> None:
    text = " ".join(str(message).split())
    print(f"::warning::{text}", flush=True)
    print(f"WARNING: {text}", file=sys.stderr, flush=True)


def failure_rate_too_high(variants: int, failures: int) -> bool:
    if variants and failures > max(FAILURE_FLOOR, FAILURE_RATE * (variants + failures)):
        return True
    # A year that produced no rows because every call failed is still a failed fetch.
    # The original check skipped this only because it required at least one variant.
    return not variants and failures > FAILURE_FLOOR


def shrinks_too_much(previous: dict | None, variants: int) -> bool:
    if not previous:
        return False
    old = previous.get("variants") or []
    if not old:
        return False
    return variants < (1 - MAX_DROP) * len(old)


def rejection_reason(doc: dict, previous: dict | None) -> str | None:
    variants = doc.get("variants") or []
    failures = int(doc.get("failures") or 0)
    if failure_rate_too_high(len(variants), failures):
        attempted = len(variants) + failures
        rate = failures / attempted if attempted else 1
        return f"failure rate too high ({failures} failures, {len(variants)} variants, {rate:.0%})"
    if shrinks_too_much(previous, len(variants)):
        old = len(previous.get("variants") or [])
        return f"variant count fell more than 25% ({len(variants)} vs committed {old})"
    return None


def _retry_after(headers) -> float | None:
    if headers is None:
        return None
    raw = headers.get("Retry-After")
    if not raw:
        return None
    text = str(raw).strip()
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        moment = parsedate_to_datetime(text)
        if moment is None:
            return None
        return max(0.0, moment.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def _http_detail(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read(240)
    except Exception:
        return ""
    text = raw.decode("utf-8", "replace")
    cleaned = []
    skip = False
    for char in text:
        if char == "<":
            skip = True
            continue
        if char == ">":
            skip = False
            continue
        if not skip:
            cleaned.append(char)
    return " ".join("".join(cleaned).split())[:160]


def get_json(url: str) -> dict:
    last: Exception | None = None
    for attempt in range(ATTEMPTS):
        LIMITER.wait()
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": UA, "Accept": "application/json"},
            )
            with _urlopen(request, 45) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = _http_detail(exc)
            last = RuntimeError(f"HTTP {exc.code} {detail}".strip())
            try:
                exc.close()
            except Exception:
                pass
            if exc.code in RETRYABLE_STATUS and attempt + 1 < ATTEMPTS:
                LIMITER.penalize(_retry_after(exc.headers), exc.code)
                continue
            break
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException, OSError) as exc:
            last = exc
            if attempt + 1 >= ATTEMPTS:
                break
            LIMITER.penalize(None, None)
            continue
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError as exc:
            last = exc
            if attempt + 1 >= ATTEMPTS:
                break
            _sleep(min(2 ** attempt, 10))
            continue
        if not isinstance(doc, dict) or not isinstance(doc.get("Results"), list):
            last = ValueError(f"unexpected payload from {url}")
        else:
            count = doc.get("Count")
            if isinstance(count, int) and count > 0 and not doc["Results"]:
                last = ValueError(f"empty Results despite Count {count} from {url}")
            else:
                LIMITER.relax()
                return doc
        if attempt + 1 >= ATTEMPTS:
            break
        _sleep(min(2 ** attempt, 10))
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


def _nonempty(url: str, label: str) -> dict:
    last = None
    for attempt in range(3):
        doc = get_json(url)
        if doc.get("Results"):
            return doc
        last = doc
        if attempt < 2:
            print(f"  empty {label}; retrying", file=sys.stderr, flush=True)
            LIMITER.penalize(2.0, None)
    return last if last is not None else {"Results": []}


def fetch_variant(make: str, model: str, vehicle_id: int) -> dict:
    last: Exception | None = None
    url = f"{API}/VehicleId/{vehicle_id}"
    for _ in range(2):
        data = get_json(url)
        results = data.get("Results") or []
        row = results[0] if results and isinstance(results[0], dict) else None
        if row and any(key in row for key in RATING_KEYS):
            return slim(make, model, row)
        if row is None:
            last = RuntimeError(f"empty VehicleId {vehicle_id}")
        else:
            last = RuntimeError(f"VehicleId {vehicle_id} payload missing rating fields")
    raise last or RuntimeError(f"empty VehicleId {vehicle_id}")


def vehicle_ids(doc: dict) -> list[int]:
    found = []
    for row in doc.get("Results") or []:
        if not isinstance(row, dict):
            continue
        try:
            vehicle_id = int(row.get("VehicleId"))
        except (TypeError, ValueError):
            continue
        if vehicle_id:
            found.append(vehicle_id)
    return found


def fetch_year(year: int) -> dict:
    failures = 0
    makes_doc = _nonempty(f"{API}/modelyear/{year}", f"model year {year}")
    makes = [row.get("Make") for row in makes_doc.get("Results") or [] if isinstance(row, dict) and row.get("Make")]
    model_rows = []

    def load_make(make: str):
        return make, get_json(f"{API}/modelyear/{year}/make/{q(make)}")

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(load_make, make): make for make in makes}
        done = 0
        for future in as_completed(futures):
            make = futures[future]
            done += 1
            try:
                _make, doc = future.result()
            except Exception as exc:  # noqa: BLE001 — skip one make and keep the year
                failures += 1
                print(f"  make {make} failed: {exc}", file=sys.stderr, flush=True)
            else:
                for row in doc.get("Results") or []:
                    if not isinstance(row, dict):
                        continue
                    model = row.get("Model")
                    if model:
                        model_rows.append((_make, model))
            if futures and (done % 100 == 0 or done == len(futures)):
                print(f"  {year} makes {done}/{len(futures)}", flush=True)

    id_rows = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(get_json, f"{API}/modelyear/{year}/make/{q(make)}/model/{q(model)}"): (make, model)
            for make, model in model_rows
        }
        done = 0
        for future in as_completed(futures):
            make, model = futures[future]
            done += 1
            ids: list[int] = []
            try:
                ids = vehicle_ids(future.result())
                # A model the make list just named should have at least one vehicle.
                # An empty body is retried once so a truncated 200 does not drop it.
                if not ids:
                    ids = vehicle_ids(get_json(f"{API}/modelyear/{year}/make/{q(make)}/model/{q(model)}"))
            except Exception as exc:  # noqa: BLE001 — skip one model and keep the year
                failures += 1
                print(f"  model {make} {model} failed: {exc}", file=sys.stderr, flush=True)
            else:
                if not ids:
                    failures += 1
                    print(f"  model {make} {model} failed: empty response", file=sys.stderr, flush=True)
                else:
                    id_rows.extend((make, model, vehicle_id) for vehicle_id in ids)
            if futures and (done % 100 == 0 or done == len(futures)):
                print(f"  {year} models {done}/{len(futures)}", flush=True)

    variants = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(fetch_variant, make, model, vehicle_id): vehicle_id
            for make, model, vehicle_id in id_rows
        }
        done = 0
        for future in as_completed(futures):
            done += 1
            try:
                variants.append(future.result())
            except Exception as exc:  # noqa: BLE001 — keep the year, record the gap
                failures += 1
                print(f"  vehicle {futures[future]} failed: {exc}", file=sys.stderr, flush=True)
            if futures and (done % 100 == 0 or done == len(futures)):
                print(f"  {year} vehicles {done}/{len(futures)}", flush=True)
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
    last: Exception | None = None
    for attempt in range(3):
        try:
            doc = get_json(API)
        except Exception as exc:  # noqa: BLE001 — catalog is retried, then the caller decides
            last = exc
            continue
        years = []
        for row in doc.get("Results") or []:
            if not isinstance(row, dict):
                continue
            try:
                years.append(int(row.get("ModelYear")))
            except (TypeError, ValueError):
                continue
        years = sorted(set(years))
        if years:
            return years
        last = RuntimeError("SafetyRatings returned no model years")
        if attempt < 2:
            print("  empty NCAP year list; retrying", file=sys.stderr, flush=True)
            LIMITER.penalize(2.0, None)
    raise RuntimeError(f"{API} failed: {last}")


def load_previous(dest: Path) -> dict | None:
    if not dest.exists():
        return None
    try:
        doc = json.loads(dest.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        warn(f"{dest.name} could not be read ({exc})")
        return None
    return doc if isinstance(doc, dict) else None


def same_payload(previous: dict, doc: dict) -> bool:
    return (
        previous.get("variants") == doc["variants"]
        and previous.get("failures") == doc["failures"]
        and previous.get("makes") == doc["makes"]
        and previous.get("models") == doc["models"]
    )


def cache_has_variants(directory: Path) -> bool:
    if not directory.exists():
        return False
    for path in directory.glob("*.json"):
        previous = load_previous(path)
        if previous and previous.get("variants"):
            return True
    return False


def store_year(dest: Path, doc: dict) -> str:
    """Write a year file, or keep the committed one.

    Returns 'unchanged', 'written', or 'kept'. Raises SystemExit only when the
    new payload is rejected and there is no committed file to keep.
    """
    previous = load_previous(dest)
    reason = rejection_reason(doc, previous)
    kept_variants = len((previous or {}).get("variants") or [])
    if reason:
        if previous is not None and kept_variants:
            warn(
                f"NCAP {doc.get('year')} kept the last committed file "
                f"({kept_variants} variants). {reason}."
            )
            return "kept"
        raise SystemExit(f"NCAP {doc.get('year')} {reason}, and there is no committed file to keep")
    if previous is not None and same_payload(previous, doc):
        print(f"NCAP {doc['year']}: unchanged ({len(doc['variants'])} variants)", flush=True)
        return "unchanged"
    payload = json.dumps(doc, separators=(",", ":")) + "\n"
    temporary = dest.with_suffix(".json.tmp")
    temporary.write_text(payload)
    temporary.replace(dest)
    print(
        f"NCAP {doc['year']}: {doc['makes']} makes, {doc['models']} models, "
        f"{len(doc['variants'])} variants, {doc['failures']} failures",
        flush=True,
    )
    return "written"


def main() -> int:
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--latest", type=int, default=0, help="Re-fetch only the N newest model years")
    parser.add_argument("--year", type=int, action="append", dest="years")
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        listed = available_years()
    except Exception as exc:  # noqa: BLE001 — a dead catalog must not abort the weekly refresh
        if cache_has_variants(OUT_DIR):
            warn(
                f"NCAP year list could not be fetched ({exc}). "
                "Kept the committed NCAP files. The rest of the refresh will continue."
            )
            return 0
        print(f"NCAP year list could not be fetched: {exc}", file=sys.stderr, flush=True)
        return 1
    newest = max(listed) if listed else 0
    wanted = [year for year in listed if 2011 <= year <= newest]
    if args.years:
        wanted = [year for year in args.years if year in listed]
        missing = [year for year in args.years if year not in listed]
        for year in missing:
            dest = OUT_DIR / f"{year}.json"
            if dest.exists():
                warn(f"NCAP {year} is not in the SafetyRatings year list. Kept the committed file.")
            else:
                warn(f"NCAP {year} is not in the SafetyRatings year list, so nothing was fetched.")
    elif args.latest:
        wanted = wanted[-args.latest :]
    print(f"NCAP years to fetch: {wanted[0]}–{wanted[-1]} ({len(wanted)} years)" if wanted else "NCAP: no years", flush=True)
    kept = 0
    fatal = False
    for year in wanted:
        dest = OUT_DIR / f"{year}.json"
        if dest.exists() and not args.latest and not args.years:
            doc = json.loads(dest.read_text())
            print(f"NCAP {year}: cached {len(doc.get('variants') or [])} variants", flush=True)
            continue
        started = time.time()
        try:
            doc = fetch_year(year)
        except Exception as exc:  # noqa: BLE001 — keep the committed year and continue
            previous = load_previous(dest)
            count = len((previous or {}).get("variants") or [])
            if previous is not None and count:
                warn(
                    f"NCAP {year} fetch failed ({exc}). "
                    f"Kept the last committed file ({count} variants). "
                    "The rest of the refresh will continue."
                )
                kept += 1
                continue
            print(f"NCAP {year} fetch failed: {exc}", file=sys.stderr, flush=True)
            fatal = True
            continue
        try:
            outcome = store_year(dest, doc)
        except SystemExit as exc:
            print(exc, file=sys.stderr, flush=True)
            fatal = True
            continue
        if outcome == "written":
            print(f"NCAP {year} wrote in {time.time() - started:.0f}s", flush=True)
        elif outcome == "kept":
            kept += 1
    if kept:
        warn(
            f"NCAP kept the last committed data for {kept} model year(s) "
            "after the SafetyRatings API could not be used. The rest of the refresh will continue."
        )
    if fatal and not cache_has_variants(OUT_DIR):
        print("NCAP failed and there is no committed file to keep.", file=sys.stderr, flush=True)
        return 1
    if fatal:
        warn("NCAP could not refresh every requested year. Committed files were left in place.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
