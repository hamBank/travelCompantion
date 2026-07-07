"""Weather lookup via Open-Meteo (free, no API key).

For dates within the ~16-day forecast horizon we use the live forecast; for dates
beyond it (e.g. a trip weeks out) we fall back to *climatology* — the average of
the same calendar dates over the past few years from the archive API. Both yield
a per-date {tmin, tmax, icon, desc} the UI can show in the day header.

Network access goes through an injectable `fetch_json` so the logic is unit-tested
without hitting the network.
"""
from __future__ import annotations

import json
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from statistics import mean

from .metrics import record_external_call

# WMO weather codes → (emoji, description). Mirrors the legacy desktop app.
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
    95: ("⛈", "Thunderstorm"), 96: ("⛈", "Thunderstorm + hail"), 99: ("⛈", "Thunderstorm + hail"),
}

FORECAST_HORIZON_DAYS = 16
CLIMATOLOGY_YEARS = 3

# Cache-key versioning: bump when the payload shape changes so stale-shaped
# entries are re-fetched rather than served. v2 added wind.
CACHE_VERSION = "v2"


def utc_today() -> date:
    """Today's date per UTC — the reference Open-Meteo's own start_date/
    end_date validity window is anchored to (confirmed directly against
    their API). `date.today()` returns the date in whatever timezone the
    *process* happens to be running under, which is not reliably UTC —
    the production server's OS clock is Europe/Berlin, not UTC, so
    `date.today()` there silently reintroduces the exact non-UTC-"today"
    bug already fixed once for destination-local time (see get_weather's
    docstring below): during the ~2-hour window each evening after Berlin's
    local date has rolled over but UTC's hasn't, the horizon would be
    computed one day ahead of Open-Meteo's real boundary.
    """
    return datetime.now(timezone.utc).date()


def strip_invisible_chars(s: str) -> str:
    """Strip zero-width/invisible Unicode format characters (category "Cf" —
    e.g. U+200B ZERO WIDTH SPACE, U+200C ZWNJ, U+FEFF BOM) that can sneak into
    pasted addresses. Left in place, they silently break Nominatim geocoding
    (the request 400s) while looking like a normal address to a human reading
    it, so the failure is invisible until you diff the raw bytes.
    """
    if not s:
        return s
    return "".join(ch for ch in s if unicodedata.category(ch) != "Cf")


def cache_key(lat, lng, start: str, end: str) -> str:
    """Canonical WeatherCache key. Coords rounded to 2dp so nearby lookups share."""
    lat_r = round(float(str(lat).split(",")[0]), 2)
    lng_r = round(float(str(lng).split(",")[0]), 2)
    return f"{CACHE_VERSION},{lat_r},{lng_r},{start},{end}"


def parse_cache_key(key: str):
    """Inverse of cache_key → (lat, lng, start, end), or None if not a coord key."""
    parts = key.split(",")
    if len(parts) != 5 or parts[0] != CACHE_VERSION or parts[1].startswith("q:"):
        return None
    _, lat, lng, start, end = parts
    return lat, lng, start, end


def parse_q_key(key: str):
    """Parse a place-name cache key → (query, start, end), or None."""
    parts = key.split(",")
    if len(parts) != 4 or parts[0] != CACHE_VERSION or not parts[1].startswith("q:"):
        return None
    return parts[1][2:], parts[2], parts[3]


def _icon_for(code: int) -> tuple[str, str]:
    return WMO_ICONS.get(int(code), ("🌡", f"Code {code}"))


