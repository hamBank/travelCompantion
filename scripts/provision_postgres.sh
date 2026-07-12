#!/usr/bin/env bash
# provision_postgres.sh — idempotently create the Travel Companion DB role + database.
#
# Run as root (uses `sudo -u postgres`). Safe to re-run: skips role/db that exist.
#
# Usage:
#   sudo PG_PASSWORD='choose-a-strong-password' ./scripts/provision_postgres.sh
#
# Optional overrides:
#   PG_USER (default: travelcomp)   PG_DB (default: travelcomp)
#
# Afterwards, set in /opt/travelcomp/.env:
#   DATABASE_URL=postgresql+psycopg://<PG_USER>:<PG_PASSWORD>@localhost/<PG_DB>
set -euo pipefail

PG_USER="${PG_USER:-travelcomp}"
PG_DB="${PG_DB:-travelcomp}"

[[ -z "${PG_PASSWORD:-}" ]] && { echo "✗ Set PG_PASSWORD (the role's password)"; exit 1; }
[[ $EUID -ne 0 ]] && { echo "✗ Run as root: sudo PG_PASSWORD=... $0"; exit 1; }

psql_su() { sudo -u postgres psql -tAc "$1"; }

# Role
if [[ "$(psql_su "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'")" == "1" ]]; then
  echo "▶ Role '$PG_USER' exists — updating password"
  sudo -u postgres psql -c "ALTER ROLE \"$PG_USER\" WITH LOGIN PASSWORD '$PG_PASSWORD';" >/dev/null
else
  echo "▶ Creating role '$PG_USER'"
  sudo -u postgres psql -c "CREATE ROLE \"$PG_USER\" WITH LOGIN PASSWORD '$PG_PASSWORD';" >/dev/null
fi

# Database
if [[ "$(psql_su "SELECT 1 FROM pg_database WHERE datname='$PG_DB'")" == "1" ]]; then
  echo "✓ Database '$PG_DB' already exists"
else
  echo "▶ Creating database '$PG_DB' (owner '$PG_USER')"
  sudo -u postgres psql -c "CREATE DATABASE \"$PG_DB\" OWNER \"$PG_USER\";" >/dev/null
fi

echo "✓ Provisioned. Set DATABASE_URL=postgresql+psycopg://$PG_USER:<password>@localhost/$PG_DB"
