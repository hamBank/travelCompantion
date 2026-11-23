"""Tests for backend/passport_ocr.py — local, offline MRZ extraction
(Tesseract + the `mrz` checksum library, no network call). Every test here
is dependency-injected against the real OCR call (monkeypatched
`pytesseract.image_to_string`) so none of them require the real tesseract
binary — see docs/plans/plan-13-passport-ocr.md's Tests section.
"""
import pytest

from backend import passport_ocr


# A real, checksum-valid ICAO Doc 9303 TD3 specimen (the standard published
# example — "Anna Maria Eriksson"), used throughout as known-good input.
@pytest.fixture(autouse=True)
def _isolate_tesseract_language_probe(monkeypatch):
    """_tess_configs() is cached and probes the host's tesseract for installed
    languages; without this, call-count assertions would depend on whether the
    machine running the tests happens to have the MRZ model installed."""
    monkeypatch.setattr(passport_ocr.pytesseract, "get_languages", lambda config="": ["eng", "osd"])
    passport_ocr._tess_configs.cache_clear()
    yield
    passport_ocr._tess_configs.cache_clear()


_VALID_LINE1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<"
_VALID_LINE2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10"


def test_find_mrz_lines_picks_last_two_mrz_shaped_lines():
    text = "PASSPORT\nSome other printed text\n" + _VALID_LINE1 + "\n" + _VALID_LINE2 + "\n"
    lines = passport_ocr._find_mrz_lines(text)
    assert lines == [_VALID_LINE1, _VALID_LINE2]


def test_find_mrz_lines_returns_empty_when_fewer_than_two_candidates():
    assert passport_ocr._find_mrz_lines("just some random text\nnot MRZ shaped at all") == []


def test_find_mrz_lines_tolerates_a_little_ocr_noise_via_length_slack():
    # A line missing a couple of trailing '<' fillers (common OCR dropout)
    # should still be picked up — re-padded to 44 later by _pad44.
    short_line1 = _VALID_LINE1[:-3]
    text = short_line1 + "\n" + _VALID_LINE2
    lines = passport_ocr._find_mrz_lines(text)
    assert lines == [short_line1, _VALID_LINE2]


def test_find_mrz_lines_tolerates_heavy_dropout_at_the_20_char_floor():
    # Real-world regression: a genuine MRZ line under noisy phone-photo
    # conditions (background patterning, blur, JPEG artifacts) OCR'd to
    # only 29 of its 44 characters and was wrongly rejected by the old
    # 30-char floor. 20 is the current floor -- right at the boundary.
    line_20 = "P<AUSERIKSSON<<ANNA<"
    assert len(line_20) == 20
    lines = passport_ocr._find_mrz_lines(line_20 + "\n" + _VALID_LINE2)
    assert lines == [line_20, _VALID_LINE2]


def test_find_mrz_lines_rejects_below_the_20_char_floor():
    line_19 = "P<AUSERIKSSON<<ANNA"
    assert len(line_19) == 19
    lines = passport_ocr._find_mrz_lines(line_19 + "\n" + _VALID_LINE2)
    assert lines == []


# ── real-world regression: line 2 split into two OCR'd lines ───────────────
# With no automatic MRZ-region cropping, tesseract can split the true line 2
# into two separate output lines on a busy/noisy photo. Both fragments still
# satisfy the plain shape/length check, so a naive "last two shape-matching
# lines" pick grabbed two line-2 fragments and treated the digit-heavy first
# one as line 1 -- reported: the holder's name came back as a garbled mix of
# letters and digits. ICAO 9303's line 1 never contains a digit (only line 2
# does), which is the structural guard _find_mrz_lines now uses.

def test_find_mrz_lines_skips_a_digit_bearing_fragment_mistaken_for_line1():
    line2_frag_a = _VALID_LINE2[:23]
    line2_frag_b = _VALID_LINE2[23:]
    assert any(c.isdigit() for c in line2_frag_a)   # confirms this fragment is digit-bearing
    text = _VALID_LINE1 + "\n" + line2_frag_a + "\n" + line2_frag_b
    lines = passport_ocr._find_mrz_lines(text)
    # Must pick the real (digit-free) line 1, not the digit-bearing fragment
    # that happens to sit right before the last candidate.
    assert lines == [_VALID_LINE1, line2_frag_b]


def test_find_mrz_lines_fails_closed_when_no_digit_free_candidate_exists():
    # Line 1 never made it into the OCR'd text at all (e.g. obscured/missed
    # entirely) -- every candidate is digit-bearing, so there's no valid
    # line-1 pairing. Must return [] (the caller 422s) rather than pairing
    # up two line-2-shaped fragments.
    line2_frag_a = _VALID_LINE2[:23]
    line2_frag_b = _VALID_LINE2[23:]
    lines = passport_ocr._find_mrz_lines(line2_frag_a + "\n" + line2_frag_b)
    assert lines == []


