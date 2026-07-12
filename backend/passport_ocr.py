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
from PIL import Image, ImageOps
from mrz.base.countries_ops import is_code as _is_country_code
from mrz.checker.td3 import TD3CodeChecker

_MRZ_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
_TESS_CONFIG = f"--psm 6 -c tessedit_char_whitelist={_MRZ_CHARSET}"
# TD3 lines are 44 chars. A real phone photo (background patterning behind
# the MRZ print, uneven lighting, slight blur/noise/rotation) reliably drops
# a handful of characters even after preprocessing — confirmed against a
# real-world failure report, where the true MRZ line OCR'd to 29 of its 44
# characters. 20 is a deliberately generous floor: low enough to survive
# that kind of dropout, still comfortably above the length of the other
# printed field values on a photo page (names, nationality, etc.) that also
# pass through the same character whitelist and would otherwise be
# candidates too. Padded back out to 44 with '<' before parsing either way.
_MRZ_LINE_RE = re.compile(r"^[A-Z0-9<]{20,44}$")


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
    """Return the best-guess MRZ line pair from OCR'd text.

    Real-world regression: with no automatic MRZ-region cropping (see the
    module docstring), tesseract occasionally splits the true line 2 into
    two separate output lines on a busy/noisy photo -- both fragments still
    satisfy the plain length/alphabet shape check, so a naive "last two
    shape-matching lines" pick grabbed two line-2 fragments and treated the
    digit-heavy first one as line 1, producing a "name" full of digits
    (reported: a garbled mix of letters and digits where the holder's name
    should have been).

    ICAO 9303 gives a hard, free structural guard against exactly this:
    **line 1 (document type/issuing country/name) never contains a digit —
    only line 2 (document number/dates/checksums) does.** So instead of
    blindly taking the last two candidates, search backward from the end of
    the text for the last candidate containing at least one digit (line 2),
    then continue searching backward from there for the nearest candidate
    containing *no* digits at all (line 1). If no such pair exists, this
    correctly returns nothing (the caller 422s) rather than pairing up two
    fragments of the same real line."""
    candidates = []
    for raw in text.splitlines():
        line = raw.strip().replace(" ", "")
        if _MRZ_LINE_RE.match(line):
            candidates.append(line)

    for i in range(len(candidates) - 1, 0, -1):
        line2 = candidates[i]
        if not any(c.isdigit() for c in line2):
            continue
        for j in range(i - 1, -1, -1):
            line1 = candidates[j]
            if not any(c.isdigit() for c in line1):
                return [line1, line2]
    return []


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


def _otsu_threshold(gray: Image.Image) -> int:
    """Otsu's method (finds the pixel value that best splits the image into
    two classes) via PIL's built-in histogram() -- no numpy dependency.
    Self-adapts per-photo rather than committing to one fixed brightness
    cutoff, which doesn't generalize across different lighting."""
    hist = gray.histogram()
    total = sum(hist)
    sum_total = sum(i * h for i, h in enumerate(hist))
    sum_b = w_b = max_var = thresh = 0.0
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_total - sum_b) / w_f
        var_between = w_b * w_f * (m_b - m_f) ** 2
        if var_between > max_var:
            max_var = var_between
            thresh = t
    return int(thresh)


def _preprocess_variants(gray: Image.Image) -> List[Image.Image]:
    """A short ladder of increasingly-aggressive contrast treatments, tried
    in order until one yields a recognizable MRZ (see extract_mrz). Real
    phone photos vary a lot in lighting and background patterning behind
    the print (confirmed against a real-world failure report) -- no single
    fixed treatment works for every photo, so this tries a few cheap ones
    rather than committing to one."""
    autocontrast = ImageOps.autocontrast(gray, cutoff=1)
    threshold = _otsu_threshold(autocontrast)
    binarized = autocontrast.point(lambda p: 255 if p > threshold else 0)
    return [gray, autocontrast, binarized]


def _bottom_strip(gray: Image.Image, fraction: float = 0.35) -> Image.Image:
    """Crop to the bottom fraction of the photo, where the MRZ always sits
    on a TD3 passport page (ICAO 9303), then upscale if the crop is small.

    Restricting OCR to just this strip removes almost all the visual noise
    a full passport photo carries -- the portrait photo, security/guilloche
    patterns, multiple printed fields in a different, non-monospace font --
    which is exactly what makes tesseract's page-segmentation struggle on a
    busy real photo (a small monospace strip competing with a much busier
    rest-of-page). This is the single biggest lever for real-world accuracy
    the module docstring already flagged as a known gap. Tried first, ahead
    of the full photo, in extract_mrz's region list."""
    w, h = gray.size
    top = int(h * (1 - fraction))
    crop = gray.crop((0, top, w, h))
    # MRZ text is often only ~20-30px tall in a full-page phone photo --
    # well below what tesseract reads reliably. Upscale small crops (cheap,
    # since this is now a small image, unlike upscaling the whole photo).
    if crop.size[1] < 120:
        scale = 120 / crop.size[1]
        crop = crop.resize((int(crop.size[0] * scale), int(crop.size[1] * scale)), Image.LANCZOS)
    return crop


def _ocr_text(image: Image.Image) -> str:
    """Write the image to a temp file (pytesseract needs a path or PIL
    image, and a temp file also matches the pattern used everywhere else in
    this module) and run tesseract against it. When called on the original
    decrypted photo, this is the one place decrypted passport bytes touch
    disk anywhere in this app — delete it immediately in `finally`, success
    or failure."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        image.save(tmp_path)
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

    gray = Image.open(io.BytesIO(image_bytes)).convert("L")

    # Bottom-strip crop first (see _bottom_strip) -- cheap, and correct for
    # the overwhelming majority of real photos, since it's where the MRZ
    # always is. Full photo stays as a fallback for unusual framing (e.g.
    # already cropped tight to just the MRZ, where cropping again could
    # clip real content).
    lines: List[str] = []
    for region in (_bottom_strip(gray), gray):
        for variant in _preprocess_variants(region):
            lines = _find_mrz_lines(_ocr_text(variant))
            if len(lines) >= 2:
                break
        if len(lines) >= 2:
            break
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

    nationality = f.nationality.rstrip("<")
    issuing_country = f.country.rstrip("<")

    return {
        "document_number": f.document_number.rstrip("<"),
        "document_number_valid": bool(checker.document_number_hash),
        "holder_name": holder_name,
        "nationality": nationality,
        # TD3's alpha-3 country codes have no ICAO check digit of their own
        # (only the numeric/date fields do) -- OCR noise on these two or
        # three letters produces a plausible-looking but wrong code with no
        # other signal to catch it (a real-world report: "P<AUS" OCR'd to a
        # value that isn't a real country at all). is_code() cross-checks
        # against the mrz package's own bundled ICAO/ISO 3166-1 alpha-3
        # list -- not a cryptographic guarantee like the other _valid
        # flags, but a real, free correctness signal for a field that
        # otherwise had none.
        "nationality_valid": bool(nationality) and _is_country_code(nationality),
        "date_of_birth": _mrz_date_to_iso(f.birth_date, is_birth=True),
        "date_of_birth_valid": bool(checker.birth_date_hash),
        "sex": f.sex if f.sex in ("M", "F") else "",
        "issuing_country": issuing_country,
        "issuing_country_valid": bool(issuing_country) and _is_country_code(issuing_country),
        "expiry_date": _mrz_date_to_iso(f.expiry_date, is_birth=False),
        "expiry_date_valid": bool(checker.expiry_date_hash),
        "overall_valid": bool(checker.final_hash),
    }
