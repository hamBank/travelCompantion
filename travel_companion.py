#!/usr/bin/env python3
"""
Travel Companion — reads your trip itinerary from Google Sheets
and shows today's (or next upcoming) day's details.

Cross-platform (macOS, Windows, Linux).

──────────────────────────────────────────────────────────────
FIRST-TIME SETUP FOR LIVE REFRESH
──────────────────────────────────────────────────────────────
1. Install libraries:
     pip install google-auth google-auth-oauthlib google-api-python-client

2. Create a credentials.json:
   a. https://console.cloud.google.com/ → select project
   b. APIs & Services → Library → enable "Google Sheets API"
   c. APIs & Services → Credentials → Create Credentials → OAuth client ID
   d. Application type: Desktop app
   e. Download JSON → save as  credentials.json  next to this script

3. Click ↻ Refresh — browser opens for one-time Google approval.
   Token saved to ~/.travel_companion_token.json; future refreshes are silent.
──────────────────────────────────────────────────────────────
"""

import tkinter as tk
from tkinter import ttk, messagebox, font as tkfont
import csv
import io
import json
import os
import pathlib
import threading
import urllib.request
import urllib.parse
from datetime import datetime, date, timedelta
import re
import webbrowser

# ── Sheet config ─────────────────────────────────────────────────────────────
SPREADSHEET_ID = "1WyCsCS89jRyPyy2lptjz3Ktpo9PCjsmdfbf8oWRxiBA"
SHEET_NAMES = ["SIN","Paris-1","Matera","Alberobello","Ostuni","Avetrana",
               "Gallipoli","Otranto","Lecce","Geneva","Lyon","Cruise","Djion","Paris-2"]
CACHE_FILE = os.path.expanduser("~/.travel_companion_cache.json")

# ── OAuth / API config ────────────────────────────────────────────────────────
TOKEN_PATH = pathlib.Path.home() / ".travel_companion_token.json"
CREDS_PATH = pathlib.Path(__file__).parent / "credentials.json"
SCOPES     = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# ── Cross-platform date formatting ────────────────────────────────────────────
def _fmt_day(d) -> str:
    """'Monday, 5 July 2026' — no leading zero, works on Windows too."""
    try:
        return d.strftime("%A, %-d %B %Y")       # Linux / macOS
    except ValueError:
        return d.strftime("%A, %d %B %Y").replace(", 0", ", ")

def _fmt_short(d) -> str:
    """'5/7' — day/month, no leading zeros."""
    return f"{d.day}/{d.month}"

def _fmt_day_short(d) -> str:
    """'Mon 5 Jul' — no leading zero."""
    try:
        return d.strftime("%a %-d %b")            # Linux / macOS
    except ValueError:
        return d.strftime("%a %d %b").replace(" 0", " ")

# ── Colours / fonts ───────────────────────────────────────────────────────────
BG          = "#1E1E2E"
CARD_BG     = "#2A2A3E"
ACCENT      = "#CBA6F7"   # mauve
GREEN       = "#A6E3A1"
BLUE        = "#89DCEB"
YELLOW      = "#F9E2AF"
RED         = "#F38BA8"
MUTED       = "#6C7086"
TEXT        = "#CDD6F4"
TEXT_DIM    = "#9399B2"


# ═══════════════════════════════════════════════════════════════════════════════
# DATA PARSING
# ═══════════════════════════════════════════════════════════════════════════════

