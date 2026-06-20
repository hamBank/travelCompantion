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


class ItemStatus(str, Enum):
    pending = "pending"
    done = "done"
    skipped = "skipped"


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
