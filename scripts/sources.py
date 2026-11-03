#!/usr/bin/env python3
"""Public source archives and how their zip members map to flat files.

VF_RAW holds the downloaded zips. The text the build reads is extracted to
VF_RAW/extracted under the expected file name. The weekly workflow sets
VF_RAW=/tmp/vf-raw, so the texts are not in VF_RAW itself.

NHTSA also lists year-range recall zips (RCL_FROM_YYYY_YYYY.zip). The two
FLAT_RCL archives are still the full files, and each contains one text member
with the same stem as the zip. Those are the files this pipeline reads.
"""

from __future__ import annotations

import os
import shutil
import zipfile
from pathlib import Path, PurePosixPath
from typing import NoReturn

DEFAULT_ROOT = Path("/tmp/vf-raw")

# key, url, zip name, extracted text name
SOURCES = [
    ("recalls_post_2010", "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip", "FLAT_RCL_POST_2010.zip", "FLAT_RCL_POST_2010.txt"),
    ("recalls_pre_2010", "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip", "FLAT_RCL_PRE_2010.zip", "FLAT_RCL_PRE_2010.txt"),
    ("complaints", "https://static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip", "FLAT_CMPL.zip", "FLAT_CMPL.txt"),
    ("investigations", "https://static.nhtsa.gov/odi/ffdd/inv/FLAT_INV.zip", "FLAT_INV.zip", "FLAT_INV.txt"),
    ("epa", "https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip", "vehicles.csv.zip", "vehicles.csv"),
]


def raw_root() -> Path:
    return Path(os.environ.get("VF_RAW", str(DEFAULT_ROOT)))


def zip_directory() -> Path:
    return Path(os.environ.get("VF_ZIPS", os.environ.get("VF_RAW", str(DEFAULT_ROOT))))


def text_dir(root: Path | None = None) -> Path:
    """Directory of extracted flat files: <VF_RAW>/extracted."""
    parent = raw_root() if root is None else root
    return parent / "extracted"


def resolve_io_dirs(raw: str | None, zips: str | None) -> tuple[Path, Path]:
    raw_dir = Path(raw) if raw else text_dir()
    zip_dir = Path(zips) if zips else zip_directory()
    return raw_dir, zip_dir


def source_by_key(key: str) -> tuple[str, str, str, str]:
    for item in SOURCES:
        if item[0] == key:
            return item
    raise KeyError(key)


def download_list() -> list[tuple[str, str]]:
    return [(url, zip_name) for _key, url, zip_name, _text in SOURCES]


def member_basename(name: str) -> str:
    return PurePosixPath(name.replace("\\", "/")).name


def match_member(members: list[str], expected: str) -> str | None:
    """Return the one archive member whose basename is `expected`.

    A member stored in a folder still matches. Two members with that basename
    are ambiguous and do not match: guessing could publish a partial recall file.
    """
    matches = [name for name in members if name and not name.endswith("/") and member_basename(name) == expected]
    if len(matches) == 1:
        return matches[0]
    return None


def format_missing(url: str, expected: str, directory: Path, detail: str) -> str:
    return (
        f"Missing extracted file {expected} from {url}. "
        f"Expected {expected} in {directory}. {detail}."
    )


def zip_member_names(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as archive:
        return [info.filename for info in archive.infolist() if not info.is_dir()]


def describe_archive(names: list[str] | None, expected: str, zip_path: Path) -> str:
    if names is None:
        return f"Zip not found: {zip_path}"
    if not names:
        return f"Archive {zip_path.name} is empty"
    if sum(1 for name in names if member_basename(name) == expected) > 1:
        return f"Ambiguous archive members named {expected}: {', '.join(names)}"
    if any(member_basename(name) == expected for name in names):
        return (
            f"Archive {zip_path.name} contains {expected} "
            f"but that file is not in the extract directory. Members: {', '.join(names)}"
        )
    return f"Archive members: {', '.join(names)}"


def _fail(url: str, expected: str, directory: Path, detail: str) -> NoReturn:
    raise SystemExit(format_missing(url, expected, directory, detail))


def extract_source(zip_path: Path, dest_dir: Path, expected: str, url: str) -> tuple[Path, str]:
    """Extract the member named `expected` to dest_dir/expected.

    The output name is always `expected`, even when the member sits in a folder.
    A renamed or missing member stops the run. An empty member is deleted so a
    later build cannot publish empty recall data.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / expected
    if not zip_path.is_file():
        _fail(url, expected, dest_dir, f"Zip not found: {zip_path}")
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        _fail(url, expected, dest_dir, f"{zip_path} is not a zip archive ({exc})")
    with archive:
        names = [info.filename for info in archive.infolist() if not info.is_dir()]
        chosen = match_member(names, expected)
        if chosen is None:
            _fail(url, expected, dest_dir, describe_archive(names, expected, zip_path))
        with archive.open(chosen, "r") as src, target.open("wb") as out:
            shutil.copyfileobj(src, out, length=1024 * 1024)
    if target.stat().st_size <= 0:
        target.unlink(missing_ok=True)
        _fail(url, expected, dest_dir, f"{expected} in {zip_path.name} was empty")
    return target, chosen


def extract_all(root: Path) -> None:
    dest = text_dir(root)
    for key, url, zip_name, text_name in SOURCES:
        target, chosen = extract_source(root / zip_name, dest, text_name, url)
        print(f"extract {key}: {chosen} -> {target}", flush=True)


def require_texts(raw_dir: Path, zip_dir: Path) -> None:
    """Stop before the build if a flat file is missing, renamed, or empty."""
    for _key, url, zip_name, text_name in SOURCES:
        text_path = raw_dir / text_name
        if text_path.is_file() and text_path.stat().st_size > 0:
            continue
        zip_path = zip_dir / zip_name
        if text_path.is_file():
            detail = f"{text_path} is empty"
        elif zip_path.is_file():
            try:
                names = zip_member_names(zip_path)
            except zipfile.BadZipFile as exc:
                detail = f"{zip_path} is not a zip archive ({exc})"
            else:
                detail = describe_archive(names, text_name, zip_path)
        else:
            detail = describe_archive(None, text_name, zip_path)
        _fail(url, text_name, raw_dir, detail)
