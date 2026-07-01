"""Tests for backend/importer.py — CSV → Trip/Stop/ItineraryItem seeding."""
import csv
import io
from datetime import datetime

import pytest
from sqlmodel import Session, select

from backend import importer
from backend.models import Trip, Stop, StopStatus, ItemKind, ItineraryItem


def _csv(rows) -> str:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue()


# ── _parse_date ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("2026-07-22", datetime(2026, 7, 22)),
    ("2026-07-22T14:30", datetime(2026, 7, 22, 14, 30)),
    ("22/07/2026 14:30", datetime(2026, 7, 22, 14, 30)),
    ("07/22/2026", None),  # ambiguous with DD/MM parsed first — 22 is not a valid month so falls through
    ("22 Jul 2026", datetime(2026, 7, 22)),
    ("22 Jul 2026 14:30", datetime(2026, 7, 22, 14, 30)),
    ("July 22, 2026", datetime(2026, 7, 22)),
    ("22/07/2026 02:30 PM", datetime(2026, 7, 22, 14, 30)),
    ("", None),
    ("not a date", None),
])
def test_parse_date_formats(text, expected):
    result = importer._parse_date(text)
    if expected is None:
        # "07/22/2026" actually IS parseable as MM/DD/YYYY (US format is also tried)
        if text == "07/22/2026":
            assert result == datetime(2026, 7, 22)
        else:
            assert result is None
    else:
        assert result == expected


def test_parse_date_infers_year_for_short_dates_near_today():
    result = importer._parse_date("22 Jul")
    assert result is not None
    assert (result.month, result.day) == (7, 22)


# ── _overlay_time / _combine_datetime ───────────────────────────────────────

def test_overlay_time_sets_hour_minute():
    base = datetime(2026, 7, 22, 0, 0)
    result = importer._overlay_time(base, "21:35")
    assert result == datetime(2026, 7, 22, 21, 35)


def test_overlay_time_handles_pm():
    base = datetime(2026, 7, 22, 0, 0)
    result = importer._overlay_time(base, "9:35 PM")
    assert result == datetime(2026, 7, 22, 21, 35)


def test_overlay_time_noop_on_blank():
    base = datetime(2026, 7, 22, 0, 0)
    assert importer._overlay_time(base, "") == base


def test_combine_datetime_from_full_datetime_string():
    assert importer._combine_datetime("", "24/07/2026 21:35") == "2026-07-24T21:35"


def test_combine_datetime_overlays_bare_time_onto_date():
    assert importer._combine_datetime("22/07/2026", "21:35") == "2026-07-22T21:35"


def test_combine_datetime_returns_empty_when_unparseable():
    assert importer._combine_datetime("garbage", "") == ""


# ── _parse_sheet ─────────────────────────────────────────────────────────────

def _paris_sheet_csv():
    return _csv([
        ["Paris", "France"],
        ["Arrive", "22/07/2026 14:00"],
        ["Depart", "25/07/2026 10:00"],
        ["Accomodation", "Hotel Lutetia", "https://hotel-lutetia.com"],
        ["Address", "45 Boulevard Raspail"],
        ["Phone", "+33 1 49 54 46 46"],
        ["Sunrise", "06:00", "Check-in", "15:00", "Check-out", "11:00"],
        ["Timezone", "+2"],
        ["Latitude", "48.8566,2.3522"],
        ["", "Activity", "Link", "Cost"],
        ["22/07/2026", "Eiffel Tower", "https://eiffel.example", "20"],
        ["Restaurant", "Type", "Walk"],
        ["", "La Rotonde", "5 min walk", "French bistro"],
        ["Weather", "Sunny"],
    ])


