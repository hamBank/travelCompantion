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
import collections
import functools
import io
import logging
import os
import re
import shutil
import tempfile
import time
from datetime import date
from typing import List, Optional

import pytesseract
from PIL import Image, ImageChops, ImageFilter, ImageOps
from mrz.base.countries_ops import is_code as _is_country_code
from mrz.checker.td3 import TD3CodeChecker

logger = logging.getLogger(__name__)

_MRZ_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
_TESS_CONFIG = f"--psm 6 -c tessedit_char_whitelist={_MRZ_CHARSET}"
# The purpose-trained MRZ models get NO character whitelist. They already only
# emit the MRZ alphabet, and a whitelist on top of them degrades the read:
# reported on a real passport photo where `tesseract photo.jpg - -l mrz --psm 6`
# returned both MRZ lines perfectly while the app (same model, plus this
# whitelist) failed. The whitelist stays on the stock `eng` model, which needs it.
_MRZ_MODEL_CONFIG = "--psm 6"
# Real MRZs are printed in OCR-B; tesseract's generic `eng` model was never
# trained on it. If a purpose-trained MRZ traineddata is installed on the
# server (deploy.sh downloads DoubangoTelecom's `mrz.traineddata` — see the
# plan doc's deployment section), prefer it. Everything degrades cleanly to
# `eng` when it isn't there, so this is a deploy-time accuracy upgrade, not
# a hard dependency.
_MRZ_TRAINEDDATA_PREFERENCE = ("mrz", "ocrb")
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


@functools.lru_cache(maxsize=1)
def _tess_configs() -> tuple:
    """Tesseract configs to try, best-guess first: an installed MRZ/OCR-B
    traineddata (see _MRZ_TRAINEDDATA_PREFERENCE), then ALWAYS the stock `eng`
    model as a last entry.

    The stock model is kept in the list on purpose, not just as a fallback for
    when tesseract errors: a purpose-trained model is an accuracy *upgrade* on
    the inputs it was trained for, but it can also return confident garbage
    on others (a full-page or loosely-cropped photo, a different tesseract
    build). Trying both and keeping whichever read scores best by ICAO check
    digits means a misbehaving MRZ model can never do worse than the stock
    one. Cached: the installed-language list only changes on redeploy, and
    probing it costs a tesseract subprocess spawn per call otherwise."""
    try:
        langs = set(pytesseract.get_languages(config=""))
    except Exception:
        langs = set()
    configs = [f"-l {lang} {_MRZ_MODEL_CONFIG}" for lang in _MRZ_TRAINEDDATA_PREFERENCE if lang in langs]
    configs.append(_TESS_CONFIG)
    return tuple(configs)


def _tess_config() -> str:
    """The preferred (first) config -- what a single-pass caller should use."""
    return _tess_configs()[0]


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


def _repair_line1(line1: str) -> str:
    """Fix the two OCR errors line 1 of a TD3 MRZ routinely suffers, neither
    of which has a check digit to catch it (so the checksum score is blind to
    them and the holder name just comes back empty):

    * the `<` after the `P` document type read as a letter ("P<AUS" ->
      "PSAUS"). Passports are type `P` with filler as the second character
      (the issuing-state variants `PD`/`PO` are rare enough that a wrong
      repair there costs only the name, which was unparseable anyway);
    * the trailing filler read as `<` mixed with stray letters
      ("<<<<<<<K<K<"). The names field is SURNAME<<GIVEN<NAMES and a run of
      three `<` can only be the start of the filler, so everything after the
      first `<<<` is filler by definition."""
    line1 = line1.strip()
    if len(line1) > 1 and line1[0] == "P" and line1[1] != "<" and line1[1].isalpha() and line1[1] in "SKCEGLIJ":
        line1 = "P<" + line1[2:]
    head, names = line1[:5], line1[5:]
    cut = names.find("<<<")
    if cut != -1:
        names = names[:cut]
    return head + names


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


