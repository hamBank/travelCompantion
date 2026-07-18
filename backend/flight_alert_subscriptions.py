"""AeroDataBox Flight Alert (webhook) subscriptions — plan 14.

Replaces flat polling for flights that can be subscribed: AeroDataBox POSTs a
FlightNotificationContract to our /webhooks/aerodatabox/{secret} endpoint on
any actual change, billed 1 credit per flight item per notification sent.

Spike-confirmed behavior this module leans on (docs/plans/plan-14):
* The production RapidAPI key works on all /subscriptions/* endpoints.
* Alert credits are a SEPARATE balance starting at 0; a zero balance silently
  pauses every subscription (isActive: false), and refilling reactivates them
  automatically — so reconcile() keeps the balance above a floor by
  converting API quota units to credits at 1:1.
* Deliveries carry no signature header; the unguessable path secret in the
  webhook URL is the only authentication.

Webhook mode is enabled only when AERODATABOX_KEY, AERODATABOX_WEBHOOK_SECRET
and PUBLIC_BASE_URL are all set; otherwise the existing polling path in
backend/notifications.py covers everything, unchanged.
"""
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from sqlmodel import Session, select

from .flight_live import AERODATABOX_KEY, _AERODATABOX_BASE
from .metrics import record_external_call, flight_alert_credits
from .models import AirportCoverage, ItineraryItem, ItemKind
from .rate_limit import throttle

WEBHOOK_SECRET = os.getenv("AERODATABOX_WEBHOOK_SECRET", "")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")

# Subscribe flights departing within this window. AeroDataBox notifications
# cover flights from 6h in the past to 72h in the future, so 72h captures the
# full coverage (and closes the 48h check-in-window gap polling had).
SUBSCRIBE_WINDOW_HOURS = 72

# Keep the alert-credit balance at or above this floor; refill (from the API
# quota, 1 unit = 1 credit) in this increment when it dips below. A zero
# balance silently pauses ALL subscriptions, so the floor is load-bearing.
CREDIT_FLOOR = int(os.getenv("FLIGHT_ALERT_CREDIT_FLOOR", "20"))
CREDIT_REFILL = int(os.getenv("FLIGHT_ALERT_CREDIT_REFILL", "50"))

# Feed statuses that mean "there's a real chance of getting live updates" —
# only Down/Unavailable are a confident "this subscription would never fire"
# signal (see FeedServiceStatus in the RapidAPI spec: Degraded/OKPartial/OK
# all mean the feed is at least partially live; Unknown is genuinely unknown,
# not evidence of absence, so it's treated the same as "usable").
_COVERAGE_OK_STATUSES = {"OK", "OKPartial", "Degraded", "Unknown"}

# How long a cached coverage check is trusted before re-checking (the FREE
# TIER feed-status call, not the ICAO lookup — that's cached forever once
# resolved, since airport codes don't change).
COVERAGE_RECHECK_DAYS = int(os.getenv("FLIGHT_ALERT_COVERAGE_RECHECK_DAYS", "7"))


class FlightAlertApiError(Exception):
    """Raised when a /subscriptions/* call fails (network, non-2xx, bad JSON)."""


def enabled() -> bool:
    return bool(AERODATABOX_KEY and WEBHOOK_SECRET and PUBLIC_BASE_URL)


def webhook_url() -> str:
    return f"{PUBLIC_BASE_URL}/webhooks/aerodatabox/{WEBHOOK_SECRET}"


def _request(method: str, path: str, json_body: Optional[dict] = None) -> httpx.Response:
    throttle("aerodatabox")
    try:
        with httpx.Client(timeout=12) as client:
            r = client.request(
                method, f"{_AERODATABOX_BASE}{path}", json=json_body,
                headers={
                    "X-RapidAPI-Key":  AERODATABOX_KEY,
                    "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
                },
            )
    except Exception as e:
        record_external_call("aerodatabox", ok=False, error=str(e))
        raise FlightAlertApiError(f"Flight Alert API unreachable: {e}")
    if not r.is_success:
        msg = (r.text or "").strip()[:300] or f"API returned {r.status_code}"
        record_external_call("aerodatabox", ok=False, error=msg)
        raise FlightAlertApiError(msg)
    record_external_call("aerodatabox", ok=True)
    return r