def test_parse_sheet_extracts_all_sections():
    data = importer._parse_sheet("Paris", _paris_sheet_csv())

    assert data["location"] == "Paris"
    assert data["country"] == "France"
    assert data["arrive"] == datetime(2026, 7, 22, 14, 0)
    assert data["depart"] == datetime(2026, 7, 25, 10, 0)

    assert data["accommodation"] == "Hotel Lutetia"
    assert data["accommodation_link"] == "https://hotel-lutetia.com"
    assert data["accommodation_details"]["location"] == "45 Boulevard Raspail"
    assert data["accommodation_details"]["contact_phone"] == "+33 1 49 54 46 46"

    assert data["check_in"] == "15:00"
    assert data["check_out"] == "11:00"
    assert data["timezone"] == "+2"
    assert data["lat"] == "48.8566"
    assert data["lng"] == "2.3522"

    assert len(data["activities"]) == 1
    assert data["activities"][0]["name"] == "Eiffel Tower"
    assert data["activities"][0]["time"] == "22/7"
    assert data["activities"][0]["cost"] == "20"

    assert len(data["restaurants"]) == 1
    assert data["restaurants"][0]["name"] == "La Rotonde"
    assert "5 min walk" in data["restaurants"][0]["notes"]


def test_parse_sheet_treats_non_url_accommodation_extra_as_notes():
    text = _csv([
        ["Rome", "Italy"],
        ["Accomodation", "B&B Rome", "ask for the courtyard room"],
    ])
    data = importer._parse_sheet("Rome", text)
    assert data["accommodation_link"] == ""
    assert data["accommodation_notes"] == "ask for the courtyard room"


def test_parse_sheet_empty_csv_returns_empty_dict():
    assert importer._parse_sheet("Empty", "") == {}


# ── _parse_flights_sheet ─────────────────────────────────────────────────────

def test_parse_flights_sheet_maps_headers_and_details():
    text = _csv([
        ["From", "To", "Flight", "Airline", "Depart Date", "Depart Time", "Arrive Time", "Cost"],
        ["SIN", "CDG", "AY 132", "Finnair", "22/07/2026", "21:35", "05:50", "1200"],
    ])
    flights = importer._parse_flights_sheet(text)
    assert len(flights) == 1
    f = flights[0]
    assert f["origin"] == "SIN"
    assert f["cost"] == "1200"
    assert f["details"]["destination"] == "CDG"
    assert f["details"]["flight_number"] == "AY 132"
    assert f["details"]["airline"] == "Finnair"
    assert f["details"]["depart_time"] == "2026-07-22T21:35"


def test_parse_flights_sheet_detects_overnight_arrival():
    text = _csv([
        ["From", "To", "Depart Date", "Depart Time", "Arrive Time"],
        ["SIN", "CDG", "22/07/2026", "23:35", "05:50"],
    ])
    flights = importer._parse_flights_sheet(text)
    assert flights[0]["details"]["arrive_time"] == "2026-07-23T05:50"


def test_parse_flights_sheet_skips_blank_rows():
    text = _csv([
        ["From", "To"],
        ["", ""],
        ["SIN", "CDG"],
    ])
    flights = importer._parse_flights_sheet(text)
    assert len(flights) == 1


def test_parse_flights_sheet_too_few_rows_returns_empty():
    assert importer._parse_flights_sheet("From,To\n") == []


# ── _find_stop_for_flight ────────────────────────────────────────────────────

def _stop(location, arrive=None, depart=None):
    return Stop(location=location, arrive=arrive, depart=depart, trip_id=1)


def test_find_stop_for_flight_explicit_hint_wins():
    stops = [_stop("Paris"), _stop("Lyon")]
    result = importer._find_stop_for_flight(stops, origin="XYZ", stop_location_hint="Lyon")
    assert result.location == "Lyon"


def test_find_stop_for_flight_matches_date_range():
    stops = [
        _stop("Paris", arrive=datetime(2026, 7, 20), depart=datetime(2026, 7, 24)),
        _stop("Lyon", arrive=datetime(2026, 7, 24), depart=datetime(2026, 7, 27)),
    ]
    result = importer._find_stop_for_flight(stops, origin="", stop_location_hint="", depart_iso="2026-07-22T10:00")
    assert result.location == "Paris"


