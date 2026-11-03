#!/usr/bin/env python3
"""Extraction file-name mapping. No network."""

from __future__ import annotations

import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import sources


POST_URL = sources.source_by_key("recalls_post_2010")[1]
POST_ZIP = sources.source_by_key("recalls_post_2010")[2]
POST_TEXT = sources.source_by_key("recalls_post_2010")[3]


class SourceMapTests(unittest.TestCase):
    def test_recall_archives_map_to_the_flat_file_names(self):
        post = sources.source_by_key("recalls_post_2010")
        pre = sources.source_by_key("recalls_pre_2010")
        self.assertEqual(post[1], "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip")
        self.assertEqual(post[2], "FLAT_RCL_POST_2010.zip")
        self.assertEqual(post[3], "FLAT_RCL_POST_2010.txt")
        self.assertEqual(pre[1], "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip")
        self.assertEqual(pre[2], "FLAT_RCL_PRE_2010.zip")
        self.assertEqual(pre[3], "FLAT_RCL_PRE_2010.txt")
        listed = dict(sources.download_list())
        self.assertEqual(listed[POST_URL], POST_ZIP)

    def test_member_mapping(self):
        expected = "FLAT_RCL_POST_2010.txt"
        self.assertEqual(sources.match_member([expected], expected), expected)
        self.assertEqual(
            sources.match_member(["rcl/FLAT_RCL_POST_2010.txt"], expected),
            "rcl/FLAT_RCL_POST_2010.txt",
        )
        self.assertEqual(
            sources.match_member(["rcl\\FLAT_RCL_POST_2010.txt"], expected),
            "rcl\\FLAT_RCL_POST_2010.txt",
        )
        self.assertEqual(
            sources.match_member(["README.txt", expected], expected),
            expected,
        )
        self.assertIsNone(sources.match_member(["RCL_FROM_2010_2014.txt"], expected))
        self.assertIsNone(sources.match_member(
            ["a/FLAT_RCL_POST_2010.txt", "b/FLAT_RCL_POST_2010.txt"],
            expected,
        ))
        self.assertIsNone(sources.match_member([], expected))

    def test_workflow_env_reads_extracted_directory(self):
        # The refresh workflow sets VF_RAW to the zip folder. The Monday run
        # looked for FLAT_RCL_POST_2010.txt in that folder and missed the file
        # fetch.sh had unpacked under extracted/.
        with mock.patch.dict(os.environ, {"VF_RAW": "/tmp/vf-raw", "VF_ZIPS": "/tmp/vf-raw"}):
            raw_dir, zip_dir = sources.resolve_io_dirs(None, None)
        self.assertEqual(raw_dir, Path("/tmp/vf-raw/extracted"))
        self.assertEqual(zip_dir, Path("/tmp/vf-raw"))

    def test_explicit_raw_dir_is_honored(self):
        raw_dir, zip_dir = sources.resolve_io_dirs("/data/texts", "/data/zips")
        self.assertEqual(raw_dir, Path("/data/texts"))
        self.assertEqual(zip_dir, Path("/data/zips"))

    def _zip(self, path: Path, members: dict[str, bytes]) -> None:
        with zipfile.ZipFile(path, "w") as archive:
            for name, payload in members.items():
                archive.writestr(name, payload)

    def test_nested_member_is_written_under_the_expected_name(self):
        payload = b"1\tCAMP\n"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            zip_path = root / POST_ZIP
            self._zip(zip_path, {"nested/FLAT_RCL_POST_2010.txt": payload})
            dest, chosen = sources.extract_source(zip_path, root / "extracted", POST_TEXT, POST_URL)
            self.assertEqual(chosen, "nested/FLAT_RCL_POST_2010.txt")
            self.assertEqual(dest, root / "extracted" / POST_TEXT)
            self.assertEqual(dest.read_bytes(), payload)
            self.assertFalse((root / POST_TEXT).exists())
            self.assertFalse((root / "extracted" / "nested" / POST_TEXT).exists())

    def test_two_members_with_the_expected_name_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            zip_path = root / POST_ZIP
            self._zip(zip_path, {
                "a/FLAT_RCL_POST_2010.txt": b"one\n",
                "b/FLAT_RCL_POST_2010.txt": b"two\n",
            })
            with self.assertRaises(SystemExit) as caught:
                sources.extract_source(zip_path, root / "extracted", POST_TEXT, POST_URL)
            self.assertIn(POST_URL, str(caught.exception))
            self.assertIn("Ambiguous", str(caught.exception))
            self.assertFalse((root / "extracted" / POST_TEXT).exists())

    def test_traversal_member_stays_inside_the_extract_directory(self):
        payload = b"1\tCAMP\n"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            zip_path = root / POST_ZIP
            self._zip(zip_path, {"../FLAT_RCL_POST_2010.txt": payload})
            dest, chosen = sources.extract_source(zip_path, root / "extracted", POST_TEXT, POST_URL)
            self.assertEqual(chosen, "../FLAT_RCL_POST_2010.txt")
            self.assertEqual(dest.read_bytes(), payload)
            self.assertEqual(dest.parent, root / "extracted")
            self.assertFalse((root / POST_TEXT).exists())

    def test_renamed_member_names_the_url_and_expected_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            zip_path = root / POST_ZIP
            self._zip(zip_path, {"RCL_FROM_2010_2014.txt": b"partial\n"})
            with self.assertRaises(SystemExit) as caught:
                sources.extract_source(zip_path, root / "extracted", POST_TEXT, POST_URL)
            message = str(caught.exception)
            self.assertIn(POST_URL, message)
            self.assertIn(POST_TEXT, message)
            self.assertIn("RCL_FROM_2010_2014.txt", message)
            self.assertFalse((root / "extracted" / POST_TEXT).exists())

    def test_missing_zip_names_the_url_and_expected_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(SystemExit) as caught:
                sources.extract_source(root / POST_ZIP, root / "extracted", POST_TEXT, POST_URL)
        message = str(caught.exception)
        self.assertIn(POST_URL, message)
        self.assertIn(POST_TEXT, message)
        self.assertIn(POST_ZIP, message)

    def test_empty_member_is_not_left_behind(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            zip_path = root / POST_ZIP
            self._zip(zip_path, {POST_TEXT: b""})
            with self.assertRaises(SystemExit) as caught:
                sources.extract_source(zip_path, root / "extracted", POST_TEXT, POST_URL)
            self.assertIn(POST_URL, str(caught.exception))
            self.assertIn("empty", str(caught.exception))
            self.assertFalse((root / "extracted" / POST_TEXT).exists())

    def test_require_texts_rejects_a_missing_or_empty_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = root / "extracted"
            raw.mkdir()
            zips = root / "zips"
            zips.mkdir()
            zip_path = zips / POST_ZIP
            self._zip(zip_path, {"RCL_RENAMED.txt": b"rows\n"})
            with self.assertRaises(SystemExit) as caught:
                sources.require_texts(raw, zips)
        message = str(caught.exception)
        self.assertIn(POST_URL, message)
        self.assertIn(POST_TEXT, message)
        self.assertIn("RCL_RENAMED.txt", message)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = root / "extracted"
            raw.mkdir()
            (raw / POST_TEXT).write_bytes(b"")
            for _key, _url, zip_name, text_name in sources.SOURCES:
                if text_name != POST_TEXT:
                    (raw / text_name).write_bytes(b"x\n")
                (root / zip_name).write_bytes(b"")
            with self.assertRaises(SystemExit) as caught:
                sources.require_texts(raw, root)
        self.assertIn("empty", str(caught.exception))
        self.assertIn(POST_URL, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
