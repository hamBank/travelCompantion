"""deploy/backup-server/travelcomp-pull-backup.sh: the off-box copy (fleet spec DEP-6).

Runs the real script and a real rsync against a local directory standing in for the
app server (SRC_HOST empty = local path), so the pull, the verification, the
freshness check and the retention rules are exercised end to end. The ssh transport is
the only thing not covered here.
"""
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "deploy" / "backup-server" / "travelcomp-pull-backup.sh"
ADD_READER = Path(__file__).resolve().parent.parent / "scripts" / "add_backup_reader.sh"
HOUR = 3600
DAY = 86400

pytestmark = pytest.mark.skipif(shutil.which("rsync") is None, reason="rsync not installed")


def _age(path: Path, seconds: float):
    t = time.time() - seconds
    os.utime(path, (t, t))


def _dump(path: Path, age=2 * HOUR, body=b"PGDMP" + b"\x01" * 200):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    _age(path, age)
    return path


def _sql(path: Path, age=2 * HOUR, complete=True):
    tail = "\n--\n-- PostgreSQL database dump complete\n--\n" if complete else "\nCOPY trip (id"
    path.write_text("-- dump\n" + tail)
    _age(path, age)
    return path


@pytest.fixture
def world(tmp_path):
    """An app dir with backups/ and mail_store/, and an empty destination."""
    app = tmp_path / "app"
    (app / "backups").mkdir(parents=True)
    (app / "mail_store" / "abc").mkdir(parents=True)
    (app / "mail_store" / "abc" / "raw.eml").write_text("From: a@b\n\nhello")
    (app / ".env").write_text("DOCUMENT_ENCRYPTION_KEY=secret\n")
    return {"app": app, "dest": tmp_path / "dest"}


def run(world, **env):
    base = {
        "PATH": os.environ["PATH"], "HOME": str(world["app"].parent),
        "TC_PULL_CONF": "/nonexistent", "SRC_ROOT": str(world["app"]), "SRC_HOST": "",
        "DEST": str(world["dest"]),
    }
    return subprocess.run(["bash", str(SCRIPT)], env={**base, **{k: str(v) for k, v in env.items()}},
                          capture_output=True, text=True, timeout=60)


def names(d: Path):
    return sorted(p.name for p in d.iterdir()) if d.exists() else []


def test_pulls_dumps_and_the_mail_store_and_leaves_the_source_alone(world):
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    _sql(world["app"] / "backups" / "travelcomp-20261105-120000.sql", age=20 * HOUR)
    r = run(world)
    assert r.returncode == 0, r.stdout + r.stderr
    assert names(world["dest"] / "dumps") == ["travelcomp-20261105-120000.sql", "travelcomp-20261106-000501.dump"]
    assert (world["dest"] / "mail_store" / "abc" / "raw.eml").read_text().endswith("hello")
    assert (world["app"] / "backups" / "travelcomp-20261106-000501.dump").exists()      # source untouched
    assert (world["dest"] / "last-success").exists()
    assert "✓ ok" in r.stdout


def test_only_backup_files_are_pulled_never_the_secrets(world):
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    (world["app"] / "backups" / ".env").write_text("secret")
    (world["app"] / "backups" / "notes.txt").write_text("x")
    run(world)
    assert names(world["dest"] / "dumps") == ["travelcomp-20261106-000501.dump"]
    assert not list(world["dest"].rglob(".env")) and not list(world["dest"].rglob("DOCUMENT_ENCRYPTION_KEY*"))


def test_local_copies_are_private(world):
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump").chmod(0o644)
    run(world)
    assert (world["dest"] / "dumps" / "travelcomp-20261106-000501.dump").stat().st_mode & 0o077 == 0
    assert world["dest"].stat().st_mode & 0o077 == 0


def test_a_file_deleted_at_the_source_is_kept_here(world):
    # The app prunes at 14 days; our retention is separate (no rsync --delete).
    old = _dump(world["app"] / "backups" / "travelcomp-20261001-000000.dump", age=5 * DAY)
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    run(world)
    old.unlink()
    assert run(world).returncode == 0
    assert "travelcomp-20261001-000000.dump" in names(world["dest"] / "dumps")


# ── verification ──────────────────────────────────────────────────────────────

