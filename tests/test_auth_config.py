"""Authentication fails closed (fleet spec CFG-2, CFG-3).

backend.auth refuses to import when auth is neither configured nor explicitly off,
or is enabled with a missing/default JWT_SECRET. Before, AUTH_ENABLED was derived from
GOOGLE_CLIENT_ID being non-empty, so one lost .env line silently turned auth off.
"""
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from backend import auth
from backend.auth import ConfigError, resolve_auth_enabled, validate_auth_config

REPO = Path(__file__).resolve().parent.parent
GOOD_SECRET = "a" * 64


# ── AUTH_ENABLED ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value", ["true", "TRUE", "1", "yes", "on", " true "])
def test_explicitly_enabled(value):
    assert resolve_auth_enabled({"AUTH_ENABLED": value}) is True


@pytest.mark.parametrize("value", ["false", "False", "0", "no", "off"])
def test_explicitly_disabled(value):
    assert resolve_auth_enabled({"AUTH_ENABLED": value}) is False


def test_explicit_false_wins_over_a_client_id():
    assert resolve_auth_enabled({"AUTH_ENABLED": "false", "GOOGLE_CLIENT_ID": "x"}) is False


def test_a_typo_is_an_error_not_a_guess():
    with pytest.raises(ConfigError, match="not a boolean"):
        resolve_auth_enabled({"AUTH_ENABLED": "ture"})


def test_unset_with_a_client_id_stays_enabled_and_warns(caplog):
    # Keeps existing deployments (which never set AUTH_ENABLED) working.
    with caplog.at_level(logging.WARNING):
        assert resolve_auth_enabled({"GOOGLE_CLIENT_ID": "x"}) is True
    assert "AUTH_ENABLED is not set" in caplog.text


@pytest.mark.parametrize("env", [{}, {"GOOGLE_CLIENT_ID": ""}, {"AUTH_ENABLED": ""}])
def test_unset_with_no_client_id_refuses_to_start(env):
    with pytest.raises(ConfigError, match="refusing to start"):
        resolve_auth_enabled(env)


# ── JWT_SECRET / client id when enabled ──────────────────────────────────────

def test_enabled_needs_a_client_id():
    with pytest.raises(ConfigError, match="GOOGLE_CLIENT_ID"):
        validate_auth_config(True, "", GOOD_SECRET)


@pytest.mark.parametrize("secret", ["", auth._DEFAULT_JWT_SECRET])
def test_enabled_rejects_a_missing_or_default_secret(secret):
    with pytest.raises(ConfigError, match="JWT_SECRET"):
        validate_auth_config(True, "client", secret)


def test_enabled_with_real_settings_is_fine():
    validate_auth_config(True, "client", GOOD_SECRET)


def test_disabled_does_not_care_about_the_secret():
    validate_auth_config(False, "", auth._DEFAULT_JWT_SECRET)


# ── the real import, in a clean process ──────────────────────────────────────

def _import_auth(env: dict):
    base = {"PATH": os.environ["PATH"], "DATABASE_URL": "sqlite://"}
    return subprocess.run(
        [sys.executable, "-c", "import backend.auth"],
        cwd=REPO, env={**base, **env}, capture_output=True, text=True, timeout=60,
    )


def test_import_fails_with_nothing_configured():
    r = _import_auth({})
    assert r.returncode != 0 and "AUTH_ENABLED is not set" in r.stderr


def test_import_fails_when_enabled_with_the_default_secret():
    r = _import_auth({"AUTH_ENABLED": "true", "GOOGLE_CLIENT_ID": "c"})
    assert r.returncode != 0 and "JWT_SECRET" in r.stderr


def test_import_works_in_dev_and_with_real_settings():
    assert _import_auth({"AUTH_ENABLED": "false"}).returncode == 0
    assert _import_auth({"AUTH_ENABLED": "true", "GOOGLE_CLIENT_ID": "c", "JWT_SECRET": GOOD_SECRET}).returncode == 0


# ── scripts/check_config.py: what deploy.sh runs before restarting ───────────

def _check(tmp_path, env_file_text: str, extra_env=None):
    f = tmp_path / ".env"
    f.write_text(env_file_text)
    base = {"PATH": os.environ["PATH"], "DATABASE_URL": "sqlite://"}
    return subprocess.run(
        [sys.executable, str(REPO / "scripts" / "check_config.py"), str(f)],
        env={**base, **(extra_env or {})}, capture_output=True, text=True, timeout=60,
    )