def test_extract_mrz_does_not_return_a_garbled_read_when_line2_is_fragmented(monkeypatch):
    """Original symptom: line 2 OCR'd as two fragments produced a "name" full
    of digits. _find_mrz_lines no longer pairs fragments (test above); and the
    resulting fragment-only parse has almost no valid check digits, so it must
    be refused (422) rather than shown for review as if it were a scan."""
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    ocr_text = "PASSPORT\n" + _VALID_LINE1 + "\n" + _VALID_LINE2[:23] + "\n" + _VALID_LINE2[23:]
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: ocr_text)
    with pytest.raises(passport_ocr.PassportOcrError):
        passport_ocr.extract_mrz(_fake_image_bytes())


def test_extract_mrz_holder_name_empty_rather_than_none_none_on_malformed_identifier(monkeypatch):
    """Real-world regression: a scan came back with every field correct
    except holder_name, which was the literal text "None None". Root cause:
    the mrz package's own identifier parser sets its internal name/surname
    fields to Python None when the identifier fails its structural checks
    (here, three "<<"-separated groups instead of two -- e.g. OCR noise
    inserting an extra separator into a given name), then stringifies them
    when building fields() -- leaking "None" as literal text instead of an
    empty value. holder_name must come back empty, not "None None", when
    this happens; every checksummed field is unaffected."""
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    malformed_line1 = "P<AUSWUTH<<ANTONY<<JOHN<<<<<<<<<<<<<<<<<<<<<"[:44]
    ocr_text = malformed_line1 + "\n" + _VALID_LINE2
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: ocr_text)

    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["holder_name"] == ""
    assert result["document_number"] == "L898902C3"
    assert result["document_number_valid"] is True


def test_pad44_pads_and_truncates():
    assert passport_ocr._pad44("ABC") == "ABC" + "<" * 41
    assert len(passport_ocr._pad44("X" * 50)) == 44


def test_mrz_date_to_iso_birth_date_infers_past_century():
    # A birth year of "74" should resolve to 1974, not 2074.
    assert passport_ocr._mrz_date_to_iso("740812", is_birth=True) == "1974-08-12"


def test_mrz_date_to_iso_birth_date_future_yy_rolls_back_a_century():
    from datetime import date
    this_year_2d = date.today().year % 100
    future_yy = min(this_year_2d + 1, 99)
    iso = passport_ocr._mrz_date_to_iso(f"{future_yy:02d}0101", is_birth=True)
    assert iso is not None
    assert iso.startswith("19")


def test_mrz_date_to_iso_expiry_date_defaults_to_2000s():
    assert passport_ocr._mrz_date_to_iso("120415", is_birth=False) == "2012-04-15"


def test_mrz_date_to_iso_invalid_input_returns_none():
    assert passport_ocr._mrz_date_to_iso("", is_birth=True) is None
    assert passport_ocr._mrz_date_to_iso("notdigit", is_birth=True) is None
    assert passport_ocr._mrz_date_to_iso("999999", is_birth=True) is None  # invalid month/day


def test_tesseract_available_reflects_shutil_which(monkeypatch):
    monkeypatch.setattr(passport_ocr.shutil, "which", lambda name: "/usr/bin/tesseract")
    assert passport_ocr.tesseract_available() is True
    monkeypatch.setattr(passport_ocr.shutil, "which", lambda name: None)
    assert passport_ocr.tesseract_available() is False


def _fake_image_bytes():
    # extract_mrz opens this with PIL before OCR — must be a real (tiny,
    # valid) image, even though the OCR call itself is monkeypatched below.
    from PIL import Image
    import io
    img = Image.new("L", (10, 10), color=255)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_extract_mrz_raises_not_available_when_tesseract_missing(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: False)
    with pytest.raises(passport_ocr.PassportOcrNotAvailable):
        passport_ocr.extract_mrz(_fake_image_bytes())


def test_extract_mrz_raises_error_when_no_mrz_found(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: "no mrz here at all")
    with pytest.raises(passport_ocr.PassportOcrError):
        passport_ocr.extract_mrz(_fake_image_bytes())


def test_extract_mrz_happy_path_all_fields_and_validity(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    ocr_text = _VALID_LINE1 + "\n" + _VALID_LINE2
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: ocr_text)

    result = passport_ocr.extract_mrz(_fake_image_bytes())

    assert result["document_number"] == "L898902C3"
    assert result["document_number_valid"] is True
    assert result["holder_name"] == "ANNA MARIA ERIKSSON"
    assert result["nationality"] == "UTO"
    assert result["nationality_valid"] is True
    assert result["date_of_birth"] == "1974-08-12"
    assert result["date_of_birth_valid"] is True
    assert result["sex"] == "F"
    assert result["issuing_country"] == "UTO"
    assert result["issuing_country_valid"] is True
    assert result["expiry_date"] == "2012-04-15"
    assert result["expiry_date_valid"] is True
    assert result["overall_valid"] is True