def parse_date(s: str):
    """Parse dates like 'Wednesday 22 Jul 22:05', '6/8', '06/08/2026 10:30', '13 Aug'"""
    if not s or not s.strip():
        return None
    s = s.strip()
    # Formats that include a year — safe on all Python versions
    for fmt in ("%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            d = datetime.strptime(s, fmt)
            if d.year in (1900, 2025):
                d = d.replace(year=2026)
            return d
        except ValueError:
            pass
    # Formats without a year — inject 2026 before parsing to avoid Python 3.13 deprecation
    # "Wednesday 22 Jul 12:00" → "Wednesday 22 Jul 2026 12:00"
    # "Wednesday 22 Jul"       → "Wednesday 22 Jul 2026"
    # "13 Aug"                 → "13 Aug 2026"
    for pattern, fmt in [
        (r"^(\w+ \d{1,2} \w{3}) (\d{2}:\d{2})$", "%A %d %b %Y %H:%M"),
        (r"^(\w+ \d{1,2} \w{3})$",                "%A %d %b %Y"),
        (r"^(\d{1,2} \w{3})$",                    "%d %b %Y"),
    ]:
        m = re.match(pattern, s)
        if m:
            try:
                base = m.group(1)
                rest = f" {m.group(2)}" if m.lastindex == 2 else ""
                d = datetime.strptime(f"{base} 2026{rest}", fmt)
                return d
            except ValueError:
                pass
    # "13 Aug 2026" already has year
    try:
        d = datetime.strptime(s, "%d %b %Y")
        return d
    except ValueError:
        pass
    # Partial numeric formats — inject year
    for year_suffix in (" 2026", "/2026"):
        try:
            d = datetime.strptime(s + year_suffix, "%d %b %Y")
            return d
        except ValueError:
            pass
    # "Tue 4 17:00" / "Wed 5 9:16" — weekday abbrev + day-of-month + optional time
    m = re.match(r"^(\w{2,3})\s+(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$", s)
    if m:
        day_num = int(m.group(2))
        weekday_map = {"mon":0,"tue":1,"wed":2,"thu":3,"fri":4,"sat":5,"sun":6}
        target_wd = weekday_map.get(m.group(1).lower()[:3])
        if target_wd is not None:
            for month in range(7, 10):  # trip window Jul–Sep
                try:
                    candidate = datetime(2026, month, day_num)
                    if candidate.weekday() == target_wd:
                        if m.group(3):
                            h, mn = m.group(3).split(":")
                            candidate = candidate.replace(hour=int(h), minute=int(mn))
                        return candidate
                except ValueError:
                    pass
    return None


def csv_to_rows(raw: str):
    """Parse CSV text into list of lists."""
    reader = csv.reader(io.StringIO(raw))
    return list(reader)


def safe(rows, r, c, default=""):
    try:
        v = rows[r][c].strip()
        return v if v else default
    except (IndexError, AttributeError):
        return default


def parse_sheet(sheet_name: str, raw_csv: str) -> dict:
    """Parse a single sheet's CSV into a structured dict."""
    rows = csv_to_rows(raw_csv)
    if not rows:
        return {}

    result = {
        "sheet": sheet_name,
        "location": safe(rows, 0, 0),
        "country": safe(rows, 0, 1),
        "raw_arrive": "",
        "raw_depart": "",
        "arrive": None,
        "depart": None,
        "nights": "",
        "sunrise": "",
        "sunset": "",
        "avg_min": "",
        "avg_max": "",
        "accommodation": "",
        "accommodation_link": "",
        "accommodation_notes": "",
        "check_in": "",
        "check_out": "",
        "activities": [],
        "restaurants": [],
        "weather_dates": [],
        "weather_max": [],
        "weather_min": [],
        "weather_cloud": [],
        "timezone": "0",
        "lat": "",
        "lng": "",
    }

    # Scan rows for key fields
    in_activities = False
    in_restaurants = False
    restaurant_header_seen = False
    weather_section = False

    for i, row in enumerate(rows):
        if not row:
            continue
        col0 = row[0].strip() if row else ""
        col1 = row[1].strip() if len(row) > 1 else ""
        col2 = row[2].strip() if len(row) > 2 else ""

        # Arrive / Depart — labelled rows
        if col0.lower() in ("arrive",):
            result["raw_arrive"] = col1
            result["arrive"] = parse_date(col1)
        elif col0.lower() in ("depart",):
            result["raw_depart"] = col1
            result["depart"] = parse_date(col1)
        # Unlabelled arrive/depart — Lyon-style: rows 1 and 2 have empty col0 but date in col1
        elif col0 == "" and i == 1 and col1 and not result.get("arrive"):
            parsed = parse_date(col1)
            if parsed:
                result["raw_arrive"] = col1
                result["arrive"] = parsed
        elif col0 == "" and i == 2 and col1 and not result.get("depart"):
            parsed = parse_date(col1)
            if parsed:
                result["raw_depart"] = col1
                result["depart"] = parsed
        elif col0.lower() in ("nights",):
            result["nights"] = col1
        elif col0.lower() == "sunrise":
            result["sunrise"] = col1
            # avg min temp is often nearby
        elif col0.lower() == "sunset":
            result["sunset"] = col1
        elif "avg min temp" in col0.lower() or (len(row) > 4 and "avg min" in " ".join(row).lower()):
            # scan for Avg Min/Max in this row
            for j, cell in enumerate(row):
                if "avg min" in cell.lower() and j+1 < len(row):
                    result["avg_min"] = row[j+1].strip()
                if "avg max" in cell.lower() and j+1 < len(row):
                    result["avg_max"] = row[j+1].strip()
        # Check for avg temp in any cell of this row when sunrise row
        if col0.lower() == "sunrise":
            for j, cell in enumerate(row):
                if "avg min" in cell.lower() and j+1 < len(row):
                    result["avg_min"] = row[j+1].strip()
                if "check-in" in cell.lower() and j+1 < len(row):
                    result["check_in"] = row[j+1].strip()
                if "check-out" in cell.lower() and j+1 < len(row):
                    result["check_out"] = row[j+1].strip()
        if col0.lower() == "sunset":
            for j, cell in enumerate(row):
                if "avg max" in cell.lower() and j+1 < len(row):
                    result["avg_max"] = row[j+1].strip()

        # Accommodation
        if col0.lower() in ("accomodation", "accommodation"):
            result["accommodation"] = col1
            result["accommodation_link"] = col2
            # Look ahead for notes
            if i+1 < len(rows):
                notes_parts = [c.strip() for c in rows[i+1] if c.strip()]
                result["accommodation_notes"] = "  ·  ".join(notes_parts[:3])

        # Timezone
        if col0.lower() == "timezone":
            result["timezone"] = col1

        # Lat/Lng — col1 may be "lat, lng" combined or just lat; col2/col3 are split
        if "lattitude" in col0.lower() or "latitude" in col0.lower():
            # Try col2/col3 first (explicit split columns)
            if col2 and col2.replace('.','').replace('-','').strip().lstrip('-').replace('.','').isdigit():
                result["lat"] = col2.strip()
                result["lng"] = row[3].strip() if len(row) > 3 else ""
            elif ',' in col1:
                # Combined "lat, lng" in col1
                parts = col1.split(',', 1)
                result["lat"] = parts[0].strip()
                result["lng"] = parts[1].strip()
            else:
                result["lat"] = col1.strip()
                result["lng"] = col2.strip()

        # Stop collecting activities/restaurants at the footer block
        # (Local/UTC times, Lat/Lng, Timezone, Weather rows)
        FOOTER_SENTINELS = ("local", "tz corrected", "lattitude", "latitude",
                            "longatude", "longitude", "timezone", "weather")
        if col0.lower() in FOOTER_SENTINELS or col1.lower() in ("utc", "local"):
            in_activities = False
            in_restaurants = False

        # Activity header
        if col0 == "" and col1.lower() == "activity":
            in_activities = True
            in_restaurants = False
            continue

        # Restaurant header detection
        if "restaurant" in col0.lower() and ("type" in col1.lower() or "walk" in col2.lower()):
            in_restaurants = True
            in_activities = False
            restaurant_header_seen = True
            continue

        # Weather section
        if col0.lower() == "date" and any("2026" in (c or "") for c in row):
            weather_section = True
            in_activities = False
            in_restaurants = False
            result["weather_dates"] = [c.strip() for c in row[1:] if c.strip()]
            continue
        if weather_section:
            if col0.lower() == "max":
                result["weather_max"] = [c.strip() for c in row[1:] if c.strip()]
            elif col0.lower() == "min":
                result["weather_min"] = [c.strip() for c in row[1:] if c.strip()]
            elif col0.lower() in ("cloud", "cloud cover", "cloud%"):
                result["weather_cloud"] = [c.strip() for c in row[1:] if c.strip()]

        # Collect activities
        if in_activities and not in_restaurants:
            # Activity rows have content in col1 (name/description)
            name = col1
            link = col2 if col2 else ""
            col3 = row[3].strip() if len(row) > 3 else ""
            time_col = ""
            # Look for time in various columns
            for j in range(7, min(len(row), 12)):
                if row[j].strip():
                    time_col = row[j].strip()
                    break

            if name and not name.lower() in ("activity", "link", "cost", "per"):
                # Check for time prefix in col0
                time_prefix = col0 if col0 and col0 != "" else ""
                # Parse time from date-style prefixes like "14/8/2026 09:30"
                dt = parse_date(col0)
                if dt and dt.year == 2026:
                    time_prefix = f"{dt.day}/{dt.month}"
                    if dt.hour or dt.minute:
                        time_prefix += f" {dt.strftime('%H:%M')}"

                activity = {
                    "time": time_prefix,
                    "name": name,
                    "link": link,
                    "cost": col3,
                }
                result["activities"].append(activity)

        # Collect restaurants
        if in_restaurants and restaurant_header_seen:
            if col1 and col1.lower() not in ("restaurant", "type", "walk", "monday hours"):
                rest = {
                    "name": col1,
                    "type": col2,
                    "walk": col3 if len(row) > 3 else "",
                    "hours": row[4].strip() if len(row) > 4 else "",
                    "notes": row[5].strip() if len(row) > 5 else "",
                }
                result["restaurants"].append(rest)

        # Also pick up Cruise-style activities with date prefix in col0
        _footer_row = col0.lower() in ("local", "tz corrected", "lattitude", "latitude",
                                        "longatude", "longitude", "timezone", "weather",
                                        "date", "max", "min", "cloud")
        if not in_activities and not _footer_row and col0 and col1 and col1 not in ("Activity","Link","cost"):
            dt0 = parse_date(col0)
            if dt0 and dt0.year == 2026 and col1 not in ("Activity",):
                activity = {
                    "time": col0,
                    "name": col1,
                    "link": col2,
                    "cost": row[3].strip() if len(row) > 3 else "",
                }
                # Avoid duplicates
                if not any(a["name"] == col1 and a["time"] == col0 for a in result["activities"]):
                    result["activities"].append(activity)

    return result


def build_day_index(sheets_data: dict) -> list:
    """
    Build a list of (date, [sheet_names]) for each calendar day of the trip.
    Multi-stop days (transit, depart morning + arrive evening) are collapsed
    into a single entry with multiple sheet names ordered by time-of-day.
    """
    from collections import defaultdict

    # date → list of (sort_time, sheet_name, role)
    date_map = defaultdict(list)

    for name, data in sheets_data.items():
        arrive = data.get("arrive")
        depart = data.get("depart")
        if not arrive:
            continue
        arrive_d = arrive.date()
        depart_d = depart.date() if depart else arrive_d
        nights = data.get("nights", "1")
        is_transit = (depart_d == arrive_d) or (str(nights).strip() == "0")

        if is_transit:
            date_map[arrive_d].append((arrive, name, "transit"))
        else:
            # Normal stay days
            d = arrive_d
            while d < depart_d:
                date_map[d].append((arrive if d == arrive_d else None, name, "stay"))
                d += timedelta(days=1)
            # Also on depart date (departing that morning)
            date_map[depart_d].append((depart, name, "depart"))

    # role sort order: depart first (early morning), transit mid-day, stay (arriving)
    role_order = {"depart": 0, "transit": 1, "stay": 2}

    result = []
    for day in sorted(date_map.keys()):
        entries = date_map[day]
        entries.sort(key=lambda x: (role_order[x[2]], x[0] or datetime.min))
        # Deduplicate sheets, preserve order
        seen = set()
        sheets_for_day = []
        for _, sheet, _ in entries:
            if sheet not in seen:
                seen.add(sheet)
                sheets_for_day.append(sheet)
        result.append((day, sheets_for_day))

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# GOOGLE SHEETS OAUTH FETCH
# ═══════════════════════════════════════════════════════════════════════════════

def _get_credentials():
    """Return valid OAuth credentials, running the browser flow if needed."""
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        raise RuntimeError(
            "Google auth libraries not installed.\n\n"
            "Run:  pip install google-auth google-auth-oauthlib google-api-python-client"
        )

    creds = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            from google.auth.transport.requests import Request
            creds.refresh(Request())
        else:
            if not CREDS_PATH.exists():
                raise RuntimeError(
                    f"credentials.json not found at:\n  {CREDS_PATH}\n\n"
                    "See the setup instructions at the top of this file."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_PATH), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_PATH.write_text(creds.to_json())

    return creds


def _fetch_via_oauth(progress_cb=None) -> dict:
    """
    Fetch all sheet CSVs via the Google Sheets API.
    Returns {sheet_name: csv_string}.  Empty string value = sheet not found.
    Raises on auth or API errors.
    """
    try:
        from googleapiclient.discovery import build
    except ImportError:
        raise RuntimeError(
            "google-api-python-client not installed.\n\n"
            "Run:  pip install google-auth google-auth-oauthlib google-api-python-client"
        )

    creds = _get_credentials()
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    api = service.spreadsheets()

    results = {}
    total = len(SHEET_NAMES)

    for i, name in enumerate(SHEET_NAMES):
        if progress_cb:
            progress_cb(f"Fetching {name}… ({i + 1}/{total})")
        try:
            resp = api.values().get(
                spreadsheetId=SPREADSHEET_ID,
                range=f"'{name}'",
                valueRenderOption="FORMATTED_VALUE",
                dateTimeRenderOption="FORMATTED_STRING",
            ).execute()
            rows = resp.get("values", [])
            buf = io.StringIO()
            writer = csv.writer(buf, quoting=csv.QUOTE_ALL)
            for row in rows:
                writer.writerow(row)
            results[name] = buf.getvalue()
            print(f"  [ok] {name}: {len(results[name])} chars")
        except Exception as e:
            print(f"  [skip] {name}: {e}")
            results[name] = ""

    if not any(results.values()):
        raise RuntimeError(
            "No sheet data returned from the API.\n\n"
            "Likely causes:\n"
            "• Google Sheets API not enabled for this project\n"
            "  → console.cloud.google.com → APIs & Services → Enable APIs → Google Sheets API\n\n"
            "• Stale token — delete and re-authenticate:\n"
            f"  Delete:  {TOKEN_PATH}\n\n"
            f"• Wrong spreadsheet ID: {SPREADSHEET_ID}\n\n"
            "Run from a terminal for per-sheet error details."
        )

    if progress_cb:
        progress_cb(f"Done — {sum(1 for v in results.values() if v)} sheets loaded")
    return results


# ═══════════════════════════════════════════════════════════════════════════════
# DATA FETCHING (cache)
# ═══════════════════════════════════════════════════════════════════════════════

def save_cache(sheets_raw: dict):
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump({"timestamp": datetime.now().isoformat(), "sheets": sheets_raw}, f)
    except Exception:
        pass


def load_cache() -> tuple:
    try:
        with open(CACHE_FILE) as f:
            d = json.load(f)
            return d.get("sheets", {}), d.get("timestamp", "")
    except Exception:
        return {}, ""


# ═══════════════════════════════════════════════════════════════════════════════
# LIVE WEATHER  (Open-Meteo — free, no API key)
# ═══════════════════════════════════════════════════════════════════════════════

WMO_ICONS = {
    0: ("☀", "Clear"),
    1: ("🌤", "Mostly clear"), 2: ("⛅", "Partly cloudy"), 3: ("☁", "Overcast"),
    45: ("🌫", "Fog"), 48: ("🌫", "Icy fog"),
    51: ("🌦", "Light drizzle"), 53: ("🌦", "Drizzle"), 55: ("🌧", "Heavy drizzle"),
    61: ("🌧", "Light rain"), 63: ("🌧", "Rain"), 65: ("🌧", "Heavy rain"),
    71: ("🌨", "Light snow"), 73: ("🌨", "Snow"), 75: ("❄", "Heavy snow"),
    77: ("🌨", "Snow grains"),
    80: ("🌦", "Light showers"), 81: ("🌧", "Showers"), 82: ("⛈", "Heavy showers"),
    85: ("🌨", "Snow showers"), 86: ("🌨", "Heavy snow showers"),
    95: ("⛈", "Thunderstorm"), 96: ("⛈", "Thunderstorm+hail"), 99: ("⛈", "Thunderstorm+hail"),
}

def fetch_live_weather(lat: str, lng: str, days: int = 4) -> list:
    """
    Fetch forecast from Open-Meteo for the given lat/lng.
    Returns list of dicts: [{date, max, min, wmo, icon, desc, precip, wind}, ...]
    """
    try:
        # Guard against "lat, lng" combined strings
        lat = str(lat).split(',')[0].strip()
        lng = str(lng).split(',')[0].strip()
        lat_f = float(lat)
        lng_f = float(lng)
        if not (-90 <= lat_f <= 90) or not (-180 <= lng_f <= 180):
            return []
    except (ValueError, TypeError) as e:
        return []

    url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat_f}&longitude={lng_f}"
        f"&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum,windspeed_10m_max"
        f"&timezone=auto&forecast_days={days}"
    )
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = json.loads(resp.read())
        daily = data.get("daily", {})
        dates   = daily.get("time", [])
        maxs    = daily.get("temperature_2m_max", [])
        mins    = daily.get("temperature_2m_min", [])
        codes   = daily.get("weathercode", [])
        precips = daily.get("precipitation_sum", [])
        winds   = daily.get("windspeed_10m_max", [])
        result = []
        for i, d in enumerate(dates):
            code = int(codes[i]) if i < len(codes) and codes[i] is not None else 0
            icon, desc = WMO_ICONS.get(code, ("🌡", f"Code {code}"))
            result.append({
                "date":   d,
                "max":    maxs[i]    if i < len(maxs)    else None,
                "min":    mins[i]    if i < len(mins)    else None,
                "icon":   icon,
                "desc":   desc,
                "precip": precips[i] if i < len(precips) else None,
                "wind":   winds[i]   if i < len(winds)   else None,
            })
        return result
    except Exception as e:
        return []



