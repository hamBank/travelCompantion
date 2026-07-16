#!/usr/bin/env bash
# smoke_check.sh — post-deploy smoke check for Travel Companion.
#
# Deploys have silently failed to take effect (webhook didn't fire, stale
# code kept running) and were only caught by manually probing production.
# This script hits the live service and fails loudly if it's not actually
# serving the code we think it is.
#
# Usage:
#   scripts/smoke_check.sh [BASE_URL] [EXPECTED_SHA]
#
#   BASE_URL      Defaults to http://127.0.0.1:8000 (the on-server case).
#   EXPECTED_SHA  Optional. If given, compared against the health response's
#                 backend_sha field (falling back to sha if backend_sha is
#                 absent — that field is landing in a parallel change).
#
# Checks:
#   1. GET /health            → HTTP 200, {"status":"ok"}       (hard FAIL)
#   2. sha comparison          (if EXPECTED_SHA given)          (hard FAIL)
#   3. GET /weather (near-term range) → HTTP 200, non-empty     (hard FAIL)
#      weather object; WARN (not FAIL) if any day in range is
#      still climatology-sourced (near-term days should be live
#      forecasts, but a transient upstream blip shouldn't fail a deploy).
#   4. Scheduled tasks (travelcomp-weather/-notifications/-backup timers)
#      (WARN only — never fails the deploy):
#      - skipped entirely if `systemctl` isn't available (e.g. running this
#        off the production server, or in a container/CI without systemd —
#        that's expected, not a problem to report on)
#      - each timer should be enabled, and its paired oneshot .service's
#        last run should not have Result=failed
#      - the backup timer additionally checks for a recent dump file under
#        $APP_DIR/backups, but only when Postgres is actually configured
#        (pg_backup.sh intentionally no-ops on a SQLite install, so an
#        empty/missing backups dir there is correct, not stale)
#
# Deploys have silently failed to take effect before, AND scheduled tasks
# have silently stopped running before (pg_backup.sh committed without +x
# failed every night with "Permission denied" until a manual server probe
# caught it — see CLAUDE.md/PR #80). Check 4 exists so that class of bug
# shows up here instead of needing another manual investigation.
#
# Exit 0 on success (hard checks all passed; check 4 never affects this),
# 1 on any hard failure. Only curl + python3 (+ systemctl, when present) are
# used — no jq dependency.

set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8000}"
EXPECTED_SHA="${2:-}"
CURL_TIMEOUT="${SMOKE_CHECK_TIMEOUT:-10}"
APP_DIR="${APP_DIR:-/opt/travelcomp}"

# Strip a trailing slash so "$BASE_URL/health" never ends up "//health".
BASE_URL="${BASE_URL%/}"

FAIL=0

pass() { echo -e "\033[1;32m✓\033[0m $*"; }
fail() { echo -e "\033[1;31m✗\033[0m $*"; FAIL=1; }
warn() { echo -e "\033[1;33m⚠\033[0m $*"; }

echo "── Smoke check: $BASE_URL ──────────────────────────────"

# ── 1. /health ─────────────────────────────────────────────────────────────
HEALTH_BODY=""
HEALTH_HTTP_CODE=0
HEALTH_RESPONSE="$(curl -sS --max-time "$CURL_TIMEOUT" -w '\n%{http_code}' "$BASE_URL/health" 2>/dev/null || true)"
if [[ -n "$HEALTH_RESPONSE" ]]; then
  HEALTH_HTTP_CODE="$(echo "$HEALTH_RESPONSE" | tail -n1)"
  HEALTH_BODY="$(echo "$HEALTH_RESPONSE" | sed '$d')"
fi

if [[ "$HEALTH_HTTP_CODE" != "200" ]]; then
  fail "GET /health → HTTP ${HEALTH_HTTP_CODE:-no response} (expected 200)"
else
  HEALTH_STATUS="$(printf '%s' "$HEALTH_BODY" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get("status", ""))
except Exception:
    print("")
' 2>/dev/null || true)"
  if [[ "$HEALTH_STATUS" == "ok" ]]; then
    pass "GET /health → HTTP 200, status=ok"
  else
    fail "GET /health → HTTP 200 but status != ok (body: $HEALTH_BODY)"
  fi
fi

# ── 2. SHA comparison (only if EXPECTED_SHA given and /health succeeded) ────
if [[ -n "$EXPECTED_SHA" ]]; then
  if [[ "$HEALTH_HTTP_CODE" != "200" ]]; then
    fail "SHA check skipped — /health did not return a usable response"
  else
    ACTUAL_SHA="$(printf '%s' "$HEALTH_BODY" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    sha = d.get("backend_sha") or d.get("sha") or ""
    print(sha)
except Exception:
    print("")
' 2>/dev/null || true)"
    if [[ -z "$ACTUAL_SHA" ]]; then
      fail "SHA check → /health response had no backend_sha or sha field"
    elif [[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]]; then
      pass "SHA check → $ACTUAL_SHA matches expected"
    else
      fail "SHA check → got '$ACTUAL_SHA', expected '$EXPECTED_SHA'"
    fi
  fi
else
  echo "  (no EXPECTED_SHA given — skipping SHA check)"
fi

# ── 3. /weather ──────────────────────────────────────────────────────────────
START_DATE="$(date -u +%Y-%m-%d)"
END_DATE="$(date -u -d '+2 days' +%Y-%m-%d 2>/dev/null || date -u -v+2d +%Y-%m-%d)"
WEATHER_URL="$BASE_URL/weather?lat=1.35&lng=103.82&start=${START_DATE}&end=${END_DATE}"

