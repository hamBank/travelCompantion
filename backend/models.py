from typing import Optional, List
from datetime import datetime
from enum import Enum
from sqlmodel import SQLModel, Field, Relationship


class StopStatus(str, Enum):
    planned = "planned"
    confirmed = "confirmed"
    completed = "completed"
    cancelled = "cancelled"


class ItemKind(str, Enum):
    activity = "activity"
    restaurant = "restaurant"
    note = "note"


class ItemStatus(str, Enum):
    pending = "pending"
    done = "done"
    skipped = "skipped"


# ── Trip ──────────────────────────────────────────────────────────────────────

class TripBase(SQLModel):
    name: str


class Trip(TripBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    stops: List["Stop"] = Relationship(back_populates="trip")


class TripCreate(TripBase):
    pass


class TripUpdate(SQLModel):
    name: Optional[str] = None


class TripRead(TripBase):
    id: int
    created_at: datetime


# ── Stop ──────────────────────────────────────────────────────────────────────

class StopBase(SQLModel):
    location: str
    country: str = ""
    arrive: Optional[datetime] = None
    depart: Optional[datetime] = None
    accommodation: str = ""
    accommodation_link: str = ""
    accommodation_notes: str = ""
    check_in: str = ""
    check_out: str = ""
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


class StopCreate(StopBase):
    pass


class StopUpdate(SQLModel):
    location: Optional[str] = None
    country: Optional[str] = None
    arrive: Optional[datetime] = None
    depart: Optional[datetime] = None
    accommodation: Optional[str] = None
    accommodation_link: Optional[str] = None
    accommodation_notes: Optional[str] = None
    check_in: Optional[str] = None
    check_out: Optional[str] = None
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


class ItemCreate(ItemBase):
    pass


class ItemUpdate(SQLModel):
    kind: Optional[ItemKind] = None
    name: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    link: Optional[str] = None
    cost: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[ItemStatus] = None


class ItemRead(ItemBase):
    id: int
    stop_id: int
