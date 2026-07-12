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
