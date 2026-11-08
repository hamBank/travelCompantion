#!/usr/bin/env bash
# install.sh — run as root on the BACKUP server (idempotent). Installs the pull script,
# its systemd service + timer, a config template and a dedicated key, and enables the
# timer. It does not start a pull: finish the steps it prints first.
#
#   install.sh [--dest DIR]
#
# --dest DIR keeps the backups on another disk or mount instead of under
# /var/lib/travelcomp-backup. The unit is sandboxed (read-only everywhere but its state
# directory), so this also writes a drop-in that allows DIR (ReadWritePaths=) and makes
# the unit wait for DIR's mount (RequiresMountsFor=, so an unmounted disk fails the pull
# instead of filling the root disk). DIR must already exist and be mounted. Re-run with
# --dest at any time to change it.
set -Eeuo pipefail
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")"
DEST_DIR=""
while (( $# )); do
  case "$1" in
    --dest) DEST_DIR="${2:?--dest needs a directory}"; shift 2;;
    -h|--help) sed -n '2,13p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
if [[ -n "$DEST_DIR" ]]; then
  [[ "$DEST_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "✗ --dest must be a plain absolute path" >&2; exit 1; }
  [[ -d "$DEST_DIR" ]] || { echo "✗ $DEST_DIR does not exist: create/mount it first" >&2; exit 1; }
fi
for c in rsync ssh ssh-keygen flock systemctl; do command -v "$c" >/dev/null || { echo "✗ missing: $c" >&2; exit 1; }; done

STATE=/var/lib/travelcomp-backup
if ! id tcpull >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE" --create-home --shell /usr/sbin/nologin tcpull
  echo "✓ created user tcpull"
fi
usermod -p '*' tcpull 2>/dev/null || true
install -d -m 700 -o tcpull -g tcpull "$STATE" "$STATE/.ssh"

install -m 755 travelcomp-pull-backup.sh /usr/local/sbin/travelcomp-pull-backup.sh
install -m 644 travelcomp-pull-backup.service /etc/systemd/system/travelcomp-pull-backup.service
install -m 644 travelcomp-pull-backup.timer   /etc/systemd/system/travelcomp-pull-backup.timer
if [[ ! -e /etc/travelcomp-pull-backup.conf ]]; then
  install -m 640 -o root -g tcpull travelcomp-pull-backup.conf.example /etc/travelcomp-pull-backup.conf
  echo "✓ wrote /etc/travelcomp-pull-backup.conf: edit SRC_HOST"
fi

KEY="$STATE/.ssh/id_ed25519"
if [[ ! -e "$KEY" ]]; then
  runuser -u tcpull -- ssh-keygen -q -t ed25519 -N '' -C "tc-pull@$(hostname)" -f "$KEY"
  echo "✓ generated $KEY"
fi
touch "$STATE/.ssh/known_hosts"; chown tcpull:tcpull "$STATE/.ssh/known_hosts"

if [[ -n "$DEST_DIR" ]]; then
  chown tcpull:tcpull "$DEST_DIR"; chmod 700 "$DEST_DIR"
  # DEST in the config: replace an existing line or append one.
  if grep -q '^DEST=' /etc/travelcomp-pull-backup.conf; then
    sed -i "s#^DEST=.*#DEST=$DEST_DIR#" /etc/travelcomp-pull-backup.conf
  else
    echo "DEST=$DEST_DIR" >> /etc/travelcomp-pull-backup.conf
  fi
  install -d -m 755 /etc/systemd/system/travelcomp-pull-backup.service.d
  cat > /etc/systemd/system/travelcomp-pull-backup.service.d/dest.conf <<DROPIN
# Written by install.sh --dest: lets the sandboxed unit write to DEST, and only once it is mounted.
[Unit]
RequiresMountsFor=$DEST_DIR

[Service]
ReadWritePaths=$DEST_DIR
DROPIN
  echo "✓ backups will go to $DEST_DIR (drop-in: travelcomp-pull-backup.service.d/dest.conf)"
fi

systemctl daemon-reload
systemctl enable travelcomp-pull-backup.timer >/dev/null
systemctl start travelcomp-pull-backup.timer

cat <<MSG

Installed. Remaining steps:

 1. On the APP server, authorise this key (read-only rsync, nothing else):
        echo '$(cat "$KEY.pub")' | sudo scripts/add_backup_reader.sh --from <this server's IP> -

 2. Edit /etc/travelcomp-pull-backup.conf and set SRC_HOST (e.g. tcbackup@your-app-host).

 3. Pin the app server's host key: check its fingerprint on the app server
    (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) then here:
        sudo -u tcpull ssh-keyscan -t ed25519 <host> | sudo -u tcpull tee -a $STATE/.ssh/known_hosts
        sudo -u tcpull ssh-keygen -lf $STATE/.ssh/known_hosts      # compare with the fingerprint

 4. Run one pull and read the result:
        sudo systemctl start travelcomp-pull-backup.service
        journalctl -u travelcomp-pull-backup.service -n 20
    Then see the next scheduled run with: systemctl list-timers travelcomp-pull-backup.timer
MSG
