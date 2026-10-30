#!/usr/bin/env python3
"""NCAP fetch guards. No network."""

import io
import json
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr
from pathlib import Path

import ncap


def variants(count: int) -> list[dict]:
    return [{"vehicleId": index} for index in range(count)]


class FakeResponse:
    def __init__(self, payload):
        if isinstance(payload, bytes):
            self.payload = payload
        else:
            self.payload = json.dumps(payload).encode()

    def read(self, _n=-1):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class GuardTests(unittest.TestCase):
    def test_thresholds_stay_put(self):
        self.assertEqual(ncap.FAILURE_FLOOR, 5)
        self.assertEqual(ncap.FAILURE_RATE, 0.05)
        self.assertEqual(ncap.MAX_DROP, 0.25)

    def test_failure_rate_matches_the_october_run(self):
        # Run 40365863090: 398 variants and 304 HTTP 403s. 304/702 is about 43%.
        self.assertTrue(ncap.failure_rate_too_high(398, 304))
        self.assertIn("failure rate too high", ncap.rejection_reason(
            {"variants": variants(398), "failures": 304},
            {"variants": variants(727)},
        ))

    def test_five_percent_boundary(self):
        # 8 failures out of 200 attempts is 4%: under the guard.
        self.assertFalse(ncap.failure_rate_too_high(192, 8))
        # 12 failures out of 200 attempts is 6%: over the guard.
        self.assertTrue(ncap.failure_rate_too_high(188, 12))
        # Five failures is the floor, not an automatic rejection.
        self.assertFalse(ncap.failure_rate_too_high(100, 5))
        self.assertTrue(ncap.failure_rate_too_high(10, 6))
        # Every call failed and no variant came back. That is still a failed fetch.
        self.assertTrue(ncap.failure_rate_too_high(0, 6))
        self.assertFalse(ncap.failure_rate_too_high(0, 0))

    def test_shrink_guard_is_25_percent(self):
        previous = {"variants": variants(100)}
        self.assertFalse(ncap.shrinks_too_much(previous, 75))
        self.assertTrue(ncap.shrinks_too_much(previous, 74))
        self.assertFalse(ncap.shrinks_too_much(None, 0))
        self.assertFalse(ncap.shrinks_too_much({"variants": []}, 0))
        reason = ncap.rejection_reason(
            {"variants": variants(500), "failures": 0},
            {"variants": variants(727)},
        )
        self.assertIn("more than 25%", reason)
        # A real weekly change can add rows, and a small drop still passes.
        self.assertIsNone(ncap.rejection_reason(
            {"variants": variants(600), "failures": 0},
            {"variants": variants(727)},
        ))


class StoreTests(unittest.TestCase):
    def test_rejected_payload_does_not_replace_committed_file(self):
        previous = {
            "year": 2025,
            "fetchedAt": "2026-10-24T00:32:56Z",
            "makes": 38,
            "models": 517,
            "failures": 0,
            "variants": variants(727),
        }
        incoming = {
            "year": 2025,
            "fetchedAt": "2026-10-26T17:50:33Z",
            "makes": 38,
            "models": 517,
            "failures": 304,
            "variants": variants(398),
        }
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "2025.json"
            dest.write_text(json.dumps(previous, separators=(",", ":")) + "\n")
            before = dest.read_bytes()
            with redirect_stderr(io.StringIO()):
                outcome = ncap.store_year(dest, incoming)
            self.assertEqual(outcome, "kept")
            self.assertEqual(dest.read_bytes(), before)
            self.assertFalse(dest.with_suffix(".json.tmp").exists())

    def test_small_change_is_written_and_identical_payload_is_not(self):
        previous = {
            "year": 2027,
            "fetchedAt": "2026-10-24T00:34:17Z",
            "makes": 24,
            "models": 265,
            "failures": 0,
            "variants": variants(388),
        }
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "2027.json"
            dest.write_text(json.dumps(previous, separators=(",", ":")) + "\n")
            before = dest.read_bytes()
            self.assertEqual(ncap.store_year(dest, dict(previous)), "unchanged")
            self.assertEqual(dest.read_bytes(), before)
            updated = dict(previous)
            updated["variants"] = variants(390)
            updated["fetchedAt"] = "2026-10-29T00:00:00Z"
            self.assertEqual(ncap.store_year(dest, updated), "written")
            saved = json.loads(dest.read_text())
            self.assertEqual(len(saved["variants"]), 390)
            self.assertEqual(saved["failures"], 0)

    def test_rejected_payload_without_a_committed_file_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "2028.json"
            with self.assertRaises(SystemExit) as caught:
                ncap.store_year(dest, {"year": 2028, "variants": [], "failures": 40, "makes": 0, "models": 0})
            self.assertIn("no committed file", str(caught.exception))
            self.assertFalse(dest.exists())