def test_a_truncated_dump_fails_the_run_and_is_quarantined_then_recovers(world):
    good = _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    bad = _dump(world["app"] / "backups" / "travelcomp-20261106-010000.dump", body=b"")
    r = run(world)
    assert r.returncode == 1 and "not a pg_dump file" in r.stdout + r.stderr
    assert "travelcomp-20261106-010000.dump" in names(world["dest"] / "quarantine")
    assert "travelcomp-20261106-010000.dump" not in names(world["dest"] / "dumps")
    assert not (world["dest"] / "last-success").exists()
    # The source is fixed (the dump finished writing): the next run fetches it again.
    _dump(bad, body=b"PGDMP" + b"\x02" * 300)
    r = run(world)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "travelcomp-20261106-010000.dump" in names(world["dest"] / "dumps")
    assert good.exists()


def test_an_incomplete_sql_dump_is_rejected(world):
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    _sql(world["app"] / "backups" / "travelcomp-20261106-020000.sql", complete=False)
    r = run(world)
    assert r.returncode == 1 and "incomplete SQL dump" in r.stdout + r.stderr


# ── freshness ─────────────────────────────────────────────────────────────────

def test_a_stale_newest_dump_fails_with_a_clear_reason(world):
    _dump(world["app"] / "backups" / "travelcomp-20261104-000501.dump", age=50 * HOUR)
    r = run(world)
    assert r.returncode == 1
    assert "50h old" in r.stdout + r.stderr and "may have stopped" in r.stdout + r.stderr
    assert not (world["dest"] / "last-success").exists()


def test_the_age_limit_is_configurable(world):
    _dump(world["app"] / "backups" / "travelcomp-20261104-000501.dump", age=50 * HOUR)
    assert run(world, MAX_AGE_HOURS=72).returncode == 0


def test_no_dumps_at_all_fails(world):
    r = run(world)
    assert r.returncode == 1 and "no backup" in r.stdout + r.stderr


def test_a_missing_source_directory_fails_instead_of_passing_silently(world):
    shutil.rmtree(world["app"] / "backups")
    r = run(world)
    assert r.returncode == 1 and "rsync of backups failed" in r.stdout + r.stderr


# ── our own retention ─────────────────────────────────────────────────────────

def test_old_dumps_are_pruned_but_never_below_the_minimum(world):
    d = world["app"] / "backups"
    for i in range(10):
        _dump(d / f"travelcomp-2026080{i}-000000.dump", age=(120 + i) * DAY)
    _dump(d / "travelcomp-20261106-000501.dump")
    # 11 dumps, 10 older than KEEP_DAYS: pruning to 1 would leave fewer than MIN_KEEP.
    run(world, KEEP_DAYS=90, MIN_KEEP=7)
    assert len(names(world["dest"] / "dumps")) == 11
    run(world, KEEP_DAYS=90, MIN_KEEP=1)
    assert names(world["dest"] / "dumps") == ["travelcomp-20261106-000501.dump"]


def test_the_mail_store_is_never_pruned(world):
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    old = world["app"] / "mail_store" / "abc" / "raw.eml"
    _age(old, 400 * DAY)
    run(world, KEEP_DAYS=1, MIN_KEEP=1)
    assert (world["dest"] / "mail_store" / "abc" / "raw.eml").exists()


def test_the_mail_store_can_be_skipped(world):
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    assert run(world, SRC_MAIL="").returncode == 0
    assert not list((world["dest"] / "mail_store").iterdir())


# ── guard rails ───────────────────────────────────────────────────────────────

def test_a_remote_pull_without_a_key_or_pinned_host_key_refuses_to_start(world):
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    r = run(world, SRC_HOST="tcbackup@app.example", SSH_KEY=world["app"] / "nokey")
    assert r.returncode == 1 and "ssh key" in r.stdout + r.stderr
    key = world["app"].parent / "key"
    key.write_text("k")
    r = run(world, SRC_HOST="tcbackup@app.example", SSH_KEY=key, KNOWN_HOSTS=world["app"] / "nohosts")
    assert r.returncode == 1 and "accept the app server's host key" in r.stdout + r.stderr


def test_two_runs_at_once_do_not_overlap(world):
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    world["dest"].mkdir()
    holder = subprocess.Popen(["bash", "-c", f"exec 9>{world['dest']}/.lock; flock 9; sleep 5"])
    time.sleep(0.5)
    try:
        r = run(world)
        assert r.returncode == 1 and "already running" in r.stdout + r.stderr
    finally:
        holder.kill()


