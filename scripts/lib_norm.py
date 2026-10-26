"""Name normalization and EPA ↔ NHTSA model matching.

Matching is name-only. It never invents a relationship that the rules below
cannot point at in the source strings.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

PUNCT = re.compile(r"[^A-Z0-9]+")
SLUG_PUNCT = re.compile(r"[^a-z0-9]+")
SERIES_RE = re.compile(r"^([1-8])SERIES$")

MAKE_ALIASES = {
    "MERCEDES BENZ": "MERCEDES",
    "MERCEDES": "MERCEDES",
    "CODA AUTOMOTIVE": "CODA",
    "MCLAREN AUTOMOTIVE": "MCLAREN",
    "MOBILITY VENTURES LLC": "MOBILITY VENTURES",
    "ROUSH PERFORMANCE": "ROUSH",
    "SALEEN PERFORMANCE": "SALEEN",
    "INEOS AUTOMOTIVE": "INEOS",
}

# Longest first. Stripped only from the NHTSA/NCAP side, and only used when the
# stripped name equals an EPA base model that does not already exact-match it.
MODEL_SUFFIXES = (
    "PLUGINHYBRID",
    "FUELCELL",
    "HYBRID",
    "PHEV",
    "BEV",
    "HEV",
    "EV",
    "4MATIC",
    "XDRIVE",
    "QUATTRO",
    "SHAWD",
    "AWD",
    "FWD",
    "RWD",
    "4WD",
    "2WD",
    "4X4",
    "4X2",
    "HATCHBACK",
    "CONVERTIBLE",
    "CABRIOLET",
    "SPORTBACK",
    "LIFTBACK",
    "ROADSTER",
    "WAGON",
    "SEDAN",
    "COUPE",
    "PRIME",
)

TRIM_SUFFIXES = ("5500", "4500", "3500", "2500", "1500", "LTZ", "SRW", "DRW", "HD", "LT")

# Removed once, from the end of an EPA name, and only when the remainder equals
# one NHTSA name. Cargo, passenger, van, wagon, hearse, and limo are omitted:
# EPA splits those into different models, and the unsuffixed NHTSA name covers
# more than one of them. Longest suffix wins (EAWD before AWD).
_EPA_SUFFIX_WORDS = (
    "EXTENDEDCAB",
    "REGULARCAB",
    "DOUBLECAB",
    "ELECTRICDRIVE",
    "PLUGINHYBRID",
    "CREWCAB",
    "QUADCAB",
    "CLUBCAB",
    "SUPERCAB",
    "KINGCAB",
    "MEGACAB",
    "CONVERTIBLE",
    "CABRIOLET",
    "SPORTBACK",
    "HATCHBACK",
    "LIFTBACK",
    "ROADSTER",
    "FUELCELL",
    "PICKUP",
    "COUPE",
    "SEDAN",
    "SPIDER",
    "4MATIC",
    "XDRIVE",
    "QUATTRO",
    "SHAWD",
    "HYBRID",
    "EAWD",
    "E4WD",
    "PRIME",
    "PHEV",
    "4WD",
    "2WD",
    "4X4",
    "4X2",
    "AWD",
    "FWD",
    "RWD",
    "BEV",
    "HEV",
    "SRT8",
    "5500",
    "4500",
    "3500",
    "2500",
    "1500",
    "V12",
    "V10",
    "AMG",
    "EV",
    "V8",
    "V6",
    "SRT",
)
EPA_SUFFIXES = tuple(sorted(_EPA_SUFFIX_WORDS, key=len, reverse=True))

# A slash in an EPA base model is EPA's own combined name ("Golf/GTI").
# Each part can claim an equal NHTSA name. Bare body words are not parts.
GENERIC_SLASH_PARTS = {
    "CABRIOLET",
    "CHALLENGE",
    "CONVERTIBLE",
    "COUPE",
    "HATCHBACK",
    "KIT",
    "PICKUP",
    "ROADSTER",
    "SEDAN",
    "SPIDER",
    "VAN",
    "WAGON",
}


def norm_make(value: str) -> str:
    text = (value or "").upper().replace("&", " AND ").replace("-BENZ", " ")
    text = PUNCT.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return MAKE_ALIASES.get(text, text)


def norm_model(value: str) -> str:
    text = (value or "").upper().replace("&", " AND ")
    return PUNCT.sub("", text)


def slug(value: str) -> str:
    text = (value or "").lower().replace("&", " and ")
    text = SLUG_PUNCT.sub("-", text).strip("-")
    return text


def strip_suffixes(value: str) -> str:
    text = value
    changed = True
    while changed and text:
        changed = False
        for suffix in MODEL_SUFFIXES:
            if text.endswith(suffix) and len(text) > len(suffix) + 1:
                text = text[: -len(suffix)]
                changed = True
                break
    return text


def strip_trims(value: str) -> str:
    text = value
    changed = True
    while changed and text:
        changed = False
        for suffix in TRIM_SUFFIXES:
            if text.endswith(suffix) and len(text) - len(suffix) >= 3:
                text = text[: -len(suffix)]
                changed = True
                break
    return text


def epa_stem(value: str) -> str | None:
    """Strip one trailing EPA suffix. None when the remainder would be too short."""
    for suffix in EPA_SUFFIXES:
        if value.endswith(suffix) and len(value) > len(suffix) + 1:
            return value[: -len(suffix)]
    return None


def slash_parts(raw: str) -> list[str]:
    if not raw or "/" not in raw:
        return []
    parts = []
    for piece in raw.split("/"):
        norm = norm_model(piece)
        if not norm or norm in GENERIC_SLASH_PARTS or norm.isdigit():
            continue
        if len(norm) < 3 and not any(ch.isdigit() for ch in norm):
            continue
        parts.append(norm)
    return parts


def class_match(stem: str, cand: str) -> bool:
    if not stem:
        return False
    if cand == stem:
        return True
    if cand.startswith(stem) and len(cand) > len(stem) and cand[len(stem)].isdigit():
        return True
    amg = "AMG" + stem
    if cand.startswith(amg) and (len(cand) == len(amg) or cand[len(amg)].isdigit()):
        return True
    return False


def series_match(digit: str, cand: str) -> bool:
    return len(cand) >= 2 and cand[0] == digit and cand[1].isdigit()


def load_manual(path: Path) -> dict[tuple[str, str], set[str]]:
    """Map (norm make, norm EPA model) → set of normalized NHTSA model names."""
    manual: dict[tuple[str, str], set[str]] = {}
    if not path.exists():
        return manual
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            make = norm_make(row.get("epa_make") or "")
            model = norm_model(row.get("epa_model") or "")
            target = norm_model(row.get("nhtsa_model") or "")
            if make and model and target:
                manual.setdefault((make, model), set()).add(target)
    return manual


def claims_for(
    make_norm: str,
    epa_model: str,
    cand: str,
    manual: set[str],
    epa_raw: str = "",
) -> int | None:
    """Return a rank (lower is stronger) if this EPA model claims the NHTSA name."""
    if cand == epa_model:
        return 0
    if cand in manual:
        return 1
    if make_norm == "MAZDA" and epa_model.isdigit() and cand == "MAZDA" + epa_model:
        return 2
    if epa_model.endswith("CLASS") and len(epa_model) > 5:
        stem = epa_model[: -len("CLASS")]
        if class_match(stem, cand):
            return 3
    series = SERIES_RE.fullmatch(epa_model)
    if series and series_match(series.group(1), cand):
        return 4
    if make_norm == "MINI" and epa_model == "CLUBMAN" and "CLUBMAN" in cand:
        return 6
    stripped = strip_suffixes(cand)
    if stripped == epa_model and stripped != cand:
        return 5
    trimmed = strip_trims(strip_suffixes(cand))
    if trimmed == epa_model and trimmed != cand:
        return 7
    # "911" → "911CARRERA", "TT" → "TTCOUPE". The next character has to be a
    # letter so "CX5" does not claim "CX50" and "Q5" does not claim "Q50".
    if (
        len(epa_model) >= 2
        and len(cand) > len(epa_model)
        and cand.startswith(epa_model)
        and cand[len(epa_model)].isalpha()
    ):
        return 8
    # Lexus "GS" → "GS350", Volvo "XC90" is exact (digits already in the name).
    # Only a short all-letter code, so "X5" and "3SERIES" are not handled here.
    if epa_model.isalpha() and 2 <= len(epa_model) <= 3:
        if cand.startswith(epa_model) and len(cand) > len(epa_model) and cand[len(epa_model)].isdigit():
            return 9
    for part in slash_parts(epa_raw):
        if cand == part:
            return 10
    stem = epa_stem(epa_model)
    if stem is not None and cand == stem:
        return 11
    # Mazda "SPEED3" → "MAZDASPEED3", Polestar "2" → "POLESTAR2".
    # Exact concatenation only, so Mazda 3 does not claim MAZDASPEED3.
    token = make_norm.replace(" ", "")
    if token and cand == token + epa_model and cand != epa_model:
        if make_norm == "POLESTAR" and epa_model.isdigit() and len(epa_model) <= 2:
            return 12
        if make_norm == "MAZDA" and len(epa_model) >= 3:
            return 12
    return None


RANK_METHOD = {
    0: "exact",
    1: "manual",
    2: "mazda-digit",
    3: "class",
    4: "series",
    5: "suffix",
    6: "mini-clubman",
    7: "trim",
    8: "prefix",
    9: "code",
    10: "slash",
    11: "epa-suffix",
    12: "make-prefix",
}

# These ranks tie whenever two EPA models claim the same name, even if the
# EPA strings differ in length. A longer name must not beat a shorter one
# when both are equally specific (Express Passenger vs Express Cargo, or two
# reviewed rows for the same NHTSA name).
TIE_RANKS = {1, 10, 11, 12}


def assign_year(
    make_norm: str,
    epa_models: list[tuple[str, str]],
    nhtsa_models: set[str],
    manual_for_make: dict[str, set[str]],
) -> tuple[dict[str, list[str]], dict[str, str], set[str]]:
    """Assign each NHTSA model to at most one EPA model.

    epa_models is a list of (model_id, normalized model) or
    (model_id, normalized model, raw EPA model). model_id is the caller's key
    (usually the display base model). The raw name is what slash-splitting reads.

    Returns (model_id → [nhtsa names], model_id → method, unclaimed nhtsa names).
    """
    parsed = []
    for entry in epa_models:
        if len(entry) == 3:
            parsed.append(entry)
        else:
            parsed.append((entry[0], entry[1], ""))
    norms = [epa_norm for _model_id, epa_norm, _raw in parsed]

    buckets: dict[str, list[tuple[int, int, str]]] = {}
    for cand in nhtsa_models:
        options = []
        for model_id, epa_norm, epa_raw in parsed:
            rank = claims_for(make_norm, epa_norm, cand, manual_for_make.get(epa_norm, set()), epa_raw)
            if rank is None:
                continue
            # "458 Spider" must not take a bare "458" while "458 Italia" is a
            # separate model that year. "DBX V8" likewise leaves "DBX" alone
            # when "DBX 707" is present. The sibling's own name is longer and
            # starts with the same stem.
            if rank == 11 and any(
                other != epa_norm and other.startswith(cand) and len(other) > len(cand) for other in norms
            ):
                continue
            length_key = 0 if rank in TIE_RANKS else -len(epa_norm)
            options.append((rank, length_key, model_id))
        if not options:
            continue
        options.sort()
        best = options[0]
        tied = [item for item in options if item[0] == best[0] and item[1] == best[1]]
        if len({item[2] for item in tied}) > 1:
            continue
        buckets.setdefault(best[2], []).append((best[0], best[1], cand))

    assigned: dict[str, list[str]] = {}
    methods: dict[str, str] = {}
    used = set()
    for model_id, rows in buckets.items():
        rows.sort()
        names = []
        best_rank = rows[0][0]
        for rank, _length, cand in rows:
            names.append(cand)
            used.add(cand)
            best_rank = min(best_rank, rank)
        assigned[model_id] = sorted(set(names))
        methods[model_id] = RANK_METHOD.get(best_rank, "matched")
    return assigned, methods, nhtsa_models - used
