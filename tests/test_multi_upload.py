"""Tests for simultaneous multi-document upload."""
import io
from sqlmodel import select
from backend.routers.documents import build_pending_changes, _merge_document_sources
from backend.models import Stop


def _trip(client, session):
    trip = client.post("/trips/", json={"name": "T"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Singapore", "status": "planned",
        "arrive": "2026-07-22T00:00", "depart": "2026-07-25T00:00",
    }).json()
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    return trip, stop, stops


def test_merge_document_sources_combines_texts():
    """Text from multiple documents is joined with a separator."""
    combined_text, pdf_b64s = _merge_document_sources([
        ("doc1.txt", "text/plain", b"Flight AY132"),
        ("doc2.txt", "text/plain", b"Hotel Paris"),
    ])
    assert "Flight AY132" in combined_text
    assert "Hotel Paris" in combined_text
    assert pdf_b64s == []


def test_merge_document_sources_collects_pdfs():
    """PDFs from multiple files are all included."""
    import base64
    fake_pdf = b"%PDF-1.4 fake"
    combined_text, pdf_b64s = _merge_document_sources([
        ("ticket1.pdf", "application/pdf", fake_pdf),
        ("ticket2.pdf", "application/pdf", fake_pdf),
        ("notes.txt", "text/plain", b"extra info"),
    ])
    assert len(pdf_b64s) == 2
    assert "extra info" in combined_text


def test_merge_document_sources_single_file_unchanged():
    """Single file behaves identically to before."""
    combined_text, pdf_b64s = _merge_document_sources([
        ("notes.txt", "text/plain", b"Booking AY132"),
    ])
    assert combined_text == "Booking AY132"
    assert pdf_b64s == []


def test_deduplication_across_documents(client, session):
    """Items described in two documents produce one pending change, not two."""
    trip, stop, stops = _trip(client, session)
    # Simulate two documents both describing the same flight
    parsed = {"items": [
        {"kind": "flight", "name": "SIN → HEL", "matched_stop_id": stop["id"],
         "confidence": "high", "match_reason": "leg 1",
         "details": {"flight_number": "AY 132", "depart_time": "2026-07-24T21:35",
                     "origin": "SIN", "destination": "HEL", "booking_ref": "DYL7CY"}},
        # Same booking from second document — different name, same ref
        {"kind": "flight", "name": "Singapore → Helsinki", "matched_stop_id": stop["id"],
         "confidence": "high", "match_reason": "duplicate",
         "details": {"flight_number": "AY 132", "depart_time": "2026-07-24T21:35",
                     "origin": "SIN", "destination": "HEL", "booking_ref": "DYL7CY"}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    # Dedup by booking_ref+kind → only one pending
    assert len(pcs) == 1


def test_two_passengers_same_flight_merged(client, session):
    """Two documents with per-passenger data for the same flight are merged."""
    trip, stop, stops = _trip(client, session)
    # First passenger's e-ticket
    parsed = {"items": [
        {"kind": "flight", "name": "SIN → HEL", "matched_stop_id": stop["id"],
         "confidence": "high", "match_reason": "leg 1",
         "details": {"flight_number": "AY 132", "depart_time": "2026-07-24T21:35",
                     "origin": "SIN", "destination": "HEL",
                     "passengers": [{"name": "Mr Antony Wuth", "seat": "3H",
                                     "baggage": "2 x 32kg"}]}},
        # Second passenger's e-ticket — same flight, different passenger
        {"kind": "flight", "name": "SIN → HEL", "matched_stop_id": stop["id"],
         "confidence": "high", "match_reason": "leg 1",
         "details": {"flight_number": "AY 132", "depart_time": "2026-07-24T21:35",
                     "origin": "SIN", "destination": "HEL",
                     "passengers": [{"name": "Mrs Nicole Wuth", "seat": "3D",
                                     "baggage": "2 x 32kg"}]}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    # Both passengers merge into one create
    assert len(pcs) == 1
    merged_pax = pcs[0].payload["details"]["passengers"]
    names = {p["name"] for p in merged_pax}
    assert "Mr Antony Wuth" in names
    assert "Mrs Nicole Wuth" in names
