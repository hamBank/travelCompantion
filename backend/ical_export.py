"""Trip -> iCal (RFC 5545) feed, for the "subscribe in your calendar app" feature.

Served by GET /calendar/{token}.ics (backend/routers/calendar.py) with no login
required — the token itself (see backend/auth.py's create_ical_token /
verify_ical_token) is the only access control.

Timezone note (see CLAUDE.md's "Timezone handling" section for the general
rule): stored item times (scheduled_at, details.depart_time/arrive_time,
details.checkin/checkout) are already destination-local wall-clock values —
that's how the rest of the app treats them (e.g. notifications.py converts
them using the stop's tz/longitude before comparing to real UTC "now").
For this feed we deliberately emit them as FLOATING iCal times: no trailing
`Z`, no `TZID` parameter. A floating time renders as the *same* wall-clock
number in whatever timezone the calendar app/device is currently set to,
which is exactly what a traveler wants ("my flight departs at 14:30" should
still read 14:30 after they've flown across three time zones) — converting
to real UTC would require knowing each stop's IANA zone, which this app does
not reliably have (see the `timezone` column notes in CLAUDE.md), and would
show the wrong local time to a traveler whose device is still on their home
zone.
"""
import re
from datetime import date, datetime, timedelta
from typing import Optional

from sqlmodel import Session, select

from .models import ItemKind, ItineraryItem, Stop, Trip
from .pdf_export import _KIND_LABEL, _to_dt

_PRODID = "-//Travel Companion//iCal Export//EN"


# ── Field extraction ───────────────────────────────────────────────────────────

def _item_span(item: ItineraryItem):
    """Return (start, end, all_day) for this item's VEVENT, or None if it has
    no date at all (e.g. an undated note) — such items get no VEVENT.

    all_day=True means start/end are `date`s (checkin/checkout, exclusive end
    per RFC 5545). Otherwise start/end are naive (floating) `datetime`s.
    """
    d = item.details or {}

    if item.kind == ItemKind.accommodation:
        start_dt = _to_dt(d.get("checkin")) or _to_dt(item.scheduled_at)
        if not start_dt:
            return None
        end_dt = _to_dt(d.get("checkout"))
        start_date = start_dt.date()
        end_date = end_dt.date() if end_dt else None
        if not end_date or end_date <= start_date:
            end_date = start_date + timedelta(days=1)
        return (start_date, end_date, True)

    # Timed transport (flight/rail/river_transfer, and any other kind that
    # happens to carry depart_time/arrive_time) takes priority over
    # scheduled_at when present; everything else (activities, transfer,
    # tour, etc.) falls back to scheduled_at.
    start_dt = _to_dt(d.get("depart_time")) or _to_dt(item.scheduled_at)
    if not start_dt:
        return None
    end_dt = _to_dt(d.get("arrive_time"))
    if not end_dt or end_dt <= start_dt:
        end_dt = start_dt + timedelta(hours=1)
    return (start_dt, end_dt, False)


def _location_for(item: ItineraryItem) -> str:
    d = item.details or {}
    if item.kind in (ItemKind.flight, ItemKind.rail, ItemKind.transfer,
                     ItemKind.walk, ItemKind.cycling, ItemKind.river_transfer):
        start = d.get("origin") or d.get("start_location")
        end = d.get("destination") or d.get("end_location")
        parts = [p for p in (start, end) if p]
        if parts:
            return " - ".join(str(p) for p in parts)
    for key in ("location", "meeting_point"):
        if d.get(key):
            return str(d[key])
    return ""


def _description_for(item: ItineraryItem) -> str:
    d = item.details or {}
    parts = []
    if d.get("booking_ref"):
        parts.append(f"Booking ref: {d['booking_ref']}")
    provider = d.get("provider") or d.get("operator") or d.get("airline")
    if provider:
        parts.append(f"Provider: {provider}")
    if item.notes:
        parts.append(str(item.notes))
    return "\n".join(parts)


# ── ICS line encoding ──────────────────────────────────────────────────────────

def _escape_text(s: str) -> str:
    """Escape the RFC 5545 TEXT special characters: backslash, comma,
    semicolon, and newlines (encoded as the literal two-char sequence \\n)."""
    return (
        str(s)
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _fold(line: str) -> str:
    """Fold a content line so no physical line exceeds 75 octets (RFC 5545
    §3.1) — continuation lines are joined with CRLF + a single leading space.
    Cuts are kept on UTF-8 character boundaries (never split a multi-byte
    sequence) since the octet limit is measured on the encoded bytes."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    chunks = []
    limit = 75
    while len(raw) > limit:
        cut = limit
        # Back off until we're not in the middle of a multi-byte UTF-8 sequence
        # (continuation bytes have the top two bits set to 10).
        while cut > 0 and (raw[cut] & 0xC0) == 0x80:
            cut -= 1
        chunks.append(raw[:cut])
        raw = raw[cut:]
        limit = 74  # continuation lines get one octet "back" for the leading space
    chunks.append(raw)
    return ("\r\n ").join(c.decode("utf-8") for c in chunks)


def _prop(name: str, value: str, params: str = "") -> str:
    return _fold(f"{name}{params}:{_escape_text(value)}")


# ── VEVENT ──────────────────────────────────────────────────────────────────

def _vevent_lines(item: ItineraryItem) -> Optional[list]:
    span = _item_span(item)
    if span is None:
        return None
    start, end, all_day = span

    kind_label = _KIND_LABEL.get(item.kind, str(item.kind))
    summary = item.name or kind_label
    location = _location_for(item)
    description = _description_for(item)

    lines = [
        "BEGIN:VEVENT",
        f"UID:item-{item.id}@travelcompanion",
    ]
    if all_day:
        lines.append(f"DTSTART;VALUE=DATE:{start.strftime('%Y%m%d')}")
        lines.append(f"DTEND;VALUE=DATE:{end.strftime('%Y%m%d')}")
    else:
        # Floating local time: no trailing Z, no TZID — see module docstring.
        lines.append(f"DTSTART:{start.strftime('%Y%m%dT%H%M%S')}")
        lines.append(f"DTEND:{end.strftime('%Y%m%dT%H%M%S')}")
    lines.append(_prop("SUMMARY", summary))
    if location:
        lines.append(_prop("LOCATION", location))
    if description:
        lines.append(_prop("DESCRIPTION", description))
    lines.append("END:VEVENT")
    return lines


# ── Full feed ───────────────────────────────────────────────────────────────

def build_trip_ics(session: Session, trip_id: int, trip_name: str = "") -> bytes:
    """Build the full VCALENDAR feed for a trip, as UTF-8 bytes."""
    stops = session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{_PRODID}",
        "CALSCALE:GREGORIAN",
    ]
    if trip_name:
        lines.append(_prop("X-WR-CALNAME", trip_name))

    for stop in stops:
        items = session.exec(
            select(ItineraryItem).where(ItineraryItem.stop_id == stop.id)
        ).all()
        for item in items:
            ev = _vevent_lines(item)
            if ev:
                lines.extend(ev)

    lines.append("END:VCALENDAR")
    return ("\r\n".join(lines) + "\r\n").encode("utf-8")