def test_extract_mrz_flags_bad_checksum_as_invalid(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    # Corrupt one digit of the document number so its check digit no longer matches.
    bad_line2 = "L898903C36UTO7408122F1204159ZE184226B<<<<<10"
    ocr_text = _VALID_LINE1 + "\n" + bad_line2
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: ocr_text)

    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["document_number_valid"] is False
    assert result["overall_valid"] is False


# ── country-code validity (real-world regression: "P<AUS" OCR'd to "SPO") ──
# TD3's alpha-3 country codes carry no ICAO check digit of their own, unlike
# document_number/dates -- a garbled code otherwise looks just as plausible
# as a correct one. This cross-checks against mrz's own bundled ICAO/ISO
# 3166-1 alpha-3 list instead.

def test_extract_mrz_flags_unrecognized_issuing_country_as_invalid(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    # "SPO" is not a real ICAO/ISO 3166-1 alpha-3 code -- simulates the
    # exact real-world OCR misread reported against "P<AUS".
    bad_line1 = "P<SPOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<"
    ocr_text = bad_line1 + "\n" + _VALID_LINE2
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: ocr_text)

    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["issuing_country"] == "SPO"
    assert result["issuing_country_valid"] is False
    # A garbled alpha country code doesn't affect the digit-based checksums.
    assert result["document_number_valid"] is True


def test_extract_mrz_flags_unrecognized_nationality_as_invalid(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    bad_line2 = "L898902C36ZZZ7408122F1204159ZE184226B<<<<<10"
    ocr_text = _VALID_LINE1 + "\n" + bad_line2
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: ocr_text)

    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["nationality"] == "ZZZ"
    assert result["nationality_valid"] is False


def test_extract_mrz_country_code_validity_accepts_real_codes():
    from backend.passport_ocr import _is_country_code
    assert _is_country_code("AUS") is True
    assert _is_country_code("USA") is True
    assert _is_country_code("GBR") is True
    assert _is_country_code("SPO") is False
    assert _is_country_code("ZZZ") is False


# ── preprocessing ladder (real-world noisy-photo regression) ───────────────

def test_otsu_threshold_correctly_separates_a_bimodal_image():
    from PIL import Image
    # Two grayscale clusters (60 / 200, not pure 0/255) -- Otsu should pick
    # a threshold that cleanly separates the two, not an arbitrary value.
    img = Image.new("L", (10, 10), color=60)
    for x in range(5, 10):
        for y in range(10):
            img.putpixel((x, y), 200)
    t = passport_ocr._otsu_threshold(img)
    assert 60 <= t < 200
    # point(lambda p: p > t) is exactly how _preprocess_variants binarizes.
    assert (60 > t) is False   # the "dark" cluster lands in the background
    assert (200 > t) is True  # the "light" cluster lands in the foreground


def test_preprocess_variants_returns_four_same_size_images():
    from PIL import Image
    img = Image.new("L", (20, 15), color=128)
    variants = passport_ocr._preprocess_variants(img)
    assert len(variants) == 4
    assert all(v.size == (20, 15) for v in variants)
    # First variant is the untouched input; later ones are contrast-treated,
    # ending with the local adaptive-mean threshold (uneven-lighting rung).
    assert variants[0] is img


def test_extract_mrz_falls_back_through_the_preprocessing_ladder(monkeypatch):
    """Real-world regression: the raw grayscale pass finds nothing, but a
    later preprocessing variant (autocontrast or the binarized one) does --
    extract_mrz must keep trying rather than giving up after the first."""
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    ocr_text = _VALID_LINE1 + "\n" + _VALID_LINE2
    calls = []

    def fake_image_to_string(path, config=None, **kwargs):
        calls.append(path)
        # First two attempts (raw, autocontrast) find nothing; the third
        # (binarized) variant succeeds.
        return "no mrz here" if len(calls) < 3 else ocr_text

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake_image_to_string)

    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["document_number"] == "L898902C3"
    assert len(calls) == 3


def test_extract_mrz_stops_at_first_successful_variant(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    ocr_text = _VALID_LINE1 + "\n" + _VALID_LINE2
    calls = []

    def fake_image_to_string(path, config=None, **kwargs):
        calls.append(path)
        return ocr_text

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake_image_to_string)

    passport_ocr.extract_mrz(_fake_image_bytes())
    assert len(calls) == 1


def test_extract_mrz_raises_error_when_every_variant_fails(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: "still no mrz")

    with pytest.raises(passport_ocr.PassportOcrError):
        passport_ocr.extract_mrz(_fake_image_bytes())


# ── bottom-strip crop (real-world "totally failing" report) ────────────────
# No automatic MRZ-region detection means a full, busy passport photo (the
# portrait, security patterning, several differently-fonted printed fields)
# competes with the small monospace MRZ strip for tesseract's attention. The
# MRZ always sits in the bottom fraction of a TD3 photo page (ICAO 9303) --
# cropping to just that strip before OCR removes nearly all of that noise.

def test_bottom_strip_crops_to_bottom_fraction_and_upscales_when_small():
    from PIL import Image
    img = Image.new("L", (400, 1000), color=200)
    crop = passport_ocr._bottom_strip(img, fraction=0.35)
    assert crop.size[0] == 400
    assert crop.size[1] == 350


