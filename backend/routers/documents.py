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

router = APIRouter()

_ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_MODEL = "claude-sonnet-4-6"
_MAX_TEXT_CHARS = 60_000  # bound token usage on huge HTML emails

# Detail-key hints per kind, mirroring the keys the edit forms read/write so the
# created record displays correctly. Times are local "YYYY-MM-DDTHH:MM".
_DETAIL_HINTS = {
    "rail": "origin, destination, train_number, operator, depart_time, arrive_time, "
            "depart_platform, arrive_platform, duration, rail_class, coach, seats, meal, "
            "passengers, loyalty_info, booking_ref, booking_phone",
    "flight": "origin, destination (IATA codes), flight_number, airline, depart_time, arrive_time, "
              "origin_terminal, arrive_terminal, origin_gate, arrive_gate, checkin_desk, depart_tz, "
              "arrive_tz, duration, seats, layover, connects_to, aircraft, fare_class, baggage, meal, "
              "passengers, loyalty_info, booking_ref, booking_airline, booking_phone",
    "accommodation": "location, checkin, checkout, booking_ref, contact_phone, contact_email, description",
    "transfer": "start_location, end_location, depart_time, arrive_time, duration, distance, provider, booking_ref",
    "tour": "meeting_point, reservation_time, duration, description, contact_phone, booking_ref",
    "activity": "location, description, duration, contact_phone, contact_email",
    "show": "location (venue), tickets (ticket numbers), seats, duration, booking_ref, description, contact_phone",
    "restaurant": "location, reservation_time, description, contact_phone, contact_email",
    "food": "description",
    "purchase": "location, description",
    "note": "description",
    "walk": "start_location, end_location, distance, description",
    "cycling": "start_location, end_location, distance, description",
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
        if part.get_filename():
            continue  # skip attachments
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

The trip has these stops (match each item to the most likely one by location AND date):
{json.dumps(stop_lines, indent=2)}

Choose each `kind` from this exact list: {", ".join(kinds)}

For `details`, use these snake_case keys per kind (include only those you can fill):
{hints}

Rules (apply per item):
- Times are LOCAL wall-clock, formatted "YYYY-MM-DDTHH:MM" (no timezone suffix). For flights/rail, depart_time uses the origin's local time and arrive_time the destination's local time.
- depart_tz / arrive_tz must be fixed UTC-offset strings in the form "GMT+8", "GMT-5", or "GMT+5:30" — the offset actually in effect at that place on that date. Never use city names or IANA zone names (no "Asia/Singapore", no "Helsinki").
- `scheduled_at` is the item's primary time: departure for transport, check-in for accommodation, start time otherwise. Same format, or null if unknown.
- `name` is a short human label, e.g. "Singapore → Helsinki" for transport or the hotel/venue name.
- `cost` is the total price as a plain string with currency symbol if present, e.g. "€48.00"; "" if unknown. If one price covers the whole booking, put it on the first item only and leave the others "".
- `link` is a booking/management URL if present, else "".
- `notes` is free text for anything important with no dedicated field, else "".
- `matched_stop_id` is the integer id of the best-matching stop above, or null if none clearly fits.
- `confidence` is "high", "medium", or "low" for that item.
- `match_reason` is one short sentence explaining the stop choice (or why none matched).

Respond with ONLY a JSON object, no markdown fences, no commentary:
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


def _call_claude(prompt: str, pdf_b64: str | None, doc_text: str | None) -> dict:
    import anthropic

    client = anthropic.Anthropic(api_key=_ANTHROPIC_KEY)
    content: list = []
    if pdf_b64:
        content.append({
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64},
        })
    content.append({"type": "text", "text": prompt})
    if doc_text:
        content.append({"type": "text", "text": f"\n\n--- DOCUMENT ---\n{doc_text}"})

    try:
        resp = client.messages.create(
            model=_MODEL,
            max_tokens=8000,
            thinking={"type": "adaptive"},
            output_config={"effort": "medium"},
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIStatusError as e:
        raise HTTPException(status_code=502, detail=f"Claude API error: {e.message}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Claude request failed: {e}")

    if resp.stop_reason == "refusal":
        raise HTTPException(status_code=422, detail="The parser declined to process this document.")

    text = next((b.text for b in resp.content if b.type == "text"), "").strip()
    # Tolerate stray code fences just in case.
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Could not parse the extraction result.")


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


def _match_existing(session, trip_id, kind, details):
    """Find an existing item this extraction most likely updates, or None.

    Flights match on flight_number + departure date, rail on train_number + date,
    accommodation on check-in date. Conservative on purpose — a wrong match would
    silently overwrite a good record, so we only match on strong identifiers.
    """
    from ..models import ItineraryItem, Stop
    if not trip_id:
        return None
    stop_ids = [s.id for s in session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()]
    if not stop_ids:
        return None
    items = session.exec(select(ItineraryItem).where(ItineraryItem.stop_id.in_(stop_ids))).all()

    def norm(v):
        return (str(v or "")).replace(" ", "").upper()

    if kind in ("flight", "rail"):
        key = "flight_number" if kind == "flight" else "train_number"
        num = norm(details.get(key))
        if not num:
            return None
        dd = _datepart(details.get("depart_time"))
        for it in items:
            if it.kind != kind:
                continue
            d = it.details or {}
            if norm(d.get(key)) == num and (not dd or _datepart(d.get("depart_time")) == dd):
                return it
    elif kind == "accommodation":
        ci = _datepart(details.get("checkin"))
        if not ci:
            return None
        for it in items:
            if it.kind != "accommodation":
                continue
            if _datepart((it.details or {}).get("checkin")) == ci:
                return it
    return None


def _compute_diff(existing, item: dict) -> dict:
    """before/after of the fields this extraction would change on an existing item."""
    before, after = {}, {}
    old_d = existing.details or {}
    new_d = item.get("details") or {}
    for k, nv in new_d.items():
        if nv in (None, "", []):
            continue
        ov = old_d.get(k)
        if str(ov or "") != str(nv):
            before[k] = ov
            after[k] = nv
    for f in ("name", "cost", "link", "notes"):
        nv = item.get(f)
        if not nv:
            continue
        ov = getattr(existing, f, "")
        if str(ov or "") != str(nv):
            before[f] = ov
            after[f] = nv
    return {"before": before, "after": after}


def build_pending_changes(session, user_email, trip_id, stops, parsed):
    """Turn a parsed multi-item result into PendingChange rows (with update-matching)."""
    from .pending import create_pending_from_parse
    kinds = [k.value for k in ItemKind]
    stop_ids = {s.id for s in stops}

    raw_items = parsed.get("items")
    if not isinstance(raw_items, list):
        # Tolerate the legacy single-object shape.
        raw_items = [parsed] if parsed.get("kind") else []

    created = []
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
        matched = raw.get("matched_stop_id")
        if not isinstance(matched, int) or matched not in stop_ids:
            matched = None

        item = {
            "kind": kind,
            "name": (raw.get("name") or "Imported item").strip(),
            "scheduled_at": raw.get("scheduled_at") or None,
            "cost": raw.get("cost") or "",
            "link": raw.get("link") or "",
            "notes": raw.get("notes") or "",
            "details": details,
        }

        existing = _match_existing(session, trip_id, kind, details)
        op = "update" if existing else "create"
        target_id = existing.id if existing else None
        diff = _compute_diff(existing, item) if existing else None
        # If matched but the item lands on a different stop, keep the existing stop.
        suggested_stop = (existing.stop_id if existing else None) or matched

        pc = create_pending_from_parse(
            session, user_email, trip_id, item, suggested_stop,
            confidence=raw.get("confidence") or "low",
            match_reason=raw.get("match_reason") or "",
            op=op, target_item_id=target_id, diff=diff,
        )
        created.append(pc)
    return created


@router.post("/trips/{trip_id}/parse-document")
async def parse_document(
    trip_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    require_trip_role(session, user, trip_id, TripRole.editor)
    if not _ANTHROPIC_KEY:
        raise HTTPException(status_code=503, detail="Document parsing not configured (set ANTHROPIC_API_KEY)")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")

    name = (file.filename or "").lower()
    ctype = (file.content_type or "").lower()
    pdf_b64 = doc_text = None

    if name.endswith(".pdf") or "pdf" in ctype:
        pdf_b64 = base64.standard_b64encode(raw).decode()
    elif name.endswith(".eml") or ctype in ("message/rfc822",):
        doc_text = _text_from_eml(raw)
    else:
        text = raw.decode("utf-8", "replace")
        doc_text = _strip_html(text) if ("<html" in text.lower() or name.endswith((".html", ".htm"))) else text

    if doc_text is not None:
        doc_text = doc_text.strip()
        if not doc_text:
            raise HTTPException(status_code=400, detail="No readable text found in that document")
        doc_text = doc_text[:_MAX_TEXT_CHARS]

    stops = session.exec(
        select(Stop).where(Stop.trip_id == trip_id).order_by(Stop.sort_order)
    ).all()
    kinds = [k.value for k in ItemKind]

    parsed = _call_claude(_build_prompt(stops, kinds), pdf_b64, doc_text)

    # Persist each extracted item as a pending change (with update-matching).
    pcs = build_pending_changes(session, user["email"], trip_id, stops, parsed)
    if not pcs:
        raise HTTPException(status_code=422, detail="No itinerary items found in that document")

    return {
        "count": len(pcs),
        "pending": [
            {"id": pc.id, "kind": pc.kind, "name": (pc.payload or {}).get("name"), "op": pc.op}
            for pc in pcs
        ],
    }
