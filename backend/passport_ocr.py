"""Local, offline passport MRZ (machine-readable zone) extraction.

No network call, no third-party service: OCR runs via the `tesseract-ocr`
system binary (through `pytesseract`), and the recognized text is parsed +
checksum-validated via the `mrz` package (ICAO Doc 9303 TD3 format). Nothing
here ever leaves the server process — see docs/plans/plan-13-passport-ocr.md.

Originally planned around `passporteye`, which also does automatic MRZ
region-detection via scikit-image/OpenCV — dropped during implementation
because its own setup.py fails to build on modern Python/setuptools (no
prebuilt wheel exists on PyPI; its abandoned `pdfminer` dependency has the
same problem). `pytesseract` + `mrz` are both actively maintained, ship
clean wheels, and have a much lighter dependency footprint. The tradeoff:
no automatic region cropping, so this looks for MRZ-shaped lines anywhere
in the recognized text rather than pre-locating the strip in the photo.
"""
import io
import os
import re
import shutil
import tempfile
from datetime import date
from typing import List, Optional

import pytesseract
from PIL import Image
from mrz.checker.td3 import TD3CodeChecker

_MRZ_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
_TESS_CONFIG = f"--psm 6 -c tessedit_char_whitelist={_MRZ_CHARSET}"
# TD3 lines are 44 chars; allow a little OCR slack on the low end rather
# than requiring an exact match, then pad back out to 44 before parsing.
_MRZ_LINE_RE = re.compile(r"^[A-Z0-9<]{30,44}$")


class PassportOcrNotAvailable(Exception):
    """Raised when the tesseract binary isn't installed — callers (the
    router) translate this into a 503, matching the fail-closed convention
    used for every other optional-but-required config in this codebase."""


class PassportOcrError(Exception):
    """Raised when a photo is readable but no valid-looking MRZ text could
    be found or parsed in it. Callers translate this into a 422 — the
    request itself was fine, the image just didn't yield a usable MRZ."""


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def _find_mrz_lines(text: str) -> List[str]:
    """Return the best-guess MRZ line pair from OCR'd text: the last two
    lines that look MRZ-shaped (mostly the MRZ alphabet, plausible length).
    The *last* two, not the first two, since the MRZ sits at the bottom of
    the photo page and any other printed text is more likely to be picked
    up first/above it."""
    candidates = []
    for raw in text.splitlines():
        line = raw.strip().replace(" ", "")
        if _MRZ_LINE_RE.match(line):
            candidates.append(line)
    return candidates[-2:] if len(candidates) >= 2 else []


def _pad44(s: str) -> str:
    return (s + "<" * 44)[:44]


def _mrz_date_to_iso(yymmdd: str, *, is_birth: bool) -> Optional[str]:
    """MRZ dates are 2-digit years with no explicit century. A birth date
    must be in the past — if treating YY as 20YY would put it in the
    future, it must mean 19YY instead. An expiry date is always meant to
    be a real, nameable calendar date relative to issuance, so default it
    to 20YY (passports issued before ~2000 with this exact ambiguity are
    long expired regardless)."""
    if not yymmdd or len(yymmdd) != 6 or not yymmdd.isdigit():
        return None
    yy, mm, dd = int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:6])
    if is_birth:
        this_year_2d = date.today().year % 100
        century = 2000 if yy <= this_year_2d else 1900
    else:
        century = 2000
    try:
        return date(century + yy, mm, dd).isoformat()
    except ValueError:
        return None


def _ocr_text(image_bytes: bytes) -> str:
    """Write the decrypted image to a temp file (pytesseract needs a path
    or PIL image; a temp file also lets us normalize odd input formats via
    PIL first) and run tesseract against it. The temp file is the one place
    decrypted passport bytes touch disk anywhere in this app — delete it
    immediately in `finally`, success or failure."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        Image.open(io.BytesIO(image_bytes)).convert("L").save(tmp_path)
        return pytesseract.image_to_string(tmp_path, config=_TESS_CONFIG)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def extract_mrz(image_bytes: bytes) -> dict:
    """Run local OCR + MRZ parsing against a decrypted passport photo.
    Raises PassportOcrNotAvailable if tesseract isn't installed,
    PassportOcrError if no valid-looking MRZ was found or it failed to
    parse. Returns a dict of extracted fields plus per-field check-digit
    validity (see docs/plans/plan-13-passport-ocr.md)."""
    if not tesseract_available():
        raise PassportOcrNotAvailable()

    text = _ocr_text(image_bytes)
    lines = _find_mrz_lines(text)
    if len(lines) < 2:
        raise PassportOcrError("Could not locate a machine-readable zone in this image.")

    mrz_text = f"{_pad44(lines[-2])}\n{_pad44(lines[-1])}"
    try:
        checker = TD3CodeChecker(mrz_text, check_expiry=False, compute_warnings=True)
    except Exception as e:
        raise PassportOcrError(f"Could not parse the detected MRZ text: {e}")

    f = checker.fields()
    holder_name = " ".join(
        part.replace("<", " ").strip() for part in (f.name, f.surname) if part
    ).strip()
    holder_name = re.sub(r"\s+", " ", holder_name)

    return {
        "document_number": f.document_number.rstrip("<"),
        "document_number_valid": bool(checker.document_number_hash),
        "holder_name": holder_name,
        "nationality": f.nationality.rstrip("<"),
        "date_of_birth": _mrz_date_to_iso(f.birth_date, is_birth=True),
        "date_of_birth_valid": bool(checker.birth_date_hash),
        "sex": f.sex if f.sex in ("M", "F") else "",
        "issuing_country": f.country.rstrip("<"),
        "expiry_date": _mrz_date_to_iso(f.expiry_date, is_birth=False),
        "expiry_date_valid": bool(checker.expiry_date_hash),
        "overall_valid": bool(checker.final_hash),
    }