def test_bottom_strip_upscales_a_short_crop():
    from PIL import Image
    img = Image.new("L", (400, 200), color=200)  # 35% of 200 = 70px -> below the 120px floor
    crop = passport_ocr._bottom_strip(img, fraction=0.35)
    assert crop.size[1] >= 120


def test_extract_mrz_tries_bottom_strip_region_before_full_image(monkeypatch):
    """The crop region's 4-variant ladder must be exhausted before
    extract_mrz falls back to the full, uncropped photo."""
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    ocr_text = _VALID_LINE1 + "\n" + _VALID_LINE2
    calls = []

    def fake_image_to_string(path, config=None, **kwargs):
        calls.append(path)
        # The crop region's 4 attempts find nothing; the 5th call (the first
        # variant of the full-image fallback) succeeds.
        return "no mrz here" if len(calls) <= 4 else ocr_text

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake_image_to_string)

    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["document_number"] == "L898902C3"
    assert len(calls) == 5


# ── adaptive-mean threshold + checksum-guided selection ─────────────────────
# A shadow band, glare edge, or illumination gradient crossing the MRZ
# defeats the global Otsu rung completely: one threshold for the whole strip
# erases the text on the wrong side of the cut. The adaptive-mean rung
# thresholds each pixel against its own neighborhood instead. And rather than
# stopping at the first MRZ-shaped read, the ladder now uses the ICAO check
# digits as a runtime quality signal to pick the best candidate across rungs.

def test_adaptive_mean_binarize_is_binary_and_same_size():
    from PIL import Image
    img = Image.new("L", (60, 40), color=128)
    out = passport_ocr._adaptive_mean_binarize(img)
    assert out.size == (60, 40)
    assert set(out.tobytes()) <= {0, 255}


def test_adaptive_mean_binarize_keeps_text_visible_across_a_shadow_boundary():
    """Dark text on a half-bright/half-shadowed background: a global Otsu
    threshold erases the text on one side (whole side goes uniform), the
    local threshold keeps text pixels dark and background pixels white on
    BOTH sides. This is the failure class the rung exists for."""
    from PIL import Image, ImageDraw
    img = Image.new("L", (200, 60), color=220)
    d = ImageDraw.Draw(img)
    d.rectangle([100, 0, 200, 60], fill=70)          # shadowed right half
    d.rectangle([20, 25, 80, 35], fill=120)           # text-ish bar, bright side
    d.rectangle([120, 25, 180, 35], fill=15)          # text-ish bar, shadow side

    out = passport_ocr._adaptive_mean_binarize(img)
    # Both bars must survive as dark-on-white after binarization.
    assert out.getpixel((50, 30)) == 0
    assert out.getpixel((150, 30)) == 0
    # And both backgrounds must be white (text/background still separable).
    assert out.getpixel((50, 5)) == 255
    assert out.getpixel((150, 5)) == 255


def test_extract_mrz_prefers_checksum_valid_candidate_over_earlier_invalid(monkeypatch):
    """An early rung reads the MRZ with a corrupted digit (checksums fail);
    a later rung reads it perfectly. The old first-match ladder returned the
    corrupted read; checksum-guided selection must return the perfect one."""
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    corrupted_l2 = "L898902C86UTO7408122F1204159ZE184226B<<<<<10"  # digit 3->8
    calls = []

    def fake_image_to_string(path, config=None, **kwargs):
        calls.append(path)
        if len(calls) == 1:
            return _VALID_LINE1 + "\n" + corrupted_l2
        return _VALID_LINE1 + "\n" + _VALID_LINE2

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake_image_to_string)

    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["document_number"] == "L898902C3"
    assert result["document_number_valid"] is True
    assert result["overall_valid"] is True
    assert len(calls) == 2  # stopped as soon as a fully-valid read appeared


def test_extract_mrz_returns_best_imperfect_candidate_when_no_perfect_exists(monkeypatch):
    """Every rung reads the same imperfect MRZ: the ladder must exhaust the
    strip's rungs looking for something better, then still return the best
    candidate (flagged invalid) rather than erroring -- and must NOT burn a
    full-image OCR pass when the strip already produced a candidate."""
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    corrupted_l2 = "L898902C86UTO7408122F1204159ZE184226B<<<<<10"
    calls = []

    def fake_image_to_string(path, config=None, **kwargs):
        calls.append(path)
        return _VALID_LINE1 + "\n" + corrupted_l2

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake_image_to_string)

    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["document_number_valid"] is False
    assert result["holder_name"] == "ANNA MARIA ERIKSSON"
    assert len(calls) == 4  # all 4 strip rungs, full-image region skipped


# ── MRZ-specific traineddata preference ─────────────────────────────────────
# Real MRZs are printed in OCR-B, which the generic eng model was never
# trained on. deploy.sh installs a purpose-trained `mrz.traineddata` when it
# can; the code prefers it when present and degrades cleanly when not.

