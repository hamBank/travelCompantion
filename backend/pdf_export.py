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
    from reportlab.graphics.shapes import Drawing, Line, Polygon, Circle, Rect, String

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

    def _linked(text, url, bold=True):
        """Wrap text in a PDF hyperlink when url is present; bold by default."""
        inner_text = f"<b>{text}</b>" if bold else text
        if url:
            return f'<a href="{escape(str(url))}" color="#1e66f5">{inner_text}</a>'
        return inner_text
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
        """Airplane icon for flight cards."""
        d = Drawing(18, 18)
        d.add(Circle(9, 9, 8.5, fillColor=ACCENT, strokeColor=ACCENT))
        w = colors.white
        # Fuselage — tapered body pointing right
        d.add(Polygon([2,8.3, 2,9.7, 13.5,9.7, 16,9, 13.5,8.3], fillColor=w, strokeColor=w, strokeWidth=0))
        # Wings — swept-back triangle each side
        d.add(Polygon([6.5,9, 10.5,9, 9,4.2, 7.5,4.8], fillColor=w, strokeColor=w, strokeWidth=0))
        d.add(Polygon([6.5,9, 10.5,9, 9,13.8, 7.5,13.2], fillColor=w, strokeColor=w, strokeWidth=0))
        # Tail fins — small triangles at rear
        d.add(Polygon([3,9, 5,9, 4.5,6.8], fillColor=w, strokeColor=w, strokeWidth=0))
        d.add(Polygon([3,9, 5,9, 4.5,11.2], fillColor=w, strokeColor=w, strokeWidth=0))
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

        title = [Paragraph(_linked(escape(it.name), it.link), card_title)] if it.name else []
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
        """Bed icon for hotel cards."""
        d = Drawing(18, 18)
        d.add(Circle(9, 9, 8.5, fillColor=HOTEL_ACCENT, strokeColor=HOTEL_ACCENT))
        w = colors.white
        # Headboard — left rectangle
        d.add(Rect(3, 6.5, 2, 5.5, fillColor=w, strokeColor=w, strokeWidth=0))
        # Bed base — horizontal bar
        d.add(Rect(3, 6.5, 12, 2, fillColor=w, strokeColor=w, strokeWidth=0))
        # Pillow — right half of bed, raised above base
        d.add(Rect(7.5, 8.5, 6.5, 3.5, fillColor=w, strokeColor=w, strokeWidth=0, rx=1, ry=1))
        return d

    def _hotel_card(it):
        fd = it.details or {}
        inner = []

        # Header: icon + hotel name (left) | phone (right)
        left = [Paragraph(_linked(escape(it.name or 'Accommodation'), it.link), fc_hotel_name)]
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

    # ── Generic item card (activity, walk, rail, restaurant, tour, transfer,
    #    cycling, food, purchase, note, show) ────────────────────────────────
    _KIND_COLOR = {
        "activity":  "#89b4fa", "walk":     "#94e2d5", "transfer":  "#e8a87c",
        "cycling":   "#fab387", "tour":     "#f5c2e7", "rail":      "#b4befe",
        "restaurant":"#a6e3a1", "food":     "#f2cdcd", "purchase":  "#eba0ac",
        "note":      "#f9e2af", "show":     "#d8a0f0",
    }
    # Small unicode-safe text symbol that lives inside the icon circle.
    # All of these are in the WinAnsi / Latin-1 range that Helvetica handles.
    _KIND_SYMBOL = {
        "activity": "A", "walk": "W", "transfer": "T", "cycling": "C",
        "tour": "G", "rail": "R", "restaurant": "D", "food": "F",
        "purchase": "P", "note": "N", "show": "S",
    }
    # Per-kind: which detail keys to show, in order (rest are suppressed).
    _KIND_FIELDS = {
        "rail":       ["depart_time", "arrive_time", "origin", "destination",
                       "train_number", "operator", "coach", "seats", "class_",
                       "platform", "booking_ref", "duration", "stops", "description"],
        "restaurant": ["scheduled_at", "location", "booking_ref", "contact_phone",
                       "cuisine", "reservation_name", "description"],
        "show":       ["start_time", "location", "ticket_number", "seats",
                       "booking_ref", "contact_phone", "description"],
        "transfer":   ["scheduled_at", "start_location", "end_location",
                       "operator", "vehicle", "booking_ref", "contact_phone", "description"],
        "tour":       ["scheduled_at", "meeting_point", "duration", "operator",
                       "booking_ref", "contact_phone", "description"],
        "activity":   ["scheduled_at", "location", "duration", "operator",
                       "booking_ref", "contact_phone", "description"],
        "walk":       ["scheduled_at", "start_location", "end_location",
                       "distance", "duration", "description"],
        "cycling":    ["scheduled_at", "start_location", "end_location",
                       "distance", "duration", "description"],
        "food":       ["scheduled_at", "location", "description"],
        "purchase":   ["scheduled_at", "location", "description"],
        "note":       ["description"],
    }
    _DATETIME_KEYS = {"depart_time", "arrive_time", "start_time", "scheduled_at",
                      "checkin", "checkout", "bag_drop"}

    def _item_icon(kind):
        hex_col = _KIND_COLOR.get(kind, "#aaaaaa")
        col = colors.HexColor(hex_col)
        d = Drawing(18, 18)
        d.add(Circle(9, 9, 8.5, fillColor=col, strokeColor=col))
        w = colors.white
        sw = 1.3  # base stroke width

        if kind == "walk":
            # Walking legs in stride — hip line + two bent legs + feet
            d.add(Line(6, 15, 12, 15, strokeColor=w, strokeWidth=sw))   # hip
            d.add(Line(6, 15, 4, 10, strokeColor=w, strokeWidth=sw))    # L thigh
            d.add(Line(4, 10, 7, 5, strokeColor=w, strokeWidth=sw))     # L lower
            d.add(Line(7, 5, 3.5, 5, strokeColor=w, strokeWidth=sw))    # L foot
            d.add(Line(12, 15, 14, 10, strokeColor=w, strokeWidth=sw))  # R thigh
            d.add(Line(14, 10, 11, 5, strokeColor=w, strokeWidth=sw))   # R lower
            d.add(Line(11, 5, 14.5, 5, strokeColor=w, strokeWidth=sw))  # R foot

        elif kind == "transfer":
            # Delivery van — cargo box + cab + door line + two wheels
            d.add(Polygon(points=[2,8, 2,14, 13,14, 13,8],
                          fillColor=None, strokeColor=w, strokeWidth=sw))
            d.add(Polygon(points=[13,8, 13,14, 16.5,14, 16.5,11, 15,8],
                          fillColor=None, strokeColor=w, strokeWidth=sw))
            d.add(Line(8.5, 8, 8.5, 14, strokeColor=w, strokeWidth=sw))  # door line
            d.add(Rect(3, 10, 3.5, 3, fillColor=None, strokeColor=w, strokeWidth=0.9))  # window
            d.add(Circle(5.5, 7.5, 2, fillColor=w, strokeColor=w))
            d.add(Circle(5.5, 7.5, 0.7, fillColor=col, strokeColor=col))
            d.add(Circle(14, 7.5, 2, fillColor=w, strokeColor=w))
            d.add(Circle(14, 7.5, 0.7, fillColor=col, strokeColor=col))

        elif kind == "food":
            # Covered cloche — dome polygon + plate base + handle
            d.add(Line(3, 7, 15, 7, strokeColor=w, strokeWidth=sw * 1.3))     # plate
            d.add(Line(4.5, 6.5, 13.5, 6.5, strokeColor=w, strokeWidth=sw))  # rim
            d.add(Polygon(points=[3,7, 3.5,9.5, 5,11.5, 7.5,13, 9,13.5,
                                  10.5,13, 13,11.5, 14.5,9.5, 15,7],
                          fillColor=None, strokeColor=w, strokeWidth=sw))
            d.add(Circle(9, 14.5, 1.2, fillColor=w, strokeColor=w))  # handle

        elif kind == "cycling":
            # Bicycle — two wheels + diamond frame + seat + handlebars
            d.add(Circle(4.5, 7, 3.5, fillColor=None, strokeColor=w, strokeWidth=sw))   # rear
            d.add(Circle(13.5, 7, 3.5, fillColor=None, strokeColor=w, strokeWidth=sw))  # front
            d.add(Line(4.5, 7, 9, 7, strokeColor=w, strokeWidth=sw))    # chain stay
            d.add(Line(9, 7, 9, 12, strokeColor=w, strokeWidth=sw))     # seat tube
            d.add(Line(9, 12, 4.5, 7, strokeColor=w, strokeWidth=sw))   # seat stay
            d.add(Line(9, 7, 13.5, 7, strokeColor=w, strokeWidth=sw))   # down tube base
            d.add(Line(9, 12, 13.5, 7, strokeColor=w, strokeWidth=sw))  # top tube
            d.add(Line(7.5, 12.5, 10.5, 12.5, strokeColor=w, strokeWidth=sw * 1.2))  # seat
            d.add(Line(13.5, 10, 13.5, 12, strokeColor=w, strokeWidth=sw))  # fork
            d.add(Line(12, 12, 15, 12, strokeColor=w, strokeWidth=sw))      # handlebars

        elif kind == "rail":
            # Train side view — body + three windows + two wheels + rail
            d.add(Rect(2, 8, 14, 6, fillColor=None, strokeColor=w, strokeWidth=sw))
            d.add(Rect(3, 10.5, 2.5, 2.5, fillColor=None, strokeColor=w, strokeWidth=0.9))
            d.add(Rect(7, 10.5, 2.5, 2.5, fillColor=None, strokeColor=w, strokeWidth=0.9))
            d.add(Rect(11, 10.5, 2.5, 2.5, fillColor=None, strokeColor=w, strokeWidth=0.9))
            d.add(Circle(5.5, 7.5, 1.5, fillColor=w, strokeColor=w))
            d.add(Circle(12.5, 7.5, 1.5, fillColor=w, strokeColor=w))
            d.add(Line(1.5, 6.5, 16.5, 6.5, strokeColor=w, strokeWidth=0.8))  # rail

        elif kind == "restaurant":
            # Table + chairs + fork, plate, knife
            d.add(Rect(2, 9, 14, 1.5, fillColor=w, strokeColor=w))       # table top
            d.add(Line(4.5, 9, 4.5, 6, strokeColor=w, strokeWidth=sw))   # left leg
            d.add(Line(13.5, 9, 13.5, 6, strokeColor=w, strokeWidth=sw)) # right leg
            d.add(Rect(0, 9, 1.5, 6, fillColor=None, strokeColor=w, strokeWidth=sw))   # left chair
            d.add(Rect(16.5, 9, 1.5, 6, fillColor=None, strokeColor=w, strokeWidth=sw)) # right chair
            d.add(Circle(9, 12.5, 2, fillColor=None, strokeColor=col, strokeWidth=0.9))  # plate
            d.add(Line(6, 10.5, 6, 16, strokeColor=col, strokeWidth=sw))   # fork handle
            d.add(Line(5.2, 13, 5.2, 16, strokeColor=col, strokeWidth=0.7))  # tine 1
            d.add(Line(6.8, 13, 6.8, 16, strokeColor=col, strokeWidth=0.7))  # tine 2
            d.add(Line(12, 10.5, 12, 16, strokeColor=col, strokeWidth=sw))  # knife

        else:
            letter = _KIND_SYMBOL.get(kind, "?")
            d.add(String(9, 5.5, letter, fontName="Helvetica-Bold", fontSize=9,
                         fillColor=colors.white, textAnchor="middle"))

        return d

    fc_item_name = ParagraphStyle("fcItemName", parent=styles["Normal"], fontSize=11, leading=13, textColor=DARK)
    fc_item_kind = ParagraphStyle("fcItemKind", parent=styles["Normal"], fontSize=8, leading=10, textColor=GREY)

    def _item_card(it):
        fd = it.details or {}
        col = colors.HexColor(_KIND_COLOR.get(it.kind, "#aaaaaa"))
        inner = []

        # Header: icon + name (left) | kind label (right)
        kind_label = _KIND_LABEL.get(it.kind, it.kind)
        fc_kind_r = ParagraphStyle("_kr", parent=fc_sm, alignment=TA_RIGHT,
                                   textColor=col)
        hdr = Table([[
            _item_icon(it.kind),
            Paragraph(_linked(escape(it.name or kind_label), it.link), fc_item_name),
            Paragraph(f"<b>{escape(kind_label)}</b>", fc_kind_r),
        ]], colWidths=[20, 340, 117])
        hdr.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (0, 0), 1),
        ]))
        inner.append(hdr)

        # Build body and footer separately so rules only appear between non-empty sections
        body = []

        # Primary time — shown prominently when present
        primary = _item_primary_dt(it)
        if primary and it.kind != "note":
            body.append(Paragraph(escape(_fmt_short(primary)), fc_hotel_dates))

        # Kind-specific fields
        field_order = _KIND_FIELDS.get(it.kind, [])
        pairs = []
        for k in field_order:
            v = fd.get(k)
            if v in (None, "", []):
                continue
            label = {"depart_time": "Departs", "arrive_time": "Arrives",
                     "start_time": "Starts", "scheduled_at": "When",
                     "class_": "Class", "start_location": "From",
                     "end_location": "To", "meeting_point": "Meeting point",
                     "reservation_name": "Reservation", "contact_phone": "Phone",
                     "ticket_number": "Ticket", "train_number": "Train",
                     "operator": "Operator", "booking_ref": "Booking ref",
                     "description": None,  # full-width
                    }.get(k, _labelize(k))
            fmt_v = _fmt_short(v) if k in _DATETIME_KEYS else str(v)
            pairs.append(("_full" if label is None else escape(label), escape(fmt_v)))

        row_buf = []
        def _flush_rows():
            if not row_buf:
                return
            rows = [row_buf[i:i+2] for i in range(0, len(row_buf), 2)]
            if len(rows[-1]) == 1:
                rows[-1].append(Paragraph("", fc_detail))
            grid = Table([[c for c in r] for r in rows],
                         colWidths=[(USABLE - 16) / 2] * 2)
            grid.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 1),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
            ]))
            body.append(grid)
            row_buf.clear()

        for label, val in pairs:
            if label == "_full":
                _flush_rows()
                body.append(Paragraph(val, fc_detail))
            else:
                row_buf.append(Paragraph(f"<b>{label}:</b> {val}", fc_detail))
        _flush_rows()

        # Footer: cost / link / notes
        footer = []
        if it.cost:
            footer.append(Paragraph(f"<b>Cost:</b> {escape(str(it.cost))}", fc_detail))
        if it.notes:
            footer.append(Paragraph(f"<b>Notes:</b> {escape(str(it.notes))}", fc_detail))

        # Rules only between non-empty sections
        _hr = lambda: HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=5, spaceAfter=5)
        if body:
            inner.append(_hr())
            inner.extend(body)
        if footer:
            if body:
                inner.append(_hr())
            inner.extend(footer)

        box = Table([[inner]], colWidths=[USABLE])
        box.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.75, col),
            ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        flow.append(KeepTogether([box]))

    for si, stop in enumerate(stops):

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

        for ii, it in enumerate(items):
            if ii > 0:
                flow.append(HRFlowable(width="100%", thickness=0.5,
                    color=colors.HexColor("#e0e0e0"), spaceBefore=6, spaceAfter=6))
            if it.kind == "flight":
                _flight_card(it)
                continue
            if it.kind == "accommodation":
                _hotel_card(it)
                continue

            _item_card(it)

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
