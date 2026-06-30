#!/usr/bin/env python3
"""Copy all data from one database into another (SQLite → Postgres).

Builds the destination schema separately (alembic upgrade head); this script only
moves rows. Tables are copied in foreign-key dependency order, primary-key ids are
preserved so existing FKs stay valid, and Postgres sequences are reset afterwards
so future inserts don't collide with copied ids.

Usage:
    python scripts/migrate_to_postgres.py \
        --from sqlite:///./travel.db \
        --to   postgresql+psycopg://user:pass@localhost/travelcomp

The destination must already have the schema (run `alembic upgrade head` first)
and should be empty. Re-running is not idempotent — it appends.
"""
import argparse
import sys
from pathlib import Path

# Make `backend` importable when run from the project root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import SQLModel, Session, create_engine, select  # noqa: E402
import backend.models as m  # noqa: E402

# Foreign-key dependency order: parents before children.
COPY_ORDER = [
    m.Trip,
    m.Stop,
    m.ItineraryItem,
    m.TripMembership,
    m.PendingChange,
    m.IngestedEmail,
    m.ProcessedDocument,
    m.UserImportToken,
    m.ItemHistory,
]


def copy_all(source_url: str, dest_url: str) -> dict[str, int]:
    """Copy every table from source to dest. Returns {table_name: row_count}."""
    src_engine = create_engine(
        source_url,
        connect_args={"check_same_thread": False} if source_url.startswith("sqlite") else {},
    )
    dst_engine = create_engine(dest_url)

    counts: dict[str, int] = {}
    with Session(src_engine) as src, Session(dst_engine) as dst:
        for model in COPY_ORDER:
            rows = src.exec(select(model)).all()
            # Detach from the source session by snapshotting field values.
            payloads = [r.model_dump() for r in rows]
            for data in payloads:
                dst.add(model(**data))
            dst.commit()
            counts[model.__tablename__] = len(payloads)
    if dest_url.startswith("postgresql"):
        _reset_sequences(dst_engine)
    return counts


def _id_tables() -> list[str]:
    """Tables with an integer 'id' PK — the ones with a serial sequence to reset.

    Excludes e.g. UserImportToken, which is keyed on user_email.
    """
    return [m.__tablename__ for m in COPY_ORDER if "id" in m.__table__.columns]


def _reset_sequences(engine) -> None:
    """Advance each table's id sequence past the max copied id (Postgres only)."""
    from sqlalchemy import text

    with engine.connect() as conn:
        for model in COPY_ORDER:
            if "id" not in model.__table__.columns:
                continue
            table = model.__tablename__
            # pg_get_serial_sequence returns NULL if the column isn't serial; the
            # WHERE guard skips the setval in that case.
            conn.execute(text(f"""
                SELECT setval(
                    pg_get_serial_sequence('{table}', 'id'),
                    COALESCE((SELECT MAX(id) FROM {table}), 1)
                )
                WHERE pg_get_serial_sequence('{table}', 'id') IS NOT NULL
            """))
        conn.commit()


def main() -> None:
    ap = argparse.ArgumentParser(description="Copy DB rows SQLite → Postgres")
    ap.add_argument("--from", dest="source", required=True, help="source SQLAlchemy URL")
    ap.add_argument("--to", dest="dest", required=True, help="destination SQLAlchemy URL")
    args = ap.parse_args()

    print(f"Copying {args.source} → {args.dest}")
    counts = copy_all(args.source, args.dest)
    total = sum(counts.values())
    for table, n in counts.items():
        print(f"  {table:20s} {n:6d}")
    print(f"Done — {total} rows across {len(counts)} tables.")


if __name__ == "__main__":
    main()