def create_subscription(flight_iata: str, *, request=_request) -> dict:
    r = request("POST", f"/subscriptions/webhook/FlightByNumber/{flight_iata}",
                {"url": webhook_url(), "maxDeliveryRetries": 0})
    return r.json()


def list_subscriptions(*, request=_request) -> list[dict]:
    r = request("GET", "/subscriptions/webhook")
    if r.status_code == 204 or not (r.text or "").strip():
        return []
    return r.json()


def delete_subscription(subscription_id: str, *, request=_request) -> None:
    request("DELETE", f"/subscriptions/webhook/{subscription_id}")


def get_balance(*, request=_request) -> int:
    """Remaining alert credits. An empty 200 body (observed live on a
    never-refilled account) means no balance record exists yet — i.e. 0."""
    r = request("GET", "/subscriptions/balance")
    if not (r.text or "").strip():
        return 0
    return int(r.json().get("creditsRemaining", 0))


def refill_balance(credits: int, *, request=_request) -> int:
    r = request("POST", "/subscriptions/balance/refill", {"credits": credits})
    return int(r.json().get("creditsRemaining", credits))


def resolve_icao(iata: str, *, request=_request) -> Optional[str]:
    """IATA → ICAO code (costs API quota, unlike the coverage-status check
    below — this is why it's cached permanently in AirportCoverage.icao)."""
    try:
        r = request("GET", f"/airports/Iata/{iata}")
    except FlightAlertApiError:
        return None
    return r.json().get("icao")


def check_live_updates_ok(icao: str, *, request=_request) -> bool:
    """FREE TIER — whether `icao`'s live-flight-updates feed is usable. See
    docs/plans/plan-14-flight-alert-webhook-migration.md: confirmed live that
    a Down feed means a webhook subscription for that airport never fires."""
    try:
        r = request("GET", f"/health/services/airports/{icao}/feeds")
    except FlightAlertApiError:
        return True  # a failed *check* isn't evidence of no coverage
    status = ((r.json().get("liveFlightUpdatesFeed") or {}).get("status") or "Unknown")
    return status in _COVERAGE_OK_STATUSES


def get_coverage(session: Session, iata: str, *, now: Optional[datetime] = None,
                  request=_request) -> bool:
    """Cached live-updates coverage for `iata`, refreshing when missing or
    past COVERAGE_RECHECK_DAYS. Defaults to True (attempt subscription) when
    the ICAO lookup itself fails — an API hiccup isn't evidence of no
    coverage, and polling remains the fallback either way if the subscription
    then never delivers anything."""
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    iata = iata.strip().upper()
    row = session.get(AirportCoverage, iata)
    stale = row is None or (now - row.checked_at) > timedelta(days=COVERAGE_RECHECK_DAYS)
    if not stale:
        return row.live_updates_ok

    icao = row.icao if row and row.icao else resolve_icao(iata, request=request)
    live_ok = check_live_updates_ok(icao, request=request) if icao else True

    if row:
        row.icao = icao
        row.live_updates_ok = live_ok
        row.checked_at = now
    else:
        row = AirportCoverage(iata=iata, icao=icao, live_updates_ok=live_ok, checked_at=now)
    session.add(row)
    session.commit()
    return live_ok


def _flight_depart_utc(session: Session, item: ItineraryItem) -> Optional[datetime]:
    # Late import: notifications.py must stay importable without this module.
    from .notifications import _local_to_utc, _stop_utc_offset_hours
    d = item.details or {}
    depart_local = d.get("depart_time")
    if not depart_local:
        return None
    fallback = None if d.get("depart_tz") else _stop_utc_offset_hours(session, item)
    return _local_to_utc(depart_local, d.get("depart_tz"), fallback_offset_hours=fallback)


