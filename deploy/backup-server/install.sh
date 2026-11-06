#!/usr/bin/env bash
# install.sh — run as root on the BACKUP server (idempotent). Installs the pull script,
# its systemd service + timer, a config template and a dedicated key, and enables the
# timer. It does not start a pull: finish the steps it prints first.
set -Eeuo pipefail
cd "$(dirname "$0")"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
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
