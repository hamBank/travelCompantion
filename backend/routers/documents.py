"""Document parsing → itinerary item.

Upload an arbitrary travel document (booking email .eml, ticket PDF, plain text,
etc.). We extract the document's text (PDFs are handed to Claude directly as a
document block), then ask Claude to:

  1. classify what *kind* of itinerary item it is (rail / flight / accommodation…),
  2. work out which stop on the trip it belongs to (by location + date),
  3. extract as much structured detail as possible into the same `details` keys
     the edit forms use, so the created record renders correctly.

The endpoint never writes anything — it returns a *preview*. The frontend shows
it for review/edit and then creates the record through the normal item endpoint
(which enforces editor permission on the chosen stop).
"""
import os, json, base64, re, html
from datetime import datetime
from email import message_from_bytes
from email.policy import default as email_default

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlmodel import Session, select

from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_trip_role
from ..models import Trip, Stop, ItemKind, TripRole
from ..pdf_export import _airport_map

router = APIRouter()

# ── Document cache helpers ─────────────────────────────────────────────────────

def _doc_cache_key(trip_id: int, raw_files: list) -> str:
    """Stable SHA256 key for a set of file bytes + trip.

    Files are sorted before hashing so upload order doesn't matter.
    """
    import hashlib
    h = hashlib.sha256()
    h.update(str(trip_id).encode())
    for chunk in sorted(raw_files):
        h.update(chunk)
    return h.hexdigest()


def _check_doc_cache(session, cache_key: str):
    """Return cached result dict or None if not seen before."""
    from ..models import ProcessedDocument
    from sqlmodel import select as _sel
    row = session.exec(_sel(ProcessedDocument).where(ProcessedDocument.cache_key == cache_key)).first()
    if not row:
        return None
    return {"item_count": row.item_count, "trip_id": row.trip_id, "processed_at": row.processed_at}


def _record_doc_cache(session, cache_key: str, trip_id, item_count: int):
    """Persist a cache entry so the same document isn't re-processed."""
    from ..models import ProcessedDocument
    session.add(ProcessedDocument(cache_key=cache_key, trip_id=trip_id, item_count=item_count))
    session.commit()

_ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_MODEL = "claude-sonnet-4-6"
_MAX_TEXT_CHARS = 60_000  # bound token usage on huge HTML emails

# Detail-key hints per kind, mirroring the keys the edit forms read/write so the
# created record displays correctly. Times are local "YYYY-MM-DDTHH:MM".
_DETAIL_HINTS = {
    "rail": "origin, destination, train_number, operator, depart_time, arrive_time, "
            "depart_platform, arrive_platform, duration, rail_class, coach, booking_ref, booking_phone, "
            "passengers (array of objects — one per traveller: {name, ticket, loyalty, seat, meal}; "
            "omit sub-fields you cannot fill)",
    "flight": "origin, destination (IATA codes), flight_number, airline, depart_time, arrive_time, "
              "origin_terminal, arrive_terminal, origin_gate, arrive_gate, checkin_desk, depart_tz, "
              "arrive_tz, duration, layover, connects_to, aircraft, fare_class, distance, "
              "booking_ref, booking_airline, booking_phone, "
              "passengers (array of objects — one per traveller: {name, ticket, loyalty, ff_tier, seat, meal, baggage}; "
              "omit sub-fields you cannot fill)",
    "accommodation": "location, checkin, checkout, booking_ref, contact_phone, contact_email, description",
    "transfer": "start_location, end_location, depart_time, arrive_time, duration, distance, provider, booking_ref",
    "river_transfer": "start_location, end_location, depart_time, arrive_time, duration, distance, "
                       "river_name, provider, booking_ref, contact_phone",
    "tour": "meeting_point, reservation_time, duration, description, contact_phone, booking_ref, "
            "participants (array of objects: {name, ticket}; one per person)",
    "activity": "location, description, duration, contact_phone, contact_email",
    "show": "location (venue), duration, booking_ref, description, contact_phone, "
            "participants (array of objects: {name, ticket, seat}; one per person)",
    "restaurant": "location, reservation_time, description, contact_phone, contact_email",
    "food": "description",
    "purchase": "location, description",
    "note": "description",
    "walk": "start_location, end_location, distance, description",
    "cycling": "start_location, end_location, distance, description",
    "hire": "vehicle_type (car | bike | scooter | van | motorcycle), provider, pickup_location, "
            "dropoff_location, pickup_time, dropoff_time, booking_ref, contact_phone, description",
}


def _strip_html(s: str) -> str:
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"[ \t]*\n[ \t\n]*", "\n", re.sub(r"[ \t]+", " ", s)).strip()