def reconcile_subscriptions(session: Session, *, now: Optional[datetime] = None,
                             request=_request) -> dict:
    """Keep AeroDataBox webhook subscriptions in sync with flight items.

    * Subscribes every flight item with a flight_number departing within the
      next SUBSCRIBE_WINDOW_HOURS that doesn't have a subscription yet,
      storing the subscription id in item.details["alert_subscription_id"]
      (which is also what makes send_flight_alerts skip polling it — see
      backend/notifications.py; a failed create leaves no id, so polling
      remains that flight's fallback).
    * Deletes remote subscriptions no longer referenced by any in-window item
      (departed flights, deleted items, edited-away flight numbers) and
      clears the stale id from any item still carrying it.
    * Tops up the alert-credit balance when below CREDIT_FLOOR and exports it
      as a Prometheus gauge either way.
    * Skips subscribing a flight whose origin airport's live-updates feed is
      Down/Unavailable (see get_coverage) — such a subscription would never
      deliver a notification, wasting a credit-consuming subscription for
      nothing. The flight is left unsubscribed, same as a failed create, so
      polling remains its fallback.

    Returns a summary dict for the cron log.
    """
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    window_end = now + timedelta(hours=SUBSCRIBE_WINDOW_HOURS)
    summary = {"subscribed": 0, "unsubscribed": 0, "credits": None, "refilled": 0,
               "no_coverage": 0}

    flights = session.exec(
        select(ItineraryItem).where(ItineraryItem.kind == ItemKind.flight)
    ).all()

    # Desired state: in-window flights, keyed by the subscription they hold.
    desired_ids: set[str] = set()
    to_subscribe: list[ItineraryItem] = []
    for item in flights:
        d = item.details or {}
        flight_iata = (d.get("flight_number") or "").replace(" ", "").upper()
        if not flight_iata:
            continue
        depart = _flight_depart_utc(session, item)
        in_window = depart is not None and now < depart <= window_end
        sub_id = d.get("alert_subscription_id")
        if in_window:
            if sub_id:
                desired_ids.add(sub_id)
            else:
                to_subscribe.append(item)
        elif sub_id:
            # Departed or moved out of window — the remote side is cleaned up
            # below (it's not in desired_ids); drop our reference now.
            item.details = {k: v for k, v in d.items() if k != "alert_subscription_id"}
            session.add(item)

    # Balance first: a create against a zero balance yields a paused
    # subscription, so top up before subscribing anything new.
    try:
        credits = get_balance(request=request)
        if credits < CREDIT_FLOOR:
            credits = refill_balance(CREDIT_REFILL, request=request)
            summary["refilled"] = CREDIT_REFILL
        summary["credits"] = credits
        flight_alert_credits.set(credits)
    except FlightAlertApiError:
        pass  # balance check failing shouldn't block subscription sync

    for item in to_subscribe:
        d = item.details or {}
        flight_iata = (d.get("flight_number") or "").replace(" ", "").upper()
        origin = (d.get("origin") or "").strip()
        if origin and not get_coverage(session, origin, now=now, request=request):
            summary["no_coverage"] += 1
            continue  # no id stored → polling keeps covering this flight
        try:
            sub = create_subscription(flight_iata, request=request)
        except FlightAlertApiError:
            continue  # no id stored → polling keeps covering this flight
        item.details = {**d, "alert_subscription_id": sub["id"]}
        session.add(item)
        desired_ids.add(sub["id"])
        summary["subscribed"] += 1

    try:
        for sub in list_subscriptions(request=request):
            if sub.get("id") not in desired_ids:
                delete_subscription(sub["id"], request=request)
                summary["unsubscribed"] += 1
    except FlightAlertApiError:
        pass  # cleanup failing is retried next cron tick

    session.commit()
    return summary
