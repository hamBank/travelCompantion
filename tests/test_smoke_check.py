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
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            body = {"status": "ok", "backend_sha": SHA}
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


def _stub_systemctl(tmp_path: Path, result: str) -> dict:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    stub = bindir / "systemctl"
    stub.write_text(
        "#!/usr/bin/env bash\n"
        'if [[ "$1" == "is-enabled" ]]; then echo enabled; exit 0; fi\n'
        f'if [[ "$1" == "show" ]]; then echo "{result}"; exit 0; fi\n'
    )
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    return {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "APP_DIR": str(tmp_path)}


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