def test_tess_config_prefers_mrz_traineddata_when_installed(monkeypatch):
    monkeypatch.setattr(passport_ocr.pytesseract, "get_languages", lambda config="": ["eng", "mrz", "osd"])
    passport_ocr._tess_configs.cache_clear()
    try:
        assert passport_ocr._tess_config().startswith("-l mrz ")
    finally:
        passport_ocr._tess_configs.cache_clear()


def test_tess_config_falls_back_to_default_without_mrz_traineddata(monkeypatch):
    monkeypatch.setattr(passport_ocr.pytesseract, "get_languages", lambda config="": ["eng", "osd"])
    passport_ocr._tess_configs.cache_clear()
    try:
        assert passport_ocr._tess_config() == passport_ocr._TESS_CONFIG
    finally:
        passport_ocr._tess_configs.cache_clear()


def test_tess_config_survives_language_probe_failure(monkeypatch):
    def boom(config=""):
        raise RuntimeError("tesseract exploded")
    monkeypatch.setattr(passport_ocr.pytesseract, "get_languages", boom)
    passport_ocr._tess_configs.cache_clear()
    try:
        assert passport_ocr._tess_config() == passport_ocr._TESS_CONFIG
    finally:
        passport_ocr._tess_configs.cache_clear()


def test_ocr_text_retries_with_default_config_when_mrz_model_broken(monkeypatch):
    """A corrupt deploy-time traineddata download must degrade to the stock
    eng model, not take the whole scan feature down."""
    from PIL import Image
    monkeypatch.setattr(passport_ocr, "_tess_config", lambda: "-l mrz " + passport_ocr._TESS_CONFIG)
    seen = []

    def fake_image_to_string(path, config=None, **kwargs):
        seen.append(config)
        if "-l mrz" in config:
            raise RuntimeError("failed to load language 'mrz'")
        return "recovered"

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake_image_to_string)
    assert passport_ocr._ocr_text(Image.new("L", (10, 10))) == "recovered"
    assert seen == ["-l mrz " + passport_ocr._TESS_CONFIG, passport_ocr._TESS_CONFIG]


# ── Orientation handling ──────────────────────────────────────────────────────
# A wide image (width > 2x height) stands in for "upright": the stubbed OCR
# below only "reads" the MRZ off such an image, so which orientation extract_mrz
# actually feeds tesseract is observable without a real tesseract install.

def _tall_image_bytes(*, exif_orientation=None):
    from PIL import Image
    import io
    img = Image.new("L", (100, 400), color=255)
    buf = io.BytesIO()
    if exif_orientation is not None:
        exif = img.getexif()
        exif[0x0112] = exif_orientation
        img.save(buf, format="JPEG", exif=exif)
    else:
        img.save(buf, format="PNG")
    return buf.getvalue()


def _ocr_reads_only_wide_images(monkeypatch):
    """Stub tesseract: returns the valid MRZ only for a wide (upright-ish)
    image. Returns the list of (w, h) sizes it was called with."""
    from PIL import Image
    seen = []

    def fake(path, config=None, **k):
        with Image.open(path) as im:
            seen.append(im.size)
            wide = im.size[0] > 2 * im.size[1]
        return (_VALID_LINE1 + "\n" + _VALID_LINE2) if wide else "no mrz here"

    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    return seen


def test_extract_mrz_honors_exif_orientation(monkeypatch):
    # Stored sideways (tall) with EXIF "rotate to display": the very first
    # OCR call must already see the corrected, wide image — i.e. it must not
    # need the rotation fallback to get there.
    seen = _ocr_reads_only_wide_images(monkeypatch)
    result = passport_ocr.extract_mrz(_tall_image_bytes(exif_orientation=6))
    assert result["document_number"] == "L898902C3"
    w, h = seen[0]
    assert w > h


def test_extract_mrz_rotation_fallback_when_exif_flag_is_missing(monkeypatch):
    # Same sideways pixels but no EXIF flag (stripped by a resizer/re-encode):
    # the upright attempts find nothing, then a rotated retry does.
    seen = _ocr_reads_only_wide_images(monkeypatch)
    result = passport_ocr.extract_mrz(_tall_image_bytes())
    assert result["document_number"] == "L898902C3"
    assert any(w > 2 * h for w, h in seen)


