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
from email import message_from_bytes
from email.policy import default as email_default

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
    return f"""You are parsing a single travel document (a booking confirmation, ticket, \
reservation, or itinerary email) for a trip-planning app. Extract exactly ONE itinerary item from it.

The trip has these stops (match the document to the most likely one by location AND date):
{json.dumps(stop_lines, indent=2)}

Choose `kind` from this exact list: {", ".join(kinds)}

For `details`, use these snake_case keys per kind (include only those you can fill from the document):
{hints}

Rules:
- Times are LOCAL wall-clock, formatted "YYYY-MM-DDTHH:MM" (no timezone suffix).
- `scheduled_at` is the item's primary time: departure for transport, check-in for accommodation, start time otherwise. Same "YYYY-MM-DDTHH:MM" format, or null if unknown.
- `name` is a short human label, e.g. "Lyon → Dijon" for transport or the hotel/venue name.
- `cost` is the total price as a plain string with currency symbol if present, e.g. "€48.00"; "" if unknown.
- `link` is a booking/management URL if present, else "".
- `notes` is free text for anything important that has no dedicated field, else "".
- `matched_stop_id` is the integer id of the best-matching stop above, or null if none clearly fits.
- `confidence` is "high", "medium", or "low" for the overall extraction.
- `match_reason` is one short sentence explaining the stop choice (or why none matched).

Respond with ONLY a JSON object, no markdown fences, no commentary:
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
            max_tokens=6000,
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

    # Validate / sanitise the model output.
    kind = parsed.get("kind")
    if kind not in kinds:
        kind = "note"
    details = parsed.get("details")
    if not isinstance(details, dict):
        details = {}

    stop_ids = {s.id for s in stops}
    matched = parsed.get("matched_stop_id")
    if not isinstance(matched, int) or matched not in stop_ids:
        matched = None

    item = {
        "kind": kind,
        "name": (parsed.get("name") or "Imported item").strip(),
        "scheduled_at": parsed.get("scheduled_at") or None,
        "cost": parsed.get("cost") or "",
        "link": parsed.get("link") or "",
        "notes": parsed.get("notes") or "",
        "details": details,
    }

    return {
        "item": item,
        "matched_stop_id": matched,
        "confidence": parsed.get("confidence") or "low",
        "match_reason": parsed.get("match_reason") or "",
        "stops": [
            {
                "id": s.id,
                "location": s.location,
                "country": s.country,
                "arrive": s.arrive.isoformat() if s.arrive else None,
                "depart": s.depart.isoformat() if s.depart else None,
            }
            for s in stops
        ],
    }
