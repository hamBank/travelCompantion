#!/usr/bin/env bash
# travelcomp-pull-backup.sh — runs on the BACKUP server. Pulls Travel Companion's
# backups from the app server over rsync/ssh, checks they are sound and fresh, and
# prunes its own copies (fleet spec DEP-6: an off-box copy).
#
# Pull, not push: the app server holds no credentials for the backup server, so
# compromising the app cannot reach the backups. The app server lets this key do one
# thing: read-only rsync of its app directory (see scripts/add_backup_reader.sh).
#
# What is pulled (paths are relative to the app dir, the root rrsync confines us to):
#   backups/       pg_backup.sh's nightly *.dump and deploy.sh's pre-deploy *.sql. The
#                  database holds trips, attachments and the (encrypted) document vault.
#   mail_store/    raw ingested emails + attachments, which live on disk, not in the DB.
# NOT pulled, deliberately: .env. It holds DOCUMENT_ENCRYPTION_KEY, and without that
# key the vault documents in the dump cannot be read. Keep a copy of it in your
# password manager (docs/offsite-backup.md).
#
# Fails (non-zero, so the systemd unit's Result shows it) if: the pull fails, a pulled
# dump is not a sound pg_dump file, or the newest dump is older than MAX_AGE_HOURS
# (which means the app server's own backup job has stopped).
#
# Config: /etc/travelcomp-pull-backup.conf (shell KEY=VALUE; override path with TC_PULL_CONF).
set -Eeuo pipefail

CONF="${TC_PULL_CONF:-/etc/travelcomp-pull-backup.conf}"
if [[ -r "$CONF" ]]; then set -a; source "$CONF"; set +a; fi

SRC_HOST="${SRC_HOST:-}"                         # user@host of the app server; empty = local path (tests)
SRC_ROOT="${SRC_ROOT:-/opt/travelcomp}"          # used only when SRC_HOST is empty
SRC_BACKUPS="${SRC_BACKUPS:-backups}"            # relative to the app dir
SRC_MAIL="${SRC_MAIL-mail_store}"                # empty = skip
DEST="${DEST:-${STATE_DIRECTORY:-/var/lib/travelcomp-backup}/data}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
KNOWN_HOSTS="${KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
KEEP_DAYS="${KEEP_DAYS:-90}"                     # our retention (the app keeps 14)
MIN_KEEP="${MIN_KEEP:-7}"                        # never prune below this many dumps
MAX_AGE_HOURS="${MAX_AGE_HOURS:-30}"             # newest dump must be younger than this
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-120}"

log()  { echo "$(date '+%F %T') $*"; }
die()  { log "✗ $*" >&2; exit 1; }
trap 'log "✗ failed at line $LINENO: $BASH_COMMAND" >&2' ERR

command -v rsync >/dev/null || die "rsync is not installed"

# Under systemd the unit is sandboxed (ProtectSystem=strict): everything but its state
# directory is read-only, so a DEST on another disk fails here unless the unit allows it.
if ! mkdir -p "$DEST" 2>/dev/null || [[ ! -w "$DEST" ]]; then
  die "$DEST is not writable by $(id -un). Run by systemd this is the unit's read-only sandbox: allow the path with 'sudo deploy/backup-server/install.sh --dest $DEST' (adds ReadWritePaths= and RequiresMountsFor=). Run by hand, check the directory's owner."
fi
mkdir -p "$DEST/dumps" "$DEST/mail_store" "$DEST/quarantine"
chmod 700 "$DEST"
exec 9>"$DEST/.lock"
flock -n 9 || die "another pull is already running"

if [[ -n "$SRC_HOST" ]]; then
  [[ -r "$SSH_KEY" ]]     || die "ssh key $SSH_KEY is missing or unreadable"
  [[ -r "$KNOWN_HOSTS" ]] || die "$KNOWN_HOSTS is missing: connect once by hand to accept the app server's host key"
  RSH="ssh -i $SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o ConnectTimeout=20"
  src() { echo "${SRC_HOST}:$1/"; }              # rrsync resolves this under its root
else
  RSH="ssh"
  src() { echo "${SRC_ROOT}/$1/"; }
fi