def test_extract_mrz_still_raises_when_no_orientation_has_an_mrz(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    calls = {"n": 0}

    def fake(*a, **k):
        calls["n"] += 1
        return "nothing"

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    with pytest.raises(passport_ocr.PassportOcrError):
        passport_ocr.extract_mrz(_tall_image_bytes())
    # upright strip+full (2 regions x 4 variants) + 3 rotations x strip (4 each)
    assert calls["n"] == 8 + 12


# ── Rejecting MRZ-shaped noise ────────────────────────────────────────────────
# Reported: a scan "succeeded" but every field was garbage (every check digit
# failing, country codes like "SSS"/"NNS"), because OCR noise from a busy part
# of the page happened to be the right length/alphabet to pass the line filter.

_NOISE_LINE1 = "SNWMNMWGGSRSENNSSCNNENSEESNWMNMWGGSRSENNSSCN"[:44]
_NOISE_LINE2 = "EENSENEBD3SSSNNSENEWNMWGGSRS8NNSSCNNENSEESNWM"[:44]


def test_is_plausible_rejects_shape_only_noise():
    from mrz.checker.td3 import TD3CodeChecker
    c = TD3CodeChecker(f"{_NOISE_LINE1}\n{_NOISE_LINE2}", check_expiry=False, compute_warnings=True)
    assert passport_ocr._checksum_score(c) == 0
    assert passport_ocr._is_plausible(c) is False


def test_is_plausible_accepts_a_real_mrz():
    from mrz.checker.td3 import TD3CodeChecker
    c = TD3CodeChecker(f"{passport_ocr._pad44(_VALID_LINE1)}\n{passport_ocr._pad44(_VALID_LINE2)}", check_expiry=False, compute_warnings=True)
    assert passport_ocr._is_plausible(c) is True


def test_extract_mrz_raises_instead_of_returning_garbage(monkeypatch):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string",
                        lambda *a, **k: _NOISE_LINE1 + "\n" + _NOISE_LINE2)
    with pytest.raises(passport_ocr.PassportOcrError):
        passport_ocr.extract_mrz(_fake_image_bytes())


def test_extract_mrz_keeps_looking_past_noise_to_a_real_read(monkeypatch):
    # First rung returns noise, a later one the real MRZ: the noise must not
    # be accepted as "best" (it would score 0) nor stop the ladder.
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    outputs = iter([_NOISE_LINE1 + "\n" + _NOISE_LINE2, _VALID_LINE1 + "\n" + _VALID_LINE2])
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string",
                        lambda *a, **k: next(outputs, "nothing"))
    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["document_number"] == "L898902C3"
    assert result["overall_valid"] is True


# ── Deskew ────────────────────────────────────────────────────────────────────
# Measured against real tesseract, the ladder only tolerated ~+-1 degree of tilt
# (2/15 exact reads across +-10 degrees); handheld photos are rarely level.

def _text_like_image(tilt=0.0, size=(900, 600), dark_surround=True):
    """Two rows of small 'character' blocks near the bottom (stand-ins for the
    MRZ lines; no fonts needed), page then rotated by `tilt` degrees onto a
    dark table -- the case that defeated a global-threshold estimator."""
    from PIL import Image, ImageDraw
    w, h = size
    page = Image.new("L", size, 225)
    d = ImageDraw.Draw(page)
    for row_y in (h - 150, h - 90):
        for i in range(44):
            x = 30 + i * 19
            d.rectangle([x, row_y, x + 11, row_y + 34], fill=25)
    if tilt:
        page = page.rotate(tilt, expand=True, fillcolor=40 if dark_surround else 225)
    return page


@pytest.mark.parametrize("tilt", [-8, -4, -2, 2, 4, 8])
def test_estimate_skew_recovers_the_tilt(tilt):
    # Correction is the negative of the applied tilt, to within the 0.5 step.
    est = passport_ocr._estimate_skew_deg(_text_like_image(tilt))
    assert abs(est - (-tilt)) <= 0.5


def test_estimate_skew_is_zero_for_a_level_image():
    assert passport_ocr._estimate_skew_deg(_text_like_image(0)) == 0.0


def test_estimate_skew_is_zero_for_a_blank_image():
    from PIL import Image
    # Must not rotate on noise: a featureless image has no peaky row profile.
    assert passport_ocr._estimate_skew_deg(Image.new("L", (600, 400), 200)) == 0.0


def test_read_orientation_retries_deskewed_when_first_read_is_imperfect(monkeypatch):
    # A tilted photo's typical failure is a plausible-but-wrong read (some check
    # digits still validate), not "nothing found" -- so an imperfect score, not
    # only a miss, must trigger the deskewed retry, and the better read wins.
    from PIL import Image
    wrong_line2 = _VALID_LINE2[:4] + "X" + _VALID_LINE2[5:]   # breaks the doc-number check digit only

    def fake(path, config=None, **kw):
        with Image.open(path) as im:
            level = passport_ocr._estimate_skew_deg(im.convert("L")) == 0.0
        return _VALID_LINE1 + "\n" + (_VALID_LINE2 if level else wrong_line2)

    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)

    import io
    buf = io.BytesIO()
    _text_like_image(5).save(buf, format="PNG")
    result = passport_ocr.extract_mrz(buf.getvalue())
    assert result["document_number"] == "L898902C3"
    assert result["overall_valid"] is True


# ── Time bounds ───────────────────────────────────────────────────────────────

def test_extract_mrz_stops_trying_once_the_time_budget_is_spent(monkeypatch):
    # A bad photo must not hold a request open (a noisy image measured 35-60s
    # against real tesseract). With the budget already spent, no OCR pass runs.
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr, "_OCR_BUDGET_S", -1.0)
    calls = {"n": 0}

    def fake(*a, **k):
        calls["n"] += 1
        return "nothing"

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    with pytest.raises(passport_ocr.PassportOcrError):
        passport_ocr.extract_mrz(_fake_image_bytes())
    assert calls["n"] == 0


