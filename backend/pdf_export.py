"""Trip → PDF export. One page per stop, with that stop's full item data.

Pure-Python (reportlab/platypus) so it runs on any server with no system libraries.
"""
import io
import os
import re
import functools
from datetime import datetime
from xml.sax.saxutils import escape

from sqlmodel import Session, select

from .models import Trip, Stop, ItineraryItem


@functools.lru_cache(maxsize=1)
def _airport_map():
    """IATA code → name, parsed from the frontend's airportNames.js (single source)."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "frontend", "src", "airportNames.js")
    try:
        txt = open(path, encoding="utf-8").read()
    except OSError:
        return {}
    return {m.group(1): m.group(2) for m in re.finditer(r'\b([A-Z]{3})\s*:\s*"([^"]+)"', txt)}


def _airport(code):
    """"CDG Paris Charles de Gaulle" — code plus name when known, else just the code."""
    if not code:
        return ""
    c = str(code).strip().upper()
    name = _airport_map().get(c)
    return f"{c} {name}" if name else c

_KIND_LABEL = {
    "activity": "Activity", "walk": "Walk / Hike", "transfer": "Road Transfer",
    "cycling": "Cycling", "tour": "Guided Tour", "rail": "Rail", "restaurant": "Restaurant",
    "food": "Food & Drink", "purchase": "Purchase", "note": "Note",
    "accommodation": "Accommodation", "flight": "Flight", "show": "Show",
}

# Detail keys that are internal / not useful in a printout.
_SKIP_DETAILS = {
    "converted_cost", "converted_amount_paid", "converted_currency",
    "gpx_filename", "original_gpx_name", "gpx_distance_m", "gpx_gain_m", "gpx_loss_m",
    "route_points", "maps_url", "important",
}

_DATE_FORMATS = (
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
)


def _to_dt(v):
    if not v:
        return None
    if isinstance(v, datetime):
        return v
    s = str(v)[:19].replace(" ", "T")
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _fmt_dt(v):
    dt = _to_dt(v)
    if not dt:
        return str(v) if v else ""
    return dt.strftime("%a %d %b %Y %H:%M") if (dt.hour or dt.minute) else dt.strftime("%a %d %b %Y")


def _item_primary_dt(item: ItineraryItem):
    d = item.details or {}
    if item.kind in ("flight", "rail"):
        return _to_dt(d.get("depart_time")) or _to_dt(item.scheduled_at)
    if item.kind == "accommodation":
        return _to_dt(d.get("bag_drop")) or _to_dt(d.get("checkin")) or _to_dt(item.scheduled_at)
    return _to_dt(item.scheduled_at)


def _labelize(key):
    return key.replace("_", " ").capitalize()


def build_trip_pdf(session: Session, trip_id: int) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak

    trip = session.get(Trip, trip_id)
    stops = session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()
    # Chronological by arrival date, then departure, then sort_order — matches the app.
    stops = sorted(stops, key=lambda s: (
        s.arrive is None, s.arrive or datetime.max,
        s.depart or datetime.max, s.sort_order,
    ))

    styles = getSampleStyleSheet()
    h_trip = ParagraphStyle("hTrip", parent=styles["Title"], fontSize=20, spaceAfter=4)
    h_stop = ParagraphStyle("hStop", parent=styles["Heading1"], fontSize=16, spaceBefore=0, spaceAfter=2,
                            textColor=colors.HexColor("#1e66f5"))
    sub = ParagraphStyle("sub", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#666666"), spaceAfter=10)
    item_name = ParagraphStyle("itemName", parent=styles["Normal"], fontSize=11, leading=14, spaceBefore=8, spaceAfter=1)
    kind_st = ParagraphStyle("kind", parent=styles["Normal"], fontSize=8, textColor=colors.HexColor("#888888"),
                             spaceAfter=2)
    body = ParagraphStyle("body", parent=styles["Normal"], fontSize=9.5, leading=13, leftIndent=10,
                          textColor=colors.HexColor("#333333"))

    flow = []

    def line(label, value):
        if value is None or str(value).strip() == "":
            return
        flow.append(Paragraph(f"<b>{escape(str(label))}:</b> {escape(str(value))}", body))

    for si, stop in enumerate(stops):
        if si == 0:
            flow.append(Paragraph(escape(trip.name or "Trip"), h_trip))
            flow.append(Spacer(1, 6))

        loc = stop.location or "Stop"
        if stop.country:
            loc += f", {stop.country}"
        flow.append(Paragraph(escape(loc), h_stop))
        dates = " – ".join(p for p in [_fmt_dt(stop.arrive), _fmt_dt(stop.depart)] if p)
        flow.append(Paragraph(escape(dates) if dates else "&nbsp;", sub))

        items = session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stop.id)).all()
        items = sorted(items, key=lambda it: (_item_primary_dt(it) is None, _item_primary_dt(it) or datetime.max))

        if not items:
            flow.append(Paragraph("<i>No items.</i>", body))

        for it in items:
            flow.append(Paragraph(escape(it.name or "(untitled)"), item_name))
            flow.append(Paragraph(_KIND_LABEL.get(it.kind, it.kind), kind_st))

            # Flights get an itinerary-style block (From/To, times, cabin, seat…)
            if it.kind == "flight":
                fd = it.details or {}
                subtitle = " · ".join(x for x in [fd.get("flight_number"), fd.get("airline"), fd.get("fare_class")] if x)
                if subtitle:
                    flow.append(Paragraph(escape(subtitle), body))

                def _seg(code, t, tz, term, gate):
                    bits = [_airport(code), _fmt_dt(t)]
                    if tz: bits.append(str(tz))
                    if term: bits.append(f"Terminal {term}")
                    if gate: bits.append(f"Gate {gate}")
                    return " · ".join(b for b in bits if b)

                line("Depart", _seg(fd.get("origin"), fd.get("depart_time"), fd.get("depart_tz"), fd.get("origin_terminal"), fd.get("origin_gate")))
                line("Arrive", _seg(fd.get("destination"), fd.get("arrive_time"), fd.get("arrive_tz"), fd.get("arrive_terminal"), fd.get("arrive_gate")))
                summary = " · ".join(x for x in [
                    fd.get("duration"), fd.get("aircraft"),
                    fd.get("seats") and f"Seat {fd['seats']}",
                    fd.get("baggage") and f"Baggage {fd['baggage']}",
                    fd.get("stops"),
                ] if x)
                if summary:
                    flow.append(Paragraph(escape(summary), body))
                line("Check-in desk", fd.get("checkin_desk"))
                line("Meal", fd.get("meal"))
                if fd.get("layover") or fd.get("connects_to"):
                    line("Layover", " ".join(x for x in [fd.get("layover"), fd.get("connects_to") and f"(connects to {fd['connects_to']})"] if x))
                line("Passengers", fd.get("passengers"))
                line("Frequent flyer", fd.get("loyalty_info"))
                line("Booking ref", fd.get("booking_ref"))
                line("Booked with", fd.get("booking_airline"))
                line("Phone", fd.get("booking_phone"))
                line("Cost", it.cost)
                line("Link", it.link)
                line("Notes", it.notes)
                continue

            primary = _item_primary_dt(it)
            if primary:
                line("When", _fmt_dt(primary))
            for k, v in (it.details or {}).items():
                if k in _SKIP_DETAILS or v in (None, "", []):
                    continue
                # Format obvious datetime fields nicely.
                line(_labelize(k), _fmt_dt(v) if k.endswith(("_time", "checkin", "checkout", "bag_drop")) else v)
            line("Cost", it.cost)
            line("Link", it.link)
            line("Notes", it.notes)

        if si < len(stops) - 1:
            flow.append(PageBreak())

    if not stops:
        flow.append(Paragraph(escape(trip.name or "Trip"), h_trip))
        flow.append(Paragraph("<i>No stops yet.</i>", body))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm, bottomMargin=18 * mm,
        title=(trip.name or "Trip"),
    )
    doc.build(flow)
    return buf.getvalue()
