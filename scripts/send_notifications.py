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
from backend import flight_live, flight_alert_subscriptions  # noqa: E402


def main() -> None:
    with Session(engine) as session:
        n = send_due_notifications(session)
        # Webhook subscriptions (plan-14): reconcile BEFORE polling so a newly
        # subscribed flight is skipped by the poll below on the same tick.
        # Needs AERODATABOX_KEY + AERODATABOX_WEBHOOK_SECRET + PUBLIC_BASE_URL;
        # without them this is a no-op and polling covers everything.
        w = (flight_alert_subscriptions.reconcile_subscriptions(session)
             if flight_alert_subscriptions.enabled() else None)
        # Live flight polling needs AeroDataBox configured — skip quietly on
        # servers that don't have it set, rather than erroring the cron. With
        # webhook mode active it still runs as the per-flight fallback for any
        # flight whose subscription couldn't be created.
        a = send_flight_alerts(session) if flight_live.AERODATABOX_KEY else 0
        # Rail polling uses the free, unauthenticated transport.rest API — no
        # key to gate on, so this always runs.
        r = send_rail_alerts(session)
        b = send_booking_reminders(session)
        # No external API dependency (pure DB query + push), so this always runs.
        e = send_document_expiry_reminders(session)
    if w:
        refilled = f", refilled {w['refilled']}" if w["refilled"] else ""
        no_coverage = f", {w['no_coverage']} skipped (no live coverage)" if w["no_coverage"] else ""
        webhook_part = (f", webhook subs +{w['subscribed']}/-{w['unsubscribed']}"
                        f" (credits: {w['credits']}{refilled}){no_coverage}")
    else:
        webhook_part = ""
    print(
        f"{datetime.now(timezone.utc):%F %T} processed {n} notification trigger{'' if n == 1 else 's'}"
        f", {a} flight alert{'' if a == 1 else 's'}"
        f", {r} rail alert{'' if r == 1 else 's'}"
        f", {b} booking reminder{'' if b == 1 else 's'}"
        f", {e} document expiry reminder{'' if e == 1 else 's'}"
        f"{webhook_part}"
    )


if __name__ == "__main__":
    main()