def _text_from_eml(raw: bytes) -> str:
    """Pull readable text out of a MIME email.

    Include BOTH the text/plain and the stripped text/html parts — many providers
    (SNCF, for one) put the payment receipt in text/plain but the actual itinerary
    (times, platforms, train number) only in the HTML part, so preferring one drops
    half the booking.
    """
    msg = message_from_bytes(raw, policy=email_default)
    subject = (msg.get("subject") or "").strip()

    plain, htmls = [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        # Skip binary attachments — but DO include text/plain and text/html even
        # when they have a filename (e.g. "itinerary.html", "eticket.txt").
        # PDFs are handled separately as document blocks; skip them here.
        if part.get_filename() and ctype not in ("text/plain", "text/html"):
            continue
        try:
            body = part.get_content()
        except Exception:
            payload = part.get_payload(decode=True) or b""
            body = payload.decode(part.get_content_charset() or "utf-8", "replace")
        if ctype == "text/plain":
            plain.append(body)
        elif ctype == "text/html":
            htmls.append(body)

    parts = []
    if subject:
        parts.append(f"Subject: {subject}")
    plain_text = "\n".join(plain).strip()
    if plain_text:
        parts.append(plain_text)
    html_text = _strip_html("\n".join(htmls)) if htmls else ""
    if html_text:
        parts.append(html_text)
    return "\n\n".join(parts).strip()


def _build_prompt(stops, kinds) -> str:
    stop_lines = [
        {
            "id": s.id,
            "location": s.location,
            "country": s.country,
            "arrive": s.arrive.isoformat() if s.arrive else None,
            "depart": s.depart.isoformat() if s.depart else None,
        }
        for s in stops
    ]
    hints = "\n".join(f"  - {k}: {_DETAIL_HINTS.get(k, 'description')}" for k in kinds)
    return f"""You are parsing a travel document (a booking confirmation, ticket, \
reservation, or itinerary email) for a trip-planning app. Extract EVERY distinct itinerary \
item it describes.

IMPORTANT: a single document often contains several items. Output ONE item per real-world \
segment or booking:
- A multi-leg journey → one item per leg (each individual flight or train segment is its own item, with its own flight/train number, times, and origin/destination).
- A confirmation covering a flight AND a hotel → one item each.
- If the document truly describes only one thing, return a single-element list.
Do NOT merge two flights into one item, and do NOT invent items that aren't in the document.

CONNECTION BOOKING RULES (critical — apply carefully):
- When a booking lists multiple flight numbers for one route (e.g. "AY132, AY1571" for \
Singapore → Paris), these are CONNECTING flights. Extract SEPARATE items — one per flight number — \
each with its own correct origin and destination for that leg (e.g. AY132: SIN→HEL, AY1571: HEL→CDG).
- NEVER set the destination of the first leg to the final destination of the connection.
- Even if you cannot find the departure/arrival times for each individual segment, STILL extract \
separate items — use the flight number, origin, destination, seats and baggage you CAN identify. \
Omit times rather than guessing them. A partial update record with just seats/baggage is valuable.
- Seat info formatted as "SIN-HEL: 3H 3D / HEL-CDG: 2C 2A" means per-segment assignments: \
for the SIN→HEL leg passenger seats are 3H and 3D; for the HEL→CDG leg they are 2C and 2A. \
Assign each seat to the correct passenger on the correct leg.
- Overall journey baggage (e.g. "4 x checked bag") for a connection means each passenger gets \
the per-passenger allowance on EACH leg. Apply it to all flight segment's passengers.
- The stop point of a connection (e.g. HEL) is the origin of the second leg AND the destination \
of the first leg — use your knowledge of the route to infer these if not stated explicitly.

CRUISE / RIVER CRUISE ITINERARY DOCUMENTS (critical — apply when the document has a "Sailing \
Schedule" table and/or a "Ship" field in its booking summary):
- Extract ONLY from the "Booking Summary" section (ship name, stateroom, embarkation/disembarkation \
dates and ports) and the "Sailing Schedule" table (the day-by-day DATE / DESTINATION / ARRIVAL / \
DEPARTURE table). IGNORE everything else — shore excursions, "Onshore Experiences" descriptions, the \
day-by-day "Detailed Itinerary" narrative, arrival/luggage/insurance/emergency-contact instructions, \
and general terms. Do NOT create separate items for individual shore excursions, tours, or activities.
- Create ONE `accommodation` item per CONTIGUOUS overnight stay in one town — NOT one item for the \
whole cruise, and NOT one item per calendar night when the ship stays in the SAME town for more than \
one night (e.g. two nights docked at the disembarkation city). Start a new item only when the \
overnight town changes from the previous night; merge consecutive same-town nights into a single item \
spanning the full stay. Every item shares the same `name`: the ship's name from the Booking Summary \
(e.g. "AmaKristina").
- Work out each night's overnight town by reading the Sailing Schedule table literally, night by \
night:
  - A date's row(s) may show the ship leaving its current town, then arriving at and being \
"Overnight" in a new town later the same day — sometimes as two location lines under one date. Use \
whichever town is marked "Overnight" as that night's town.
  - If a date's row shows only a departure time (no "Overnight") and no further destination for that \
date, the ship is cruising through the night to the following day's arrival town — that night's town \
is "<next arrival town> (overnight sailing)".
- For each item, `details.location` is that (possibly multi-night) overnight town. Set \
`checkin`/`scheduled_at` to the EXPLICIT arrival/overnight time the schedule gives for the FIRST \
night of the stay (or the Booking Summary's check-in time, for the embarkation-night item). Set \
`checkout` to the explicit departure/arrival time given for the day the ship FINALLY LEAVES that \
town — i.e. the row after the LAST consecutive night at that same town, not after every individual \
night (the final item's checkout is the disembarkation time). If the schedule gives no time for one \
side, include just the date — this is the one exception to "never estimate times" above, since these \
records are synthesized from the schedule rather than read as single fields.
- If a "Docking Locations" section gives a pier/dock address for that item's town, include it in \
`details.description`. This is a bonus, not required — omit `description` rather than guessing an \
address that isn't in the document.

The trip has these stops (match each item to the most likely one by location AND date):
{json.dumps(stop_lines, indent=2)}

Stop-matching rules for flights and rail (important):
- Match to the stop whose location corresponds to the DEPARTURE city/airport of that segment.
- If the departure city is NOT a stop (e.g. a transit/layover airport), match to the LAST stop
  whose depart date is on or before the flight's departure date — i.e. the stop the traveller
  departed from to reach this transit point. Do NOT match a transit segment to the final
  destination stop unless the destination IS an explicit stop and no earlier stop fits.

Choose each `kind` from this exact list: {", ".join(kinds)}

For `details`, use these snake_case keys per kind (include only those you can fill):
{hints}

Rules (apply per item):
- Times are LOCAL wall-clock, formatted "YYYY-MM-DDTHH:MM" (no timezone suffix). For flights/rail, depart_time uses the origin's local time and arrive_time the destination's local time. ONLY include times that appear EXPLICITLY in the document — do NOT calculate or estimate segment times from overall journey durations or connection totals.
- depart_tz / arrive_tz must be fixed UTC-offset strings in the form "GMT+8", "GMT-5", or "GMT+5:30" — the offset actually in effect at that place on that date. Never use city names or IANA zone names (no "Asia/Singapore", no "Helsinki").
- `scheduled_at` is the item's primary time: departure for transport, check-in for accommodation, start time otherwise. Same format, or null if unknown.
- `name` is a short human label. For flights and rail: "Origin City → Destination City" using city names only — no airport or station codes, e.g. "Singapore → Helsinki" not "Singapore SIN → Helsinki HEL". For accommodation: the property name. For other items: a brief descriptive label.
- `cost` is the total price as a plain string with currency symbol if present, e.g. "€48.00"; "" if unknown. If one price covers the whole booking, put it on the first item only and leave the others "".
- `link` is a booking/management URL if present, else "".
- `notes` is free text for anything important with no dedicated field, else "".
- `matched_stop_id` is the integer id of the best-matching stop above, or null if none clearly fits.
- `confidence` is "high", "medium", or "low" for that item.
- `match_reason` is one short sentence explaining the stop choice (or why none matched).

IMPORTANT OUTPUT FORMAT: your entire response must be valid JSON only — no preamble, \
no commentary, no reasoning text before or after the JSON. Start your response with {{ and \
end with }}. Any text outside the JSON object will cause a parse failure.

Output format:
{{
  "items": [
    {{
      "kind": "...",
      "name": "...",
      "scheduled_at": "YYYY-MM-DDTHH:MM" or null,
      "cost": "...",
      "link": "...",
      "notes": "...",
      "details": {{ ...snake_case keys... }},
      "matched_stop_id": <int> or null,
      "confidence": "high|medium|low",
      "match_reason": "..."
    }}
  ]
}}"""


def _call_claude(prompt: str, pdf_b64s: list | None, doc_text: str | None) -> dict:
    import anthropic

    client = anthropic.Anthropic(api_key=_ANTHROPIC_KEY)
    content: list = []
    for pdf_b64 in (pdf_b64s or []):
        content.append({
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64},
        })
    content.append({"type": "text", "text": prompt})
    if doc_text:
        content.append({"type": "text", "text": f"\n\n--- DOCUMENT ---\n{doc_text}"})

    # Scale max_tokens with number of PDF documents — each PDF can produce many items.
    n_docs = len([c for c in content if c.get("type") == "document"])
    max_tokens = min(8000 + n_docs * 4000, 32000)

    import time
    from ..metrics import record_claude_usage
    _t0 = time.monotonic()
    try:
        # Use streaming — required by the SDK when max_tokens is large enough that
        # the request might take > 10 minutes (common with multiple PDF documents).
        with client.messages.stream(
            model=_MODEL,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": content}],
        ) as stream:
            resp = stream.get_final_message()
        record_claude_usage(getattr(resp, "usage", None), time.monotonic() - _t0)
    except anthropic.APIStatusError as e:
        record_claude_usage(None, time.monotonic() - _t0, status="error")
        raise HTTPException(status_code=502, detail=f"Claude API error: {e.message}")
    except Exception as e:
        record_claude_usage(None, time.monotonic() - _t0, status="error")
        raise HTTPException(status_code=502, detail=f"Claude request failed: {e}")

    if resp.stop_reason == "refusal":
        raise HTTPException(status_code=422, detail="The parser declined to process this document.")

    text = next((b.text for b in resp.content if b.type == "text"), "").strip()
    # Tolerate stray code fences.
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text).strip()
    # If Claude prefixed with reasoning prose, find the JSON object.
    if not text.startswith("{"):
        start = text.find("{")
        if start != -1:
            text = text[start:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        preview = text[:300].replace("\n", " ") if text else "(empty)"
        raise HTTPException(status_code=502, detail=f"Could not parse extraction result (stop_reason={resp.stop_reason}): {preview}")


_CITY_TZ = {
    # Small alias map for the most common bare city names the model might emit,
    # so they still normalise even though they aren't IANA identifiers.
    "singapore": "Asia/Singapore", "helsinki": "Europe/Helsinki",
    "paris": "Europe/Paris", "london": "Europe/London", "doha": "Asia/Qatar",
    "dubai": "Asia/Dubai", "sydney": "Australia/Sydney", "melbourne": "Australia/Melbourne",
    "tokyo": "Asia/Tokyo", "new york": "America/New_York", "los angeles": "America/Los_Angeles",
}


def _fmt_offset(total_min: int) -> str:
    sign = "+" if total_min >= 0 else "-"
    h, m = divmod(abs(total_min), 60)
    return f"GMT{sign}{h}" if m == 0 else f"GMT{sign}{h}:{m:02d}"


def _normalize_tz(tz, local_dt) -> str:
    """Coerce a timezone value to the app's canonical 'GMT±X' offset string.

    Accepts existing offsets (passed through, tidied), IANA names, and a few bare
    city names — resolving names to the offset in effect on `local_dt` (DST-correct).
    Unknown values are returned unchanged so nothing is lost.
    """
    if not tz:
        return tz
    s = str(tz).strip()
    compact = s.replace(" ", "").upper()
    m = re.match(r"^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$", compact)
    if m:
        sign = -1 if m.group(1) == "-" else 1
        return _fmt_offset(sign * (int(m.group(2)) * 60 + int(m.group(3) or 0)))
    if ZoneInfo is None:
        return s
    name = s if "/" in s else _CITY_TZ.get(s.lower())
    if not name:
        return s
    try:
        ref = datetime.strptime((str(local_dt) or "")[:16], "%Y-%m-%dT%H:%M") if local_dt else datetime(2026, 1, 1)
    except ValueError:
        ref = datetime(2026, 1, 1)
    try:
        off = ZoneInfo(name).utcoffset(ref)
        return _fmt_offset(int(off.total_seconds() // 60))
    except Exception:
        return s


def _datepart(s) -> str:
    return (str(s) or "")[:10] if s else ""


# ── Post-extraction normalizers ────────────────────────────────────────────────

def _norm_flight_number(s: str) -> str:
    """Canonicalise flight/train number spacing: 'AY132' → 'AY 132'."""
    if not s:
        return s
    m = re.match(r'^([A-Z]{1,3})\s*[-]?\s*(\d+[A-Z]?)$', str(s).strip().upper())
    return f"{m.group(1)} {m.group(2)}" if m else str(s).strip()


def _norm_duration(s: str) -> str:
    """Normalise flight/rail duration to 'Xh Ym': '13:25', '08:10', '13h25m' → '13h 25m'."""
    if not s:
        return s
    s = str(s).strip()
    m = re.match(r'^(\d{1,2}):(\d{2})$', s)
    if m:
        h, mn = int(m.group(1)), int(m.group(2))
        return f"{h}h {mn}m" if mn else f"{h}h"
    m = re.match(r'^(\d+)\s*h\s*(?:(\d+)\s*m)?$', s, re.IGNORECASE)
    if m:
        h, mn = int(m.group(1)), int(m.group(2) or 0)
        return f"{h}h {mn}m" if mn else f"{h}h"
    return s


# Manufacturer prefixes Claude includes that we strip to get a canonical base.
_AIRCRAFT_MFR = re.compile(
    r'^(?:Airbus|Boeing|Embraer|ATR|Bombardier|De\s+Havilland|McDonnell\s+Douglas|Fokker|Saab)\s+',
    re.IGNORECASE,
)

# Maps alternative designations → preferred detailed form.
# Keys are lower-cased for lookup; values are the canonical display string.
_AIRCRAFT_LOOKUP: dict[str, str] = {
    # Airbus narrowbody
    "a318": "A318", "a319": "A319", "a319neo": "A319neo",
    "a320": "A320", "a320ceo": "A320", "a320neo": "A320neo",
    "a321": "A321", "a321neo": "A321neo", "a321xlr": "A321XLR",
    # Airbus widebody
    "a220": "A220", "a220-100": "A220-100", "a220-300": "A220-300",
    "a330": "A330", "a330-200": "A330-200", "a330-300": "A330-300",
    "a330neo": "A330neo", "a330-800neo": "A330-800neo", "a330-900neo": "A330-900neo",
    "a340": "A340", "a340-300": "A340-300", "a340-500": "A340-500", "a340-600": "A340-600",
    "a350": "A350", "a350-900": "A350-900", "a350-1000": "A350-1000",
    "a380": "A380", "a380-800": "A380",          # A380-800 is the only variant
    # Boeing narrowbody
    "737": "737", "737-700": "737-700", "737-800": "737-800", "737-900": "737-900",
    "737-900er": "737-900ER",
    "737 max": "737 MAX", "737 max 8": "737 MAX 8", "737 max 9": "737 MAX 9",
    "737 max 10": "737 MAX 10", "737max8": "737 MAX 8", "737max9": "737 MAX 9",
    "757": "757", "757-200": "757-200", "757-300": "757-300",
    # Boeing widebody
    "747": "747", "747-400": "747-400", "747-8": "747-8", "747-8i": "747-8",
    "767": "767", "767-300": "767-300", "767-300er": "767-300ER", "767-400er": "767-400ER",
    "777": "777", "777-200": "777-200", "777-200er": "777-200ER", "777-200lr": "777-200LR",
    "777-300": "777-300", "777-300er": "777-300ER",
    "777x": "777X", "777-8": "777-8", "777-9": "777-9",
    "787": "787", "787-8": "787-8", "787-9": "787-9", "787-10": "787-10",
    "dreamliner": "787",
    # Embraer
    "e170": "E170", "e175": "E175", "e190": "E190", "e195": "E195",
    "e175-e2": "E175-E2", "e190-e2": "E190-E2", "e195-e2": "E195-E2",
    "erj-135": "ERJ-135", "erj-145": "ERJ-145",
    # ATR
    "atr 42": "ATR 42", "atr 72": "ATR 72", "atr-72": "ATR 72",
    # Bombardier / De Havilland
    "crj-200": "CRJ-200", "crj-700": "CRJ-700", "crj-900": "CRJ-900", "crj-1000": "CRJ-1000",
    "dash 8": "Dash 8", "q400": "Q400", "dhc-8-400": "Q400",
}


import functools

@functools.lru_cache(maxsize=1)
def _airport_rev() -> tuple:
    """Return (fwd, rev) maps built from airportNames.js.

    fwd: IATA → display name
    rev: lower-cased name/alias → IATA  (only unambiguous entries kept)
    """
    from ..pdf_export import _airport_map
    fwd = _airport_map()
    rev: dict = {}
    city_map: dict = {}

    for iata, name in fwd.items():
        # Full display name  e.g. "Tokyo Narita"
        key = name.lower()
        if key in rev:
            rev[key] = None      # collision → ambiguous
        else:
            rev[key] = iata

        # First word (city)  e.g. "tokyo"
        city = name.split()[0].lower()
        if city in city_map:
            city_map[city] = None
        else:
            city_map[city] = iata

    # Merge city map into rev (only for keys that don't already exist)
    for city, iata in city_map.items():
        if iata and city not in rev:
            rev[city] = iata

    return fwd, {k: v for k, v in rev.items() if v}


def _norm_iata(s: str) -> str:
    """Normalise an airport identifier to a 3-letter IATA code where possible.

    Handles (in order):
    - Already a bare IATA code: 'SIN' → 'SIN'
    - Code in parentheses: 'Singapore (SIN)' → 'SIN'
    - Bare code embedded in string: 'Paris CDG' → 'CDG'
    - Exact display name: 'Singapore' → 'SIN', 'Tokyo Narita' → 'NRT'
    - Name with common suffixes stripped: 'Helsinki-Vantaa International' → 'HEL'
    - City prefix before separator: 'Helsinki-Vantaa' → first try full, then 'Helsinki'
    Falls back to the original value if no match found.
    """
    if not s:
        return s
    s = str(s).strip()
    fwd, rev = _airport_rev()

    # 1. Bare 3-letter code (valid in our map or plausible IATA)
    up = s.upper()
    if re.match(r'^[A-Z]{3}$', up):
        return up  # trust Claude when it gives us a 3-letter code

    # 2. Code in parentheses: "Singapore (SIN)"
    m = re.search(r'\(([A-Z]{3})\)\s*$', up)
    if m and m.group(1) in fwd:
        return m.group(1)

    # 3. Embedded bare code: "Paris CDG", "CDG –"
    for token in re.findall(r'\b([A-Z]{3})\b', up):
        if token in fwd:
            return token

    # 4. Exact display name lookup (case-insensitive)
    clean = s.lower().strip()
    if clean in rev:
        return rev[clean]

    # 5. Strip trailing noise words and retry
    suffixes = (
        ' international airport', ' international', ' airport',
        ' intl.', ' intl', ' arpt',
    )
    for suffix in suffixes:
        if clean.endswith(suffix):
            base = clean[:-len(suffix)].strip()
            if base in rev:
                return rev[base]

    # 6. First word (handles "Singapore Changi" → "singapore" → SIN,
    #    "Melbourne Tullamarine" → "melbourne" → MEL)
    first = clean.split()[0]
    if first != clean and first in rev:
        return rev[first]

    # 7. Part before a hyphen/dash ("Helsinki-Vantaa" → "Helsinki")
    m = re.match(r'^([^–—\-]+)', clean)
    if m:
        city = m.group(1).strip()
        if city and city != clean and city in rev:
            return rev[city]

    # 8. Primary-airport overrides for cities with multiple airports where one
    #    is the clear international gateway.  Only reached when all above fail.
    _PRIMARY = {
        "paris": "CDG", "london": "LHR", "new york": "JFK",
        "chicago": "ORD", "los angeles": "LAX", "tokyo": "NRT",
        "moscow": "SVO", "milan": "MXP", "rome": "FCO",
        "amsterdam": "AMS", "frankfurt": "FRA", "dubai": "DXB",
        "istanbul": "IST", "bangkok": "BKK",
    }
    if clean in _PRIMARY:
        return _PRIMARY[clean]

    return s  # can't confidently normalise — leave as-is


def _norm_name_fuzzy(s: str) -> str:
    """Normalise a venue/item name for fuzzy comparison.

    Strips common meal/event prefixes ('Dinner - ', 'Lunch at ') that get
    added manually but may be absent in imported booking data.
    """
    s = re.sub(
        r'^(?:Dinner|Lunch|Breakfast|Brunch|Supper|Déjeuner|Dîner)\s*[-–:]\s*',
        '', str(s).strip(), flags=re.IGNORECASE,
    )
    s = re.sub(
        r'^(?:Dinner|Lunch|Breakfast|Brunch|Supper)\s+(?:at|@)\s+',
        '', s, flags=re.IGNORECASE,
    )
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', s.lower())).strip()


def _fuzzy_name_match(a: str, b: str) -> bool:
    """Return True if two item names refer to the same place/event.

    Accepts if one normalised name contains the other, or if word-level
    Jaccard similarity ≥ 0.5 (ignoring very short words).
    """
    na, nb = _norm_name_fuzzy(a), _norm_name_fuzzy(b)
    if not na or not nb:
        return False
    if na == nb or na in nb or nb in na:
        return True
    wa = {w for w in na.split() if len(w) > 2}
    wb = {w for w in nb.split() if len(w) > 2}
    if wa and wb:
        return len(wa & wb) / len(wa | wb) >= 0.5
    return False


def _within_hours(t1: str, t2: str, hours: float = 2.0) -> bool:
    """True if two ISO datetime strings are within `hours` of each other."""
    if not t1 or not t2:
        return True  # no time on one side → don't reject on time alone
    try:
        from datetime import datetime as _dt
        diff = abs((_dt.fromisoformat(t1[:16]) - _dt.fromisoformat(t2[:16])).total_seconds())
        return diff <= hours * 3600
    except Exception:
        return True


def _norm_terminal(s: str) -> str:
    """Strip 'Terminal ' / 'T' prefix so we store just the designator ('2B', '1', 'F').

    The FlightDetailModal display already prepends 'T', so storing the bare
    designator avoids 'TTerminal 2B' and keeps diffs clean.

    Rejects values that are IATA airport codes (3-letter alpha like 'CDG', 'SIN')
    — Claude sometimes puts the destination airport code in the terminal field.
    """
    if not s:
        return s
    s = str(s).strip()
    # Reject plain 3-letter airport codes (e.g. "CDG", "HEL", "SIN")
    if re.match(r'^[A-Z]{3}$', s.upper()):
        from ..pdf_export import _airport_map
        if s.upper() in _airport_map():
            return ""   # not a terminal designator
    # "Terminal 2B", "terminal 2b" → "2B"
    no_prefix = re.sub(r'^[Tt]erminal\s+', '', s).strip()
    if no_prefix != s.strip():          # the prefix was actually removed
        return no_prefix.upper() if no_prefix else ""

    # "T2B", "t1" → "2B", "1"  (single T followed by alphanumeric designator)
    m = re.match(r'^[Tt]([A-Z0-9].*)$', s, re.IGNORECASE)
    if m:
        return m.group(1).upper()
    return s.upper()


def _norm_aircraft(s: str) -> str:
    """Canonicalise aircraft name: strip manufacturer prefix, apply lookup table.

    Prefers the more detailed designation — e.g. 'A330-200' beats 'A330'.
    """
    if not s:
        return s
    stripped = _AIRCRAFT_MFR.sub('', str(s).strip())
    canonical = _AIRCRAFT_LOOKUP.get(stripped.lower())
    return canonical if canonical else stripped


_NORMALIZERS = {
    "flight_number":    _norm_flight_number,
    "train_number":     _norm_flight_number,
    "duration":         _norm_duration,
    "aircraft":         _norm_aircraft,
    "origin":           _norm_iata,
    "destination":      _norm_iata,
    "origin_terminal":  _norm_terminal,
    "arrive_terminal":  _norm_terminal,
}


def _aircraft_is_more_specific(new_val: str, old_val: str) -> bool:
    """Return True if new_val is strictly more specific than old_val.

    'A330-200' is more specific than 'A330'; 'A330' is not more specific than 'A330-200'.
    Used so a vaguer re-import doesn't overwrite a detailed stored value.
    """
    n, o = new_val.upper(), old_val.upper()
    if n == o:
        return False
    # new starts with old → new is a variant/extension of old → more specific
    return n.startswith(o) or (len(n) > len(o) and o in n)


def _normalize_details(details: dict) -> dict:
    """Apply field-level normalizers to a details dict in-place and return it."""
    for k, fn in _NORMALIZERS.items():
        if k in details and details[k]:
            details[k] = fn(details[k])
    return details


def _match_existing(session, trip_id, kind, details, all_stop_ids=None,
                    name: str = "", scheduled_at: str = ""):
    """Find an existing item this extraction most likely updates, or None.

    Primary match  — flight/train number + departure date (strongest signal).
    Fallback match — origin + destination (+ date if available) when no number
                     was extracted from the document.

    When trip_id is None (email ingest) and all_stop_ids is provided, searches
    across all those stops so imports still match even when Claude can't assign
    a stop.
    """
    from ..models import ItineraryItem, Stop

    if trip_id:
        stop_ids = [s.id for s in session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()]
    elif all_stop_ids:
        stop_ids = list(all_stop_ids)
    else:
        return None

    if not stop_ids:
        return None

    items = session.exec(select(ItineraryItem).where(ItineraryItem.stop_id.in_(stop_ids))).all()

    def norm(v):
        return (str(v or "")).replace(" ", "").upper()

    if kind in ("flight", "rail"):
        key = "flight_number" if kind == "flight" else "train_number"
        num = norm(details.get(key))
        dd = _datepart(details.get("depart_time"))

        if num:
            # Primary: match on flight/train number (+ date when available)
            for it in items:
                if it.kind != kind:
                    continue
                d = it.details or {}
                if norm(d.get(key)) == num and (not dd or _datepart(d.get("depart_time")) == dd):
                    return it

            # Fallback: match on numeric portion only so '17756' matches 'TER 17756'.
            # Rail operators often prefix numbers with service codes (TER, IC, MOBIGO)
            # that may or may not be present across different booking sources.
            import re as _re
            num_digits = _re.sub(r'[^0-9]', '', num)
            if num_digits and len(num_digits) >= 4:   # avoid matching short ambiguous numbers
                for it in items:
                    if it.kind != kind:
                        continue
                    d = it.details or {}
                    it_digits = _re.sub(r'[^0-9]', '', norm(d.get(key) or ''))
                    if it_digits == num_digits and (not dd or _datepart(d.get("depart_time")) == dd):
                        return it

        # Fallback: match on origin + destination (+ date when available).
        # Only used when the document didn't contain a flight number.
        orig = norm(details.get("origin"))
        dest = norm(details.get("destination"))
        if orig and dest and not num:
            candidates = []
            for it in items:
                if it.kind != kind:
                    continue
                d = it.details or {}
                if norm(d.get("origin")) == orig and norm(d.get("destination")) == dest:
                    if not dd or _datepart(d.get("depart_time")) == dd:
                        candidates.append(it)
            # Only match if unambiguous (single candidate)
            if len(candidates) == 1:
                return candidates[0]

    elif kind == "accommodation":
        ci = _datepart(details.get("checkin"))
        if not ci:
            return None
        for it in items:
            if it.kind != "accommodation":
                continue
            if _datepart((it.details or {}).get("checkin")) == ci:
                return it

    elif kind in ("transfer", "river_transfer", "restaurant", "tour", "show"):
        # Primary: booking_ref (normalised — strip spaces/dashes)
        def norm_ref(v):
            return re.sub(r'[\s\-]', '', str(v or '')).upper()

        ref = norm_ref(details.get("booking_ref"))
        if ref:
            for it in items:
                if it.kind != kind:
                    continue
                if norm_ref((it.details or {}).get("booking_ref")) == ref:
                    return it

        # Fallback for transfer/river_transfer: depart_time + start/end location
        if kind in ("transfer", "river_transfer"):
            dt = _datepart(details.get("depart_time"))
            orig = norm(details.get("start_location") or details.get("origin") or "")
            dest = norm(details.get("end_location") or details.get("destination") or "")
            if dt and (orig or dest):
                for it in items:
                    if it.kind != kind:
                        continue
                    d = it.details or {}
                    it_dt = _datepart(d.get("depart_time"))
                    it_orig = norm(d.get("start_location") or d.get("origin") or "")
                    it_dest = norm(d.get("end_location") or d.get("destination") or "")
                    if it_dt == dt and it_orig == orig and it_dest == dest:
                        return it

        # Fallback for restaurant / show / activity:
        # fuzzy name match + optional 2-hour time window.
        # The time window is deliberately permissive when one side has no time
        # (entries are often created before a reservation is confirmed).
        if kind in ("restaurant", "show", "activity", "tour"):
            new_time = (details.get("reservation_time") or details.get("depart_time")
                        or scheduled_at or "")
            for it in items:
                if it.kind != kind:
                    continue
                if not _fuzzy_name_match(name, it.name or ""):
                    continue
                d = it.details or {}
                it_time = (d.get("reservation_time") or d.get("depart_time")
                           or (it.scheduled_at.isoformat() if it.scheduled_at else ""))
                if _within_hours(new_time, it_time, hours=2.0):
                    return it

    return None


# Fields whose values are per-person arrays (or legacy strings) — merged rather than
# replaced when a second confirmation for the same transport arrives.
_PASSENGER_FIELDS = {"passengers", "participants"}


_TITLE_RE = re.compile(r'\b(?:Mr|Mrs|Ms|Dr|Miss|Mx|Master)\.?\b', re.IGNORECASE)


def _norm_name(s: str) -> str:
    """Normalise a passenger name for matching.

    Handles both 'Firstname Lastname' and surname-first 'Lastname Firstname Title'
    formats by:
      1. Stripping titles anywhere in the string
      2. Reducing to exactly two tokens (dropping middle names)
      3. Sorting the two tokens so order doesn't affect the match key

    'Mr Antony Wuth', 'Wuth Antony Mr', 'Antony Wuth' all produce 'antony wuth'.
    """
    s = _TITLE_RE.sub('', str(s).strip())
    s = re.sub(r'\s+', ' ', s).lower().strip()
    parts = [p for p in s.split() if p]
    if not parts:
        return s
    if len(parts) == 1:
        return parts[0]
    # Reduce to first + last, then sort so name order doesn't matter
    first, last = parts[0], parts[-1]
    return ' '.join(sorted([first, last]))


def _merge_passengers_array(existing: list, new: list) -> list:
    """Merge two passenger/participant arrays, matching by name and filling missing sub-fields."""
    result = [dict(p) for p in (existing or [])]
    name_idx = {_norm_name(p.get('name', '')): i for i, p in enumerate(result) if p.get('name')}
    for new_p in (new or []):
        if not isinstance(new_p, dict):
            continue
        new_name = _norm_name(new_p.get('name', ''))
        if new_name and new_name in name_idx:
            idx = name_idx[new_name]
            for k, v in new_p.items():
                if v is not None and v != '' and not result[idx].get(k):
                    result[idx][k] = v
        elif new_p.get('name'):
            result.append(dict(new_p))
            name_idx[new_name] = len(result) - 1
    return result


def _merge_field(existing_val, new_val):
    """Merge two passenger/participant values.

    New format: both are lists → merge arrays by name.
    Mixed: new is a list, old is a string → replace (migrate to array format).
    Legacy: both strings → simple comma-dedup.
    """
    if isinstance(new_val, list):
        ex_list = existing_val if isinstance(existing_val, list) else []
        return _merge_passengers_array(ex_list, new_val)
    if isinstance(existing_val, list):
        return existing_val  # keep existing array; new string value is ignored
    # Legacy string-vs-string dedup
    parts = [p.strip() for p in str(existing_val).split(",") if p.strip()]
    for part in str(new_val).split(","):
        p = part.strip()
        if p and p not in parts:
            parts.append(p)
    return ", ".join(parts)


def _val_eq(a, b) -> bool:
    """Equality check that handles lists correctly."""
    if isinstance(a, list) or isinstance(b, list):
        return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)
    return str(a or "") == str(b or "")


def _compute_diff(existing, item: dict) -> dict:
    """before/after of the fields this extraction would change on an existing item.

    For passengers/participants, values are merged (array-aware) so a second
    confirmation for the same transport adds to rather than replaces existing data.
    """
    before, after = {}, {}
    old_d = existing.details or {}
    new_d = item.get("details") or {}
    # Detail fields where the existing value is trusted over re-imports:
    # location is often manually curated; description is LLM-generated prose.
    # origin/destination are defining identifiers for transport legs — if already
    # set they must not be overwritten by a connection booking that shows the
    # overall route rather than individual segment origins/destinations.
    # Times are protected by the prompt rule ("only explicit times") rather than
    # here — keeping them in _KEEP_EXISTING causes all diffs to be empty when
    # the booking confirmation doesn't show individual segment times.
    _KEEP_EXISTING = {"description", "location", "start_location", "end_location",
                      "origin", "destination"}

    for k, nv in new_d.items():
        if nv in (None, "", []):
            continue
        ov = old_d.get(k)
        if k in _KEEP_EXISTING and ov:
            continue
        # Normalise both sides so formatting differences don't generate noise.
        norm = _NORMALIZERS.get(k)
        ov_cmp = norm(ov) if (norm and ov) else ov
        nv_cmp = norm(nv) if norm else nv
        if _val_eq(ov_cmp, nv_cmp):
            continue
        # For aircraft: only update if the new value is strictly more specific.
        # 'A330' won't overwrite 'A330-200', but 'A330-200' will fill in 'A330'.
        if k == "aircraft" and ov_cmp and nv_cmp and not _aircraft_is_more_specific(str(nv_cmp), str(ov_cmp)):
            continue
        if k in _PASSENGER_FIELDS:
            merged = _merge_field(ov, nv) if ov else nv
            if _val_eq(ov, merged):
                continue  # merge added nothing new — don't flag as changed
            before[k] = ov
            after[k] = merged
        else:
            before[k] = ov
            after[k] = nv_cmp  # store normalised value
    for f in ("name", "cost", "link", "notes"):
        nv = item.get(f)
        if not nv:
            continue
        ov = getattr(existing, f, "")
        # notes is LLM-generated prose — re-importing the same email will always
        # produce slightly different wording. Skip it if the record already has notes.
        if f == "notes" and ov:
            continue
        if str(ov or "") != str(nv):
            before[f] = ov
            after[f] = nv
    return {"before": before, "after": after}


def _attachments_from_eml(raw: bytes):
    """[(filename, content_type, bytes), …] for every real attachment in a message."""
    msg = message_from_bytes(raw, policy=email_default)
    out = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        fn = part.get_filename()
        if not fn:
            continue
        try:
            data = part.get_payload(decode=True)
        except Exception:
            data = None
        if data:
            out.append((fn, part.get_content_type(), data))
    return out


def build_pending_changes(session, user_email, trip_id, stops, parsed,
                          source="upload", source_email_id=None):
    """Turn a parsed multi-item result into PendingChange rows (with update-matching)."""
    from .pending import create_pending_from_parse
    kinds = [k.value for k in ItemKind]
    stop_ids = {s.id for s in stops}

    raw_items = parsed.get("items")
    if not isinstance(raw_items, list):
        # Tolerate the legacy single-object shape.
        raw_items = [parsed] if parsed.get("kind") else []

    created = []
    # dedup key → index in `created` so we can merge per-passenger data from
    # a second document covering the same booking (different passenger e-ticket).
    _seen_key_idx: dict = {}

    def _item_key(kind, details, payload):
        """Stable dedup key for an extracted item.

        For flight/rail: always includes the flight/train number so that two
        legs on the same booking (sharing a booking_ref) are NOT collapsed —
        only truly duplicate extractions of the *same* leg are deduplicated.
        """
        d = details or {}
        ref = re.sub(r'[\s\-]', '', str(d.get("booking_ref") or "")).upper()

        if kind in ("flight", "rail"):
            num_key = "flight_number" if kind == "flight" else "train_number"
            num = re.sub(r'[\s]', '', str(d.get(num_key) or "")).upper()
            date = _datepart(d.get("depart_time") or "")
            # Primary: flight/train number + date (ignores booking_ref intentionally)
            if num and date:
                return (kind, num, date)
            if num:
                return (kind, num, ref)
            # No flight number known — fall back to ref + date
            if ref and date:
                return (kind, ref, date)

        elif kind == "accommodation":
            # A multi-night stay (e.g. a cruise broken into one item per night)
            # legitimately shares ONE booking_ref across many nights — date-scope
            # the ref so nights aren't collapsed into a single dedup key.
            ci = _datepart(d.get("checkin"))
            if ref and ci:
                return (kind, ref, ci)
            if ref:
                return (kind, ref)

        elif ref:
            return (kind, ref)

        # Generic fallback: kind + primary date + route/name
        date = _datepart(d.get("depart_time") or d.get("checkin") or
                         d.get("reservation_time") or payload.get("scheduled_at") or "")
        route = (str(d.get("origin") or d.get("start_location") or "") + "→" +
                 str(d.get("destination") or d.get("end_location") or "")).upper().replace(" ", "")
        name_key = re.sub(r'\W', '', str(payload.get("name") or "")).upper()[:20]
        return (kind, date, route or name_key)

    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        kind = raw.get("kind")
        if kind not in kinds:
            kind = "note"
        details = raw.get("details")
        if not isinstance(details, dict):
            details = {}
        # Canonicalise timezones to GMT±X (the format the rest of the app uses).
        if kind in ("flight", "rail"):
            if details.get("depart_tz"):
                details["depart_tz"] = _normalize_tz(details["depart_tz"], details.get("depart_time"))
            if details.get("arrive_tz"):
                details["arrive_tz"] = _normalize_tz(details["arrive_tz"], details.get("arrive_time"))
        # Normalise values that Claude formats inconsistently across runs.
        _normalize_details(details)
        matched = raw.get("matched_stop_id")
        if not isinstance(matched, int) or matched not in stop_ids:
            matched = None

        # For flights/rail build the name from IATA codes via the airport map so
        # codes Claude includes ("Paris CDG → Doha DOH") are stripped to city names.
        if kind in ("flight", "rail"):
            orig = details.get("origin") or details.get("start_location")
            dest = details.get("destination") or details.get("end_location")
            if orig and dest:
                amap = _airport_map()
                raw_name = f"{amap.get(str(orig).strip().upper(), str(orig).strip())} → {amap.get(str(dest).strip().upper(), str(dest).strip())}"
            else:
                raw_name = (raw.get("name") or "Imported item").strip()
        else:
            raw_name = (raw.get("name") or "Imported item").strip()

        item = {
            "kind": kind,
            "name": raw_name,
            "scheduled_at": raw.get("scheduled_at") or None,
            "cost": raw.get("cost") or "",
            "link": raw.get("link") or "",
            "notes": raw.get("notes") or "",
            "details": details,
        }

        # Derive trip_id from the matched stop when the caller didn't provide one
        # (e.g. email ingest passes trip_id=None but provides all user stops).
        effective_trip_id = trip_id
        if effective_trip_id is None and matched:
            stop_obj = session.get(Stop, matched)
            if stop_obj:
                effective_trip_id = stop_obj.trip_id

        # For transit/connecting flights whose departure city isn't a trip stop,
        # Claude may match to the destination stop. Correct this by finding the
        # last stop (by depart date) that is on or before the flight's departure —
        # that is the stop the traveller was at before this transit segment.
        if kind in ("flight", "rail") and matched and stops:
            dep_str = details.get("depart_time") or ""
            dep_date = _datepart(dep_str)
            if dep_date:
                matched_stop = session.get(Stop, matched)
                if matched_stop:
                    from datetime import date as _date
                    try:
                        dep_d = _date.fromisoformat(dep_date)
                    except ValueError:
                        dep_d = None
                    if dep_d and matched_stop.arrive:
                        arr_d = matched_stop.arrive.date() if hasattr(matched_stop.arrive, "date") else None
                        # If Claude picked a stop whose arrive date is AFTER the flight departs,
                        # it chose a future/destination stop — find the correct departing stop.
                        if arr_d and arr_d > dep_d:
                            best = None
                            for st in stops:
                                if st.depart is None:
                                    continue
                                st_dep = st.depart.date() if hasattr(st.depart, "date") else None
                                if st_dep and st_dep <= dep_d:
                                    if best is None or st_dep > (best.depart.date() if hasattr(best.depart, "date") else _date.min):
                                        best = st
                            if best and best.id != matched:
                                matched = best.id
                                if effective_trip_id is None:
                                    effective_trip_id = best.trip_id

        # Pass all user stops so route-based fallback matching works even when
        # trip_id is unknown (e.g. email ingest without a matched stop).
        existing = _match_existing(session, effective_trip_id, kind, details,
                                   all_stop_ids=stop_ids if not effective_trip_id else None,
                                   name=item.get("name", ""),
                                   scheduled_at=item.get("scheduled_at", ""))
        # If the fallback route-match found an item, derive the trip from it.
        if existing and not effective_trip_id:
            src_stop = session.get(Stop, existing.stop_id)
            if src_stop:
                effective_trip_id = src_stop.trip_id
        op = "update" if existing else "create"
        target_id = existing.id if existing else None
        diff = _compute_diff(existing, item) if existing else None
        # If matched but the item lands on a different stop, keep the existing stop.
        suggested_stop = (existing.stop_id if existing else None) or matched

        # Skip when matched but nothing has changed — the record is already up to date.
        if existing and diff is not None and not diff.get("after") and not diff.get("before"):
            continue

        # Deduplicate same-booking items: merge per-passenger data rather than
        # dropping the second document outright.
        ikey = _item_key(kind, details, item)
        if ikey in _seen_key_idx:
            # Merge passengers from this document into the already-created PC.
            prior_idx = _seen_key_idx[ikey]
            if prior_idx < len(created):
                prior_pc = created[prior_idx]
                prior_d = (prior_pc.payload or {}).get("details") or {}
                new_pax = details.get("passengers")
                if isinstance(new_pax, list) and isinstance(prior_d.get("passengers"), list):
                    merged_pax = _merge_passengers_array(prior_d["passengers"], new_pax)
                    if merged_pax != prior_d["passengers"]:
                        prior_d["passengers"] = merged_pax
                        prior_pc.payload["details"] = prior_d
                        from sqlalchemy.orm.attributes import flag_modified as _fm
                        _fm(prior_pc, "payload")
                        session.add(prior_pc)
                        session.commit()
            continue
        _seen_key_idx[ikey] = len(created)

        pc = create_pending_from_parse(
            session, user_email, effective_trip_id, item, suggested_stop,
            confidence=raw.get("confidence") or "low",
            match_reason=raw.get("match_reason") or "",
            op=op, target_item_id=target_id, diff=diff,
            source=source, source_email_id=source_email_id,
        )
        created.append(pc)
    return created


def _merge_document_sources(file_tuples: list) -> tuple:
    """Combine text and PDFs from multiple (filename, content_type, bytes) tuples.

    Returns (combined_text: str | None, pdf_b64s: list[str]).
    Text sections are joined with a '--- DOCUMENT ---' separator so Claude
    sees each document's content clearly delineated.
    """
    texts: list = []
    pdf_b64s: list = []
    for name, ctype, raw in file_tuples:
        name = (name or "").lower()
        ctype = (ctype or "").lower()
        if name.endswith(".pdf") or "pdf" in ctype:
            pdf_b64s.append(base64.standard_b64encode(raw).decode())
        elif name.endswith(".eml") or ctype in ("message/rfc822",):
            t = _text_from_eml(raw)
            if t and t.strip():
                texts.append(t.strip())
            pdf_b64s.extend(
                base64.standard_b64encode(data).decode()
                for fn, ct, data in _attachments_from_eml(raw)
                if fn.lower().endswith(".pdf") or "pdf" in (ct or "")
            )
        else:
            text = raw.decode("utf-8", "replace")
            if "<html" in text.lower() or name.endswith((".html", ".htm")):
                text = _strip_html(text)
            if text and text.strip():
                texts.append(text.strip())

    combined = "\n\n--- DOCUMENT ---\n\n".join(texts) if texts else None
    if combined:
        combined = combined[:_MAX_TEXT_CHARS]
    return combined, pdf_b64s


@router.post("/trips/{trip_id}/parse-document")
async def parse_document(
    trip_id: int,
    files: list[UploadFile] = File(...),
    force: bool = False,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    require_trip_role(session, user, trip_id, TripRole.editor)
    if not _ANTHROPIC_KEY:
        raise HTTPException(status_code=503, detail="Document parsing not configured (set ANTHROPIC_API_KEY)")

    file_tuples = []
    for file in files:
        raw = await file.read()
        if raw:
            file_tuples.append((file.filename, file.content_type, raw))

    if not file_tuples:
        raise HTTPException(status_code=400, detail="No files provided or all files are empty")

    # Check whether we've already processed these exact bytes for this trip.
    raw_bytes = [raw for _, _, raw in file_tuples]
    cache_key  = _doc_cache_key(trip_id, raw_bytes)
    cached     = None if force else _check_doc_cache(session, cache_key)
    if cached:
        raise HTTPException(
            status_code=422,
            detail=(
                f"This document has already been imported "
                f"(processed {cached['processed_at'].strftime('%d %b %Y %H:%M')} UTC, "
                f"{cached['item_count']} item(s) created). "
                f"No API call made."
            ),
        )

    doc_text, pdf_b64s = _merge_document_sources(file_tuples)

    if not doc_text and not pdf_b64s:
        raise HTTPException(status_code=400, detail="No readable content found in the uploaded files")

    stops = session.exec(
        select(Stop).where(Stop.trip_id == trip_id).order_by(Stop.sort_order)
    ).all()
    kinds = [k.value for k in ItemKind]

    parsed = _call_claude(_build_prompt(stops, kinds), pdf_b64s, doc_text)

    # Persist each extracted item as a pending change (with update-matching).
    raw_item_count = len(parsed.get("items", [])) if isinstance(parsed.get("items"), list) else 0
    pcs = build_pending_changes(session, user["email"], trip_id, stops, parsed)
    if not pcs:
        if raw_item_count > 0:
            _record_doc_cache(session, cache_key, trip_id=trip_id, item_count=0)
            raise HTTPException(
                status_code=422,
                detail=f"Already up to date — {raw_item_count} item(s) found but all are already recorded with no new information.",
            )
        raise HTTPException(status_code=422, detail="No itinerary items found in that document")
    _record_doc_cache(session, cache_key, trip_id=trip_id, item_count=len(pcs))
    from ..metrics import pending_created as _pc_metric
    for pc in pcs:
        _pc_metric.labels(op=pc.op, kind=str(pc.kind).split(".")[-1]).inc()

    return {
        "count": len(pcs),
        "pending": [
            {"id": pc.id, "kind": pc.kind, "name": (pc.payload or {}).get("name"), "op": pc.op}
            for pc in pcs
        ],
    }
