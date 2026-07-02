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
from backend.notifications import send_due_notifications  # noqa: E402


def main() -> None:
    with Session(engine) as session:
        n = send_due_notifications(session)
    print(f"{datetime.now(timezone.utc):%F %T} processed {n} notification trigger{'' if n == 1 else 's'}")


if __name__ == "__main__":
    main()
