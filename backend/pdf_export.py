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
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, PageBreak,
        Table, TableStyle, HRFlowable, KeepTogether,
    )
    from reportlab.graphics.shapes import Drawing, Line, Polygon, Circle

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

    # ── Flight card (TripIt-style) ──────────────────────────────────────────
    USABLE = 493  # A4 width minus 18mm margins each side, in points
    ACCENT = colors.HexColor("#6c4fd8")
    RULE = colors.HexColor("#dddddd")
    GREY = colors.HexColor("#777777")
    DARK = colors.HexColor("#222222")

    card_title  = ParagraphStyle("fcTitle", parent=styles["Normal"], fontSize=11, leading=13, spaceBefore=8, spaceAfter=3, textColor=DARK)
    fc_route    = ParagraphStyle("fcRoute", parent=styles["Normal"], fontSize=10.5, leading=13, textColor=DARK)
    fc_air      = ParagraphStyle("fcAir", parent=styles["Normal"], fontSize=9.5, leading=12, textColor=DARK)
    fc_code     = ParagraphStyle("fcCode", parent=styles["Normal"], fontSize=8.5, leading=11, textColor=GREY)
    fc_time     = ParagraphStyle("fcTime", parent=styles["Normal"], fontSize=13, leading=15, textColor=DARK)
    fc_sm       = ParagraphStyle("fcSm", parent=styles["Normal"], fontSize=8, leading=11, textColor=GREY)
    fc_smr      = ParagraphStyle("fcSmR", parent=fc_sm, alignment=TA_RIGHT)
    fc_status   = ParagraphStyle("fcStatus", parent=styles["Normal"], fontSize=9.5, leading=12, textColor=ACCENT, alignment=TA_RIGHT)
    fc_detail   = ParagraphStyle("fcDetail", parent=styles["Normal"], fontSize=8.5, leading=12, textColor=DARK)
    fc_detail_r = ParagraphStyle("fcDetailR", parent=fc_detail, alignment=TA_RIGHT)

    def _name_only(code):
        return _airport_map().get(str(code).strip().upper(), "") if code else ""

    def _t12(v):
        dt = _to_dt(v)
        return dt.strftime("%I:%M %p").lstrip("0") if dt and (dt.hour or dt.minute) else ""

    def _daymon(v):
        dt = _to_dt(v)
        return dt.strftime("%a, %b %d").replace(" 0", " ") if dt else ""

    def _icon():
        d = Drawing(18, 18)
        d.add(Circle(9, 9, 8.5, fillColor=ACCENT, strokeColor=ACCENT))
        return d

    def _arrow():
        d = Drawing(18, 8)
        d.add(Line(1, 4, 12, 4, strokeColor=ACCENT, strokeWidth=1))
        d.add(Polygon(points=[12, 1, 17, 4, 12, 7], fillColor=ACCENT, strokeColor=ACCENT))
        return d

    def _endpoint_cell(code, t, tz, term, gate):
        cells = []
        head = " ".join(x for x in [f"<b>{escape((code or '').upper())}</b>", escape(_name_only(code))] if x.strip())
        if head.strip():
            cells.append(Paragraph(head, fc_code))
        tline = _t12(t)
        if tline:
            cells.append(Paragraph(f"<b>{escape(tline)}</b><font size=8 color='#777777'>{escape((', ' + _daymon(t)) if _daymon(t) else '')}{escape((' ' + tz) if tz else '')}</font>", fc_time))
        extra = " · ".join(x for x in [term and f"Terminal {term}", gate and f"Gate {gate}"] if x)
        if extra:
            cells.append(Paragraph(escape(extra), fc_sm))
        return cells or [Paragraph("&nbsp;", fc_sm)]

    def _flight_card(it):
        fd = it.details or {}
        o, dst = fd.get("origin"), fd.get("destination")
        inner = []

        # Header: icon + route/sub-line, status + confirmation on the right
        route = " - ".join(p for p in [
            (" ".join(x for x in [f"<b>{escape((o or '').upper())}</b>", escape(_name_only(o))] if x.strip())) if o else "",
            (" ".join(x for x in [f"<b>{escape((dst or '').upper())}</b>", escape(_name_only(dst))] if x.strip())) if dst else "",
        ] if p) or escape(it.name or "Flight")
        left = [Paragraph(route, fc_route)]
        subline = " · ".join(x for x in [_daymon(fd.get("depart_time")), fd.get("duration"), fd.get("stops")] if x)
        if subline:
            left.append(Paragraph(escape(subline), fc_sm))
        right = []
        if fd.get("flight_status"):
            right.append(Paragraph(f"<b>{escape(str(fd['flight_status']).upper())}</b>", fc_status))
        if fd.get("booking_ref"):
            right.append(Paragraph(f"Confirmation: {escape(str(fd['booking_ref']))}", fc_smr))
        header = Table([[_icon(), left, right or Paragraph("&nbsp;", fc_sm)]], colWidths=[20, 330, 127])
        header.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (0, 0), 1),
        ]))
        inner.append(header)
        inner.append(HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=6, spaceAfter=6))

        # Airline / flight number, with distance on the right
        airline = ", ".join(x for x in [fd.get("airline"), fd.get("flight_number")] if x)
        if airline or fd.get("distance"):
            arow = Table([[
                Paragraph(f"<b>{escape(airline)}</b>", fc_air) if airline else Paragraph("&nbsp;", fc_air),
                Paragraph(f"<b>Distance:</b> {escape(str(fd['distance']))}", fc_detail_r) if fd.get("distance") else Paragraph("&nbsp;", fc_sm),
            ]], colWidths=[(USABLE - 16) * 0.62, (USABLE - 16) * 0.38])
            arow.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]))
            inner.append(arow)
            inner.append(Spacer(1, 4))

        # Segments: depart  →  arrive  |  cabin / class / aircraft
        detail = []
        for lbl, val in [("Cabin", fd.get("fare_class")), ("Aircraft", fd.get("aircraft")),
                         ("Seat", fd.get("seats")), ("Baggage", fd.get("baggage"))]:
            if val:
                detail.append(Paragraph(f"<b>{lbl}:</b> {escape(str(val))}", fc_detail))
        seg = Table([[
            _endpoint_cell(o, fd.get("depart_time"), fd.get("depart_tz"), fd.get("origin_terminal"), fd.get("origin_gate")),
            _arrow(),
            _endpoint_cell(dst, fd.get("arrive_time"), fd.get("arrive_tz"), fd.get("arrive_terminal"), fd.get("arrive_gate")),
            detail or Paragraph("&nbsp;", fc_sm),
        ]], colWidths=[152, 28, 152, 145])
        seg.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"), ("VALIGN", (1, 0), (1, 0), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        inner.append(seg)

        # Passengers / frequent flyer
        if fd.get("passengers") or fd.get("loyalty_info"):
            inner.append(HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=5, spaceAfter=5))
            pax = []
            if fd.get("passengers"):
                pax.append(Paragraph(f"<b>Passengers:</b> {escape(str(fd['passengers']))}", fc_detail))
            if fd.get("loyalty_info"):
                pax.append(Paragraph(f"<b>Frequent flyer:</b> {escape(str(fd['loyalty_info']))}", fc_detail))
            inner.append(Table([[pax]], colWidths=[USABLE - 16], style=TableStyle([
                ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ])))

        # Remaining details — compact three-column rows, kept inside the box
        def _cell(lbl, val):
            return Paragraph(f"<b>{lbl}:</b> {escape(str(val))}", fc_detail) if val not in (None, "", []) else Paragraph("", fc_detail)

        grid_rows = []
        for trio in [
            [("Meal", fd.get("meal")), ("Lounge", fd.get("lounge")), ("Entertainment", fd.get("entertainment"))],
            [("Booked with", fd.get("booking_airline")), ("Booking phone", fd.get("booking_phone")), ("Cost", it.cost)],
        ]:
            if any(v not in (None, "", []) for _, v in trio):
                grid_rows.append([_cell(l, v) for l, v in trio])

        checkin = Paragraph(f"<b>Check-in desk:</b> {escape(str(fd['checkin_desk']))}", fc_detail) if fd.get("checkin_desk") else None
        notes_link = []
        if it.notes:
            notes_link.append(Paragraph(f"<b>Notes:</b> {escape(str(it.notes))}", fc_detail))
        if it.link:
            notes_link.append(Paragraph(f"<b>Link:</b> {escape(str(it.link))}", fc_detail))

        if checkin or grid_rows or notes_link:
            inner.append(HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=5, spaceAfter=5))
            if checkin:
                inner.append(checkin)
            if grid_rows:
                grid = Table(grid_rows, colWidths=[(USABLE - 16) / 3] * 3)
                grid.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 1),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
                ]))
                inner.append(grid)
            for p in notes_link:
                inner.append(p)

        # Layover footer
        lay = " ".join(x for x in [fd.get("layover"), fd.get("connects_to") and f"– {fd['connects_to']}"] if x)
        if lay:
            inner.append(HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=5, spaceAfter=5))
            inner.append(Paragraph(f"Layover {escape(lay)}", fc_sm))

        box = Table([[inner]], colWidths=[USABLE])
        box.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.75, RULE),
            ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))

        title = [Paragraph(escape(it.name), card_title)] if it.name else []
        flow.append(KeepTogether(title + [box]))

    # ── Hotel card ─────────────────────────────────────────────────────────────
    HOTEL_ACCENT = colors.HexColor("#1e66f5")

    fc_hotel_name = ParagraphStyle("fcHotelName", parent=styles["Normal"], fontSize=11, leading=13, textColor=DARK)
    fc_hotel_dates = ParagraphStyle("fcHotelDates", parent=styles["Normal"], fontSize=9.5, leading=12, textColor=DARK)
    fc_hotel_r = ParagraphStyle("fcHotelR", parent=fc_hotel_dates, alignment=TA_RIGHT, textColor=GREY)

    def _fmt_short(v):
        """Wed 22 Jul 16:00 — no year, 24h."""
        dt = _to_dt(v)
        if not dt:
            return str(v) if v else ""
        if dt.hour or dt.minute:
            return dt.strftime("%a %d %b %H:%M").replace(" 0", " ")
        return dt.strftime("%a %d %b").replace(" 0", " ")

    def _hotel_arrow():
        d = Drawing(14, 8)
        d.add(Line(1, 4, 9, 4, strokeColor=HOTEL_ACCENT, strokeWidth=0.9))
        d.add(Polygon(points=[9, 1.5, 13, 4, 9, 6.5], fillColor=HOTEL_ACCENT, strokeColor=HOTEL_ACCENT))
        return d

    def _hotel_icon():
        d = Drawing(18, 18)
        d.add(Circle(9, 9, 8.5, fillColor=HOTEL_ACCENT, strokeColor=HOTEL_ACCENT))
        return d

    def _hotel_card(it):
        fd = it.details or {}
        inner = []

        # Header: icon + hotel name (left) | phone (right)
        left = [Paragraph(f"<b>{escape(it.name or 'Accommodation')}</b>", fc_hotel_name)]
        right = []
        if fd.get("contact_phone"):
            right.append(Paragraph(f"<b>Phone:</b> {escape(str(fd['contact_phone']))}", fc_smr))
        if fd.get("contact_email"):
            right.append(Paragraph(f"<b>Email:</b> {escape(str(fd['contact_email']))}", fc_smr))
        hdr = Table([[_hotel_icon(), left, right or Paragraph("&nbsp;", fc_sm)]], colWidths=[20, 280, 177])
        hdr.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (0, 0), 1),
        ]))
        inner.append(hdr)

        # Date row: check-in → check-out (left) | booking ref (right)
        has_dates = fd.get("checkin") or fd.get("checkout")
        has_ref = fd.get("booking_ref")
        if has_dates or has_ref:
            dep = _fmt_short(fd.get("checkin"))
            arr = _fmt_short(fd.get("checkout"))
            date_parts = []
            if dep:
                date_parts.append((Paragraph(dep, fc_hotel_dates), 90))
            if dep and arr:
                date_parts.append((_hotel_arrow(), 16))
            if arr:
                date_parts.append((Paragraph(arr, fc_hotel_dates), 90))
            if date_parts:
                cells, widths = zip(*date_parts)
                date_inner = Table([list(cells)], colWidths=list(widths))
                date_inner.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ]))
                date_col = date_inner
            else:
                date_col = Paragraph("&nbsp;", fc_sm)
            drow = Table([[date_col, Paragraph(f"<b>Booking ref:</b> {escape(str(has_ref))}", fc_hotel_r) if has_ref else Paragraph("&nbsp;", fc_sm)]], colWidths=[320, 157])
            drow.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]))
            inner.append(drow)

        inner.append(HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=5, spaceAfter=5))

        # Location and description
        if fd.get("location"):
            inner.append(Paragraph(f"<b>Location:</b> {escape(str(fd['location']))}", fc_detail))
        if fd.get("description"):
            inner.append(Paragraph(escape(str(fd["description"])), fc_detail))

        # Bag drop (no rule needed, sits below the location/description block)
        if fd.get("bag_drop"):
            inner.append(Paragraph(f"<b>Bag drop:</b> {escape(_fmt_short(fd['bag_drop']))}", fc_detail))

        # Notes only — rule + block suppressed when empty
        if it.notes:
            inner.append(HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=5, spaceAfter=5))
            inner.append(Paragraph(f"<b>Notes:</b> {escape(str(it.notes))}", fc_detail))

        box = Table([[inner]], colWidths=[USABLE])
        box.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.75, RULE),
            ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        flow.append(KeepTogether([box]))

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
            if it.kind == "flight":
                _flight_card(it)
                continue
            if it.kind == "accommodation":
                _hotel_card(it)
                continue

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
