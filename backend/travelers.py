"""Pure helpers for Traveler rows (plan 17a) — no FastAPI imports here; see
backend/routers/travelers.py for the routes that use these.

`age_at`/`age_band` derive a traveler's age band at profile-save time (D5,
docs/plans/plan-17-travelers.md — age is never stored as a rotting number).
`encode_profile`/`decode_profile` wrap document_crypto's Fernet encrypt/
decrypt around the D3 encrypted-field JSON blob, filtering to PROFILE_FIELDS
on the way in so an unknown/legacy key never gets silently persisted.
`trip_ids_traveled_by` is the single source of "which trips does this user
count as traveling on" (D6) — plan-17b's personal totals import this exact
name, so don't rename it, and no personal aggregate may query TripMembership
for "which trips count" instead of this.
"""
import json
from datetime import date
from typing import Set

from sqlmodel import Session, select

from . import document_crypto
from .models import Traveler

AGE_BAND_INFANT = "infant"
AGE_BAND_CHILD = "child"
AGE_BAND_ADULT = "adult"

# D3: the encrypted profile's exact key set.
PROFILE_FIELDS = (
    "full_name",
    "date_of_birth",
    "sex",
    "nationality",
    "passport_number",
    "passport_issuing_country",
    "email",
    "phone",
    "frequent_flyer",
    "meal_preference",
    "seat_preference",
    "notes",
)


def age_at(dob: date, on: date) -> int:
    """Whole years elapsed from `dob` to `on`, birthday-aware. A Feb 29 DOB
    "has" its birthday on the date Python's own (month, day) comparison
    treats as equivalent (Feb 29 in a leap `on` year; compared as (2, 29)
    otherwise), matching ordinary calendar-age expectations without any
    special-casing."""
    years = on.year - dob.year
    if (on.month, on.day) < (dob.month, dob.day):
        years -= 1
    return years


def age_band(dob: date, on: date) -> str:
    """infant < 2y, child < 12y, else adult (D5 boundaries)."""
    years = age_at(dob, on)
    if years < 2:
        return AGE_BAND_INFANT
    if years < 12:
        return AGE_BAND_CHILD
    return AGE_BAND_ADULT


def encode_profile(data: dict) -> bytes:
    """Filter `data` down to PROFILE_FIELDS, then Fernet-encrypt as JSON.
    Raises document_crypto.DocumentVaultNotConfigured when
    DOCUMENT_ENCRYPTION_KEY is unset, same as every other document_crypto
    caller — routes translate that into a 503 via require_configured()
    before ever reaching here, so this should not raise it in practice."""
    filtered = {k: v for k, v in data.items() if k in PROFILE_FIELDS}
    return document_crypto.encrypt_bytes(json.dumps(filtered).encode())


def decode_profile(blob: bytes) -> dict:
    return json.loads(document_crypto.decrypt_bytes(blob).decode())


def trip_ids_traveled_by(session: Session, email: str) -> Set[int]:
    """Trip ids where `email` (case-insensitive) has a Traveler row — i.e. is
    actually traveling on that trip, not merely a TripMembership (D6)."""
    rows = session.exec(
        select(Traveler.trip_id).where(Traveler.user_email == email.lower())
    ).all()
    return set(rows)
