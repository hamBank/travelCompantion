#!/bin/sh
# Postfix pipe wrapper for Travel Companion email ingestion.
#
# Postfix's pipe(8) gives a minimal environment, so we source the app's .env
# (which holds MAIL_INGEST_SECRET / MAIL_DOMAIN) before running the shim. This
# must run as a user that can read the .env (chmod 600 travelcomp) — set
# `user=travelcomp` on the master.cf pipe service.
#
# Usage (from master.cf):
#   argv=/opt/travelcomp/scripts/mail_ingest_wrapper.sh ${recipient}
set -eu

APP_DIR="${TRAVELCOMP_DIR:-/opt/travelcomp}"

# Load secrets without choking on comments/blank lines.
if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$APP_DIR/.env"
  set +a
fi

exec /usr/bin/python3 "$APP_DIR/mail_ingest.py" "$@"