def test_ocr_text_treats_a_tesseract_timeout_as_no_text_without_retrying(monkeypatch):
    from PIL import Image
    monkeypatch.setattr(passport_ocr, "_tess_config", lambda: "-l mrz " + passport_ocr._TESS_CONFIG)
    seen = []

    def fake(path, config=None, **kw):
        seen.append(kw.get("timeout"))
        raise RuntimeError("Tesseract process timeout")

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    assert passport_ocr._ocr_text(Image.new("L", (10, 10))) == ""
    # One call only: a timeout is not a broken model, so no second (eng) attempt.
    assert seen == [passport_ocr._OCR_CALL_TIMEOUT_S]


# ── Trying every configured model ─────────────────────────────────────────────
# A purpose-trained MRZ model is an accuracy upgrade on the inputs it was trained
# for, but can return confident garbage on others. The stock model is therefore
# always tried too, and the better-scoring read wins.

def _with_mrz_model(monkeypatch):
    monkeypatch.setattr(passport_ocr.pytesseract, "get_languages", lambda config="": ["eng", "mrz", "osd"])
    passport_ocr._tess_configs.cache_clear()
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)


def test_tess_configs_always_ends_with_the_stock_model(monkeypatch):
    _with_mrz_model(monkeypatch)
    configs = passport_ocr._tess_configs()
    assert configs[0].startswith("-l mrz ")
    assert configs[-1] == passport_ocr._TESS_CONFIG


def test_a_garbage_producing_mrz_model_does_not_beat_the_stock_model(monkeypatch):
    _with_mrz_model(monkeypatch)

    def fake(path, config=None, **kw):
        if "-l mrz" in config:
            return _NOISE_LINE1 + "\n" + _NOISE_LINE2     # MRZ-shaped junk
        return _VALID_LINE1 + "\n" + _VALID_LINE2

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["document_number"] == "L898902C3"
    assert result["overall_valid"] is True


def test_stock_model_read_wins_when_it_scores_higher_than_the_mrz_model(monkeypatch):
    _with_mrz_model(monkeypatch)
    imperfect = _VALID_LINE2[:4] + "X" + _VALID_LINE2[5:]   # breaks one check digit

    def fake(path, config=None, **kw):
        return _VALID_LINE1 + "\n" + (imperfect if "-l mrz" in config else _VALID_LINE2)

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["overall_valid"] is True


def test_a_perfect_first_read_does_not_spend_a_second_model_pass(monkeypatch):
    _with_mrz_model(monkeypatch)
    configs_seen = []

    def fake(path, config=None, **kw):
        configs_seen.append(config)
        return _VALID_LINE1 + "\n" + _VALID_LINE2

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    passport_ocr.extract_mrz(_fake_image_bytes())
    assert len(configs_seen) == 1 and "-l mrz" in configs_seen[0]


def test_failure_is_logged_with_counts_but_never_recognized_text(monkeypatch, caplog):
    _with_mrz_model(monkeypatch)
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string",
                        lambda *a, **k: _NOISE_LINE1 + "\n" + _NOISE_LINE2)
    import logging
    # Other tests in the suite (alembic's fileConfig) can disable existing
    # loggers; re-enable this one so the test doesn't depend on run order.
    monkeypatch.setattr(passport_ocr.logger, "disabled", False)
    monkeypatch.setattr(passport_ocr.logger, "propagate", True)
    with caplog.at_level(logging.WARNING, logger=passport_ocr.logger.name):
        with pytest.raises(passport_ocr.PassportOcrError):
            passport_ocr.extract_mrz(_fake_image_bytes())
    msg = " ".join(r.getMessage() for r in caplog.records)
    assert "found no MRZ" in msg
    assert "mrz:rejected_as_noise" in msg and "eng:rejected_as_noise" in msg
    # Passport data must never reach the log, even OCR noise that looked like it.
    assert _NOISE_LINE1[:20] not in msg and _NOISE_LINE2[:20] not in msg


# --- line-1 repair (name has no check digit, so OCR errors there are silent) ---

def test_repair_line1_restores_filler_after_document_type():
    assert passport_ocr._repair_line1("PSAUSDOE<<JANE<<<<<<<<")[:5] == "P<AUS"


def test_repair_line1_drops_stray_letters_in_trailing_filler():
    fixed = passport_ocr._repair_line1("P<AUSDOE<<JANE<<<<<<<K<K<")
    assert fixed == "P<AUSDOE<<JANE"


def test_repair_line1_leaves_clean_line_alone():
    assert passport_ocr._repair_line1(_VALID_LINE1) == _VALID_LINE1.rstrip("<")


