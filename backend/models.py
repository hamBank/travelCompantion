from typing import Optional, List
from datetime import datetime
from enum import Enum
from sqlmodel import SQLModel, Field, Relationship
from sqlalchemy import Column, JSON, LargeBinary


class StopStatus(str, Enum):
    planned = "planned"
    confirmed = "confirmed"
    completed = "completed"
    cancelled = "cancelled"


class ItemKind(str, Enum):
    activity = "activity"
    restaurant = "restaurant"
    note = "note"
    accommodation = "accommodation"
    flight = "flight"
    cycling = "cycling"
    rail = "rail"
    walk = "walk"
    transfer = "transfer"
    tour = "tour"
    food = "food"
    purchase = "purchase"
    show = "show"
    hire = "hire"
    river_transfer = "river_transfer"


class ItemStatus(str, Enum):
    pending = "pending"
    done = "done"
    skipped = "skipped"


class TripRole(str, Enum):
    owner = "owner"
    editor = "editor"
    viewer = "viewer"


# Higher number = more privilege. Used for "at least this role" checks.
ROLE_RANK = {TripRole.viewer: 1, TripRole.editor: 2, TripRole.owner: 3}


# ── Trip ──────────────────────────────────────────────────────────────────────

class TripBase(SQLModel):
    name: str
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    # Cost-style string like "5000 AUD", parsed client-side (parseCost) same
    # as item costs — stored opaquely here, same convention as ItineraryItem.cost.
    budget: Optional[str] = None