def _can_make_a_readonly_mount(tmp_path: Path) -> bool:
    """A private mount namespace with a read-only tmpfs needs root (or user namespaces)."""
    d = tmp_path / "probe"
    d.mkdir()
    r = subprocess.run(["unshare", "-m", "sh", "-c", f"mount -t tmpfs tmpfs {d} && mount -o remount,ro {d}"],
                       capture_output=True)
    return r.returncode == 0


def test_a_destination_on_a_read_only_filesystem_says_how_to_fix_it(world, tmp_path):
    # What the systemd sandbox (ProtectSystem=strict) does to a DEST on another disk:
    # the directory exists and looks fine, but nothing can be written to it. Before the fix
    # this surfaced as a bare "chmod: … Read-only file system".
    if shutil.which("unshare") is None or not _can_make_a_readonly_mount(tmp_path):
        pytest.skip("cannot create a read-only mount here")
    _dump(world["app"] / "backups" / "travelcomp-20261106-000501.dump")
    ro = tmp_path / "ro"
    ro.mkdir()
    dest = ro / "dest"
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "TC_PULL_CONF": "/nonexistent",
           "SRC_ROOT": str(world["app"]), "SRC_HOST": "", "DEST": str(dest)}
    r = subprocess.run(
        ["unshare", "-m", "sh", "-c",
         f"mount -t tmpfs tmpfs {ro} && mkdir {dest} && mount -o remount,ro {ro} && exec bash {SCRIPT}"],
        env=env, capture_output=True, text=True, timeout=60)
    out = r.stdout + r.stderr
    assert r.returncode == 1, out
    assert "is not writable" in out and "install.sh --dest" in out
    assert "chmod:" not in out                       # the failure is explained, not a bare chmod error


# ── scripts/add_backup_reader.sh (the app-server side) ───────────────────────

KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UVd1G1ZS+8YHvVE9KlUE2HQkvZ5G backup@vault"


def reader(*args, stdin=KEY):
    return subprocess.run(["bash", str(ADD_READER), "--print-line", *args, "-"], input=stdin,
                          capture_output=True, text=True, timeout=30)


def test_the_authorized_key_is_read_only_and_confined():
    r = reader("--from", "203.0.113.7")
    assert r.returncode == 0, r.stderr
    line = r.stdout.strip()
    assert line.startswith('restrict,from="203.0.113.7",command="')
    assert ' -ro /opt/travelcomp"' in line
    assert line.endswith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UVd1G1ZS+8YHvVE9KlUE2HQkvZ5G tc-offsite-backup")
    assert "backup@vault" not in line                      # the caller's comment is replaced by our marker


def test_a_key_that_brings_its_own_options_is_refused():
    # An options prefix could smuggle in a different command=.
    r = reader(stdin='command="sh" ' + KEY)
    assert r.returncode == 1 and "not a bare ssh public key" in r.stderr


@pytest.mark.parametrize("value", ['1.2.3.4" ,command="sh', "1.2.3.4 5.6.7.8", "$(id)"])
def test_from_cannot_be_used_to_inject_options(value):
    r = reader("--from", value)
    assert r.returncode == 1 and "unexpected characters" in r.stderr


def test_the_app_dir_must_be_a_plain_path():
    r = reader("--app-dir", '/opt/x" -rw /')
    assert r.returncode == 1


# ── the files install.sh installs exist and agree with each other ────────────

def test_the_installer_and_units_agree():
    d = SCRIPT.parent
    installer = (d / "install.sh").read_text()
    for name in ("travelcomp-pull-backup.sh", "travelcomp-pull-backup.service",
                 "travelcomp-pull-backup.timer", "travelcomp-pull-backup.conf.example"):
        assert (d / name).exists() and name in installer
    service = (d / "travelcomp-pull-backup.service").read_text()
    assert "ExecStart=/usr/local/sbin/travelcomp-pull-backup.sh" in service
    assert "Type=oneshot" in service and "User=tcpull" in service
    # --dest: the sandbox exception and the mount dependency must both be written.
    assert "ReadWritePaths=$DEST_DIR" in installer and "RequiresMountsFor=$DEST_DIR" in installer
    assert "--dest" in installer and "ReadWritePaths=" in service
    timer = (d / "travelcomp-pull-backup.timer").read_text()
    assert "Persistent=true" in timer and "OnCalendar=" in timer
    for script in (SCRIPT, d / "install.sh", ADD_READER):
        assert subprocess.run(["bash", "-n", str(script)]).returncode == 0
