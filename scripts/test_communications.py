#!/usr/bin/env python3
"""Manufacturer-communication parsing. No network."""

from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

import communications as comms
from lib_norm import norm_make, norm_model


def row(**kwargs) -> str:
    fields = [
        kwargs.get("nid", "100"),
        "",
        kwargs.get("added", "20200115"),
        kwargs.get("doc", "SB-1"),
        kwargs.get("comm", "20190601"),
        "",
        "Service Bulletin/Repair Instructions",
        kwargs.get("make", "HONDA"),
        kwargs.get("model", "FIT"),
        kwargs.get("year", "2017"),
        kwargs.get("component", "ENGINE"),
        "",
        "",
        kwargs.get("summary", "A repair for the dealer."),
    ]
    return "\t".join(fields) + "\n"


class CommunicationTests(unittest.TestCase):
    def test_invalid_calendar_days_are_rejected(self):
        self.assertEqual(comms.ymd_int("29130401"), 0)
        self.assertEqual(comms.ymd_int("19050705"), 0)
        self.assertEqual(comms.ymd_int("20200230"), 0)
        self.assertEqual(comms.ymd_int("20200115"), 20200115)

    def test_manufacturer_date_wins_over_date_added(self):
        self.assertEqual(comms.merge_stamp(0, 20190601, 20200115), 20190601)
        self.assertEqual(comms.merge_stamp(-20200115, 20190601, 20200115), 20190601)
        self.assertEqual(comms.merge_stamp(20190601, 0, 20180101), 20190601)
        self.assertEqual(comms.merge_stamp(20200601, 20190601, 0), 20190601)

    def test_vehicle_identifiers_are_removed_from_summaries(self):
        text = comms.redact_vehicle_identifiers("SEE VIN 1HGCM82633A004352 ON THE DOOR.")
        self.assertNotIn("1HGCM82633A004352", text)
        self.assertIn("a vehicle identifier", text)

    def test_scan_dedupes_components_and_skips_unmatched_years(self):
        target = {(norm_make("HONDA"), norm_model("FIT"), 2017)}
        lines = [
            row(nid="100", component="BRAKES", summary="First."),
            row(nid="100", component="ENGINE", summary="First. Longer text."),
            row(nid="200", year="9999", summary="Unknown year."),
            row(nid="300", year="1999", summary="Before the spine."),
            row(nid="400", make="FORD", model="FOCUS", summary="Other make."),
            row(nid="500", comm="29130401", added="20200301", summary="Bad communication date."),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "TSBS_RECEIVED_2020-2024.txt"
            path.write_text("".join(lines), encoding="latin1")
            found = comms.scan_communication_files([path], target)
        key = (norm_make("HONDA"), norm_model("FIT"), 2017)
        payload = found["by_key"][key]
        self.assertEqual(payload["ids"], ["100", "500"])
        self.assertEqual(len(payload["rows"]), 2)
        first = next(item for item in payload["rows"] if item["id"] == "100")
        self.assertEqual(first["component"], "BRAKES; ENGINE")
        self.assertEqual(first["summary"], "First. Longer text.")
        self.assertEqual(first["date"], "2019-06-01")
        dated = next(item for item in payload["rows"] if item["id"] == "500")
        self.assertEqual(dated["date"], "2020-03-01")
        self.assertEqual(found["ids"], 5)
        self.assertNotIn("1HGCM82633A004352", "".join(item["summary"] for item in payload["rows"]))

    def test_newest_rows_are_capped_and_duplicate_files_count_once(self):
        target = {(norm_make("HONDA"), norm_model("FIT"), 2017)}
        older = []
        newer = []
        for number in range(1, 12):
            older.append(row(nid=str(number), comm=f"202001{number:02d}", component="ENGINE", summary=f"Old {number}."))
        newer.append(
            row(
                nid="11",
                comm="20200111",
                component="BRAKES",
                summary="Updated 11 with more detail about the repair.",
            )
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "TSBS_RECEIVED_2015-2019.zip"
            second = root / "TSBS_RECEIVED_2020-2024.zip"
            for path, lines in ((first, older), (second, newer)):
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr(path.with_suffix(".txt").name, "".join(lines))
            found = comms.scan_communication_files([first, second], target)
        payload = found["by_key"][(norm_make("HONDA"), norm_model("FIT"), 2017)]
        self.assertEqual(len(payload["ids"]), 11)
        self.assertEqual(len(payload["rows"]), comms.COMMUNICATION_ROW_CAP)
        ids = [item["id"] for item in payload["rows"]]
        self.assertEqual(ids[0], "11")
        self.assertNotIn("1", ids)
        self.assertNotIn("2", ids)
        self.assertNotIn("3", ids)
        updated = next(item for item in payload["rows"] if item["id"] == "11")
        self.assertEqual(updated["component"], "BRAKES; ENGINE")
        self.assertIn("Updated 11", updated["summary"])

    def test_split_headline_counts_distinct_ids(self):
        doc = {
            "model": "300",
            "modelNorm": "300",
            "years": {},
        }
        row = {
            "splitNames": True,
            "headlineExact": False,
            "nhtsaModels": ["300", "300M"],
            "also": [
                {"norm": "300", "name": "300", "exact": False, "recalls": [], "complaints": {"n": 0}, "investigations": []},
                {"norm": "300M", "name": "300M", "exact": False, "recalls": [], "complaints": {"n": 0}, "investigations": []},
            ],
        }
        by_norm = {
            "300": {"ids": ["1", "2"], "rows": [{"id": "2", "date": "2020-02-01", "component": "A", "summary": "Two."}]},
            "300M": {"ids": ["2", "3"], "rows": [{"id": "3", "date": "2021-01-01", "component": "B", "summary": "Three."}]},
        }
        entry = comms.assign_year_payloads(doc, row, by_norm)
        self.assertEqual(row["communicationCount"], 3)
        self.assertEqual([item["id"] for item in row["communications"]], ["3", "2"])
        self.assertEqual(entry["300"], ["1", "2"])
        self.assertEqual(entry["300M"], ["2", "3"])


if __name__ == "__main__":
    unittest.main()