def test_extract_mrz_recovers_name_from_corrupted_line1(monkeypatch):
    corrupted = "PSAUSDOE<<JANE<<<<<<<K<K<"
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr, "_ocr_text", lambda img, config=None: f"{corrupted}\n{_VALID_LINE2}")
    monkeypatch.setattr(passport_ocr, "_estimate_skew_deg", lambda *a, **k: 0.0)
    result = passport_ocr.extract_mrz(_fake_image_bytes())
    assert result["holder_name"] == "JANE DOE"


def test_mrz_model_config_has_no_character_whitelist(monkeypatch):
    # A real photo read perfectly with `-l mrz --psm 6` but failed in the app,
    # which added a char whitelist on top of the MRZ model.
    monkeypatch.setattr(passport_ocr.pytesseract, "get_languages", lambda config="": ["eng", "mrz"])
    passport_ocr._tess_configs.cache_clear()
    try:
        configs = passport_ocr._tess_configs()
    finally:
        passport_ocr._tess_configs.cache_clear()
    assert configs[0] == "-l mrz --psm 6"
    assert "whitelist" not in configs[0]
    assert "whitelist" in configs[-1]  # the stock model keeps it


def test_single_valid_check_digit_with_valid_country_codes_is_not_plausible():
    # Reported garbage scan: document number `P<AUS1<<N`, random-letter name, no
    # dates, yet one check digit and two country codes happened to look valid.
    c = passport_ocr.TD3CodeChecker(
        passport_ocr._pad44("P<AUSWUTH<<NICOLE<TRACY") + "\n" + passport_ocr._pad44("P<AUS1<<N"),
        check_expiry=False, compute_warnings=True,
    )
    assert passport_ocr._checksum_score(c) < 2
    assert passport_ocr._is_plausible(c) is False


def test_mrz_model_reads_the_untouched_full_image_first(monkeypatch):
    # `tesseract photo.jpg - -l mrz --psm 6` on the raw photo is the proven
    # path, so the first OCR call must be that: the mrz model, un-preprocessed.
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr.pytesseract, "get_languages", lambda config="": ["eng", "mrz"])
    passport_ocr._tess_configs.cache_clear()
    sizes = []
    def fake(path, config="", **k):
        from PIL import Image
        sizes.append((Image.open(path).size, config))
        return _VALID_LINE1 + "\n" + _VALID_LINE2
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    try:
        passport_ocr.extract_mrz(_fake_image_bytes())
    finally:
        passport_ocr._tess_configs.cache_clear()
    from PIL import Image
    import io
    assert sizes[0][1] == "-l mrz --psm 6"
    assert sizes[0][0] == Image.open(io.BytesIO(_fake_image_bytes())).size
    assert len(sizes) == 1  # perfect first read: nothing else spent


def _capture_first_mrz_call(monkeypatch, image_bytes):
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr.pytesseract, "get_languages", lambda config="": ["eng", "mrz"])
    passport_ocr._tess_configs.cache_clear()
    seen = []

    def fake(path, config="", **k):
        with open(path, "rb") as fh:
            seen.append((fh.read(), config, k.get("timeout")))
        return _VALID_LINE1 + "\n" + _VALID_LINE2

    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", fake)
    try:
        passport_ocr.extract_mrz(image_bytes)
    finally:
        passport_ocr._tess_configs.cache_clear()
    return seen


def test_mrz_model_first_pass_gets_the_uploaded_file_byte_for_byte(monkeypatch):
    # The CLI call that read a real photo perfectly was given the original
    # file; the app used to hand the model a re-encoded grayscale PNG.
    from PIL import Image
    import io
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 190, 180)).save(buf, "JPEG")
    jpeg = buf.getvalue()
    seen = _capture_first_mrz_call(monkeypatch, jpeg)
    assert seen[0][0] == jpeg
    assert seen[0][1] == "-l mrz --psm 6"
    assert seen[0][2] == passport_ocr._OCR_ORIGINAL_TIMEOUT_S


def test_original_file_is_not_used_when_exif_rotation_is_pending(monkeypatch):
    # With an EXIF orientation flag the file's pixels are sideways; the
    # transposed image must be read instead.
    from PIL import Image
    import io
    img = Image.new("RGB", (64, 48), (200, 190, 180))
    exif = img.getexif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    seen = _capture_first_mrz_call(monkeypatch, buf.getvalue())
    assert seen[0][0] != buf.getvalue()


def test_failure_log_reports_output_sizes_and_timing_not_text(monkeypatch, caplog):
    import logging
    monkeypatch.setattr(passport_ocr.logger, "disabled", False)
    monkeypatch.setattr(passport_ocr.logger, "propagate", True)
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(passport_ocr.pytesseract, "image_to_string", lambda *a, **k: "HELLO WORLD SECRET")
    with caplog.at_level(logging.WARNING, logger=passport_ocr.logger.name):
        with pytest.raises(passport_ocr.PassportOcrError):
            passport_ocr.extract_mrz(_fake_image_bytes())
    msg = " ".join(r.getMessage() for r in caplog.records)
    assert "eng:chars" in msg and "eng:longest_line" in msg
    assert "SECRET" not in msg