class Trip(TripBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    stops: List["Stop"] = Relationship(back_populates="trip")
    # Revocable public read-only share link — GET /shared/{share_token}/timeline.
    # None means sharing is off. Regenerating (POST /trips/{id}/share-token)
    # replaces the value, invalidating any previously shared link; revoking
    # (DELETE) sets it back to None. Deliberately NOT part of TripBase/TripRead/
    # TripTimeline — it's a capability secret, not trip data, and must never
    # round-trip through any endpoint a non-owner (or the public timeline
    # response itself) can read.
    share_token: Optional[str] = Field(default=None, index=True, unique=True)


class TripCreate(TripBase):
    pass


class TripUpdate(SQLModel):
    name: Optional[str] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    budget: Optional[str] = None


class TripRead(TripBase):
    id: int
    created_at: datetime


class TripReadWithRole(TripRead):
    role: TripRole = TripRole.owner


# ── TripMembership (per-trip access control) ───────────────────────────────────

class TripMembership(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    user_email: str = Field(index=True)
    role: TripRole = TripRole.viewer
    created_at: datetime = Field(default_factory=datetime.utcnow)


class MembershipRead(SQLModel):
    user_email: str
    role: TripRole


class MembershipCreate(SQLModel):
    user_email: str
    role: TripRole = TripRole.viewer


# ── Stop ──────────────────────────────────────────────────────────────────────

class StopBase(SQLModel):
    location: str
    country: str = ""
    arrive: Optional[datetime] = None
    depart: Optional[datetime] = None
    timezone: str = "0"
    lat: str = ""
    lng: str = ""
    sort_order: int = 0
    status: StopStatus = StopStatus.planned


class Stop(StopBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id")
    trip: Optional[Trip] = Relationship(back_populates="stops")
    items: List["ItineraryItem"] = Relationship(back_populates="stop")
    # Legacy columns kept in DB; data is migrated to ItineraryItem on startup
    accommodation: str = Field(default="")
    accommodation_link: str = Field(default="")
    accommodation_notes: str = Field(default="")
    check_in: str = Field(default="")
    check_out: str = Field(default="")


class StopCreate(StopBase):
    pass


class StopUpdate(SQLModel):
    location: Optional[str] = None
    country: Optional[str] = None
    arrive: Optional[datetime] = None
    depart: Optional[datetime] = None
    timezone: Optional[str] = None
    lat: Optional[str] = None
    lng: Optional[str] = None
    sort_order: Optional[int] = None
    status: Optional[StopStatus] = None
    # Offline queue replay (plan 11): base value of each changed field as seen
    # by the client at edit time, for compare-and-set conflict detection.
    base: Optional[dict] = None


class StopRead(StopBase):
    id: int
    trip_id: int


# ── ItineraryItem ─────────────────────────────────────────────────────────────

class ItemBase(SQLModel):
    kind: ItemKind = ItemKind.activity
    name: str
    scheduled_at: Optional[datetime] = None
    link: str = ""
    cost: str = ""
    notes: str = ""
    status: ItemStatus = ItemStatus.pending


class ItineraryItem(ItemBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    stop_id: int = Field(foreign_key="stop.id")
    stop: Optional[Stop] = Relationship(back_populates="items")
    details: Optional[dict] = Field(default=None, sa_column=Column(JSON))


class ItemCreate(ItemBase):
    details: Optional[dict] = None


class ItemUpdate(SQLModel):
    kind: Optional[ItemKind] = None
    name: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    link: Optional[str] = None
    cost: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[ItemStatus] = None
    details: Optional[dict] = None
    # Offline queue replay (plan 11): base value of each changed top-level
    # field, and of each changed `details` key, as seen by the client at edit
    # time. See backend/compare_and_set.py.
    base: Optional[dict] = None


class ItemRead(ItemBase):
    id: int
    stop_id: int
    details: Optional[dict] = None


# ── PendingChange (review-before-apply staging for imports) ────────────────────

class PendingStatus(str, Enum):
    pending = "pending"
    applied = "applied"
    discarded = "discarded"


class PendingChange(SQLModel, table=True):
    """A proposed itinerary change awaiting human review.

    Fed initially by in-app document upload; later by inbound email. Applying a
    pending change routes through the same item create/update path (permission
    checked) — the mail/import side never writes items directly.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    created_by: str = Field(index=True)              # owning user's email (lowercased)
    source: str = "upload"                            # upload | email
    source_email_id: Optional[int] = None             # set in the email phase
    trip_id: Optional[int] = Field(default=None, index=True)
    op: str = "create"                                # create | update
    target_item_id: Optional[int] = None              # set when op == update
    suggested_stop_id: Optional[int] = None
    kind: ItemKind = ItemKind.activity
    # payload mirrors the item edit shape: {name, scheduled_at, cost, link, notes, details}
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    diff: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    confidence: str = "low"
    match_reason: str = ""
    status: PendingStatus = PendingStatus.pending
    created_at: datetime = Field(default_factory=datetime.utcnow)
    decided_at: Optional[datetime] = None
    decided_by: str = ""


class PendingChangeRead(SQLModel):
    id: int
    created_by: str
    source: str
    source_email_id: Optional[int] = None
    trip_id: Optional[int] = None
    op: str
    target_item_id: Optional[int] = None
    suggested_stop_id: Optional[int] = None
    kind: ItemKind
    payload: dict = {}
    diff: Optional[dict] = None
    confidence: str
    match_reason: str
    status: PendingStatus
    created_at: datetime


class PendingChangeUpdate(SQLModel):
    trip_id: Optional[int] = None
    suggested_stop_id: Optional[int] = None
    kind: Optional[ItemKind] = None
    payload: Optional[dict] = None


# ── Email ingestion ────────────────────────────────────────────────────────────

class IngestedEmail(SQLModel, table=True):
    """A forwarded email saved for parsing, debugging, and future source display."""
    id: Optional[int] = Field(default=None, primary_key=True)
    received_at: datetime = Field(default_factory=datetime.utcnow)
    from_addr: str = ""
    to_addr: str = ""
    subject: str = ""
    storage_dir: str = ""               # uuid dir under the mail store
    resolved_user_email: str = ""       # from the +token in the recipient
    status: str = "received"            # received | parsed | error
    parse_error: str = ""
    item_count: int = 0


class IngestedEmailRead(SQLModel):
    """API-safe view of a stored email, including the extracted text body."""
    id: int
    received_at: datetime
    from_addr: str
    to_addr: str
    subject: str
    status: str
    parse_error: str
    item_count: int
    body_text: str = ""   # extracted plain-text body; empty if file unavailable


class ProcessedDocument(SQLModel, table=True):
    """Hash-based cache of already-imported documents.

    Keyed on SHA256(trip_id + sorted file bytes) so re-uploading the same
    file for the same trip skips the Claude API call entirely.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    cache_key: str = Field(index=True)          # hex SHA256
    trip_id: Optional[int] = None
    item_count: int = 0
    processed_at: datetime = Field(default_factory=datetime.utcnow)


class UserImportToken(SQLModel, table=True):
    """Per-user secret embedded in their forwarding address (import+<token>@…)."""
    user_email: str = Field(primary_key=True)   # lowercased
    token: str = Field(index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Bag(SQLModel, table=True):
    """A piece of luggage for a trip (shared/trip-level). Packing items go in one.
    Bags may nest (parent_id) — e.g. a packing cube inside a suitcase. `packed`
    is a manual, independent flag for the bag itself (not derived from its
    contents): zipping up a packing cube is a single action, not one you want
    to re-confirm by checking every item inside it again, so this lets a bag
    be marked done as a unit — its subtree then rolls up as fully packed
    regardless of the actual state of the items/sub-bags inside it."""
    id: Optional[int] = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    name: str
    parent_id: Optional[int] = Field(default=None, foreign_key="bag.id")
    packed: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)


class PackingItem(SQLModel, table=True):
    """A thing to pack. owner_email == "" means a SHARED item (everyone sees it);
    otherwise it's personal to that user and only they see it. quantity/packed_count
    track partial packing (e.g. 3 of 5 socks packed)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    name: str
    owner_email: str = Field(default="", index=True)   # "" = shared
    bag_id: Optional[int] = Field(default=None, foreign_key="bag.id")
    quantity: int = 1
    packed_count: int = 0
    sort_order: int = 0
    created_at: datetime = Field(default_factory=datetime.utcnow)


class BagCreate(SQLModel):
    name: str
    parent_id: Optional[int] = None


class BagUpdate(SQLModel):
    name: Optional[str] = None
    parent_id: Optional[int] = None
    packed: Optional[bool] = None


class BagRead(SQLModel):
    id: int
    trip_id: int
    name: str
    parent_id: Optional[int] = None
    packed: bool = False


class PackingItemCreate(SQLModel):
    name: str
    shared: bool = False
    bag_id: Optional[int] = None
    quantity: int = 1
    packed_count: int = 0


class PackingItemUpdate(SQLModel):
    name: Optional[str] = None
    shared: Optional[bool] = None
    bag_id: Optional[int] = None
    quantity: Optional[int] = None
    packed_count: Optional[int] = None
    # Offline queue replay (plan 11): base value of each changed field as seen
    # by the client at edit time, for compare-and-set conflict detection.
    base: Optional[dict] = None


class PackingItemRead(SQLModel):
    id: int
    trip_id: int
    name: str
    owner_email: str          # "" = shared; frontend compares to current user
    bag_id: Optional[int] = None
    quantity: int
    packed_count: int


class PushSubscription(SQLModel, table=True):
    """One browser/device's Web Push subscription. A user may have several
    (phone, laptop, etc.) — "disable per device" means deleting just that
    device's row, which is what unsubscribing does."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_email: str = Field(index=True)
    endpoint: str = Field(unique=True, index=True)
    p256dh: str
    auth: str
    device_label: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)


class PushSubscriptionCreate(SQLModel):
    endpoint: str
    p256dh: str
    auth: str
    device_label: str = ""


class NotificationLog(SQLModel, table=True):
    """Records that a notification for (item_id, kind) has already been sent,
    so the periodic job never double-sends across runs."""
    id: Optional[int] = Field(default=None, primary_key=True)
    item_id: int = Field(index=True)
    kind: str                                    # "checkin_heads_up" | "checkin" | "departure"
                                                  # | "booking_soon" | "booking_due" | ...
    sent_at: datetime = Field(default_factory=datetime.utcnow)


class WeatherCache(SQLModel, table=True):
    """6-hour cache of Open-Meteo lookups, keyed by rounded coords + date range.

    Climatology is near-static and forecasts change slowly, so caching avoids
    hammering the API (and surviving restarts means deploys don't re-fetch).
    """
    cache_key: str = Field(primary_key=True)    # "lat,lng,start,end" (coords rounded)
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    fetched_at: datetime = Field(default_factory=datetime.utcnow)


class LocationTimezone(SQLModel, table=True):
    """Cache of location name → IANA timezone, resolved via Nominatim + Open-Meteo
    by scripts/refresh_location_timezones.py (never resolved live in a request —
    see backend/tz_check.py). Timezones are effectively permanent, so there's no
    TTL; a location is re-resolved only if it's missing from this table.
    """
    location: str = Field(primary_key=True)     # normalized place name or "<IATA> airport"
    iana_zone: str                                # e.g. "Europe/Rome"
    resolved_at: datetime = Field(default_factory=datetime.utcnow)


class AirportCoverage(SQLModel, table=True):
    """Cache of AeroDataBox ADS-B/live-flight-update coverage per airport, used
    by backend/flight_alert_subscriptions.py to skip webhook subscriptions for
    flights whose airport has no live data feed — such a subscription would
    never deliver a notification (confirmed live 2026-07-18: Rome Fiumicino's
    liveFlightUpdatesFeed was "Down"). `icao` is cached permanently once
    resolved (airport codes don't change; resolving it costs API quota, unlike
    the free-tier coverage-status check); `live_updates_ok`/`checked_at` are
    re-checked periodically since feed outages come and go.
    """
    iata: str = Field(primary_key=True)          # as stored in item.details["origin"]
    icao: Optional[str] = None                     # None if IATA→ICAO lookup failed
    live_updates_ok: bool = True                   # conservative default until checked
    checked_at: datetime = Field(default_factory=datetime.utcnow)


# ── ItemHistory (versioning / audit log) ──────────────────────────────────────

class ItemHistory(SQLModel, table=True):
    """One entry per create/update/delete on an ItineraryItem.

    item_id is intentionally not a foreign key so history survives item deletion.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    item_id: int = Field(index=True)
    op: str                                      # "create" | "update" | "delete"
    changed_by: str                              # user email
    changed_at: datetime = Field(default_factory=datetime.utcnow)
    snapshot: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    diff: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    source: str = ""                             # "" (manual) | "upload" | "email"


class ItemHistoryRead(SQLModel):
    id: int
    item_id: int
    op: str
    changed_by: str
    changed_at: datetime
    snapshot: Optional[dict] = None
    diff: Optional[dict] = None
    source: str = ""


# ── ItemAttachment (boarding passes, booking PDFs, QR codes) ──────────────────

class ItemAttachment(SQLModel, table=True):
    """A file attached to an itinerary item, viewable at the gate even under
    offline-ish conditions. Stored as a blob directly in the DB (not on disk)
    so the existing single-database backup story covers attachments too — no
    separate uploads-directory to back up in sync with the DB.

    item_id IS a real foreign key (unlike ItemHistory) — attachments aren't an
    audit trail meant to outlive the item; deleting the item removes them too
    (see delete_item in routers/items.py, which deletes these rows first).
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    item_id: int = Field(foreign_key="itineraryitem.id", index=True)
    filename: str
    content_type: str = ""
    size: int = 0
    data: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ItemAttachmentRead(SQLModel):
    """API-safe view of an attachment — deliberately omits `data` so listing
    attachments never ships the raw bytes; those are only served one-at-a-time
    by GET /attachments/{id}."""
    id: int
    item_id: int
    filename: str
    content_type: str
    size: int
    created_at: datetime


# ── Expense (actual, real-world logged spend — issue #59) ─────────────────────

class ExpenseBase(SQLModel):
    name: str
    # Free-text cost string, e.g. "500 THB" — same convention as
    # ItineraryItem.cost, parsed client-side via parseCost().
    amount: str
    occurred_at: datetime = Field(default_factory=datetime.utcnow)
    notes: str = ""


class Expense(ExpenseBase, table=True):
    """An actual, real-world spend logged during a trip — distinct from
    ItineraryItem.cost/details.amount_paid, which track a *planned* item's
    expected cost and how much of it has been paid so far. An Expense is a
    point-in-time event ("I spent X just now"), optionally tied to a specific
    planned item (for a plan-vs-actual comparison) or a stop (for a per-stop/
    per-day rollup) — but plenty of real spend has neither: a snack, a taxi,
    a souvenir that was never itemized in the plan. Per-trip only (no
    personal/shared split like PackingItem) — spend tracking is a whole-trip
    concern.

    converted_amount/converted_currency are a snapshot of the home-currency
    conversion taken at entry time (same pattern as ItineraryItem's
    details.converted_cost) — deliberately NOT recomputed if the user's home
    currency preference changes later, so a trip's running total stays
    stable rather than drifting underfoot each time it's viewed.

    stop_id/item_id are real FKs (unlike ItemHistory's deliberately-bare
    item_id) but deleting the stop/item only unlinks the expense (nulls the
    FK) rather than deleting it — the money was still spent regardless of
    whether the plan changed after the fact. See delete_stop/delete_item in
    routers/stops.py/items.py. Deleting the whole trip removes its expenses
    too (see delete_trip in routers/trips.py) — nothing to preserve them for.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    stop_id: Optional[int] = Field(default=None, foreign_key="stop.id", index=True)
    item_id: Optional[int] = Field(default=None, foreign_key="itineraryitem.id", index=True)
    converted_amount: Optional[float] = None
    converted_currency: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ExpenseCreate(ExpenseBase):
    stop_id: Optional[int] = None
    item_id: Optional[int] = None
    converted_amount: Optional[float] = None
    converted_currency: Optional[str] = None


class ExpenseUpdate(SQLModel):
    """No offline-queue `base` field (unlike PackingItemUpdate/StopUpdate) —
    expense logging follows Bag's precedent (also editor-gated, trip-wide
    financial/organizational data) of being online-only for now, rather than
    every mutable entity in the app automatically getting queue support."""
    name: Optional[str] = None
    amount: Optional[str] = None
    stop_id: Optional[int] = None
    item_id: Optional[int] = None
    occurred_at: Optional[datetime] = None
    notes: Optional[str] = None
    converted_amount: Optional[float] = None
    converted_currency: Optional[str] = None


class ExpenseRead(ExpenseBase):
    id: int
    trip_id: int
    stop_id: Optional[int] = None
    item_id: Optional[int] = None
    converted_amount: Optional[float] = None
    converted_currency: Optional[str] = None


# ── UserDocument vault (passport/licence/visa scans, encrypted at rest) ───────

class UserDocument(SQLModel, table=True):
    """A user's own travel document (passport, driver's licence, visa) —
    never trip-scoped, owner-only, keyed directly on user_email like
    UserImportToken (there's no separate Users table to FK against).

    document_number_encrypted is the sensitive payload; doc_type/label/
    country/expiry_date stay in the clear so they can be queried/rendered
    without a decrypt round-trip (e.g. by the expiry-reminder cron)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_email: str = Field(index=True)
    doc_type: str
    label: str = ""
    country: str = ""
    document_number_encrypted: Optional[bytes] = Field(default=None, sa_column=Column(LargeBinary))
    issued_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    notes: str = ""
    # Fernet-encrypted JSON: {"holder_name", "nationality", "date_of_birth"
    # (YYYY-MM-DD), "sex"} — sourced from passport MRZ OCR (plan-13) or
    # manual entry. Same tier as document_number_encrypted: never queried
    # directly, never in UserDocumentRead, decrypted only via GET .../holder.
    holder_data_encrypted: Optional[bytes] = Field(default=None, sa_column=Column(LargeBinary))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class UserDocumentRead(SQLModel):
    """API-safe view of a document — omits document_number_encrypted; the
    plaintext number is only ever served by GET /me/documents/{id}/number."""
    id: int
    user_email: str
    doc_type: str
    label: str
    country: str
    issued_date: Optional[datetime]
    expiry_date: Optional[datetime]
    notes: str
    created_at: datetime
    updated_at: datetime


class UserDocumentFile(SQLModel, table=True):
    """One or more encrypted scans per document (passport photo page, a visa
    stamp page, a licence's front+back) — same one-to-many blob-in-DB shape
    as ItemAttachment, scoped to UserDocument instead of ItineraryItem.

    document_id is a real FK with no ORM Relationship() — the same shape
    issue #68's Postgres CI job caught as a live delete-ordering bug
    elsewhere (SQLAlchemy's unit-of-work doesn't order relationship-less FK
    deletes correctly). Flush between deleting these rows and deleting the
    parent UserDocument."""
    id: Optional[int] = Field(default=None, primary_key=True)
    document_id: int = Field(foreign_key="userdocument.id", index=True)
    filename: str
    content_type: str = ""
    size: int = 0
    data_encrypted: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class UserDocumentFileRead(SQLModel):
    """API-safe view of a document file — omits data_encrypted; the decrypted
    bytes are only ever served by GET /me/documents/{id}/files/{file_id}."""
    id: int
    document_id: int
    filename: str
    content_type: str
    size: int
    created_at: datetime
