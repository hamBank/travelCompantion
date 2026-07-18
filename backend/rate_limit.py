"""Minimal per-service call spacing for third-party APIs with a tight
per-second rate limit — RapidAPI's BASIC plan rejects two AeroDataBox calls
made back-to-back (confirmed live 2026-07-18: reconcile_subscriptions'
get_balance() immediately followed by list_subscriptions() 429'd every time).
Shared across flight_alert_subscriptions.py (subscription calls) and
flight_live.py (polling) since both use the same RapidAPI key and therefore
the same rate limit — one module's last call can starve the other's next one
just as easily as its own.

Default interval history: 1.2s (the exact gap that worked in one manual
test) still produced an occasional 429 in production on the very next
verification run — a "per-second" cap enforced as a fixed window can reject
two calls 1.2s apart if they straddle a window boundary unluckily. 2.0s
leaves real margin; this only runs from a 15-minute cron, so a couple of
extra seconds of spacing costs nothing.
"""
import time
import threading

_lock = threading.Lock()
_last_call: dict[str, float] = {}


def throttle(service: str, min_interval: float = 2.0) -> None:
    """Block until at least `min_interval` seconds have passed since the last
    throttled call for this service, then record now as the new last call."""
    with _lock:
        last = _last_call.get(service)
        now = time.monotonic()
        if last is not None:
            wait = min_interval - (now - last)
            if wait > 0:
                time.sleep(wait)
                now = time.monotonic()
        _last_call[service] = now
