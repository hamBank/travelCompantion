#!/usr/bin/env python3
"""End-to-end check for the offline write queue (plan 11, step 6).

Drives the real, built app (backend/static/) in a headless browser through
the two scenarios the plan's design hinges on:

  1. Basic replay — go offline, cycle an item's status, reload the page
     while still offline (the op must survive in IndexedDB), go back
     online, and confirm the server ends up with the change.
  2. Conflict — go offline, queue a status change, have a "second device"
     (a plain HTTP PATCH) change the same field on the server first, then
     reconnect and confirm the conflict banner appears with "Keep theirs" /
     "Apply mine", and that "Apply mine" wins on the server.

This starts its own uvicorn against a throwaway SQLite DB, so it doesn't
touch dev/prod data. Auth is left disabled (no GOOGLE_CLIENT_ID), which is
this repo's normal local/CI setup — the app auto-logs in as dev@local.

Requires:
  - The frontend already built into backend/static/ (`cd frontend && npm
    run build`) — this script does not build it for you, matching the
    "build must happen after the source commit" rule elsewhere in this repo.
  - `pip install playwright` (browser binaries are expected to already be
    present — e.g. via PLAYWRIGHT_BROWSERS_PATH — this script does not run
    `playwright install`).

Usage:
    python scripts/offline_e2e.py [--chromium PATH]

Exits 0 if both scenarios pass, 1 otherwise.
"""
import argparse
import contextlib
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parent.parent
PORT = 8931
BASE = f"http://127.0.0.1:{PORT}"
DONE_ICON_TITLE = "Mark as done"


def _fail(msg: str) -> None:
    print(f"✗ {msg}")
    sys.exit(1)


def _ok(msg: str) -> None:
    print(f"✓ {msg}")


def wait_for_health(timeout: float = 20) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(f"{BASE}/health", timeout=1).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Server never came up at {BASE}/health within {timeout}s")


@contextlib.contextmanager
def running_server():
    if not (REPO_ROOT / "backend" / "static" / "index.html").exists():
        _fail("backend/static/index.html not found — build the frontend first "
              "(`cd frontend && npm run build`)")
    db_path = Path(tempfile.mkstemp(suffix=".db")[1])
    db_path.unlink()  # let sqlite create it fresh
    env = {"DATABASE_URL": f"sqlite:///{db_path}", "PATH": __import__("os").environ["PATH"]}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.main:app", "--port", str(PORT)],
        cwd=REPO_ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_health()
        yield
    finally:
        proc.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=10)
        db_path.unlink(missing_ok=True)


def seed_item(status: str = "pending") -> dict:
    """Fresh trip/stop/item for one scenario, isolated from the others."""
    trip = httpx.post(f"{BASE}/trips/", json={"name": "E2E Trip"}).json()
    stop = httpx.post(f"{BASE}/trips/{trip['id']}/stops",
                       json={"location": "Rome", "status": "planned"}).json()
    item = httpx.post(f"{BASE}/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Pantheon", "status": status,
    }).json()
    return item


def open_trip_page(page, trip_name: str = "E2E Trip"):
    page.goto(f"{BASE}/")
    page.wait_for_selector(f'[title="{DONE_ICON_TITLE}"]', timeout=15_000)
    # The first load isn't served by the service worker — it only starts
    # controlling the page after installing, which triggers main.jsx's
    # controllerchange auto-reload. Wait for that to settle so a later
    # `page.reload()` while offline is actually servable from the SW's cache
    # (the whole point of this scenario) instead of failing outright.
    page.wait_for_function(
        "() => navigator.serviceWorker && navigator.serviceWorker.controller",
        timeout=15_000,
    )
    page.wait_for_timeout(1000)
    page.wait_for_selector(f'[title="{DONE_ICON_TITLE}"]', timeout=15_000)