def test_check_config_accepts_a_good_env_file(tmp_path):
    r = _check(tmp_path, f"AUTH_ENABLED=true\nGOOGLE_CLIENT_ID=c\nJWT_SECRET={GOOD_SECRET}\n")
    assert r.returncode == 0 and "configuration OK" in r.stdout


def test_check_config_rejects_the_default_secret(tmp_path):
    r = _check(tmp_path, "AUTH_ENABLED=true\nGOOGLE_CLIENT_ID=c\n")
    assert r.returncode == 1 and "JWT_SECRET" in r.stderr


def test_check_config_rejects_a_lost_client_id(tmp_path):
    # The incident the rule exists for: the GOOGLE_CLIENT_ID line goes missing.
    r = _check(tmp_path, f"JWT_SECRET={GOOD_SECRET}\n")
    assert r.returncode == 1 and "refusing to start" in r.stderr


def test_check_config_ignores_the_deploys_own_environment(tmp_path):
    # Only the env file counts: it is all the service gets.
    r = _check(tmp_path, "JWT_SECRET=x\n", {"AUTH_ENABLED": "false"})
    assert r.returncode == 1


def test_check_config_reads_the_file_like_systemd_not_like_bash(tmp_path):
    text = ('AUTH_ENABLED="true"\nGOOGLE_CLIENT_ID=\'c\'\n# a comment\n\n'
            f"SHEET_NAMES=Itinerary 2026 and more\nJWT_SECRET={GOOD_SECRET}\n")
    assert _check(tmp_path, text).returncode == 0


def test_check_config_aborts_on_a_malformed_setting_and_names_it(tmp_path):
    # Settings validates every field at startup (fleet spec CFG-1): a typo in a
    # number must stop the deploy here, not surface later as a 500 in production.
    r = _check(tmp_path, f"AUTH_ENABLED=false\nJWT_EXPIRE_DAYS=thirty\nJWT_SECRET={GOOD_SECRET}\n")
    assert r.returncode == 1 and "jwt_expire_days" in r.stderr



# ── the database driver must be loadable (fleet spec D4: psycopg3 across the fleet) ──

def _env(*lines: str) -> str:
    return "\n".join(["AUTH_ENABLED=false", f"JWT_SECRET={GOOD_SECRET}", *lines]) + "\n"


def test_check_config_aborts_when_the_database_driver_is_not_installed(tmp_path):
    # `mysql+pymysql` stands for "a +driver this venv does not have", e.g. +psycopg2 left
    # in .env after the requirements moved to psycopg3. Without this check the service
    # would crash after the restart.
    r = _check(tmp_path, _env("DATABASE_URL=mysql+pymysql://u:p@localhost/db"))
    assert r.returncode == 1
    assert "database driver cannot be loaded" in r.stderr and "pymysql" in r.stderr


def test_check_config_aborts_on_a_misspelt_driver(tmp_path):
    r = _check(tmp_path, _env("DATABASE_URL=postgresql+psycopg9://u:p@localhost/db"))
    assert r.returncode == 1 and "database driver cannot be loaded" in r.stderr


@pytest.mark.parametrize("url", [
    "sqlite:///./travel.db",
    "postgresql+psycopg://travelcomp:secret@localhost/travelcomp",
])
def test_check_config_accepts_loadable_drivers_without_connecting(tmp_path, url):
    # The Postgres URL points at nothing: the check imports the driver, it does not connect.
    r = _check(tmp_path, _env(f"DATABASE_URL={url}"))
    assert r.returncode == 0, r.stderr


def test_check_config_uses_the_env_files_database_url_not_the_deploys(tmp_path):
    # A DATABASE_URL leaked from the deploy's shell must not hide a bad one in .env.
    r = _check(tmp_path, _env("DATABASE_URL=mysql+pymysql://u:p@h/db"), {"DATABASE_URL": "sqlite://"})
    assert r.returncode == 1


def test_a_validation_failure_never_echoes_the_value(tmp_path):
    r = _check(tmp_path, _env("JWT_EXPIRE_DAYS=hunter2-not-a-number"))
    assert r.returncode == 1 and "jwt_expire_days" in r.stderr
    assert "hunter2" not in r.stderr
