"""Trip → PDF export. One page per stop, with that stop's full item data.

Pure-Python (reportlab/platypus) so it runs on any server with no system libraries.
"""
import io
from datetime import datetime
from xml.sax.saxutils import escape

from sqlmodel import Session, select

from .models import Trip, Stop, ItineraryItem

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
        dates = " → ".join(p for p in [_fmt_dt(stop.arrive), _fmt_dt(stop.depart)] if p)
        flow.append(Paragraph(escape(dates) if dates else "&nbsp;", sub))

        items = session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stop.id)).all()
        items = sorted(items, key=lambda it: (_item_primary_dt(it) is None, _item_primary_dt(it) or datetime.max))

        if not items:
            flow.append(Paragraph("<i>No items.</i>", body))

        for it in items:
            flow.append(Paragraph(escape(it.name or "(untitled)"), item_name))
            flow.append(Paragraph(_KIND_LABEL.get(it.kind, it.kind), kind_st))
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
