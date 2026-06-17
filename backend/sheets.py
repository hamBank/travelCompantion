import csv
import io
import pathlib

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

    results = {}
    for name in SHEET_NAMES + FLIGHT_SHEET_NAMES:
        try:
            resp = api.values().get(
                spreadsheetId=SPREADSHEET_ID,
                range=f"'{name}'",
                valueRenderOption="FORMATTED_VALUE",
                dateTimeRenderOption="FORMATTED_STRING",
            ).execute()
            rows = resp.get("values", [])
            buf = io.StringIO()
            csv.writer(buf, quoting=csv.QUOTE_ALL).writerows(rows)
            results[name] = buf.getvalue()
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