# --chmod: our copies are private to this user whatever the source modes were.
# No --delete: the app prunes at 14 days; we keep our own, longer history.
pull() {                                          # pull <remote-subdir> <local-dir> [rsync filter args...]
  local sub="$1" dst="$2"; shift 2
  local rc=0
  rsync -a --partial --timeout="$RSYNC_TIMEOUT" -e "$RSH" \
        --chmod=Fu=rw,Fg=,Fo=,Du=rwx,Dg=,Do= "$@" "$(src "$sub")" "$dst/" || rc=$?
  # 24 = a source file vanished mid-transfer (the app pruned it): harmless.
  if (( rc != 0 && rc != 24 )); then die "rsync of $sub failed (exit $rc)"; fi
}

log "pulling ${SRC_HOST:-$SRC_ROOT}:$SRC_BACKUPS"
pull "$SRC_BACKUPS" "$DEST/dumps" \
     --include='travelcomp-*.dump' --include='travelcomp-*.sql' --exclude='*'
if [[ -n "$SRC_MAIL" ]]; then
  log "pulling ${SRC_HOST:-$SRC_ROOT}:$SRC_MAIL"
  pull "$SRC_MAIL" "$DEST/mail_store"
fi

# ── verify what we hold ──────────────────────────────────────────────────────
# A custom-format pg_dump starts with "PGDMP"; a plain .sql dump ends with a
# completion marker. A file failing this was caught mid-write or truncated: move it
# aside (so the next run fetches it again) and fail loudly.
bad=0
shopt -s nullglob
for f in "$DEST"/dumps/travelcomp-*.dump; do
  if [[ "$(head -c 5 "$f")" != "PGDMP" ]]; then
    log "✗ not a pg_dump file: $(basename "$f")"; mv -f "$f" "$DEST/quarantine/"; bad=$((bad+1))
  fi
done
for f in "$DEST"/dumps/travelcomp-*.sql; do
  if ! tail -c 400 "$f" | grep -q "PostgreSQL database dump complete"; then
    log "✗ incomplete SQL dump: $(basename "$f")"; mv -f "$f" "$DEST/quarantine/"; bad=$((bad+1))
  fi
done
(( bad == 0 )) || die "$bad pulled file(s) failed verification (moved to $DEST/quarantine)"

# ── freshness: has the app server's backup job kept running? ──────────────────
newest="$(find "$DEST/dumps" -maxdepth 1 -name 'travelcomp-*.dump' -printf '%T@ %p\n' | sort -nr | head -1 || true)"
[[ -n "$newest" ]] || die "no travelcomp-*.dump in $DEST/dumps: the app server has produced no backup"
age_h=$(( ( $(date +%s) - ${newest%%.*} ) / 3600 ))
(( age_h < MAX_AGE_HOURS )) || die "newest dump is ${age_h}h old (limit ${MAX_AGE_HOURS}h): the app server's backup job may have stopped"

# ── retention (only reached when everything above passed) ─────────────────────
total="$(find "$DEST/dumps" -maxdepth 1 -name 'travelcomp-*.dump' | wc -l)"
old="$(find "$DEST/dumps" -maxdepth 1 \( -name 'travelcomp-*.dump' -o -name 'travelcomp-*.sql' \) -mtime +"$KEEP_DAYS" | wc -l)"
dumps_old="$(find "$DEST/dumps" -maxdepth 1 -name 'travelcomp-*.dump' -mtime +"$KEEP_DAYS" | wc -l)"
if (( total - dumps_old >= MIN_KEEP )); then
  find "$DEST/dumps" -maxdepth 1 \( -name 'travelcomp-*.dump' -o -name 'travelcomp-*.sql' \) -mtime +"$KEEP_DAYS" -delete
  (( old == 0 )) || log "pruned $old file(s) older than ${KEEP_DAYS} days"
elif (( old > 0 )); then
  log "kept $old old file(s): pruning would leave fewer than $MIN_KEEP dumps"
fi

date -u +%FT%TZ > "$DEST/last-success"
log "✓ ok: $(find "$DEST/dumps" -maxdepth 1 -name 'travelcomp-*.dump' | wc -l) dump(s), newest ${age_h}h old, $(du -sh "$DEST" | cut -f1) total"
