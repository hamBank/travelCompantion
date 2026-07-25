#!/usr/bin/env python3
"""Reconcile AeroDataBox Flight Alert (webhook) subscriptions — plan 14.

Deliberately on its OWN, much coarser cron than scripts/send_notifications.py
(15 min). reconcile_subscriptions() makes at least two AeroDataBox API calls
every time it runs regardless of whether anything changed (get_balance +
list_subscriptions), which on a 15-minute cadence is ~192 calls/day — already
~10x AeroDataBox's 600-unit/month free-tier budget from that guaranteed
per-tick overhead alone, before counting actual subscribes/refills/coverage
checks or the fallback polling path. See docs/plans/plan-14 and
docs/plans/plan-14-flight-alert-webhook-migration.md's 2026-07 retune note.

Run every few hours via cron with DATABASE_URL set — subscribing a
newly-added flight a little later than instantly is a fine trade for staying
inside quota. A no-op (and cheap: just an env-var check) when webhook mode
isn't configured (AERODATABOX_KEY / AERODATABOX_WEBHOOK_SECRET /
PUBLIC_BASE_URL) — polling in scripts/send_notifications.py covers
everything in that case, unchanged.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import Session  # noqa: E402
from backend.database import engine  # noqa: E402
from backend import flight_alert_subscriptions  # noqa: E402


def main() -> None:
    if not flight_alert_subscriptions.enabled():
        print(f"{datetime.now(timezone.utc):%F %T} webhook mode not configured — skipping")
        return
    with Session(engine) as session:
        w = flight_alert_subscriptions.reconcile_subscriptions(session)
    refilled = f", refilled {w['refilled']}" if w["refilled"] else ""
    no_coverage = f", {w['no_coverage']} skipped (no live coverage)" if w["no_coverage"] else ""
    print(
        f"{datetime.now(timezone.utc):%F %T} webhook subs +{w['subscribed']}/-{w['unsubscribed']}"
        f" (credits: {w['credits']}{refilled}){no_coverage}"
    )


if __name__ == "__main__":
    main()
