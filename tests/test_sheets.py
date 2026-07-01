"""Tests for backend/sheets.py — Google Sheets fetch + cell/date conversion."""
import csv
import io
import json

import pytest

from backend import sheets


def _csv_of(rows) -> str:
    buf = io.StringIO()
    csv.writer(buf, quoting=csv.QUOTE_ALL).writerows(rows)
    return buf.getvalue()


# ── _serial_to_iso ───────────────────────────────────────────────────────────

def test_serial_to_iso_date_only():
    # Serial 1 = 1899-12-31 (one day after the epoch)
    assert sheets._serial_to_iso(1, with_time=False) == "1899-12-31"


def test_serial_to_iso_with_time():
    # 0.5 days after epoch = 12:00
    assert sheets._serial_to_iso(0.5, with_time=True) == "1899-12-30T12:00:00"


def test_serial_to_iso_known_date():
    # 2026-07-22 relative to the Sheets epoch (1899-12-30)
    from datetime import datetime
    serial = (datetime(2026, 7, 22) - sheets._SHEETS_EPOCH).days
    assert sheets._serial_to_iso(serial, with_time=False) == "2026-07-22"


# ── _cell_to_str ─────────────────────────────────────────────────────────────

def test_cell_to_str_converts_date_serial_to_iso():
    cell = {
        "effectiveValue": {"numberValue": 46224},  # arbitrary DATE serial
        "effectiveFormat": {"numberFormat": {"type": "DATE"}},
        "formattedValue": "7/22/2026",
    }
    result = sheets._cell_to_str(cell)
    assert result == sheets._serial_to_iso(46224, with_time=False)


def test_cell_to_str_converts_datetime_serial_with_time():
    cell = {
        "effectiveValue": {"numberValue": 46224.5},
        "effectiveFormat": {"numberFormat": {"type": "DATE_TIME"}},
        "formattedValue": "7/22/2026 12:00",
    }
    result = sheets._cell_to_str(cell)
    assert result == sheets._serial_to_iso(46224.5, with_time=True)


def test_cell_to_str_falls_back_to_formatted_value_for_plain_numbers():
    cell = {
        "effectiveValue": {"numberValue": 42},
        "effectiveFormat": {"numberFormat": {"type": "NUMBER"}},
        "formattedValue": "42",
    }
    assert sheets._cell_to_str(cell) == "42"


def test_cell_to_str_uses_formatted_value_for_text_cells():
    cell = {"effectiveValue": {"stringValue": "Paris"}, "formattedValue": "Paris"}
    assert sheets._cell_to_str(cell) == "Paris"


def test_cell_to_str_handles_missing_effective_value():
    assert sheets._cell_to_str({"formattedValue": "hi"}) == "hi"
    assert sheets._cell_to_str({}) == ""


# ── _get_credentials ─────────────────────────────────────────────────────────

def test_get_credentials_raises_when_creds_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(sheets, "CREDS_PATH", tmp_path / "missing-credentials.json")
    with pytest.raises(RuntimeError, match="credentials.json not found"):
        sheets._get_credentials()


def test_get_credentials_uses_service_account_when_configured(tmp_path, monkeypatch):
    creds_path = tmp_path / "credentials.json"
    creds_path.write_text(json.dumps({"type": "service_account", "client_email": "svc@example.com"}))
    monkeypatch.setattr(sheets, "CREDS_PATH", creds_path)

    sentinel = object()
    monkeypatch.setattr(
        "google.oauth2.service_account.Credentials.from_service_account_file",
        lambda path, scopes: sentinel,
    )
    assert sheets._get_credentials() is sentinel


def test_get_credentials_reuses_valid_cached_oauth_token(tmp_path, monkeypatch):
    creds_path = tmp_path / "credentials.json"
    creds_path.write_text(json.dumps({"type": "installed"}))
    token_path = tmp_path / "token.json"
    token_path.write_text("{}")
    monkeypatch.setattr(sheets, "CREDS_PATH", creds_path)
    monkeypatch.setattr(sheets, "TOKEN_PATH", token_path)

    class FakeCreds:
        valid = True
        expired = False
        refresh_token = None

    monkeypatch.setattr(
        "google.oauth2.credentials.Credentials.from_authorized_user_file",
        lambda path, scopes: FakeCreds(),
    )
    result = sheets._get_credentials()
    assert isinstance(result, FakeCreds)


def test_get_credentials_refreshes_expired_token(tmp_path, monkeypatch):
    creds_path = tmp_path / "credentials.json"
    creds_path.write_text(json.dumps({"type": "installed"}))
    token_path = tmp_path / "token.json"
    token_path.write_text("{}")
    monkeypatch.setattr(sheets, "CREDS_PATH", creds_path)
    monkeypatch.setattr(sheets, "TOKEN_PATH", token_path)

    refreshed = {"called": False}

    class FakeCreds:
        valid = False
        expired = True
        refresh_token = "rt"

        def refresh(self, request):
            refreshed["called"] = True

        def to_json(self):
            return '{"refreshed": true}'

    monkeypatch.setattr(
        "google.oauth2.credentials.Credentials.from_authorized_user_file",
        lambda path, scopes: FakeCreds(),
    )
    result = sheets._get_credentials()
    assert refreshed["called"] is True
    assert token_path.read_text() == '{"refreshed": true}'


