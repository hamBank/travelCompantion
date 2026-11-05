"""deploy.sh's strict mode and ERR trap (fleet spec DEP-1): a failed deploy must say
where it died, and benign non-zero exits must stay quiet. Runs the real header."""
import re
import subprocess
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent.parent / "deploy.sh"


def _header() -> str:
    s = DEPLOY.read_text()
    return s[s.index("set -Eeuo pipefail"): s.index("# ── Config (override")]


def _run(tmp_path, body: str):
    f = tmp_path / "t.sh"
    f.write_text("#!/usr/bin/env bash\n" + _header() + body)
    r = subprocess.run(["bash", str(f)], capture_output=True, text=True, timeout=30)
    return r.returncode, re.sub(r"\x1b\[[0-9;]*m", "", r.stderr), r.stdout


def test_a_failure_reports_file_line_command_and_status(tmp_path):
    rc, err, out = _run(tmp_path, "f() { ls /nonexistent-dir-xyz; }\nf\necho AFTER\n")
    assert rc == 2
    assert "AFTER" not in out
    assert re.search(r"✗ ERROR \S*t\.sh:\d+: `ls /nonexistent-dir-xyz` exited with status 2", err)


def test_benign_non_zero_exits_are_quiet(tmp_path):
    rc, err, out = _run(tmp_path, (
        "false || true\nif false; then :; fi\n[[ 1 -eq 2 ]] && echo no\n"
        'x="$(false || true)"\nf() { false || true; }\nf\necho done\n'))
    assert rc == 0 and "ERROR" not in err and "done" in out


def test_deploy_aborts_before_restart_when_the_config_check_fails():
    s = DEPLOY.read_text()
    check = s.index("scripts/check_config.py")
    restart = s.index('systemctl restart "$SERVICE_NAME"')
    assert check < restart, "the config check must run before the service is restarted"
    assert "die " in s[check: check + 400], "a failed config check must abort the deploy"
