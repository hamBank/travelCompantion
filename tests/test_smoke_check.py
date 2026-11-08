"""scripts/smoke_check.sh: waits for a freshly restarted service, and fails
loudly on a broken scheduled job instead of passing silently.

Runs the real script against a throwaway local HTTP server and a stub
`systemctl` on PATH (so no systemd is needed).
"""
import json
import os
import socket
import stat
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "smoke_check.sh"
SHA = "abc1234"


class _Handler(BaseHTTPRequestHandler):
    BUILD = SHA  # what /health reports as build_sha; None = field absent

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            body = {"status": "ok", "backend_sha": SHA}
            if self.BUILD is not None:
                body["build_sha"] = self.BUILD
        else:
            body = {"weather": {"2026-01-01": {"source": "forecast"}}}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _serve(port: int, delay: float = 0.0) -> HTTPServer:
    holder = {}

    def run():
        time.sleep(delay)
        srv = HTTPServer(("127.0.0.1", port), _Handler)
        holder["srv"] = srv
        srv.serve_forever()

    threading.Thread(target=run, daemon=True).start()
    return holder


def _stub_systemctl(tmp_path: Path, result: str, only_unit: str = None) -> dict:
    """`only_unit`: report `result` just for that service (others succeed)."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    stub = bindir / "systemctl"
    show = (f'if [[ "$1" == "show" ]]; then if [[ "$2" == "{only_unit}" ]]; then echo "{result}"; else echo success; fi; exit 0; fi\n'
            if only_unit else f'if [[ "$1" == "show" ]]; then echo "{result}"; exit 0; fi\n')
    stub.write_text(
        "#!/usr/bin/env bash\n"
        'if [[ "$1" == "is-enabled" ]]; then echo enabled; exit 0; fi\n'
        + show
    )
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    # `crontab -l -u <user>` prints $TMP/crontab.txt when a test wrote one, else "no crontab".
    cron = bindir / "crontab"
    cron.write_text(
        "#!/usr/bin/env bash\n"
        f'if [[ -f "{tmp_path}/crontab.txt" ]]; then cat "{tmp_path}/crontab.txt"; exit 0; fi\n'
        'echo "no crontab for $3" >&2; exit 1\n'
    )
    cron.chmod(cron.stat().st_mode | stat.S_IEXEC)
    # SMOKE_CRON_FILES="" keeps the real /etc/cron.d out of the tests.
    return {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "APP_DIR": str(tmp_path),
            "SMOKE_CRON_FILES": ""}


def _run(port, env, *extra_args, wait="20"):
    return subprocess.run(
        ["bash", str(SCRIPT), f"http://127.0.0.1:{port}", *extra_args],
        env={**env, "SMOKE_CHECK_WAIT": wait, "SMOKE_CHECK_TIMEOUT": "2"},
        capture_output=True, text=True, timeout=60,
    )


def test_passes_when_everything_is_healthy(tmp_path):
    port = _free_port()
    _serve(port)
    r = _run(port, _stub_systemctl(tmp_path, "success"), SHA)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "matches expected" in r.stdout


def test_waits_for_a_service_that_is_still_starting(tmp_path):
    port = _free_port()
    _serve(port, delay=3.0)  # not listening yet when the script starts
    r = _run(port, _stub_systemctl(tmp_path, "success"))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "waiting up to" in r.stdout


def test_fails_when_service_never_comes_up(tmp_path):
    port = _free_port()  # nothing listening
    r = _run(port, _stub_systemctl(tmp_path, "success"), wait="2")
    assert r.returncode == 1
    assert "GET /health" in r.stdout


@pytest.mark.parametrize("result", ["exit-code", "signal", "timeout", "failed"])
def test_fails_when_a_scheduled_job_last_run_failed(tmp_path, result):
    port = _free_port()
    _serve(port)
    r = _run(port, _stub_systemctl(tmp_path, result))
    assert r.returncode == 1, r.stdout + r.stderr
    assert f"Result={result}" in r.stdout


def test_fails_on_sha_mismatch(tmp_path):
    port = _free_port()
    _serve(port)
    r = _run(port, _stub_systemctl(tmp_path, "success"), "deadbee")
    assert r.returncode == 1
    assert "expected 'deadbee'" in r.stdout


def test_passes_only_when_the_frontend_was_built_from_the_deployed_commit(tmp_path):
    port = _free_port()
    _serve(port)
    r = _run(port, _stub_systemctl(tmp_path, "success"), SHA)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Build check" in r.stdout and "matches expected" in r.stdout


def test_fails_when_the_frontend_build_is_stale(tmp_path, monkeypatch):
    # A skipped or failed build keeps serving the previous bundle: backend is
    # on the new commit, the bundle was built from an older one.
    monkeypatch.setattr(_Handler, "BUILD", "0ld0000")
    port = _free_port()
    _serve(port)
    r = _run(port, _stub_systemctl(tmp_path, "success"), SHA)
    assert r.returncode == 1
    assert "built from '0ld0000'" in r.stdout


def test_fails_when_health_has_no_build_sha(tmp_path, monkeypatch):
    monkeypatch.setattr(_Handler, "BUILD", None)
    port = _free_port()
    _serve(port)
    r = _run(port, _stub_systemctl(tmp_path, "success"), SHA)
    assert r.returncode == 1
    assert "not rebuilt" in r.stdout


def test_build_check_is_skipped_without_an_expected_sha(tmp_path, monkeypatch):
    monkeypatch.setattr(_Handler, "BUILD", None)
    port = _free_port()
    _serve(port)
    r = _run(port, _stub_systemctl(tmp_path, "success"))
    assert r.returncode == 0, r.stdout + r.stderr


# ── legacy cron entries that duplicate a systemd timer ───────────────────────

def _env_with_cron(tmp_path, crontab: str = None, cron_files: str = ""):
    env = _stub_systemctl(tmp_path, "success")
    if crontab is not None:
        (tmp_path / "crontab.txt").write_text(crontab)
    env["SMOKE_CRON_FILES"] = cron_files
    return env


def test_no_legacy_cron_entries_passes(tmp_path):
    port = _free_port()
    _serve(port)
    r = _run(port, _env_with_cron(tmp_path), SHA)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "No legacy cron entries" in r.stdout


@pytest.mark.parametrize("script", [
    "pg_backup.sh", "refresh_weather.py", "send_notifications.py",
    "reconcile_flight_alerts.py", "refresh_location_timezones.py",
])
def test_a_crontab_entry_for_a_timer_job_fails_the_check(tmp_path, script):
    port = _free_port()
    _serve(port)
    cron = f"15 3 * * * cd /opt/travelcomp && bash scripts/{script} >> backups/x.log 2>&1\n"
    r = _run(port, _env_with_cron(tmp_path, cron), SHA)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "runs twice" in r.stdout and script in r.stdout
    assert "crontab -u travelcomp -e" in r.stdout


def test_commented_out_and_unrelated_cron_lines_are_ignored(tmp_path):
    port = _free_port()
    _serve(port)
    cron = (
        "# 15 3 * * * bash scripts/pg_backup.sh   (disabled)\n"
        "\n"
        "0 4 * * * /usr/local/bin/some-other-job.sh\n"
        "*/5 * * * * curl -s localhost/health\n"
    )
    r = _run(port, _env_with_cron(tmp_path, cron), SHA)
    assert r.returncode == 0, r.stdout + r.stderr


def test_an_etc_cron_d_entry_is_found_too(tmp_path):
    port = _free_port()
    _serve(port)
    f = tmp_path / "travelcomp-cron"
    f.write_text("MAILTO=root\n*/15 * * * * travelcomp /opt/travelcomp/.venv/bin/python /opt/travelcomp/scripts/send_notifications.py\n")
    r = _run(port, _env_with_cron(tmp_path, cron_files=str(f)), SHA)
    assert r.returncode == 1 and "send_notifications.py" in r.stdout and str(f) in r.stdout


# ── every job timer is checked, not just three of them ───────────────────────

ALL_TIMERS = ["weather", "notifications", "flight-reconcile", "loctz", "backup"]


def test_all_five_job_timers_are_checked(tmp_path):
    port = _free_port()
    _serve(port)
    r = _run(port, _stub_systemctl(tmp_path, "success"), SHA)
    assert r.returncode == 0, r.stdout + r.stderr
    for name in ALL_TIMERS:
        assert f"travelcomp-{name}.timer enabled" in r.stdout, name


@pytest.mark.parametrize("name", ["flight-reconcile", "loctz"])
def test_a_failed_flight_reconcile_or_loctz_run_fails_the_check(tmp_path, name):
    # The AeroDataBox credit refill failed for weeks (fixed in #207) because this
    # check never read the flight-reconcile job's result.
    port = _free_port()
    _serve(port)
    env = _stub_systemctl(tmp_path, "exit-code", only_unit=f"travelcomp-{name}.service")
    r = _run(port, env, SHA)
    assert r.returncode == 1, r.stdout + r.stderr
    assert f"travelcomp-{name}.service's last run failed (Result=exit-code)" in r.stdout