def _fetch_json(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            result = json.loads(resp.read())
    except Exception as e:
        record_external_call("open_meteo", ok=False, error=str(e))
        raise
    record_external_call("open_meteo", ok=True)
    return result


def _fetch_geocode(q: str):
    # Nominatim requires a User-Agent; without one it returns 403.
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": q, "format": "json", "limit": 1}
    )
    req = urllib.request.Request(url, headers={"User-Agent": "travel-companion/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            result = json.loads(resp.read())
    except Exception as e:
        record_external_call("nominatim", ok=False, error=str(e))
        raise
    record_external_call("nominatim", ok=True)
    return result


def geocode(q: str, *, fetch=_fetch_geocode):
    """Resolve a place name to (lat, lng) via Nominatim, or None."""
    if not q or not q.strip():
        return None
    q = strip_invisible_chars(q).strip()
    if not q:
        return None
    try:
        results = fetch(q)
        if results:
            return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception:
        pass
    return None


def _valid_coords(lat, lng) -> tuple[float, float] | None:
    try:
        lat_f = float(str(lat).split(",")[0].strip())
        lng_f = float(str(lng).split(",")[0].strip())
    except (ValueError, TypeError):
        return None
    if not (-90 <= lat_f <= 90) or not (-180 <= lng_f <= 180):
        return None
    return lat_f, lng_f


def parse_daily(payload: dict) -> dict[str, dict]:
    """Open-Meteo daily payload → {iso_date: {tmin, tmax, code}} (skips null rows)."""
    daily = (payload or {}).get("daily", {}) or {}
    out: dict[str, dict] = {}
    times = daily.get("time", []) or []
    tmax = daily.get("temperature_2m_max", []) or []
    tmin = daily.get("temperature_2m_min", []) or []
    codes = daily.get("weathercode", []) or []
    winds = daily.get("windspeed_10m_max", []) or []
    for i, d in enumerate(times):
        mx = tmax[i] if i < len(tmax) else None
        mn = tmin[i] if i < len(tmin) else None
        if mx is None or mn is None:
            continue
        cd = codes[i] if i < len(codes) and codes[i] is not None else 0
        wind = winds[i] if i < len(winds) and winds[i] is not None else None
        out[d] = {"tmin": mn, "tmax": mx, "code": int(cd), "wind": wind}
    return out


def average_climatology(year_payloads: list[dict]) -> dict[str, dict]:
    """Average several years of archive daily data, keyed by MM-DD.

    Each payload covers the same calendar span in a different year. Temps are
    averaged; the weather code is the most common across years.
    """
    by_md: dict[str, dict] = {}
    for payload in year_payloads:
        for iso, rec in parse_daily(payload).items():
            md = iso[5:]  # "MM-DD"
            by_md.setdefault(md, {"tmin": [], "tmax": [], "code": [], "wind": []})
            by_md[md]["tmin"].append(rec["tmin"])
            by_md[md]["tmax"].append(rec["tmax"])
            by_md[md]["code"].append(rec["code"])
            if rec.get("wind") is not None:
                by_md[md]["wind"].append(rec["wind"])
    result: dict[str, dict] = {}
    for md, vals in by_md.items():
        if not vals["tmin"]:
            continue
        modal_code = Counter(vals["code"]).most_common(1)[0][0]
        result[md] = {
            "tmin": round(mean(vals["tmin"]), 1),
            "tmax": round(mean(vals["tmax"]), 1),
            "code": int(modal_code),
            "wind": round(mean(vals["wind"]), 1) if vals["wind"] else None,
        }
    return result


def _decorate(rec: dict, source: str) -> dict:
    icon, desc = _icon_for(rec["code"])
    wind = rec.get("wind")
    return {
        "tmin": round(rec["tmin"], 1),
        "tmax": round(rec["tmax"], 1),
        "wind": round(wind, 1) if wind is not None else None,  # km/h
        "icon": icon,
        "desc": desc,
        "source": source,
    }


def get_weather(lat, lng, start: str, end: str, *, fetch_json=_fetch_json, today: date | None = None) -> dict[str, dict]:
    """Return {iso_date: {tmin, tmax, icon, desc, source}} for [start, end] inclusive.

    Live forecast for dates within the horizon; climatology for the rest.
    """
    coords = _valid_coords(lat, lng)
    if not coords:
        return {}
    lat_f, lng_f = coords
    start_d = date.fromisoformat(start)
    end_d = date.fromisoformat(end)
    if end_d < start_d:
        return {}
    # "Today" here must match whatever clock Open-Meteo itself validates
    # start_date/end_date against — confirmed directly against their API that
    # this is their own server clock (UTC), NOT the queried location's local
    # time, despite `timezone=auto` making the *returned* data locally
    # bucketed. Using the destination's local "today" instead (as a previous
    # version of this code did) makes an eastern destination's computed
    # horizon run ahead of Open-Meteo's real UTC-anchored boundary for part of
    # each day, causing the whole batched request to be rejected outright —
    # dragging every date in it down to climatology, not just the overreaching
    # one. utc_today() (not date.today(), which follows the *process's* own
    # OS timezone — not reliably UTC, see its docstring) is the correct
    # reference here.
    today = today or utc_today()
    # Open-Meteo's forecast endpoint counts today as day 0, so FORECAST_HORIZON_DAYS
    # (16) total days of live data reach only to today+15 — confirmed directly
    # against the API ("end_date out of allowed range" past that). Using +DAYS here
    # would request one day past what Open-Meteo actually returns, silently
    # dropping to climatology for that last day even though it's still "within"
    # the intended 16-day horizon.
    horizon = today + timedelta(days=FORECAST_HORIZON_DAYS - 1)

    out: dict[str, dict] = {}

    # 1) Live forecast for the portion of [start,end] inside [today, horizon].
    fc_start = max(start_d, today)
    fc_end = min(end_d, horizon)
    if fc_start <= fc_end:
        url = (
            f"https://api.open-meteo.com/v1/forecast?latitude={lat_f}&longitude={lng_f}"
            f"&daily=temperature_2m_max,temperature_2m_min,weathercode,windspeed_10m_max"
            f"&timezone=auto&start_date={fc_start.isoformat()}&end_date={fc_end.isoformat()}"
        )
        try:
            payload = fetch_json(url)
        except Exception:
            # Transient upstream blips are common enough to be worth one
            # immediate retry before conceding the whole batch to climatology
            # (see the /weather endpoint's degraded-payload guard, which
            # exists precisely because a bare give-up here used to poison the
            # cache for up to 48h on a single blip).
            try:
                payload = fetch_json(url)
            except Exception:
                payload = None
        if payload is not None:
            for iso, rec in parse_daily(payload).items():
                out[iso] = _decorate(rec, "forecast")

    # 2) Climatology for any remaining dates (typically a future trip).
    remaining = [
        start_d + timedelta(days=i)
        for i in range((end_d - start_d).days + 1)
        if (start_d + timedelta(days=i)).isoformat() not in out
    ]
    if remaining:
        payloads = []
        for yr_off in range(1, CLIMATOLOGY_YEARS + 1):
            try:
                hist_start = start_d.replace(year=start_d.year - yr_off)
                hist_end = end_d.replace(year=end_d.year - yr_off)
            except ValueError:
                continue  # e.g. Feb 29 — skip that year
            url = (
                f"https://archive-api.open-meteo.com/v1/archive?latitude={lat_f}&longitude={lng_f}"
                f"&daily=temperature_2m_max,temperature_2m_min,weathercode,windspeed_10m_max&timezone=auto"
                f"&start_date={hist_start.isoformat()}&end_date={hist_end.isoformat()}"
            )
            try:
                payloads.append(fetch_json(url))
            except Exception:
                continue
        climo = average_climatology(payloads)
        for d in remaining:
            rec = climo.get(d.isoformat()[5:])
            if rec:
                out[d.isoformat()] = _decorate(rec, "climatology")

    return out
