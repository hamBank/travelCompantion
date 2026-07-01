"""Regression test: every static PWA asset the service worker fetches via
importScripts() (or the browser fetches to install the SW at all) must be in
the auth middleware's public allowlist.

Real bug this caught: sw-push.js (added for push notifications) was missing
from _PUBLIC_PREFIXES. Since AUTH_ENABLED requires a Bearer token for anything
not on the allowlist, importScripts('sw-update.js', 'sw-push.js') fetched
sw-push.js with no Authorization header, got a 401, and — per the Service
Worker spec — that makes the entire importScripts() call throw, so the new
service worker (with the push handler) never installed at all. Every device
silently stayed on the last-successfully-installed worker.
"""
from backend.main import _PUBLIC_PREFIXES, _PUBLIC_EXACT


# Real filenames the generated service worker / PWA manifest reference.
# Any new file the SW loads via importScripts (or the browser fetches directly
# to bootstrap the PWA) must be added here AND to _PUBLIC_PREFIXES/_PUBLIC_EXACT.
REQUIRED_PUBLIC_ASSETS = [
    "/sw.js",
    "/sw-update.js",
    "/sw-push.js",
    "/workbox-abc123.js",   # content-hashed filename, prefix match
    "/registerSW.js",
    "/manifest.webmanifest",
]


def _is_public(path: str) -> bool:
    return path in _PUBLIC_EXACT or any(path.startswith(p) for p in _PUBLIC_PREFIXES)


def test_all_service_worker_assets_are_public():
    for path in REQUIRED_PUBLIC_ASSETS:
        assert _is_public(path), f"{path} is not in the auth-public allowlist — importScripts() would 401 and fail"


def test_sw_push_specifically_is_public():
    """Direct regression test for the exact bug: /sw-push.js must be public."""
    assert _is_public("/sw-push.js")
