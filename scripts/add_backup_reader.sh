#!/usr/bin/env bash
# add_backup_reader.sh — run as root on the APP server (once). Lets the backup server
# PULL backups, with a key that can do exactly one thing: read-only rsync of the app dir.
#
#   sudo scripts/add_backup_reader.sh [--from ADDR] [--app-dir DIR] [--user NAME] PUBKEY_FILE|-
#   scripts/add_backup_reader.sh --print-line [--from ADDR] PUBKEY_FILE|-      # no changes, no root
#
# It creates a login-less system user (default tcbackup) whose only authorized key is
#     restrict,from="ADDR",command="rrsync -ro /opt/travelcomp" ssh-ed25519 AAAA… tc-offsite-backup
# `restrict` turns off forwarding, ptys and agent use; the forced command means the key
# cannot run a shell or write anything, and cannot read outside the app dir. The user
# is unprivileged, so .env and .pg-bootstrap (mode 600, owned by the app user) stay
# unreadable to it: this script checks that and fails if they are not.
set -Eeuo pipefail

APP_DIR="/opt/travelcomp"; BACKUP_USER="tcbackup"; FROM=""; PRINT=0; KEYSRC=""
MARK="tc-offsite-backup"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
die()   { echo "✗ $*" >&2; exit 1; }

while (( $# )); do
  case "$1" in
    --from)       FROM="${2:?--from needs an address}"; shift 2;;
    --app-dir)    APP_DIR="${2:?}"; shift 2;;
    --user)       BACKUP_USER="${2:?}"; shift 2;;
    --print-line) PRINT=1; shift;;
    -h|--help)    usage 0;;
    -)            [[ -z "$KEYSRC" ]] || usage; KEYSRC="-"; shift;;
    -*)           echo "unknown option $1" >&2; usage;;
    *)            [[ -z "$KEYSRC" ]] || usage; KEYSRC="$1"; shift;;
  esac
done
[[ -n "$KEYSRC" ]] || usage

if [[ "$KEYSRC" == "-" ]]; then KEY_LINE="$(grep -v '^#' | grep -v '^[[:space:]]*$' | head -1 || true)"
else [[ -r "$KEYSRC" ]] || die "cannot read $KEYSRC"; KEY_LINE="$(grep -v '^#' "$KEYSRC" | grep -v '^[[:space:]]*$' | head -1 || true)"; fi
[[ -n "$KEY_LINE" ]] || die "no public key found in $KEYSRC"

# Only a bare public key: an options prefix would let the caller smuggle in their own command=.
if ! [[ "$KEY_LINE" =~ ^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com)[[:space:]]+([A-Za-z0-9+/=]+)([[:space:]].*)?$ ]]; then
  die "that is not a bare ssh public key (expected 'ssh-ed25519 AAAA… comment')"
fi
KEY_TYPE="${BASH_REMATCH[1]}"; KEY_BLOB="${BASH_REMATCH[3]}"
if [[ -n "$FROM" && ! "$FROM" =~ ^[A-Za-z0-9.:/,*?!-]+$ ]]; then die "--from contains unexpected characters"; fi
[[ "$APP_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--app-dir must be a plain absolute path"

RRSYNC="$(command -v rrsync || true)"
if [[ -z "$RRSYNC" ]]; then
  (( PRINT )) && RRSYNC="/usr/bin/rrsync" || die "rrsync not found: install the rsync package"
fi

OPTS="restrict"
[[ -n "$FROM" ]] && OPTS+=",from=\"$FROM\""
OPTS+=",command=\"$RRSYNC -ro $APP_DIR\""
LINE="$OPTS $KEY_TYPE $KEY_BLOB $MARK"

if (( PRINT )); then echo "$LINE"; exit 0; fi

(( EUID == 0 )) || die "run as root (or use --print-line to see what would be installed)"
[[ -d "$APP_DIR/backups" ]] || die "$APP_DIR/backups does not exist: is --app-dir right, and has the backup job run?"

if ! id "$BACKUP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/$BACKUP_USER" --shell /bin/sh "$BACKUP_USER"
  echo "✓ created user $BACKUP_USER"
fi
# '!' (locked) is refused by sshd when PAM is off; '*' means "no password, key only".
usermod -p '*' "$BACKUP_USER"

HOME_DIR="$(getent passwd "$BACKUP_USER" | cut -d: -f6)"
install -d -m 700 -o "$BACKUP_USER" -g "$(id -gn "$BACKUP_USER")" "$HOME_DIR/.ssh"
AK="$HOME_DIR/.ssh/authorized_keys"
touch "$AK"
grep -vF " $MARK" "$AK" > "$AK.new" || true       # replace any earlier key of ours
echo "$LINE" >> "$AK.new"
install -m 600 -o "$BACKUP_USER" -g "$(id -gn "$BACKUP_USER")" "$AK.new" "$AK"; rm -f "$AK.new"
echo "✓ installed key in $AK"

# What this user can read matters more than what it is told to read.
ok=1
readable() { runuser -u "$BACKUP_USER" -- test -r "$1"; }
for secret in "$APP_DIR/.env" "$APP_DIR/.pg-bootstrap"; do
  if [[ -e "$secret" ]] && readable "$secret"; then
    echo "✗ $BACKUP_USER can read $secret: tighten it (chmod 600, owned by the app user)" >&2; ok=0
  fi
done
if ! readable "$APP_DIR/backups"; then
  echo "! $BACKUP_USER cannot read $APP_DIR/backups: the pull would fail. Fix with: chmod o+rx $APP_DIR $APP_DIR/backups" >&2; ok=0
fi
(( ok )) || exit 1
echo "✓ $BACKUP_USER can read $APP_DIR/backups and cannot read the secrets"
