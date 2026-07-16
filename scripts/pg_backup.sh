#!/usr/bin/env bash
# pg_backup.sh — dump the Travel Companion Postgres DB and prune old backups
# (both this script's own .dump files and deploy.sh's pre-deploy .sql dumps,
# which deploy.sh itself never prunes).
#
# Runs as the app user (no sudo): reads the DB password from $APP_DIR/.pg-bootstrap
# and writes a compressed custom-format dump (restorable with pg_restore) to
# $APP_DIR/backups. Intended for a daily cron. Safe to run by hand.
#
#   Restore:  pg_restore -h localhost -U travelcomp -d travelcomp --clean <file>
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/travelcomp}"
BACKUP_DIR="$APP_DIR/backups"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
PG_HOST="${PG_HOST:-localhost}"
PG_USER="${PG_USER:-travelcomp}"
PG_DB="${PG_DB:-travelcomp}"

PW="$(cat "$APP_DIR/.pg-bootstrap" 2>/dev/null | tr -d '\r\n' || true)"
[[ -z "$PW" ]] && { echo "$(date '+%F %T') ✗ no password at $APP_DIR/.pg-bootstrap"; exit 1; }

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/travelcomp-$(date +%Y%m%d-%H%M%S).dump"

if PGPASSWORD="$PW" pg_dump -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -Fc -f "$OUT"; then
  echo "$(date '+%F %T') ✓ backup → $OUT ($(du -h "$OUT" | cut -f1))"
else
  echo "$(date '+%F %T') ✗ pg_dump failed"; rm -f "$OUT"; exit 1
fi

# Prune backups older than RETAIN_DAYS — both this script's .dump files and
# deploy.sh's pre-deploy .sql dumps (deploy.sh writes one per deploy and never
# prunes them itself, so without this they accumulate forever).
find "$BACKUP_DIR" \( -name 'travelcomp-*.dump' -o -name 'travelcomp-*.sql' \) -type f -mtime +"$RETAIN_DAYS" -delete
