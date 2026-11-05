"""Fleet spec PRC-2: the SessionStart hook that makes a fresh remote session
able to run the tests. Only the wiring is tested here (the install itself needs
network); the point is that nobody breaks it silently."""
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOOK = ROOT / ".claude" / "hooks" / "session-start.sh"
SETTINGS = ROOT / ".claude" / "settings.json"


def test_settings_registers_the_hook():
    cfg = json.loads(SETTINGS.read_text())
    commands = [
        h["command"]
        for entry in cfg["hooks"]["SessionStart"]
        for h in entry["hooks"]
    ]
    assert "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh" in commands


def test_hook_is_executable():
    assert os.access(HOOK, os.X_OK), "chmod +x .claude/hooks/session-start.sh"


def test_hook_installs_the_real_requirements_file_and_sets_auth_off():
    text = HOOK.read_text()
    assert "backend/requirements.txt" in text
    assert (ROOT / "backend" / "requirements.txt").exists()
    assert "AUTH_ENABLED=false" in text


def test_hook_does_nothing_outside_a_remote_session(tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_REMOTE"}
    env["CLAUDE_PROJECT_DIR"] = str(tmp_path)  # would fail loudly if it ran
    r = subprocess.run(["bash", str(HOOK)], env=env, capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (tmp_path / ".venv").exists()
