import csv
import io
import pathlib
from datetime import datetime, timedelta

# Google Sheets serial dates count days from this epoch (1899-12-30).
_SHEETS_EPOCH = datetime(1899, 12, 30)


def _serial_to_iso(serial, with_time):
    """Convert a Sheets date serial number to an unambiguous ISO string."""
    dt = _SHEETS_EPOCH + timedelta(days=float(serial))
    return dt.strftime("%Y-%m-%dT%H:%M:%S") if with_time else dt.strftime("%Y-%m-%d")


def _cell_to_str(cell):
    """Render a grid cell to text. Real DATE/DATE_TIME cells are emitted as ISO
    (from their serial value) so the importer never has to parse a locale-formatted
    display string or guess a missing year. Everything else uses the display text."""
    ev = cell.get("effectiveValue") or {}
    if "numberValue" in ev:
        ntype = (((cell.get("effectiveFormat") or {}).get("numberFormat")) or {}).get("type")
        if ntype in ("DATE", "DATE_TIME"):
            n = ev["numberValue"]
            return _serial_to_iso(n, ntype == "DATE_TIME" or (n % 1 != 0))
    return cell.get("formattedValue", "")

SPREADSHEET_ID = "1WyCsCS89jRyPyy2lptjz3Ktpo9PCjsmdfbf8oWRxiBA"
SHEET_NAMES = [
    "SIN", "Paris-1", "Matera", "Alberobello", "Ostuni", "Avetrana",
    "Gallipoli", "Otranto", "Lecce", "Geneva", "Lyon", "Cruise", "Djion", "Paris-2",
]

# Sheets that contain flight data (tabular format, one flight per row)
FLIGHT_SHEET_NAMES = ["Flights"]

TOKEN_PATH = pathlib.Path.home() / ".travel_companion_token.json"
CREDS_PATH = pathlib.Path(__file__).parent.parent / "credentials.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


def _get_credentials():
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        raise RuntimeError(
            "Run: pip install google-auth google-auth-oauthlib google-api-python-client"
        )

    creds = None
    if TOKEN_PATH.exists():
        from google.oauth2.credentials import Credentials
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            from google.auth.transport.requests import Request
            creds.refresh(Request())
        else:
            if not CREDS_PATH.exists():
                raise RuntimeError(
                    f"credentials.json not found at: {CREDS_PATH}\n\n"
                    "Create a Google Cloud OAuth 2.0 Desktop app credential and save it there.\n"
                    "See: https://console.cloud.google.com → APIs & Services → Credentials"
                )
            from google_auth_oauthlib.flow import InstalledAppFlow
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_PATH), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_PATH.write_text(creds.to_json())

    return creds


def fetch_sheets() -> dict[str, str]:
    """
    Fetch all configured sheets via OAuth. Returns {sheet_name: csv_string}.
    Opens a browser on first run for Google authentication.
    Reuses the token file from the desktop app if already authenticated.
    """
    try:
        from googleapiclient.discovery import build
    except ImportError:
        raise RuntimeError(
            "Run: pip install google-auth google-auth-oauthlib google-api-python-client"
        )

    creds = _get_credentials()
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    api = service.spreadsheets()

    wanted = SHEET_NAMES + FLIGHT_SHEET_NAMES
    results = {name: "" for name in wanted}

    def _rows_to_csv(rows):
        buf = io.StringIO()
        csv.writer(buf, quoting=csv.QUOTE_ALL).writerows(rows)
        return buf.getvalue()

    try:
        # Single grid read with cell metadata. We read each cell's typed value and
        # number-format so real DATE/DATE_TIME cells can be emitted as ISO from
        # their serial value (no display-string parsing, no year guessing). Only
        # request sheets that exist so one missing tab doesn't fail the whole call.
        titles = {
            s["properties"]["title"]
            for s in api.get(spreadsheetId=SPREADSHEET_ID, fields="sheets.properties.title")
            .execute().get("sheets", [])
        }
        ranges = [f"'{n}'" for n in wanted if n in titles]
        if not ranges:
            raise RuntimeError("none of the configured sheets exist in the spreadsheet")

        resp = api.get(
            spreadsheetId=SPREADSHEET_ID,
            ranges=ranges,
            includeGridData=True,
            fields="sheets(properties.title,data.rowData.values("
                   "formattedValue,effectiveValue,effectiveFormat.numberFormat.type))",
        ).execute()

        for sheet in resp.get("sheets", []):
            name = sheet["properties"]["title"]
            if name not in results:
                continue
            data = sheet.get("data") or [{}]
            row_data = data[0].get("rowData", []) if data else []
            rows = [[_cell_to_str(c) for c in (rd.get("values") or [])] for rd in row_data]
            results[name] = _rows_to_csv(rows)
    except Exception:
        # Fall back to the old formatted-string fetch so import never hard-breaks.
        for name in wanted:
            try:
                resp = api.values().get(
                    spreadsheetId=SPREADSHEET_ID,
                    range=f"'{name}'",
                    valueRenderOption="FORMATTED_VALUE",
                    dateTimeRenderOption="FORMATTED_STRING",
                ).execute()
                results[name] = _rows_to_csv(resp.get("values", []))
            except Exception:
                results[name] = ""

    if not any(results.values()):
        raise RuntimeError(
            f"No data returned from the Sheets API. Check that:\n"
            f"• The Sheets API is enabled in your Google Cloud project\n"
            f"• The spreadsheet ID is correct: {SPREADSHEET_ID}\n"
            f"• You have access to the spreadsheet\n"
            f"To re-authenticate, delete: {TOKEN_PATH}"
        )

    return results