def test_find_stop_for_flight_matches_same_day_departure():
    stops = [
        _stop("Paris", arrive=datetime(2026, 7, 20), depart=datetime(2026, 7, 24)),
    ]
    result = importer._find_stop_for_flight(stops, origin="", stop_location_hint="", depart_iso="2026-07-24T09:00")
    assert result.location == "Paris"


def test_find_stop_for_flight_falls_back_to_city_name():
    stops = [_stop("Paris"), _stop("Lyon")]
    result = importer._find_stop_for_flight(stops, origin="Lyon", stop_location_hint="")
    assert result.location == "Lyon"


def test_find_stop_for_flight_falls_back_to_iata_code():
    stops = [_stop("Paris"), _stop("Lyon")]
    result = importer._find_stop_for_flight(stops, origin="LYS", stop_location_hint="")
    assert result.location == "Lyon"


def test_find_stop_for_flight_defaults_to_first_stop():
    stops = [_stop("Paris"), _stop("Lyon")]
    result = importer._find_stop_for_flight(stops, origin="Nowhere", stop_location_hint="")
    assert result.location == "Paris"


def test_find_stop_for_flight_empty_stops_returns_none():
    assert importer._find_stop_for_flight([], origin="Paris", stop_location_hint="") is None


# ── _assign_flights_to_stops (chain-aware) ──────────────────────────────────

def test_assign_flights_chains_transit_leg_to_same_stop():
    singapore = _stop("Singapore", arrive=datetime(2026, 7, 20), depart=datetime(2026, 7, 22))
    paris = _stop("Paris", arrive=datetime(2026, 7, 23), depart=datetime(2026, 7, 26))
    stops = [singapore, paris]

    flights = [
        {  # SIN -> HEL (transit, not an itinerary stop)
            "label": "SIN-HEL", "cost": "", "booking_url": "", "stop_location": "",
            "origin": "SIN", "details": {"destination": "HEL", "depart_time": "2026-07-22T21:35"},
        },
        {  # HEL -> CDG (should chain onto the Singapore stop, not re-match by date)
            "label": "HEL-CDG", "cost": "", "booking_url": "", "stop_location": "",
            "origin": "HEL", "details": {"destination": "CDG", "depart_time": "2026-07-23T05:00"},
        },
    ]
    assignments = importer._assign_flights_to_stops(flights, stops)
    assert assignments[0][1].location == "Singapore"
    assert assignments[1][1].location == "Singapore"  # chained, not re-matched to Paris


def test_assign_flights_breaks_chain_at_itinerary_stop():
    paris = _stop("Paris", arrive=datetime(2026, 7, 20), depart=datetime(2026, 7, 24))
    lyon = _stop("Lyon", arrive=datetime(2026, 7, 24), depart=datetime(2026, 7, 27))
    stops = [paris, lyon]

    flights = [
        {
            "label": "PAR-LYS", "cost": "", "booking_url": "", "stop_location": "",
            "origin": "Paris", "details": {"destination": "Lyon", "depart_time": "2026-07-24T08:00"},
        },
    ]
    assignments = importer._assign_flights_to_stops(flights, stops)
    assert assignments[0][1].location == "Paris"


# ── update_stop_dates ────────────────────────────────────────────────────────