WEATHER_HTTP_CODE=0
WEATHER_BODY=""
WEATHER_RESPONSE="$(curl -sS --max-time "$CURL_TIMEOUT" -w '\n%{http_code}' "$WEATHER_URL" 2>/dev/null || true)"
if [[ -n "$WEATHER_RESPONSE" ]]; then
  WEATHER_HTTP_CODE="$(echo "$WEATHER_RESPONSE" | tail -n1)"
  WEATHER_BODY="$(echo "$WEATHER_RESPONSE" | sed '$d')"
fi

if [[ "$WEATHER_HTTP_CODE" != "200" ]]; then
  fail "GET /weather → HTTP ${WEATHER_HTTP_CODE:-no response} (expected 200)"
else
  # Parse: is "weather" a non-empty object, and does any day use climatology?
  WEATHER_CHECK="$(printf '%s' "$WEATHER_BODY" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    w = d.get("weather")
    if not isinstance(w, dict) or not w:
        print("empty")
        sys.exit(0)
    has_climatology = any(
        isinstance(day, dict) and day.get("source") == "climatology"
        for day in w.values()
    )
    print("climatology" if has_climatology else "ok")
except Exception:
    print("parse_error")
' 2>/dev/null || echo "parse_error")"

  case "$WEATHER_CHECK" in
    ok)
      pass "GET /weather → HTTP 200, non-empty weather object, all live forecasts"
      ;;
    climatology)
      pass "GET /weather → HTTP 200, non-empty weather object"
      warn "One or more near-term days are still climatology-sourced (expected live forecast) — likely a transient upstream blip, not failing the deploy"
      ;;
    empty)
      fail "GET /weather → HTTP 200 but weather object is empty/missing (body: $WEATHER_BODY)"
      ;;
    *)
      fail "GET /weather → HTTP 200 but response could not be parsed (body: $WEATHER_BODY)"
      ;;
  esac
fi

# ── 4. Scheduled tasks (systemd timers) ─────────────────────────────────────
# WARN-only: a scheduled-task problem is real and worth surfacing, but it's
# not something that happened *because of this deploy*, so it shouldn't make
# a deploy look like it failed (the existing FAIL/pass convention above is
# reserved for "is the thing we just deployed actually serving correctly").
if ! command -v systemctl &>/dev/null; then
  echo "  (systemctl not available — skipping scheduled-task checks; expected off the production server)"
else
  # unit_ok NAME → the paired oneshot .service's last run didn't fail.
  # Absent Result (never run yet, e.g. right after a fresh enable) prints
  # empty and is NOT treated as a failure — only an explicit "failed" is.
  unit_result() {
    systemctl show "$1" --property=Result --value 2>/dev/null || true
  }
  # `systemctl is-enabled` already prints a value ("enabled"/"disabled"/
  # "not-found"/...) to stdout on every path, including its non-zero exit
  # for a missing unit or no systemd bus at all -- don't `|| echo` a second
  # fallback value on top of that or a missing unit prints twice.
  unit_enabled() {
    systemctl is-enabled "$1" 2>/dev/null
    return 0
  }

  for pair in "travelcomp-weather.timer:travelcomp-weather.service" \
              "travelcomp-notifications.timer:travelcomp-notifications.service" \
              "travelcomp-backup.timer:travelcomp-backup.service"; do
    TIMER="${pair%%:*}"; SERVICE="${pair##*:}"
    ENABLED="$(unit_enabled "$TIMER")"
    RESULT="$(unit_result "$SERVICE")"
    if [[ "$ENABLED" != "enabled" ]]; then
      warn "$TIMER is '$ENABLED', not enabled — scheduled task will never run. Fix: sudo systemctl daemon-reload && sudo systemctl enable --now $TIMER"
    elif [[ "$RESULT" == "failed" ]]; then
      warn "$SERVICE's last run FAILED — check: journalctl -u $SERVICE -n 40"
    else
      pass "$TIMER enabled, $SERVICE last result: ${RESULT:-not yet run}"
    fi
  done

  # Backup freshness: only meaningful when Postgres is actually configured —
  # pg_backup.sh intentionally no-ops (exit 0, no dump written) on a
  # SQLite-only install, so no backups dir there is correct, not stale.
  ENV_FILE="$APP_DIR/.env"
  DB_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  if [[ "$DB_URL" == postgresql* ]]; then
    BACKUP_DIR="$APP_DIR/backups"
    LATEST_DUMP="$(find "$BACKUP_DIR" -name 'travelcomp-*.dump' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
    if [[ -z "$LATEST_DUMP" ]]; then
      warn "Postgres is configured but no backup dump found under $BACKUP_DIR — has travelcomp-backup.timer ever run successfully?"
    else
      AGE_SEC=$(( $(date +%s) - $(date -r "$LATEST_DUMP" +%s 2>/dev/null || echo 0) ))
      # Daily schedule + up to 600s randomized delay; 36h leaves generous slack
      # for a slow dump before calling it stale.
      if [[ "$AGE_SEC" -gt $((36 * 3600)) ]]; then
        warn "Latest backup ($LATEST_DUMP) is $((AGE_SEC / 3600))h old — expected a fresh one within ~24h"
      else
        pass "Latest backup: $LATEST_DUMP ($((AGE_SEC / 3600))h old)"
      fi
    fi
  fi
fi

echo "──────────────────────────────────────────────────────────"
if [[ "$FAIL" -eq 0 ]]; then
  pass "Smoke check passed"
  exit 0
else
  fail "Smoke check FAILED"
  exit 1
fi