# ═══════════════════════════════════════════════════════════════════════════════
# APP
# ═══════════════════════════════════════════════════════════════════════════════

class TravelApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("✈  Travel Companion")
        self.geometry("900x700")
        self.minsize(700, 500)
        self.configure(bg=BG)

        # State
        self.sheets_raw: dict = {}
        self.sheets_data: dict = {}
        self.day_index: list = []   # [(date, sheet_name), ...]
        self.current_idx: int = 0
        self.cache_time: str = ""
        self.loading = False

        self._setup_styles()
        self._build_ui()
        self._load_initial_data()

    # ── Styles ────────────────────────────────────────────────────────────────

    def _setup_styles(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TScrollbar", background=CARD_BG, troughcolor=BG,
                        bordercolor=BG, arrowcolor=MUTED)

    # ── UI Construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        # ── Header bar ───────────────────────────────────────────────────────
        header = tk.Frame(self, bg=CARD_BG, pady=10)
        header.pack(fill="x", padx=0, pady=0)

        # Nav buttons
        nav_frame = tk.Frame(header, bg=CARD_BG)
        nav_frame.pack(side="left", padx=14)

        self.btn_prev = tk.Button(nav_frame, text="◀", command=self._prev_day,
                                   bg=CARD_BG, fg=ACCENT, relief="flat",
                                   font=("SF Pro Display", 18, "bold"),
                                   cursor="hand2", padx=6)
        self.btn_prev.pack(side="left")

        self.btn_next = tk.Button(nav_frame, text="▶", command=self._next_day,
                                   bg=CARD_BG, fg=ACCENT, relief="flat",
                                   font=("SF Pro Display", 18, "bold"),
                                   cursor="hand2", padx=6)
        self.btn_next.pack(side="left", padx=(2, 0))

        # Date label
        self.lbl_date = tk.Label(header, text="Loading…", bg=CARD_BG, fg=TEXT,
                                  font=("SF Pro Display", 17, "bold"))
        self.lbl_date.pack(side="left", padx=16)

        self.lbl_badge = tk.Label(header, text="", bg=ACCENT, fg=BG,
                                   font=("SF Pro Display", 10, "bold"),
                                   padx=8, pady=3)
        self.lbl_badge.pack(side="left", padx=4)

        # Right: refresh + cache time
        right_frame = tk.Frame(header, bg=CARD_BG)
        right_frame.pack(side="right", padx=14)

        self.lbl_cache = tk.Label(right_frame, text="", bg=CARD_BG, fg=MUTED,
                                   font=("SF Pro Display", 10))
        self.lbl_cache.pack(side="right", padx=(8, 0))

        self.btn_refresh = tk.Button(right_frame, text="↻  Refresh",
                                      command=self._refresh,
                                      bg="#313244", fg=GREEN, relief="flat",
                                      font=("SF Pro Display", 12),
                                      cursor="hand2", padx=10, pady=4)
        self.btn_refresh.pack(side="right")

        # ── Sub-header: location info strip ─────────────────────────────────
        self.info_strip = tk.Frame(self, bg="#252538", pady=8)
        self.info_strip.pack(fill="x")

        self.lbl_location = tk.Label(self.info_strip, text="", bg="#252538",
                                      fg=ACCENT, font=("SF Pro Display", 13, "bold"))
        self.lbl_location.pack(side="left", padx=16)

        self.lbl_meta = tk.Label(self.info_strip, text="", bg="#252538",
                                  fg=TEXT_DIM, font=("SF Pro Display", 11))
        self.lbl_meta.pack(side="left", padx=8)

        self.lbl_weather = tk.Label(self.info_strip, text="", bg="#252538",
                                     fg=YELLOW, font=("SF Pro Display", 11))
        self.lbl_weather.pack(side="right", padx=16)

        # ── Main scrollable content ──────────────────────────────────────────
        content_frame = tk.Frame(self, bg=BG)
        content_frame.pack(fill="both", expand=True, padx=0, pady=0)

        self.canvas = tk.Canvas(content_frame, bg=BG, highlightthickness=0)
        scrollbar = ttk.Scrollbar(content_frame, orient="vertical",
                                   command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=scrollbar.set)

        scrollbar.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)

        self.inner = tk.Frame(self.canvas, bg=BG)
        self.canvas_window = self.canvas.create_window(
            (0, 0), window=self.inner, anchor="nw")

        self.inner.bind("<Configure>", self._on_inner_configure)
        self.canvas.bind("<Configure>", self._on_canvas_configure)
        self.canvas.bind_all("<MouseWheel>", self._on_mousewheel)
        self.canvas.bind_all("<Button-4>", self._on_mousewheel)
        self.canvas.bind_all("<Button-5>", self._on_mousewheel)

        # Keyboard shortcuts
        self.bind("<Left>", lambda e: self._prev_day())
        self.bind("<Right>", lambda e: self._next_day())
        self.bind("<r>", lambda e: self._refresh())

        # ── Status bar ───────────────────────────────────────────────────────
        self.status_bar = tk.Label(self, text="", bg="#181825", fg=MUTED,
                                    font=("SF Pro Display", 10), pady=4)
        self.status_bar.pack(fill="x", side="bottom")

    # ── Scroll helpers ────────────────────────────────────────────────────────

    def _on_inner_configure(self, event):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _on_canvas_configure(self, event):
        self.canvas.itemconfig(self.canvas_window, width=event.width)

    def _on_mousewheel(self, event):
        if event.num == 4:
            self.canvas.yview_scroll(-1, "units")
        elif event.num == 5:
            self.canvas.yview_scroll(1, "units")
        else:
            self.canvas.yview_scroll(int(-1*(event.delta/120)), "units")

    # ── Data loading ──────────────────────────────────────────────────────────

    def _load_initial_data(self):
        cached, ts = load_cache()
        if cached:
            self.sheets_raw = cached
            self.cache_time = ts
            self._process_data()
            self._set_status(f"Loaded from cache ({ts[:16] if ts else 'unknown'})")
        else:
            self._set_status("No cache found. Click ↻ Refresh to load from Google Sheets.")
            self._show_welcome()

    def _show_welcome(self):
        for w in self.inner.winfo_children():
            w.destroy()
        msg = tk.Label(self.inner, text=(
            "Welcome to Travel Companion!\n\n"
            "Click  ↻ Refresh  to fetch your itinerary from Google Sheets.\n\n"
            "First time? Make sure credentials.json is in the same folder.\n"
            "See the setup instructions at the top of the script.\n\n"
            "Keyboard shortcuts:  ← →  navigate days  ·  R  refresh"
        ), bg=BG, fg=TEXT_DIM, font=("SF Pro Display", 14),
            justify="center", pady=60)
        msg.pack(expand=True)
        self.lbl_date.config(text="No data")
        self.lbl_location.config(text="")
        self.lbl_meta.config(text="")
        self.lbl_weather.config(text="")

    def _process_data(self):
        self.sheets_data = {}
        for name, raw in self.sheets_raw.items():
            if raw:
                parsed = parse_sheet(name, raw)
                if parsed.get("arrive") and parsed.get("depart"):
                    self.sheets_data[name] = parsed

        self.day_index = build_day_index(self.sheets_data)
        if not self.day_index:
            self._show_welcome()
            return

        # Find today or next upcoming day
        today = date.today()
        idx = 0
        for i, (d, _sheets) in enumerate(self.day_index):
            if d >= today:
                idx = i
                break
        else:
            idx = 0
        self.current_idx = idx
        self._render_day()

    def _refresh(self):
        if self.loading:
            return
        self.loading = True
        self.btn_refresh.config(text="⟳  Fetching…", state="disabled", fg=MUTED)
        self._set_status("Connecting to Google Sheets API…")
        threading.Thread(target=self._do_refresh, daemon=True).start()

    def _do_refresh(self):
        """Background thread: fetch all sheets via Google Sheets API (OAuth)."""
        try:
            results = _fetch_via_oauth(
                progress_cb=lambda msg: self.after(0, lambda m=msg: self._set_status(m))
            )
        except Exception as e:
            import traceback
            print(f"\n[Refresh error]\n{traceback.format_exc()}")
            self.after(0, self._refresh_error, str(e))
            return

        errors = [s for s, v in results.items() if not v]
        good   = {s: v for s, v in results.items() if v}
        self.after(0, self._refresh_done, good, errors)

    def _refresh_error(self, message):
        self.loading = False
        self.btn_refresh.config(text="↻  Refresh", state="normal", fg=RED)
        self._set_status("Refresh failed — see error dialog")
        messagebox.showerror("Refresh failed", message)

    def _refresh_done(self, results, errors):
        self.loading = False
        self.btn_refresh.config(text="↻  Refresh", state="normal", fg=GREEN)

        print(f"\n=== REFRESH ===  fetched={list(results.keys())}  errors={errors}\n")

        if results:
            self.sheets_raw.update(results)
            ts = datetime.now().isoformat()
            self.cache_time = ts
            save_cache(self.sheets_raw)
            self._process_data()
            msg = f"Refreshed {len(results)} sheets."
            if errors:
                msg += f"  ({len(errors)} failed: {', '.join(str(e) for e in errors[:3])})"
            self._set_status(msg)
            self.lbl_cache.config(text=f"Updated {ts[11:16]}")
        else:
            self._set_status("Refresh failed — no data returned. Check terminal for details.")

    # ── Navigation ────────────────────────────────────────────────────────────

    def _prev_day(self):
        if self.current_idx > 0:
            self.current_idx -= 1
            self._render_day()

    def _next_day(self):
        if self.current_idx < len(self.day_index) - 1:
            self.current_idx += 1
            self._render_day()

    # ── Rendering ─────────────────────────────────────────────────────────────

    def _render_day(self):
        if not self.day_index:
            return

        for w in self.inner.winfo_children():
            w.destroy()
        self.canvas.yview_moveto(0)

        day, all_sheets_today = self.day_index[self.current_idx]

        is_multi = len(all_sheets_today) > 1

        # Primary sheet = first one for this date (drives header/weather)
        sheet_name = all_sheets_today[0]
        data = self.sheets_data.get(sheet_name, {})
        today = date.today()

        # ── Header update ─────────────────────────────────────────────────
        day_label = _fmt_day(day)
        self.lbl_date.config(text=day_label)

        # Badge
        if day == today:
            self.lbl_badge.config(text="TODAY", bg=GREEN, fg=BG)
        elif day < today:
            diff = (today - day).days
            self.lbl_badge.config(text=f"{diff}d ago", bg=MUTED, fg=BG)
        else:
            diff = (day - today).days
            self.lbl_badge.config(text=f"in {diff}d", bg=ACCENT, fg=BG)

        # Location meta
        loc = data.get("location", sheet_name)
        country = data.get("country", "")
        if is_multi:
            all_locs = " → ".join(
                self.sheets_data.get(s, {}).get("location", s)
                for s in all_sheets_today
            )
            self.lbl_location.config(text=f"📍 {all_locs}")
        else:
            self.lbl_location.config(text=f"📍 {loc}" + (f", {country}" if country else ""))

        loc = " → ".join(
            self.sheets_data.get(s, {}).get("location", s)
            for s in all_sheets_today
        ) if is_multi else data.get("location", sheet_name)
        arrive_raw = data.get("raw_arrive", "")
        depart_raw = data.get("raw_depart", "")
        nights = data.get("nights", "")
        sun_rise = data.get("sunrise", "")
        sun_set = data.get("sunset", "")
        meta_parts = []
        if arrive_raw:
            meta_parts.append(f"Arrive {arrive_raw}")
        if depart_raw:
            meta_parts.append(f"→ Depart {depart_raw}")
        if nights:
            try:
                n = float(nights)
                meta_parts.append(f"({int(n)}{'½' if n % 1 > 0.3 else ''} nights)")
            except ValueError:
                meta_parts.append(f"({nights} nights)")
        self.lbl_meta.config(text="  ·  ".join(meta_parts))

        # Weather for today's date
        weather_str = ""
        if sun_rise:
            weather_str += f"🌅 {sun_rise}  🌇 {sun_set}   "
        # Find weather for this specific day
        w_dates = data.get("weather_dates", [])
        w_max = data.get("weather_max", [])
        w_min = data.get("weather_min", [])
        w_cloud = data.get("weather_cloud", [])
        day_str_variants = [
            day.strftime("%Y-%m-%d"),
            _fmt_short(day),
        ]
        for j, wd in enumerate(w_dates):
            if wd in day_str_variants or day.strftime("%Y-%m-%d") in wd:
                mx = w_max[j] if j < len(w_max) else ""
                mn = w_min[j] if j < len(w_min) else ""
                cl = w_cloud[j] if j < len(w_cloud) else ""
                if mx:
                    try:
                        weather_str += f"🌡 {float(mn):.0f}–{float(mx):.0f}°C"
                    except ValueError:
                        weather_str += f"🌡 {mn}–{mx}°C"
                if cl:
                    try:
                        c_pct = float(cl)
                        if c_pct < 20:
                            weather_str += "  ☀"
                        elif c_pct < 50:
                            weather_str += "  🌤"
                        elif c_pct < 75:
                            weather_str += "  ⛅"
                        else:
                            weather_str += "  ☁"
                    except ValueError:
                        pass
                break
        else:
            # Use avg temps
            avg_min = data.get("avg_min", "")
            avg_max = data.get("avg_max", "")
            if avg_min and avg_max:
                try:
                    weather_str += f"🌡 ~{float(avg_min):.0f}–{float(avg_max):.0f}°C"
                except ValueError:
                    weather_str += f"🌡 {avg_min}–{avg_max}°C"
        self.lbl_weather.config(text=weather_str)

        # ── Accommodation card ─────────────────────────────────────────────
        accom = data.get("accommodation", "")
        accom_link = data.get("accommodation_link", "")
        accom_notes = data.get("accommodation_notes", "")
        check_in = data.get("check_in", "")
        check_out = data.get("check_out", "")

        if accom:
            self._section_card(
                "🏨  Accommodation",
                accom,
                accom_link,
                accom_notes,
                f"Check-in {check_in}  ·  Check-out {check_out}" if check_in else ""
            )

        # ── Activities ────────────────────────────────────────────────────
        activities = data.get("activities", [])
        # Filter activities relevant to this day
        day_activities = self._filter_activities_for_day(activities, day)
        if day_activities:
            self._activities_card("📋  Activities", day_activities)
        elif activities:
            # Show all activities if we can't filter
            self._activities_card("📋  Activities", activities[:20])

        # ── Restaurants ───────────────────────────────────────────────────
        restaurants = data.get("restaurants", [])
        if restaurants:
            self._restaurants_card("🍽  Restaurants", restaurants)

        # ── Transit stops for the same day ────────────────────────────────
        if is_multi:
            for transit_sheet in all_sheets_today[1:]:
                td = self.sheets_data.get(transit_sheet, {})
                t_loc = td.get("location", transit_sheet)
                t_country = td.get("country", "")
                t_arrive = td.get("raw_arrive", "")
                t_depart = td.get("raw_depart", "")
                t_header = f"🚉  {t_loc}" + (f", {t_country}" if t_country else "")
                if t_arrive or t_depart:
                    t_header += f"  ({t_arrive} → {t_depart})"
                t_acts = td.get("activities", [])
                t_filtered = self._filter_activities_for_day(t_acts, day) if t_acts else []
                if t_filtered or t_acts:
                    self._activities_card(t_header, t_filtered or t_acts[:20])
                else:
                    tk.Label(self.inner, text=t_header,
                             bg=CARD, fg=ACCENT,
                             font=("SF Pro Display", 13, "bold"),
                             pady=8, padx=12, anchor="w").pack(fill="x", pady=(8,0))

        # ── Live weather forecast (fetched async) ─────────────────────────
        lat = data.get("lat", "")
        lng = data.get("lng", "")

        # Use a render_id to detect stale callbacks after navigation
        self._weather_render_id = getattr(self, "_weather_render_id", 0) + 1
        my_render_id = self._weather_render_id


        # Placeholder shown immediately while fetching
        wx_placeholder = tk.Frame(self.inner, bg=BG)
        wx_placeholder.pack(fill="x")
        tk.Label(wx_placeholder, text="  🌤  Fetching live forecast…",
                 bg=BG, fg=MUTED, font=("SF Pro Display", 11),
                 pady=8, anchor="w").pack(fill="x", padx=12)

        # ── Day navigation pills ──────────────────────────────────────────
        self._nav_pills_frame = tk.Frame(self.inner, bg=BG)
        self._nav_pills_frame.pack(fill="x")
        self._nav_pills()

        # Update button states
        self.btn_prev.config(state="normal" if self.current_idx > 0 else "disabled")
        self.btn_next.config(state="normal" if self.current_idx < len(self.day_index)-1 else "disabled")
        self._set_status(f"Day {self.current_idx+1} of {len(self.day_index)}  ·  {loc}  ·  ← → to navigate")

        _snap_day = day

        def _do_weather_fetch(lat=lat, lng=lng, snap_day=_snap_day,
                              ph=wx_placeholder, rid=my_render_id):
            forecast = fetch_live_weather(lat, lng, days=5)
            def _render(f=forecast, sd=snap_day, ph=ph, rid=rid):
                if rid != self._weather_render_id:
                    return  # user navigated away — discard
                try:
                    ph.destroy()
                except Exception:
                    pass
                self._weather_card(f, sd)
                # Move nav pills below weather
                if hasattr(self, "_nav_pills_frame") and self._nav_pills_frame.winfo_exists():
                    self._nav_pills_frame.pack_forget()
                    self._nav_pills_frame.pack(fill="x")
            self.after(0, _render)

        threading.Thread(target=_do_weather_fetch, daemon=True).start()

    def _filter_activities_for_day(self, activities, day):
        """Return activities that match this calendar date, plus undated ones.

        Logic:
        - Dated activities that match today -> always shown
        - Dated activities that don't match -> hidden
        - Undated activities -> shown if there are NO dated activities at all
          in the sheet (i.e. all are undated), OR always shown alongside
          matching dated ones (they are general-purpose notes for the location)
        """
        matching = []
        untagged = []
        any_dated = False

        for act in activities:
            t = act.get("time", "")
            if not t:
                untagged.append(act)
                continue

            # Try to parse date from time field
            parsed = None
            for fmt in ("%d/%m/%Y %H:%M", "%d/%m/%Y"):
                try:
                    pd = datetime.strptime(t.strip(), fmt)
                    if pd.year in (1900, 2025):
                        pd = pd.replace(year=2026)
                    parsed = pd.date()
                    break
                except ValueError:
                    pass
            if parsed is None:
                for fmt, suffix in (("%d %b %Y", " 2026"), ("%d/%m/%Y", "/2026")):
                    try:
                        pd = datetime.strptime(t.strip() + suffix, fmt)
                        parsed = pd.date()
                        break
                    except ValueError:
                        pass
            if parsed is None:
                m = re.match(r"^(\d{1,2})/(\d{1,2})", t)
                if m:
                    try:
                        parsed = date(2026, int(m.group(2)), int(m.group(1)))
                    except ValueError:
                        pass
            # "Tue 4 17:00" / "Wed 5 9:16" style (day-of-week + day number + optional time)
            if parsed is None:
                m = re.match(r"^\w{2,3}\s+(\d{1,2})(?:\s+\d{1,2}:\d{2})?$", t.strip())
                if m:
                    day_num = int(m.group(1))
                    if day_num == day.day:
                        parsed = day

            if parsed:
                any_dated = True
                if parsed == day:
                    matching.append(act)
            else:
                untagged.append(act)

        if matching:
            # Dated matches found — append undated items too (general notes)
            return matching + untagged
        elif not any_dated:
            # No dated activities at all — show everything
            return untagged
        else:
            # Dated activities exist but none match today — show undated only
            return untagged

    # ── Card widgets ──────────────────────────────────────────────────────────

    # ── Selectable text helper ───────────────────────────────────────────────

    def _selectable(self, parent, text, fg=None, font=None, bold=False,
                    wraplength=700, pady=0, padx=0):
        """
        A read-only tk.Text that looks like a Label but allows text selection.
        Height auto-sizes to content.
        """
        if fg is None:
            fg = TEXT
        if font is None:
            font = ("SF Pro Display", 12)
        elif isinstance(font, tuple) and bold and "bold" not in font:
            font = font + ("bold",)

        # Estimate line height and number of lines needed
        # Use a temporary widget width guess; will be correct after pack
        chars_per_line = max(1, (wraplength // 7))  # ~7px per char at 12pt
        import math
        lines = max(1, math.ceil(len(text) / chars_per_line)) if text else 1
        # Add extra lines for embedded newlines
        lines += text.count("\n")

        t = tk.Text(parent, height=lines, wrap="word",
                    bg=parent.cget("bg"), fg=fg,
                    font=font,
                    relief="flat", borderwidth=0,
                    highlightthickness=0,
                    selectbackground=ACCENT, selectforeground=BG,
                    inactiveselectbackground=ACCENT,
                    cursor="arrow",
                    pady=pady, padx=padx,
                    spacing3=2)
        t.insert("1.0", text)
        t.config(state="disabled")
        return t

    def _section_header(self, title: str):
        lbl = tk.Label(self.inner, text=title, bg=BG, fg=ACCENT,
                       font=("SF Pro Display", 13, "bold"),
                       anchor="w", pady=8, padx=16)
        lbl.pack(fill="x", pady=(14, 0))

    def _section_card(self, section_title, name, link, notes, meta=""):
        self._section_header(section_title)
        card = tk.Frame(self.inner, bg=CARD_BG, padx=16, pady=12)
        card.pack(fill="x", padx=12, pady=(0, 4))

        name_frame = tk.Frame(card, bg=CARD_BG)
        name_frame.pack(fill="x")

        fg_name = BLUE if link else TEXT
        lbl = self._selectable(name_frame, name, fg=fg_name,
                               font=("SF Pro Display", 13, "bold"), wraplength=750)
        lbl.pack(side="left", fill="x", expand=True)
        if link:
            lbl.config(state="normal", cursor="hand2")
            lbl.bind("<Button-1>", lambda e, u=link: webbrowser.open(u))
            lbl.config(state="disabled")

        if meta:
            mk = self._selectable(card, meta, fg=TEXT_DIM,
                                  font=("SF Pro Display", 10), wraplength=800)
            mk.pack(fill="x", pady=(2, 0))

        if notes:
            nk = self._selectable(card, notes, fg=TEXT_DIM,
                                  font=("SF Pro Display", 10), wraplength=800)
            nk.pack(fill="x", pady=(4, 0))

    def _activities_card(self, section_title, activities):
        self._section_header(section_title)
        card = tk.Frame(self.inner, bg=CARD_BG, padx=16, pady=12)
        card.pack(fill="x", padx=12, pady=(0, 4))

        for i, act in enumerate(activities):
            if i > 0:
                sep = tk.Frame(card, bg="#313244", height=1)
                sep.pack(fill="x", pady=6)

            row = tk.Frame(card, bg=CARD_BG)
            row.pack(fill="x")

            # Time badge
            time_str = act.get("time", "")
            if time_str:
                # Extract just the time part if there's a date prefix
                m = re.search(r"(\d{1,2}:\d{2})", time_str)
                display_time = m.group(1) if m else time_str
                tbadge = tk.Label(row, text=display_time, bg="#313244", fg=YELLOW,
                                  font=("SF Mono", 10, "bold"),
                                  padx=6, pady=2, width=6)
                tbadge.pack(side="left", anchor="n", pady=2)

            # Name + description
            name = act.get("name", "")
            link = act.get("link", "")
            cost = act.get("cost", "")
            is_url = link and link.startswith("http")

            text_frame = tk.Frame(row, bg=CARD_BG)
            text_frame.pack(side="left", fill="x", expand=True, padx=(8, 0))

            name_row = tk.Frame(text_frame, bg=CARD_BG)
            name_row.pack(fill="x", anchor="w")

            # Activity name — selectable text
            name_fg = BLUE if is_url else TEXT
            nlbl = self._selectable(name_row, name, fg=name_fg,
                                    font=("SF Pro Display", 12), wraplength=600)
            nlbl.pack(side="left", anchor="w", fill="x", expand=True)

            # Link button — ↗ shown whenever there's a URL
            if is_url:
                lbtn = tk.Label(name_row, text="↗", bg=CARD_BG, fg=BLUE,
                                font=("SF Pro Display", 12, "bold"),
                                cursor="hand2", padx=4)
                lbtn.pack(side="left", anchor="w", padx=(2, 0))
                lbtn.bind("<Button-1>", lambda e, u=link: webbrowser.open(u))
                nlbl.config(state="normal", cursor="hand2")
                nlbl.bind("<Button-1>", lambda e, u=link: webbrowser.open(u))
                nlbl.config(state="disabled")
            elif link:
                # Non-URL content — show as selectable subtitle
                slbl = self._selectable(text_frame, link, fg=TEXT_DIM,
                                        font=("SF Pro Display", 10), wraplength=660)
                slbl.pack(anchor="w", fill="x")

            if cost:
                clbl = tk.Label(row, text=cost, bg=CARD_BG, fg=GREEN,
                                font=("SF Pro Display", 10), anchor="e", padx=8)
                clbl.pack(side="right", anchor="n", pady=2)

    def _restaurants_card(self, section_title, restaurants):
        self._section_header(section_title)
        card = tk.Frame(self.inner, bg=CARD_BG, padx=16, pady=12)
        card.pack(fill="x", padx=12, pady=(0, 4))

        for i, rest in enumerate(restaurants):
            if i > 0:
                sep = tk.Frame(card, bg="#313244", height=1)
                sep.pack(fill="x", pady=6)

            row = tk.Frame(card, bg=CARD_BG)
            row.pack(fill="x")

            name = rest.get("name", "")
            rtype = rest.get("type", "")
            walk = rest.get("walk", "")
            hours = rest.get("hours", "")
            notes = rest.get("notes", "")

            rnlbl = self._selectable(row, name, fg=TEXT,
                                    font=("SF Pro Display", 12, "bold"), wraplength=300)
            rnlbl.pack(side="left", anchor="w")

            meta_parts = [p for p in [rtype, walk, hours] if p]
            if meta_parts:
                mlbl = self._selectable(row, "  ·  ".join(meta_parts), fg=TEXT_DIM,
                                        font=("SF Pro Display", 10), wraplength=400)
                mlbl.pack(side="left", padx=(8, 0), anchor="w")

            if notes:
                nf = tk.Frame(card, bg=CARD_BG)
                nf.pack(fill="x")
                nlbl2 = self._selectable(nf, notes, fg=TEXT_DIM,
                                         font=("SF Pro Display", 10), wraplength=800)
                nlbl2.pack(anchor="w", fill="x", pady=(2, 0))

    def _weather_card(self, forecast: list, current_day: date):
        """Render a 3-day live forecast card."""
        if not forecast:
            return

        self._section_header("🌤  3-Day Forecast  (live)")
        card = tk.Frame(self.inner, bg=CARD_BG, padx=16, pady=14)
        card.pack(fill="x", padx=12, pady=(0, 4))

        # Find index of current_day in forecast, show from there
        start = 0
        for i, f in enumerate(forecast):
            if f.get("date") == current_day.strftime("%Y-%m-%d"):
                start = i
                break

        days_to_show = forecast[start:start+3]
        if not days_to_show:
            days_to_show = forecast[:3]

        cols = tk.Frame(card, bg=CARD_BG)
        cols.pack(fill="x")

        for f in days_to_show:
            col = tk.Frame(cols, bg="#313244", padx=14, pady=12)
            col.pack(side="left", padx=(0, 10), pady=2)

            # Date label
            try:
                d = datetime.strptime(f["date"], "%Y-%m-%d")
                day_str = _fmt_day_short(d)
                is_today = d.date() == date.today()
            except Exception:
                day_str = f["date"]
                is_today = False

            day_lbl = tk.Label(col, text=day_str + (" ←today" if is_today else ""),
                               bg="#313244", fg=GREEN if is_today else ACCENT,
                               font=("SF Pro Display", 10, "bold"))
            day_lbl.pack()

            # Big weather icon
            icon_lbl = tk.Label(col, text=f.get("icon", "🌡"),
                                bg="#313244", fg=TEXT,
                                font=("SF Pro Display", 28))
            icon_lbl.pack(pady=(6, 2))

            # Description
            desc_lbl = tk.Label(col, text=f.get("desc", ""),
                                bg="#313244", fg=TEXT_DIM,
                                font=("SF Pro Display", 10))
            desc_lbl.pack()

            # Temp range
            mx = f.get("max")
            mn = f.get("min")
            if mx is not None and mn is not None:
                temp_str = f"{mn:.0f}° – {mx:.0f}°C"
            elif mx is not None:
                temp_str = f"Max {mx:.0f}°C"
            else:
                temp_str = "—"
            temp_lbl = tk.Label(col, text=temp_str,
                                bg="#313244", fg=YELLOW,
                                font=("SF Pro Display", 12, "bold"))
            temp_lbl.pack(pady=(6, 0))

            # Precip + wind
            details = []
            if f.get("precip") is not None:
                details.append(f"💧 {f['precip']:.1f}mm")
            if f.get("wind") is not None:
                details.append(f"💨 {f['wind']:.0f}km/h")
            if details:
                det_lbl = tk.Label(col, text="  ".join(details),
                                   bg="#313244", fg=TEXT_DIM,
                                   font=("SF Pro Display", 10))
                det_lbl.pack(pady=(4, 0))

    def _nav_pills(self):
        """Show a horizontal strip of all trip days as clickable pills."""
        # Pack into the pre-created frame so we can refresh it after weather loads
        container = getattr(self, "_nav_pills_frame", None)
        parent = container if (container and container.winfo_exists()) else self.inner
        frame = tk.Frame(parent, bg=BG, pady=16)
        frame.pack(fill="x", padx=12)

        tk.Label(frame, text="All days:", bg=BG, fg=MUTED,
                 font=("SF Pro Display", 10)).pack(side="left", padx=(0, 8))

        today = date.today()
        canvas = tk.Canvas(frame, bg=BG, highlightthickness=0, height=32)
        canvas.pack(fill="x", expand=True)

        pills_frame = tk.Frame(canvas, bg=BG)
        canvas.create_window((0, 0), window=pills_frame, anchor="nw")

        prev_loc = None
        seen_pill_dates = {}  # date → first index seen (to detect multi-stop days)
        for i, (d, sheets) in enumerate(self.day_index):
            seen_pill_dates.setdefault(d, i)

        prev_loc = None
        for i, (d, sheets) in enumerate(self.day_index):
            is_multi_day = len(sheets) > 1
            primary_sheet = sheets[0]
            loc = self.sheets_data.get(primary_sheet, {}).get("location", primary_sheet)
            # For multi-stop days show abbreviated location chain; otherwise show date
            short = "/".join(
                self.sheets_data.get(s, {}).get("location", s)[:4] for s in sheets
            ) if is_multi_day else _fmt_short(d)
            is_current = (i == self.current_idx)
            is_today = (d == today)

            if loc != prev_loc:
                sep_lbl = tk.Label(pills_frame, text=f"  {loc[:8]}  ",
                                   bg=BG, fg=MUTED, font=("SF Pro Display", 8))
                sep_lbl.pack(side="left")
            prev_loc = loc

            if is_current:
                bg_c, fg_c = ACCENT, BG
            elif is_today:
                bg_c, fg_c = GREEN, BG
            elif d < today:
                bg_c, fg_c = "#313244", TEXT_DIM
            else:
                bg_c, fg_c = "#313244", TEXT

            btn = tk.Button(pills_frame, text=short, bg=bg_c, fg=fg_c,
                            relief="flat", font=("SF Mono", 9),
                            padx=5, pady=3, cursor="hand2",
                            command=lambda idx=i: self._jump_to(idx))
            btn.pack(side="left", padx=1)

    def _jump_to(self, idx: int):
        self.current_idx = idx
        self._render_day()

    def _set_status(self, msg: str):
        self.status_bar.config(text=f"  {msg}")


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app = TravelApp()
    app.mainloop()
