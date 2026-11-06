"""store instants as timestamptz (fleet spec DB-8)

TC's 27 instant columns (audit/cache timestamps: created_at, fetched_at, ...)
were created as `timestamp without time zone`. Two different things have been
written into them on the Postgres database (live since 2026-06-30):

* before #194 (2026-09-24 ~00:00 UTC) the app wrote naive UTC, so the stored
  value IS the UTC instant;
* since #194 it writes aware UTC datetimes. psycopg sends those as timestamptz,
  and Postgres stores them in a plain `timestamp` column as the wall-clock time
  in the session's TimeZone (prod: Europe/Berlin, so +1h/+2h). SQLModel then
  reads the value back and labels it UTC, i.e. every read was 1-2h ahead.
  Verified against prod 2026-11-06: 05:14 UTC written, 06:14 stored.

So the conversion depends on the row's era. Older rows are read as UTC
(`AT TIME ZONE 'UTC'`); newer rows are read in the session TimeZone, which is
exactly how they were written (the plain cast, no hard-coded zone, so it
recovers the instant whatever zone the server runs in). The cutover is
2026-09-24 00:00: deploy lag after #194's merge (23:15 UTC) is minutes, and any
row written after the deploy has a wall-clock value of at least 01:15, so the
two eras cannot overlap around it.

Wall-clock fields (Stop.arrive/depart, Trip dates, ItineraryItem.scheduled_at,
...) are NaiveDatetime and deliberately stay `timestamp`.

SQLite has no column types to change, so this is a no-op there.

Downgrade casts back to the session-zone wall clock (the inverse of the newer
era's rule). Pre-cutover rows come back as session-zone wall time rather than
their original UTC text; that information is not recoverable and no longer
matters once the app writes aware values.

Revision ID: a3f1c8d2e7b4
Revises: 9a88f48bcd59
Create Date: 2026-11-06 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3f1c8d2e7b4'
down_revision: Union[str, Sequence[str], None] = '9a88f48bcd59'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: Stored values below this are UTC; at or above it, session-zone wall clock.
CUTOVER = "2026-09-24 00:00:00"

#: (table, column, nullable) for every instant column (sqlmodel UTCDateTime).
COLUMNS = [
    ("airportcoverage", "checked_at", False),
    ("apitoken", "created_at", False),
    ("apitoken", "expires_at", True),
    ("apitoken", "revoked_at", True),
    ("bag", "created_at", False),
    ("expense", "created_at", False),
    ("ingestedemail", "received_at", False),
    ("itemattachment", "created_at", False),
    ("itemhistory", "changed_at", False),
    ("locationcoords", "resolved_at", False),
    ("locationtimezone", "resolved_at", False),
    ("notificationlog", "sent_at", False),
    ("packingitem", "created_at", False),
    ("pendingchange", "created_at", False),
    ("pendingchange", "decided_at", True),
    ("processeddocument", "processed_at", False),
    ("pushsubscription", "created_at", False),
    ("traveler", "created_at", False),
    ("traveler", "updated_at", False),
    ("trip", "created_at", False),
    ("tripmembership", "created_at", False),
    ("userdistancetotal", "updated_at", False),
    ("userdocument", "created_at", False),
    ("userdocument", "updated_at", False),
    ("userdocumentfile", "created_at", False),
    ("userimporttoken", "created_at", False),
    ("weathercache", "fetched_at", False),
]


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    """Upgrade schema."""
    if not _is_postgres():
        return
    for table, column, nullable in COLUMNS:
        using = (
            f'CASE WHEN "{column}" < TIMESTAMP \'{CUTOVER}\' '
            f'THEN "{column}" AT TIME ZONE \'UTC\' '
            f'ELSE "{column}"::timestamptz END'
        )
        op.alter_column(
            table,
            column,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=using,
        )


def downgrade() -> None:
    """Downgrade schema."""
    if not _is_postgres():
        return
    for table, column, nullable in COLUMNS:
        op.alter_column(
            table,
            column,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f'"{column}"::timestamp',
        )