class FetchTests(unittest.TestCase):
    def setUp(self):
        self._wait = ncap.LIMITER.wait
        self._penalize = ncap.LIMITER.penalize
        self._relax = ncap.LIMITER.relax
        self._sleep = ncap._sleep
        self._urlopen = ncap._urlopen
        self._get_json = ncap.get_json
        ncap.LIMITER.wait = lambda: None
        ncap.LIMITER.penalize = lambda *_args, **_kwargs: None
        ncap.LIMITER.relax = lambda: None
        ncap._sleep = lambda _seconds: None

    def tearDown(self):
        ncap.LIMITER.wait = self._wait
        ncap.LIMITER.penalize = self._penalize
        ncap.LIMITER.relax = self._relax
        ncap._sleep = self._sleep
        ncap._urlopen = self._urlopen
        ncap.get_json = self._get_json

    def test_retries_rate_limit_then_reads_json(self):
        calls = {"n": 0}
        pauses = []

        def penalize(pause, status):
            pauses.append((pause, status))

        def urlopen(_request, _timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError(
                    "https://api.nhtsa.gov/SafetyRatings",
                    403,
                    "Forbidden",
                    {"Retry-After": "2"},
                    io.BytesIO(b"Forbidden"),
                )
            return FakeResponse({"Count": 1, "Results": [{"ModelYear": 2027}]})

        ncap.LIMITER.penalize = penalize
        ncap._urlopen = urlopen
        doc = ncap.get_json("https://api.nhtsa.gov/SafetyRatings")
        self.assertEqual(doc["Results"][0]["ModelYear"], 2027)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(pauses, [(2.0, 403)])

    def test_client_error_is_not_retried_as_a_rate_limit(self):
        calls = {"n": 0}

        def urlopen(_request, _timeout):
            calls["n"] += 1
            raise urllib.error.HTTPError(
                "https://api.nhtsa.gov/SafetyRatings/modelyear/2025/make/X/model/Y",
                400,
                "Bad Request",
                {},
                io.BytesIO(b"bad request"),
            )

        ncap._urlopen = urlopen
        with self.assertRaises(RuntimeError) as caught:
            ncap.get_json("https://api.nhtsa.gov/example")
        self.assertIn("HTTP 400", str(caught.exception))
        self.assertEqual(calls["n"], 1)

    def test_malformed_and_empty_payloads_are_retried(self):
        calls = {"n": 0}

        def urlopen(_request, _timeout):
            calls["n"] += 1
            if calls["n"] < 3:
                return FakeResponse(b"<html>blocked</html>")
            return FakeResponse({"Count": 2, "Results": []})

        ncap._urlopen = urlopen
        with self.assertRaises(RuntimeError) as caught:
            ncap.get_json("https://api.nhtsa.gov/example")
        self.assertEqual(calls["n"], ncap.ATTEMPTS)
        self.assertIn("empty Results", str(caught.exception))

    def test_timeout_is_retried(self):
        calls = {"n": 0}

        def urlopen(_request, _timeout):
            calls["n"] += 1
            if calls["n"] < 3:
                raise TimeoutError("timed out")
            return FakeResponse({"Count": 0, "Results": []})

        ncap._urlopen = urlopen
        doc = ncap.get_json("https://api.nhtsa.gov/example")
        self.assertEqual(doc["Results"], [])
        self.assertEqual(calls["n"], 3)

    def test_changed_vehicle_payload_is_not_stored_as_blank_ratings(self):
        ncap.get_json = lambda _url: {"Count": 1, "Results": [{"SomethingElse": True}]}
        with self.assertRaises(RuntimeError) as caught:
            ncap.fetch_variant("EX", "CAR", 5)
        self.assertIn("missing rating fields", str(caught.exception))

    def test_fetch_year_keeps_going_after_one_make_and_an_empty_model(self):
        def fake(url):
            if url.endswith("/modelyear/2025"):
                return {"Count": 2, "Results": [{"Make": "GOOD"}, {"Make": "BAD"}]}
            if url.endswith("/make/GOOD"):
                return {"Count": 2, "Results": [{"Model": "CAR"}, {"Model": "NONE"}]}
            if url.endswith("/make/BAD"):
                raise RuntimeError("HTTP 403 Forbidden")
            if "/model/CAR" in url:
                return {"Count": 1, "Results": [{"VehicleId": 9, "VehicleDescription": "car"}]}
            if "/model/NONE" in url:
                return {"Count": 0, "Results": []}
            if url.endswith("/VehicleId/9"):
                return {
                    "Count": 1,
                    "Results": [{"VehicleId": 9, "VehicleDescription": "car", "OverallRating": "5"}],
                }
            raise AssertionError(url)

        ncap.get_json = fake
        doc = ncap.fetch_year(2025)
        self.assertEqual(doc["makes"], 2)
        self.assertEqual(doc["models"], 2)
        self.assertEqual(len(doc["variants"]), 1)
        self.assertEqual(doc["variants"][0]["overall"], "5")
        # One failed make and one empty model. The empty model is not counted twice.
        self.assertEqual(doc["failures"], 2)

    def test_slash_in_a_model_name_stays_a_slash(self):
        encoded = ncap.q("IMPREZA WRX/STI")
        self.assertIn("/", encoded)
        self.assertNotIn("%2F", encoded.upper())


class MainTests(unittest.TestCase):
    def setUp(self):
        self._argv = ncap.sys.argv
        self._out = ncap.OUT_DIR
        self._years = ncap.available_years
        self._fetch = ncap.fetch_year

    def tearDown(self):
        ncap.sys.argv = self._argv
        ncap.OUT_DIR = self._out
        ncap.available_years = self._years
        ncap.fetch_year = self._fetch

    def _run(self, folder: Path, argv: list[str]) -> int:
        ncap.OUT_DIR = folder
        ncap.sys.argv = argv
        with redirect_stderr(io.StringIO()):
            return ncap.main()

    def test_catalog_outage_keeps_committed_files_and_exits_0(self):
        def boom():
            raise RuntimeError("HTTP 403 Forbidden")

        ncap.available_years = boom
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            dest = folder / "2025.json"
            dest.write_text(json.dumps({"year": 2025, "variants": [{"vehicleId": 1}]}) + "\n")
            before = dest.read_bytes()
            code = self._run(folder, ["ncap.py", "--latest", "3"])
            self.assertEqual(code, 0)
            self.assertEqual(dest.read_bytes(), before)

    def test_catalog_outage_with_no_cache_exits_1(self):
        ncap.available_years = lambda: (_ for _ in ()).throw(RuntimeError("timed out"))
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self._run(Path(tmp), ["ncap.py"]), 1)

    def test_year_fetch_failure_keeps_each_committed_file(self):
        ncap.available_years = lambda: [2025, 2026, 2027]
        ncap.fetch_year = lambda year: (_ for _ in ()).throw(RuntimeError(f"HTTP 429 for {year}"))
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            bodies = {}
            for year, count in ((2025, 727), (2026, 667)):
                dest = folder / f"{year}.json"
                dest.write_text(json.dumps({"year": year, "variants": variants(count)}) + "\n")
                bodies[year] = dest.read_bytes()
            code = self._run(folder, ["ncap.py", "--latest", "3"])
            self.assertEqual(code, 0)
            self.assertEqual((folder / "2025.json").read_bytes(), bodies[2025])
            self.assertEqual((folder / "2026.json").read_bytes(), bodies[2026])
            self.assertFalse((folder / "2027.json").exists())


if __name__ == "__main__":
    unittest.main()
