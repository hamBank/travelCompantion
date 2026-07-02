import csv
import io
import pathlib
from datetime import datetime, timedelta

from .metrics import record_external_call

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


# Interactive OAuth (browser consent) only runs when explicitly allowed — never on
# a headless server, where it would hang/500. Set SHEETS_ALLOW_INTERACTIVE=1 locally
# to mint a token.
import os as _os
_ALLOW_INTERACTIVE = _os.getenv("SHEETS_ALLOW_INTERACTIVE") == "1"


def _get_credentials():
    if not CREDS_PATH.exists():
        raise RuntimeError(
            f"credentials.json not found at: {CREDS_PATH}\n"
            "Provide a Google service-account key (recommended for servers) or an OAuth "
            "Desktop client. See: https://console.cloud.google.com → APIs & Services → Credentials"
        )

    import json as _json
    try:
        blob = _json.loads(CREDS_PATH.read_text())
    except Exception:
        blob = {}

    # Service account — headless, no token, no expiry. Share the spreadsheet with the
    # service account's client_email (Viewer) for this to work.
    if blob.get("type") == "service_account":
        try:
            from google.oauth2 import service_account
        except ImportError:
            raise RuntimeError("Run: pip install google-auth google-api-python-client")
        return service_account.Credentials.from_service_account_file(str(CREDS_PATH), scopes=SCOPES)

    # OAuth installed/desktop client — needs a cached token from a one-time browser consent.
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
    except ImportError:
        raise RuntimeError("Run: pip install google-auth google-auth-oauthlib google-api-python-client")

    creds = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except Exception as e:
            record_external_call("google_oauth", ok=False, error=str(e))
            raise RuntimeError(f"Google token expired and refresh failed — re-authenticate: {e}")
        record_external_call("google_oauth", ok=True)
        TOKEN_PATH.write_text(creds.to_json())
        return creds

    if not _ALLOW_INTERACTIVE:
        raise RuntimeError(
            "No usable Google Sheets authorization on this server. credentials.json is an "
            "interactive OAuth client, which can't authorize headless. Use a service account "
            "(recommended): create one, share the spreadsheet with its email, and replace "
            f"credentials.json with its JSON key — or generate a token locally and copy it to {TOKEN_PATH}."
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

    errors = []  # capture the real cause so a 403 / disabled-API isn't masked as "no data"
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
        record_external_call("google_sheets", ok=True)

        for sheet in resp.get("sheets", []):
            name = sheet["properties"]["title"]
            if name not in results:
                continue
            data = sheet.get("data") or [{}]
            row_data = data[0].get("rowData", []) if data else []
            rows = [[_cell_to_str(c) for c in (rd.get("values") or [])] for rd in row_data]
            results[name] = _rows_to_csv(rows)
    except Exception as e:
        record_external_call("google_sheets", ok=False, error=str(e))
        errors.append(f"grid read: {e}")
        # Fall back to the old formatted-string fetch so import never hard-breaks.
        for name in wanted:
            try:
                resp = api.values().get(
                    spreadsheetId=SPREADSHEET_ID,
                    range=f"'{name}'",
                    valueRenderOption="FORMATTED_VALUE",
                    dateTimeRenderOption="FORMATTED_STRING",
                ).execute()
                record_external_call("google_sheets", ok=True)
                results[name] = _rows_to_csv(resp.get("values", []))
            except Exception as e2:
                record_external_call("google_sheets", ok=False, error=str(e2))
                if len(errors) < 3:
                    errors.append(f"{name}: {e2}")
                results[name] = ""

    if not any(results.values()):
        detail = ("\n".join(errors)) if errors else "(no underlying error reported)"
        raise RuntimeError(
            "No data returned from the Sheets API.\n"
            f"Underlying error: {detail}\n\n"
            "Most common cause: the spreadsheet isn't shared with the service account. "
            "Open the Sheet → Share and add the service account's client_email as Viewer. "
            "Also confirm the Google Sheets API is enabled in the project and the ID is correct: "
            f"{SPREADSHEET_ID}"
        )

    return results
