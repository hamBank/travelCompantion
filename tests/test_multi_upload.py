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


def test_merge_document_sources_strips_saved_webpage_html():
    """A confirmation page saved as plain .html is stripped to readable text."""
    html_doc = b"""<!DOCTYPE html><html><head><title>Confirmation</title>
    <style>body { color: red; }</style>
    <script>console.log('nav tracking');</script>
    </head><body><h1>Booking AY132</h1><p>Singapore &rarr; Helsinki</p></body></html>"""
    combined_text, pdf_b64s = _merge_document_sources([
        ("confirmation.html", "text/html", html_doc),
    ])
    assert "Booking AY132" in combined_text
    assert "Singapore" in combined_text
    assert "console.log" not in combined_text
    assert "color: red" not in combined_text
    assert pdf_b64s == []


def test_merge_document_sources_decodes_declared_charset():
    """An .html file with a non-UTF-8 declared charset is decoded correctly, not mangled."""
    html_doc = (
        '<html><head><meta charset="windows-1252"></head>'
        '<body><p>Café Résa – confirmation</p></body></html>'
    ).encode("windows-1252")
    combined_text, _ = _merge_document_sources([
        ("confirmation.html", "text/html", html_doc),
    ])
    assert "Café Résa" in combined_text


def test_merge_document_sources_parses_mhtml_saved_webpage():
    """A 'Webpage, Single File' .mhtml save is parsed like a MIME email, not left as raw MIME/quoted-printable."""
    mhtml_doc = (
        b"From: <Saved by Blink>\n"
        b"Snapshot-Content-Location: https://airline.example/confirm\n"
        b"Subject: Booking confirmation\n"
        b"MIME-Version: 1.0\n"
        b'Content-Type: multipart/related; type="text/html"; boundary="----MultipartBoundary"\n'
        b"\n"
        b"------MultipartBoundary\n"
        b"Content-Type: text/html\n"
        b"Content-Transfer-Encoding: quoted-printable\n"
        b"Content-Location: https://airline.example/confirm\n"
        b"\n"
        b"<html><body><h1>Flight AY=20132</h1><p>Singapore =E2=86=92 Helsinki</p></body></html>\n"
        b"------MultipartBoundary--\n"
    )
    combined_text, pdf_b64s = _merge_document_sources([
        ("confirmation.mhtml", "message/rfc822", mhtml_doc),
    ])
    assert "Flight AY 132" in combined_text
    assert "Singapore" in combined_text and "Helsinki" in combined_text
    assert "Content-Transfer-Encoding" not in combined_text
    assert "------MultipartBoundary" not in combined_text
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


def test_same_booking_ref_different_legs_not_deduped(client, session):
    """Multiple flights sharing one booking_ref (multi-leg itinerary) must not be collapsed."""
    trip, stop, stops = _trip(client, session)

    # QR40 and QR900 share booking ref FVLYWE — should produce 2 separate creates
    parsed = {"items": [
        {"kind": "flight", "name": "Paris → Doha",
         "matched_stop_id": stop["id"], "confidence": "high", "match_reason": "",
         "details": {"flight_number": "QR 40", "depart_time": "2026-08-19T16:25",
                     "origin": "CDG", "destination": "DOH", "booking_ref": "FVLYWE",
                     "passengers": [{"name": "Mrs Nicole Wuth", "seat": "12E"}]}},
        {"kind": "flight", "name": "Doha → Perth",
         "matched_stop_id": stop["id"], "confidence": "high", "match_reason": "",
         "details": {"flight_number": "QR 900", "depart_time": "2026-08-20T02:30",
                     "origin": "DOH", "destination": "PER", "booking_ref": "FVLYWE",
                     "passengers": [{"name": "Mrs Nicole Wuth", "seat": "03E"}]}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 2, f"Expected 2 pending changes, got {len(pcs)}"
    flight_numbers = {(pc.payload or {}).get("details", {}).get("flight_number") for pc in pcs}
    assert "QR 40" in flight_numbers
    assert "QR 900" in flight_numbers
