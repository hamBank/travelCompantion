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
    assert result["date_of_birth"] == "1974-08-12"
    assert result["date_of_birth_valid"] is True
    assert result["sex"] == "F"
    assert result["issuing_country"] == "UTO"
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


def test_preprocess_variants_returns_three_same_size_images():
    from PIL import Image
    img = Image.new("L", (20, 15), color=128)
    variants = passport_ocr._preprocess_variants(img)
    assert len(variants) == 3
    assert all(v.size == (20, 15) for v in variants)
    # First variant is the untouched input; later ones are contrast-treated.
    assert variants[0] is img


def test_extract_mrz_falls_back_through_the_preprocessing_ladder(monkeypatch):
    """Real-world regression: the raw grayscale pass finds nothing, but a
    later preprocessing variant (autocontrast or the binarized one) does --
    extract_mrz must keep trying rather than giving up after the first."""
    monkeypatch.setattr(passport_ocr, "tesseract_available", lambda: True)
    ocr_text = _VALID_LINE1 + "\n" + _VALID_LINE2
    calls = []

    def fake_image_to_string(path, config=None):
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

    def fake_image_to_string(path, config=None):
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