def test_update_stop_dates_raises_when_no_stops(session: Session):
    trip = Trip(name="Empty Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    with pytest.raises(ValueError):
        importer.update_stop_dates(session, trip.id, {})


def test_update_stop_dates_patches_by_sort_order(session: Session):
    trip = Trip(name="Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Paris", sort_order=0, status=StopStatus.planned)
    session.add(stop)
    session.commit()
    session.refresh(stop)

    sheets_raw = {"Paris": _csv([
        ["Paris", "France"],
        ["Arrive", "22/07/2026 14:00"],
        ["Depart", "25/07/2026 10:00"],
    ])}
    result = importer.update_stop_dates(session, trip.id, sheets_raw)
    assert result["stops_updated"] == 1

    session.refresh(stop)
    assert stop.arrive == datetime(2026, 7, 22, 14, 0)
    assert stop.depart == datetime(2026, 7, 25, 10, 0)


def test_update_stop_dates_skips_flight_sheets(session: Session):
    trip = Trip(name="Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Paris", sort_order=0, status=StopStatus.planned)
    session.add(stop)
    session.commit()

    result = importer.update_stop_dates(session, trip.id, {"Flights": "From,To\nSIN,CDG\n"})
    assert result["stops_updated"] == 0
    assert result["detail"] == []


# ── import_flights ───────────────────────────────────────────────────────────

def test_import_flights_raises_when_no_stops(session: Session):
    trip = Trip(name="Empty Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    with pytest.raises(ValueError):
        importer.import_flights(session, trip.id, {})


def test_import_flights_creates_flight_items(session: Session):
    trip = Trip(name="Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Singapore", status=StopStatus.planned)
    session.add(stop)
    session.commit()

    sheets_raw = {"Flights": _csv([
        ["From", "To", "Flight", "Depart Date", "Depart Time", "Cost"],
        ["SIN", "CDG", "AY132", "22/07/2026", "21:35", "1200"],
    ])}
    count = importer.import_flights(session, trip.id, sheets_raw)
    assert count == 1

    flight_items = session.exec(
        select(ItineraryItem).where(ItineraryItem.kind == ItemKind.flight)
    ).all()
    assert len(flight_items) == 1
    assert flight_items[0].cost == "1200"


# ── import_sheets (end-to-end) ───────────────────────────────────────────────

def test_import_sheets_creates_trip_stops_and_items(session: Session):
    sheets_raw = {"Paris": _paris_sheet_csv()}
    trip = importer.import_sheets(session, "Europe 2026", sheets_raw)

    assert trip.id is not None
    assert trip.name == "Europe 2026"

    stops = session.exec(select(Stop).where(Stop.trip_id == trip.id)).all()
    assert len(stops) == 1
    assert stops[0].location == "Paris"
    assert stops[0].country == "France"

    items = session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stops[0].id)).all()
    kinds = {i.kind for i in items}
    assert ItemKind.accommodation in kinds
    assert ItemKind.activity in kinds
    assert ItemKind.restaurant in kinds

    accom = next(i for i in items if i.kind == ItemKind.accommodation)
    assert accom.name == "Hotel Lutetia"
    assert accom.details["checkin"] == "2026-07-22T15:00"
    assert accom.details["checkout"] == "2026-07-25T11:00"


def test_import_sheets_ignores_sheets_without_a_location(session: Session):
    sheets_raw = {
        "Paris": _csv([["Paris", ""]]),
        "Blank": _csv([["", ""]]),
    }
    trip = importer.import_sheets(session, "Trip", sheets_raw)
    stops = session.exec(select(Stop).where(Stop.trip_id == trip.id)).all()
    assert [s.location for s in stops] == ["Paris"]


def test_import_sheets_attaches_flights_across_sheets(session: Session):
    sheets_raw = {
        "Singapore": _csv([["Singapore", ""]]),
        "Paris": _csv([["Paris", ""]]),
        "Flights": _csv([
            ["From", "To", "Depart Date", "Depart Time"],
            ["Singapore", "Paris", "22/07/2026", "21:35"],
        ]),
    }
    trip = importer.import_sheets(session, "Trip", sheets_raw)

    flight_items = session.exec(
        select(ItineraryItem).where(ItineraryItem.kind == ItemKind.flight)
    ).all()
    assert len(flight_items) == 1


# ── enrich_accommodations ─────────────────────────────────────────────────────

