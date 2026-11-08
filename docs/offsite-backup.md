# Off-box backups (fleet spec DEP-6)

The app server dumps its database nightly and keeps 14 days on the same disk. This adds a second
copy on a separate, locked-down **backup server** that *pulls* it over rsync/ssh.

```
 app server                                    backup server
 ──────────                                    ─────────────
 00:00  travelcomp-backup.timer                03:30  travelcomp-pull-backup.timer
        └ pg_backup.sh → backups/*.dump                └ travelcomp-pull-backup.sh
 user tcbackup (no shell, read-only key)  ◄──── rsync over ssh (key + pinned host key)
 forced: rrsync -ro /opt/travelcomp                   └ verify · freshness check · prune
```

**Pull, not push**: the app server holds no credentials for the backup server, so a compromised
app cannot reach or delete the backups. The app-side key can only run a read-only rsync inside
`/opt/travelcomp` (`rrsync -ro`): no shell, no writes, no `..`, no other paths.

## What is copied, and what is not

| Copied | Why |
|---|---|
| `backups/travelcomp-*.dump` (nightly) and `*.sql` (taken before each deploy) | The database: trips, attachments, and the **encrypted** document vault all live in Postgres |
| `mail_store/` | Raw ingested emails and attachments: the one thing stored on disk rather than in the database |

**Not copied, on purpose: `.env`.** It holds `DOCUMENT_ENCRYPTION_KEY`, and **without that key the
document vault in the dump cannot be read**. Keep a copy of `.env` (or at least that key) in your
password manager. The pull key cannot read it, and `add_backup_reader.sh` checks that.

## Setup

**1. Backup server** (as root, from a checkout of this repo):

```bash
sudo deploy/backup-server/install.sh
```

Creates user `tcpull`, an ed25519 key, `/etc/travelcomp-pull-backup.conf`, the service and the
timer (enabled). It prints the next steps with your public key filled in.

**2. App server** (as root): authorise that key. `--from` restricts it to the backup server's IP.

```bash
echo '<the public key install.sh printed>' | sudo scripts/add_backup_reader.sh --from <backup-server-ip> -
```

This creates the login-less `tcbackup` user, installs the key as
`restrict,from="…",command="rrsync -ro /opt/travelcomp"`, then checks that `tcbackup` **can** read
`backups/` and **cannot** read `.env` or `.pg-bootstrap`. If `backups/` is unreadable it tells you
the `chmod` to run (`pg_backup.sh` writes with the app user's umask). Needs the `rsync` package
(provides `rrsync`) and your sshd must allow the user (`AllowUsers`, if you use it).

**3. Backup server**: set `SRC_HOST=tcbackup@<app-host>` in `/etc/travelcomp-pull-backup.conf`, and
pin the app server's host key (the script uses `StrictHostKeyChecking=yes`, so an unknown or changed
key is a failure, not a prompt): compare the fingerprint from
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the app server with what you scan here:

```bash
sudo -u tcpull ssh-keyscan -t ed25519 <app-host> | sudo -u tcpull tee -a /var/lib/travelcomp-backup/.ssh/known_hosts
sudo -u tcpull ssh-keygen -lf /var/lib/travelcomp-backup/.ssh/known_hosts
```

**4. First run, by hand:**

```bash
sudo systemctl start travelcomp-pull-backup.service
journalctl -u travelcomp-pull-backup.service -n 20      # expect "✓ ok: N dump(s), newest Xh old"
systemctl list-timers travelcomp-pull-backup.timer
```

## Keeping the backups on another disk

The service is sandboxed: it can write only to its own state directory, so a `DEST` elsewhere fails
under systemd with `chmod: … Read-only file system` even though the same script works when you run it
by hand as `tcpull`. Set it with the installer, which does everything needed (idempotent, re-run any time):

```bash
sudo deploy/backup-server/install.sh --dest /lklBackup/sites_apps/travelcomp
```

The directory must already exist and be mounted. It sets `DEST=` in the config, makes `tcpull` the owner,
and writes `travelcomp-pull-backup.service.d/dest.conf` with `ReadWritePaths=` (the sandbox exception)
and `RequiresMountsFor=` (the pull waits for the mount, and fails if the disk is absent, instead of
quietly filling the root filesystem). By hand, that drop-in is `sudo systemctl edit
travelcomp-pull-backup.service` with those two lines.

## What a failed run means

The unit exits non-zero (and shows in `systemctl --failed`) when:

| Message | Cause |
|---|---|
| `… is not writable by tcpull … read-only sandbox` | `DEST` is outside the unit's state directory: `install.sh --dest <path>` (above) |
| `rsync of backups failed (exit …)` | ssh/key/host-key/permission problem; the line above it says which |
| `not a pg_dump file` / `incomplete SQL dump` | A file was caught mid-write or truncated. It is moved to `quarantine/` and fetched again next run |
| `newest dump is Nh old … backup job may have stopped` | **The app server's own backup stopped.** Check `systemctl status travelcomp-backup.service` and `/var/log/travelcomp/pg-backup.log` there |
| `no travelcomp-*.dump` | The app server has never produced a backup |

For an alert, point `OnFailure=` in the service at a unit that mails or pushes you (there is a
commented line for it). Without that, check `systemctl --failed` now and then, or look at
`/var/lib/travelcomp-backup/data/last-success`, which holds the time of the last good pull.

## Retention

The app prunes at 14 days; the backup server keeps `KEEP_DAYS=90` (never fewer than `MIN_KEEP=7`
dumps, so a broken source cannot make it prune everything). Nothing is deleted just because the
source deleted it, and `mail_store/` is never pruned. Files here are mode 0600 in a 0700 directory.

## Restore drill (do this once, then yearly)

A backup you have not restored is a hope. On any machine with Postgres client tools:

```bash
pg_restore -l /var/lib/travelcomp-backup/data/dumps/travelcomp-<newest>.dump | head     # readable?
createdb tc_restore_test
pg_restore -d tc_restore_test --no-owner /var/lib/travelcomp-backup/data/dumps/travelcomp-<newest>.dump
psql tc_restore_test -c 'select count(*) from trip'
dropdb tc_restore_test
```

For the vault, also confirm you can find `DOCUMENT_ENCRYPTION_KEY` in your password manager.

## Rotating the key / removing access

Re-run `add_backup_reader.sh` with the new public key (it replaces the old `tc-offsite-backup`
line), or delete that line from `/var/lib/tcbackup/.ssh/authorized_keys` to cut access at once.

## Tests

`tests/test_pull_backup.py` runs the real script and rsync against a local stand-in for the app
server: the pull, verification (and recovery after a quarantined file), the freshness check,
retention, "never `--delete`", and the authorized-key builder's refusal to accept injected
options. Not covered: the ssh transport itself. The `rrsync -ro` confinement was checked by hand
(reads under the root work; `..`, a path outside the root, a write, `--delete` and a shell are all refused).
