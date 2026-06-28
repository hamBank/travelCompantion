from typing import Optional, List
from datetime import datetime
from enum import Enum
from sqlmodel import SQLModel, Field, Relationship
from sqlalchemy import Column, JSON


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


class Trip(TripBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    stops: List["Stop"] = Relationship(back_populates="trip")


class TripCreate(TripBase):
    pass


class TripUpdate(SQLModel):
    name: Optional[str] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None


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


class UserImportToken(SQLModel, table=True):
    """Per-user secret embedded in their forwarding address (import+<token>@…)."""
    user_email: str = Field(primary_key=True)   # lowercased
    token: str = Field(index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