def test_enrich_accommodations_raises_when_no_stops(session: Session):
    trip = Trip(name="Empty Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    with pytest.raises(ValueError):
        importer.enrich_accommodations(session, trip.id)


def test_enrich_accommodations_skips_items_with_existing_address(session: Session, monkeypatch):

    trip = Trip(name="Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Paris", status=StopStatus.planned)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    item = ItineraryItem(
        stop_id=stop.id, kind=ItemKind.accommodation, name="Hotel Lutetia",
        details={"location": "45 Boulevard Raspail"},
    )
    session.add(item)
    session.commit()

    def fail_if_called(*args, **kwargs):
        raise AssertionError("should not perform network lookup when address already present")

    monkeypatch.setattr(importer, "_lookup_nominatim", fail_if_called)
    result = importer.enrich_accommodations(session, trip.id)
    assert result["skipped"] == 1
    assert result["updated"] == 0


def test_enrich_accommodations_fills_gaps_without_overwriting_existing_fields(session: Session, monkeypatch):

    trip = Trip(name="Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Paris", status=StopStatus.planned)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    item = ItineraryItem(
        stop_id=stop.id, kind=ItemKind.accommodation, name="Hotel Lutetia",
        details={"contact_phone": "+33 1 00 00 00 00"},
    )
    session.add(item)
    session.commit()
    session.refresh(item)

    monkeypatch.setattr(importer, "time", type("T", (), {"sleep": staticmethod(lambda *_: None)}))
    monkeypatch.setattr(
        importer, "_lookup_nominatim",
        lambda name, city, country: {
            "location": "45 Boulevard Raspail",
            "_lat": "48.8", "_lng": "2.3",
        },
    )

    result = importer.enrich_accommodations(session, trip.id)
    assert result["updated"] == 1

    session.refresh(item)
    session.refresh(stop)
    assert item.details["location"] == "45 Boulevard Raspail"
    assert item.details["contact_phone"] == "+33 1 00 00 00 00"  # not overwritten
    assert stop.lat == "48.8"
    assert stop.lng == "2.3"


def test_enrich_accommodations_uses_google_places_when_api_key_set(session: Session, monkeypatch):
    import json
    import urllib.request

    trip = Trip(name="Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Paris", status=StopStatus.planned)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.accommodation, name="Hotel Lutetia")
    session.add(item)
    session.commit()

    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-key")

    search_response = json.dumps({"results": [{"place_id": "abc123"}]}).encode()
    detail_response = json.dumps({
        "result": {
            "formatted_address": "45 Boulevard Raspail, Paris",
            "formatted_phone_number": "+33 1 49 54 46 46",
            "website": "https://hotel-lutetia.com",
            "geometry": {"location": {"lat": 48.8, "lng": 2.3}},
        }
    }).encode()
    responses = [search_response, detail_response]

    class FakeResponse:
        def __init__(self, body):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(url, timeout=8):
        return FakeResponse(responses.pop(0))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    result = importer.enrich_accommodations(session, trip.id)
    assert result["updated"] == 1
    assert result["detail"][0]["source"] == "google_places"

    session.refresh(item)
    session.refresh(stop)
    assert item.details["location"] == "45 Boulevard Raspail, Paris"
    assert item.link == "https://hotel-lutetia.com"
    assert stop.lat == "48.8"


def test_enrich_accommodations_records_not_found(session: Session, monkeypatch):

    trip = Trip(name="Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Paris", status=StopStatus.planned)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.accommodation, name="Mystery Hotel")
    session.add(item)
    session.commit()

    monkeypatch.setattr(importer, "time", type("T", (), {"sleep": staticmethod(lambda *_: None)}))
    monkeypatch.setattr(importer, "_lookup_nominatim", lambda name, city, country: {})

    result = importer.enrich_accommodations(session, trip.id)
    assert result["updated"] == 0
    assert result["detail"][0]["status"] == "not found"