def test_get_credentials_raises_when_no_token_and_interactive_disabled(tmp_path, monkeypatch):
    creds_path = tmp_path / "credentials.json"
    creds_path.write_text(json.dumps({"type": "installed"}))
    monkeypatch.setattr(sheets, "CREDS_PATH", creds_path)
    monkeypatch.setattr(sheets, "TOKEN_PATH", tmp_path / "no-token.json")
    monkeypatch.setattr(sheets, "_ALLOW_INTERACTIVE", False)

    with pytest.raises(RuntimeError, match="No usable Google Sheets authorization"):
        sheets._get_credentials()


# ── fetch_sheets ─────────────────────────────────────────────────────────────

class _FakeExecutor:
    def __init__(self, result):
        self._result = result

    def execute(self):
        return self._result


class _FakeValues:
    def __init__(self, values_by_name, raise_for):
        self._values_by_name = values_by_name
        self._raise_for = raise_for

    def get(self, spreadsheetId, range, valueRenderOption=None, dateTimeRenderOption=None):
        name = range.strip("'")
        if name in self._raise_for:
            raise RuntimeError(f"fallback failed for {name}")
        return _FakeExecutor({"values": self._values_by_name.get(name, [])})


class _FakeSpreadsheets:
    def __init__(self, titles, grid_resp=None, grid_exc=None, values_by_name=None, raise_for=None):
        self._titles = titles
        self._grid_resp = grid_resp
        self._grid_exc = grid_exc
        self._values = _FakeValues(values_by_name or {}, raise_for or set())

    def get(self, spreadsheetId, fields=None, ranges=None, includeGridData=None):
        if fields == "sheets.properties.title":
            return _FakeExecutor({"sheets": [{"properties": {"title": t}} for t in self._titles]})
        if self._grid_exc:
            raise self._grid_exc
        return _FakeExecutor(self._grid_resp)

    def values(self):
        return self._values


class _FakeService:
    def __init__(self, spreadsheets):
        self._spreadsheets = spreadsheets

    def spreadsheets(self):
        return self._spreadsheets


@pytest.fixture
def sheet_names(monkeypatch):
    monkeypatch.setattr(sheets, "SHEET_NAMES", ["TestSheet"])
    monkeypatch.setattr(sheets, "FLIGHT_SHEET_NAMES", ["Flights"])
    monkeypatch.setattr(sheets, "_get_credentials", lambda: "fake-creds")


def _install_fake_build(monkeypatch, spreadsheets):
    monkeypatch.setattr(
        "googleapiclient.discovery.build",
        lambda name, version, credentials=None, cache_discovery=None: _FakeService(spreadsheets),
    )


def test_fetch_sheets_returns_csv_via_grid_read(sheet_names, monkeypatch):
    grid_resp = {
        "sheets": [{
            "properties": {"title": "TestSheet"},
            "data": [{"rowData": [{"values": [{"formattedValue": "A"}, {"formattedValue": "B"}]}]}],
        }],
    }
    spreadsheets = _FakeSpreadsheets(titles=["TestSheet"], grid_resp=grid_resp)
    _install_fake_build(monkeypatch, spreadsheets)

    result = sheets.fetch_sheets()
    rows = list(csv.reader(io.StringIO(result["TestSheet"])))
    assert rows == [["A", "B"]]
    assert result["Flights"] == ""


def test_fetch_sheets_falls_back_to_values_get_on_grid_error(sheet_names, monkeypatch):
    spreadsheets = _FakeSpreadsheets(
        titles=["TestSheet"],
        grid_exc=RuntimeError("grid API disabled"),
        values_by_name={"TestSheet": [["C", "D"]]},
    )
    _install_fake_build(monkeypatch, spreadsheets)

    result = sheets.fetch_sheets()
    rows = list(csv.reader(io.StringIO(result["TestSheet"])))
    assert rows == [["C", "D"]]


def test_fetch_sheets_raises_when_nothing_comes_back(sheet_names, monkeypatch):
    spreadsheets = _FakeSpreadsheets(
        titles=["TestSheet"],
        grid_exc=RuntimeError("grid API disabled"),
        values_by_name={},
        raise_for={"TestSheet", "Flights"},
    )
    _install_fake_build(monkeypatch, spreadsheets)

    with pytest.raises(RuntimeError, match="No data returned from the Sheets API"):
        sheets.fetch_sheets()


def test_fetch_sheets_raises_when_configured_sheets_dont_exist(sheet_names, monkeypatch):
    spreadsheets = _FakeSpreadsheets(titles=["SomeOtherSheet"], values_by_name={})
    _install_fake_build(monkeypatch, spreadsheets)

    with pytest.raises(RuntimeError, match="No data returned from the Sheets API"):
        sheets.fetch_sheets()