def scenario_basic_replay(chromium_launch_kwargs) -> bool:
    """Offline status cycle survives a reload, then replays on reconnect.

    Runs against its own fresh server (a new SQLite DB, one trip) so the
    app's "auto-open the only trip" behavior applies — same reason
    scenario_conflict gets its own server rather than sharing this one.
    """
    with running_server():
        item = seed_item(status="pending")
        with sync_playwright() as p:
            browser = p.chromium.launch(**chromium_launch_kwargs)
            context = browser.new_context()
            page = context.new_page()
            try:
                open_trip_page(page)

                context.set_offline(True)
                page.wait_for_timeout(300)
                page.click(f'[title="{DONE_ICON_TITLE}"]')
                page.wait_for_timeout(300)

                # Reload while still offline — the queued op must survive in IndexedDB.
                page.reload()
                page.wait_for_timeout(1500)
                body = page.inner_text("body")
                if "waiting to sync" not in body:
                    _fail("basic replay: pending-op badge missing after an offline reload")
                    return False
                server_status = httpx.get(f"{BASE}/items/{item['id']}").json()["status"]
                if server_status != "pending":
                    _fail(f"basic replay: server already applied the change before reconnect (status={server_status!r})")
                    return False

                # Reconnect — the queue should flush and the badge should clear.
                context.set_offline(False)
                page.wait_for_timeout(2500)
                if "waiting to sync" in page.inner_text("body"):
                    _fail("basic replay: pending-op badge still present after reconnecting")
                    return False

                server_status = httpx.get(f"{BASE}/items/{item['id']}").json()["status"]
                if server_status != "done":
                    _fail(f"basic replay: server status is {server_status!r}, expected 'done'")
                    return False

                _ok("basic replay: offline op survived a reload and replayed on reconnect")
                return True
            finally:
                browser.close()


def scenario_conflict(chromium_launch_kwargs) -> bool:
    """A same-field concurrent server edit conflicts; 'Apply mine' resolves it."""
    with running_server():
        item = seed_item(status="pending")
        with sync_playwright() as p:
            browser = p.chromium.launch(**chromium_launch_kwargs)
            context = browser.new_context()
            page = context.new_page()
            try:
                open_trip_page(page)

                context.set_offline(True)
                page.wait_for_timeout(300)
                page.click(f'[title="{DONE_ICON_TITLE}"]')  # queues: pending -> done, base=pending
                page.wait_for_timeout(300)

                # A "second device" changes the same field server-side while we're offline.
                r = httpx.patch(f"{BASE}/items/{item['id']}", json={"status": "skipped"})
                if r.status_code != 200:
                    _fail(f"conflict: setup PATCH failed ({r.status_code}: {r.text})")
                    return False

                context.set_offline(False)
                page.wait_for_timeout(2500)
                body = page.inner_text("body")
                if "couldn't sync" not in body:
                    _fail("conflict: no conflict banner appeared after reconnecting")
                    return False
                if page.locator("text=Apply mine").count() == 0:
                    _fail("conflict: 'Apply mine' button not found")
                    return False

                page.click("text=Apply mine")
                page.wait_for_timeout(1000)
                if "couldn't sync" in page.inner_text("body"):
                    _fail("conflict: banner still present after resolving")
                    return False

                server_status = httpx.get(f"{BASE}/items/{item['id']}").json()["status"]
                if server_status != "done":
                    _fail(f"conflict: server status is {server_status!r} after 'Apply mine', expected 'done'")
                    return False

                _ok("conflict: banner appeared with the right fields, 'Apply mine' won on the server")
                return True
            finally:
                browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--chromium", default=None,
        help="Path to a Chromium executable. Defaults to Playwright's own "
             "managed browser, falling back to $PLAYWRIGHT_BROWSERS_PATH's "
             "chromium if that's not installed.",
    )
    args = parser.parse_args()

    chromium_path = args.chromium
    if not chromium_path:
        import os
        pw_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
        if pw_path:
            candidates = sorted(Path(pw_path).glob("chromium-*/chrome-linux/chrome"))
            if candidates:
                chromium_path = str(candidates[-1])

    launch_kwargs = {"headless": True}
    if chromium_path:
        launch_kwargs["executable_path"] = chromium_path

    print(f"── Offline write queue e2e ({BASE}) ──────────────────────────")
    results = [
        scenario_basic_replay(launch_kwargs),
        scenario_conflict(launch_kwargs),
    ]

    print("──────────────────────────────────────────────────────────")
    if all(results):
        print("✓ Offline write queue e2e passed")
        sys.exit(0)
    else:
        print("✗ Offline write queue e2e FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()