def _adaptive_mean_binarize(gray: Image.Image, c: int = 12) -> Image.Image:
    """Local adaptive-mean threshold: each pixel is white iff it's brighter
    than (its neighborhood mean - c), computed entirely with C-speed PIL
    primitives (BoxBlur + subtract + point LUT) -- no numpy dependency.

    This is the ladder's answer to *uneven* lighting: a shadow band, glare
    edge, or illumination gradient crossing the MRZ defeats the global Otsu
    rung completely -- one threshold for the whole strip puts half the text
    on the wrong side of the cut and erases it before tesseract ever sees
    it (benchmarked: every shadow-over-MRZ case scored 0.00 with the global
    ladder, 0.88-0.93 with this rung). The trailing median filter despeckles
    the flat background regions where a purely local threshold otherwise
    amplifies noise into text-like clutter -- which is also why this is a
    *fallback* rung rather than the first choice: on clean, evenly-lit
    photos the global treatments are more reliable."""
    window = max(15, (gray.size[1] // 6) | 1)
    mean = gray.filter(ImageFilter.BoxBlur(window // 2))
    # subtract(clip((p - mean) + 128)) > 128 - c  <=>  p > mean - c, staying
    # within 8-bit range the whole way.
    diff = ImageChops.subtract(gray, mean, scale=1, offset=128)
    binz = diff.point(lambda v: 255 if v > 128 - c else 0)
    return binz.filter(ImageFilter.MedianFilter(3))


def _preprocess_variants(gray: Image.Image) -> List[Image.Image]:
    """A short ladder of increasingly-aggressive contrast treatments, tried
    in order until one yields a recognizable MRZ (see extract_mrz). Real
    phone photos vary a lot in lighting and background patterning behind
    the print (confirmed against a real-world failure report) -- no single
    fixed treatment works for every photo, so this tries a few cheap ones
    rather than committing to one. Order matters: global treatments first
    (most reliable on evenly-lit photos), the local adaptive threshold last
    (the only rung that survives uneven lighting, but noisier on clean
    input -- see _adaptive_mean_binarize)."""
    autocontrast = ImageOps.autocontrast(gray, cutoff=1)
    threshold = _otsu_threshold(autocontrast)
    binarized = autocontrast.point(lambda p: 255 if p > threshold else 0)
    return [gray, autocontrast, binarized, _adaptive_mean_binarize(gray)]


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


def _ocr_text(image: Image.Image, config: Optional[str] = None) -> str:
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
        config = config or _tess_config()
        try:
            return pytesseract.image_to_string(tmp_path, config=config, timeout=_OCR_CALL_TIMEOUT_S)
        except Exception as e:
            # pytesseract raises RuntimeError("Tesseract process timeout") when
            # the per-call cap is hit. That's "no text from this pass", not a
            # broken traineddata -- don't retry it with eng (that would just
            # spend a second timeout on the same image).
            if isinstance(e, RuntimeError) and "timeout" in str(e).lower():
                return ""
            # A broken/corrupt MRZ traineddata on the server must degrade to
            # the stock eng model, not take the whole feature down -- the
            # traineddata is a deploy-time download (see deploy.sh), so a
            # truncated file is a real possibility the code has to absorb.
            if config == _TESS_CONFIG:
                raise
            return pytesseract.image_to_string(tmp_path, config=_TESS_CONFIG, timeout=_OCR_CALL_TIMEOUT_S)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def _checksum_score(checker: TD3CodeChecker) -> int:
    """How many of the four ICAO check digits validate (0-4). The runtime
    quality signal that lets the ladder rank candidates instead of trusting
    whichever variant happened to produce MRZ-shaped text first."""
    return sum(bool(h) for h in (
        checker.document_number_hash, checker.birth_date_hash,
        checker.expiry_date_hash, checker.final_hash,
    ))


_PERFECT_SCORE = 4

# Hard bounds so a bad photo can never hold a request open for a minute behind
# the reverse proxy. Measured against real tesseract: a photo with no MRZ
# fails in ~5s, but a featureless/noisy one ran 35-60s because tesseract spends
# seconds per pass on whole-photo noise. Each call is capped, and once the
# overall budget is spent the ladder stops and returns the best read found so
# far (or the caller's honest 422).
_OCR_CALL_TIMEOUT_S = 10
_OCR_BUDGET_S = 20.0


# Two independent check digits validating is the floor for "this is a real MRZ".
# One is not enough: a reported scan of a real passport returned a "document
# number" of `P<AUS1<<N`, a name of random letters and no dates, yet looked
# plausible because one check digit over an empty field and two valid-by-chance
# country codes got it through. Better an honest 422 than that.
_MIN_PLAUSIBLE_SCORE = 2


def _is_plausible(checker: TD3CodeChecker) -> bool:
    """Is this parse evidence of a real MRZ, or just text that happens to be
    the right *shape*?

    The line filter (_find_mrz_lines) only checks length/alphabet and the
    digit-free-line-1 rule, so OCR noise from a patterned or busy region
    (guilloche, hologram, printed names) can pass it -- reported: a scan
    "succeeded" with a document number, name, nationality and issuing
    country that were all garbage, with every check digit failing.

    A genuine MRZ, even a noisy read, leaves at least one of two signals
    intact: some ICAO check digit still validates, or a country code still
    matches the bundled ICAO list (random letters hit a valid 3-letter code
    only ~1% of the time per field). Neither => treat as not found, so the
    ladder moves on to the next variant/rotation and ultimately the caller
    gets an honest 422 instead of junk to review."""
    return _checksum_score(checker) >= _MIN_PLAUSIBLE_SCORE


def _estimate_skew_deg(gray: Image.Image, max_deg: float = 10.0, step: float = 0.5) -> float:
    """Angle (degrees, PIL's counter-clockwise-positive convention, i.e. the
    value to pass to Image.rotate) that levels the text lines in the bottom
    strip, or 0.0 when there's no clear improvement over the photo as-is.

    Classic projection-profile deskew: binarize the strip so ink is white,
    rotate it through a range of small angles, and score each by the variance
    of its per-row ink totals -- when the two MRZ lines are exactly
    horizontal their rows are dense and the gaps between are empty, so the
    row profile is at its most "peaky". PIL-only (resize-to-one-column is a
    C-speed row average), no numpy/OpenCV dependency.

    Real phone photos are rarely level, and the OCR ladder only tolerates
    about +-1 degree of tilt (measured against real tesseract: beyond that it
    either finds nothing or returns a plausible but wrong read), so this is
    what makes handheld photos readable at all."""
    strip = _bottom_strip(gray)
    w, h = strip.size
    if w > 700:
        strip = strip.resize((700, max(1, int(h * 700 / w))))
    # Local-adaptive binarize, NOT a global threshold: a global one counts the
    # dark table/background around a tilted page as "ink", and its huge flat
    # triangle swamps the two text lines (measured: the estimate was 0 at
    # every tilt). Adaptive keeps only strokes and edges.
    ink = ImageChops.invert(_adaptive_mean_binarize(strip)).point(lambda v: 255 if v > 127 else 0)

    def row_variance(angle: float) -> float:
        r = ink.rotate(angle, resample=Image.BILINEAR, expand=True, fillcolor=0)
        rows = r.resize((1, r.size[1]), Image.BOX).tobytes()
        mean = sum(rows) / len(rows)
        return sum((v - mean) ** 2 for v in rows) / len(rows)

    base = row_variance(0.0)
    best_angle, best_var = 0.0, base
    n = int(max_deg / step)
    for i in range(1, n + 1):
        for angle in (i * step, -i * step):
            v = row_variance(angle)
            if v > best_var:
                best_angle, best_var = angle, v
    # Demand a real improvement so a blank/featureless image, or one that is
    # already level, isn't rotated on noise.
    if abs(best_angle) < step or best_var < base * 1.05:
        return 0.0
    return best_angle


def _deskew(gray: Image.Image, angle: float) -> Image.Image:
    """Rotate by `angle` (see _estimate_skew_deg), filling the new corners
    with the photo's median brightness so they don't read as ink."""
    hist = gray.histogram()
    total, acc, median = sum(hist), 0, 255
    for i, c in enumerate(hist):
        acc += c
        if acc >= total / 2:
            median = i
            break
    return gray.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=median)


def _better(a: Optional[TD3CodeChecker], b: Optional[TD3CodeChecker]) -> Optional[TD3CodeChecker]:
    if a is None:
        return b
    if b is None:
        return a
    return b if _checksum_score(b) > _checksum_score(a) else a


def _read_orientation(gray: Image.Image, regions, deadline: float = float("inf"), stats=None) -> Optional[TD3CodeChecker]:
    """Best read of one orientation: as-is first (cheap, and right for a level
    photo), then -- unless that was already a fully checksum-valid read --
    again after straightening the estimated tilt, keeping whichever scores
    higher. A tilted photo typically yields a wrong-but-plausible read at the
    as-is rung, which is why a non-perfect score (not just 'nothing found')
    triggers the deskewed retry."""
    best = _best_candidate(gray, regions, deadline, stats)
    if best is not None and _checksum_score(best) == _PERFECT_SCORE:
        return best
    if time.monotonic() > deadline:
        return best
    angle = _estimate_skew_deg(gray)
    if angle:
        best = _better(best, _best_candidate(_deskew(gray, angle), regions, deadline, stats))
    return best


def _best_candidate(gray: Image.Image, regions, deadline: float = float("inf"), stats=None) -> Optional[TD3CodeChecker]:
    """Run the region x preprocessing ladder over one orientation of the photo
    and return the best-scoring parsed MRZ candidate, or None.

    Bottom-strip crop first (see _bottom_strip) -- cheap, and correct for
    the overwhelming majority of real photos, since it's where the MRZ
    always is. `regions` lets the caller add the full photo as a fallback
    for unusual framing (e.g. already cropped tight to just the MRZ, where
    cropping again could clip real content) -- but only when the strip
    produced *nothing*, so the expensive whole-photo OCR pass stays off the
    common path.

    Checksum-guided selection: the old ladder stopped at the first variant
    that produced two MRZ-shaped lines, even when every check digit failed
    -- benchmarked, that early stop left recoverable accuracy on the table
    (a glare case stopped at ~90% char accuracy when a later rung read the
    same strip at ~98%). The ICAO check digits are a free runtime quality
    signal, so: stop immediately only on a fully checksum-valid read;
    otherwise remember the best-scoring candidate and let the remaining
    rungs try to beat it."""
    best: Optional[TD3CodeChecker] = None
    best_score = -1
    configs = _tess_configs()

    def consider(text: str, model: str) -> None:
        nonlocal best, best_score
        lines = _find_mrz_lines(text)
        if stats is not None:
            stats[f"{model}:passes"] += 1
        if len(lines) < 2:
            return
        if stats is not None:
            stats[f"{model}:mrz_shaped"] += 1
        mrz_text = f"{_pad44(_repair_line1(lines[-2]))}\n{_pad44(lines[-1])}"
        try:
            candidate = TD3CodeChecker(mrz_text, check_expiry=False, compute_warnings=True)
        except Exception:
            return  # unparseable candidate; a later pass may do better
        if not _is_plausible(candidate):
            if stats is not None:
                stats[f"{model}:rejected_as_noise"] += 1
            return  # MRZ-shaped noise, not a real read; keep looking
        score = _checksum_score(candidate)
        if stats is not None:
            stats[f"{model}:plausible"] += 1
        if score > best_score:
            best, best_score = candidate, score

    def model_of(config: str) -> str:
        return config.split()[1] if config.startswith("-l ") else "eng"

    # A purpose-trained MRZ model is built to read the whole page untouched:
    # on a real photo `tesseract photo.jpg - -l mrz --psm 6` returned both MRZ
    # lines perfectly while the preprocessed-strip ladder below did not. So
    # give each such model that exact input first, and stop if it's perfect.
    for config in configs:
        if config == _TESS_CONFIG or time.monotonic() > deadline:
            continue
        consider(_ocr_text(gray, config), model_of(config))
        if best_score == _PERFECT_SCORE:
            return best

    for region in regions(gray):
        for variant in _preprocess_variants(region):
            for config in configs:
                if time.monotonic() > deadline:
                    return best
                consider(_ocr_text(variant, config), model_of(config))
                if best_score == _PERFECT_SCORE:
                    break
            if best_score == _PERFECT_SCORE:
                break
        if best is not None:
            break
    return best


def extract_mrz(image_bytes: bytes) -> dict:
    """Run local OCR + MRZ parsing against a decrypted passport photo.
    Raises PassportOcrNotAvailable if tesseract isn't installed,
    PassportOcrError if no valid-looking MRZ was found or it failed to
    parse. Returns a dict of extracted fields plus per-field check-digit
    validity (see docs/plans/plan-13-passport-ocr.md)."""
    if not tesseract_available():
        raise PassportOcrNotAvailable()

    # Phone cameras usually store a portrait/landscape shot sideways and set an
    # EXIF Orientation flag instead of rotating the pixels. PIL ignores that
    # flag unless asked, so without this the MRZ is OCR'd on its side and
    # never found, and the scan 422s on a photo that looks fine on screen.
    gray = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("L")

    started = time.monotonic()
    deadline = started + _OCR_BUDGET_S
    stats: collections.Counter = collections.Counter()
    best = _read_orientation(gray, regions=lambda g: (_bottom_strip(g), g), deadline=deadline, stats=stats)
    if best is None:
        # No usable MRZ upright. The EXIF flag may have been stripped (an
        # upload resizer, a screenshot, a messaging app's re-encode) leaving
        # a sideways or upside-down photo -- try the other three orientations
        # before giving up. Only the bottom strip is tried per rotation (the
        # expensive whole-photo pass stays upright-only), and this runs only
        # on inputs that would otherwise 422, so it costs nothing on the
        # common path.
        for angle in (90, 270, 180):
            if time.monotonic() > deadline:
                break
            rotated = gray.rotate(angle, expand=True)
            best = _read_orientation(rotated, regions=lambda g: (_bottom_strip(g),), deadline=deadline, stats=stats)
            if best is not None:
                break
    if best is None:
        # Diagnostics only -- counts and timings, never recognized text (it's
        # passport data). Tells an operator whether the MRZ model was in use,
        # whether it produced anything MRZ-shaped, and whether the time budget
        # was spent, without having to reproduce the photo.
        logger.warning(
            "passport scan found no MRZ: image=%dx%d models=%s elapsed=%.1fs budget_spent=%s stats=%s",
            gray.size[0], gray.size[1], [c.split()[1] if c.startswith("-l ") else "eng" for c in _tess_configs()],
            time.monotonic() - started, time.monotonic() > deadline, dict(stats),
        )
        raise PassportOcrError("Could not locate a machine-readable zone in this image.")
    checker = best

    f = checker.fields()
    # The mrz package's own identifier parser (name/surname) sets its two
    # internal fields to Python `None` when the identifier fails its
    # structural checks (e.g. more than two "<<"-separated groups, often
    # from OCR noise splitting a given name) -- but fields() then stringifies
    # them, so a failed parse leaks the *literal text* "None" into f.name /
    # f.surname rather than an empty string (confirmed via reproduction: a
    # real-world report of a passport scan where every other field extracted
    # correctly except the holder name, which came back "None None"). Filter
    # that placeholder out same as any other missing value.
    holder_name = " ".join(
        part.replace("<", " ").strip() for part in (f.name, f.surname) if part and part != "None"
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
