#!/usr/bin/env python3
"""Send due push notifications (flight check-in opens, transport departure approaching).

Run frequently via cron (e.g. every 15 min) with DATABASE_URL and VAPID_PRIVATE_KEY
set — see backend/notifications.py for the trigger logic.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import Session  # noqa: E402
from backend.database import engine  # noqa: E402
from backend.notifications import (  # noqa: E402
    send_due_notifications, send_flight_alerts, send_rail_alerts, send_booking_reminders,
    send_document_expiry_reminders,
)
from backend import flight_live  # noqa: E402


def main() -> None:
    with Session(engine) as session:
        n = send_due_notifications(session)
        # Live flight polling needs AeroDataBox configured — skip quietly on
        # servers that don't have it set, rather than erroring the cron.
        a = send_flight_alerts(session) if flight_live.AERODATABOX_KEY else 0
        # Rail polling uses the free, unauthenticated transport.rest API — no
        # key to gate on, so this always runs.
        r = send_rail_alerts(session)
        b = send_booking_reminders(session)
        # No external API dependency (pure DB query + push), so this always runs.
        e = send_document_expiry_reminders(session)
    print(
        f"{datetime.now(timezone.utc):%F %T} processed {n} notification trigger{'' if n == 1 else 's'}"
        f", {a} flight alert{'' if a == 1 else 's'}"
        f", {r} rail alert{'' if r == 1 else 's'}"
        f", {b} booking reminder{'' if b == 1 else 's'}"
        f", {e} document expiry reminder{'' if e == 1 else 's'}"
    )


if __name__ == "__main__":
    main()
