"""Fleet spec CFG-1: one Settings class owns every environment variable.

Three things have to stay true or the class stops being the complete list:
  * nothing under backend/ reads os.environ / os.getenv except backend/config.py,
  * every Settings field is documented in .env.example (so an operator can find it),
  * a malformed value fails at startup naming the field.
"""
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.config import Settings, get_settings

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"


def test_nothing_else_in_backend_reads_the_environment():
    offenders = []
    for path in BACKEND.rglob("*.py"):
        if path == BACKEND / "config.py" or "static" in path.relative_to(BACKEND).parts:
            continue
        text = path.read_text()
        for n, line in enumerate(text.splitlines(), 1):
            if re.search(r"\bos\.(environ|getenv)\b|\b_os\.(environ|getenv)\b|\bgetenv\(", line):
                offenders.append(f"{path.relative_to(ROOT)}:{n}: {line.strip()}")
    assert not offenders, "read settings through backend.config.get_settings():\n" + "\n".join(offenders)


def test_every_setting_is_documented_in_env_example():
    documented = set(
        m.group(1).lower()
        for m in re.finditer(r"^#?\s*([A-Z][A-Z0-9_]+)=", (ROOT / ".env.example").read_text(), re.M)
    )
    missing = sorted(set(Settings.model_fields) - documented)
    assert not missing, f".env.example has no entry for: {', '.join(m.upper() for m in missing)}"


def test_env_example_documents_no_variable_the_app_ignores():
    documented = set(
        m.group(1).lower()
        for m in re.finditer(r"^#?\s*([A-Z][A-Z0-9_]+)=", (ROOT / ".env.example").read_text(), re.M)
    )
    stale = sorted(documented - set(Settings.model_fields))
    assert not stale, f".env.example lists variables Settings does not read: {', '.join(s.upper() for s in stale)}"


def test_defaults_match_the_values_the_code_used_before(monkeypatch):
    # The Postgres CI job sets DATABASE_URL; defaults are what an unset env gives.
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)
    s = Settings(_env_file=None)
    assert s.database_url == "sqlite:///./travel.db"
    assert (s.jwt_expire_days, s.api_token_expire_days) == (30, 365)
    assert s.log_dir == "/var/log/travelcomp"
    assert s.mail_domain == "tripplan.hups.club"
    assert (s.flight_alert_credit_floor, s.flight_alert_credit_refill, s.flight_alert_credit_refill_max) == (20, 40, 40)
    assert s.flight_alert_coverage_recheck_days == 7
    assert (s.departure_lead_hours, s.flight_alert_window_hours, s.flight_alert_poll_minutes) == (3, 24, 45)
    assert (s.rail_alert_window_hours, s.rail_alert_poll_minutes) == (24, 30)
    assert s.vapid_contact_email == "admin@tripplan.hups.club"
    assert s.sheets_allow_interactive is False


def test_variables_are_read_by_their_upper_case_names(monkeypatch):
    monkeypatch.setenv("FLIGHT_ALERT_CREDIT_FLOOR", "11")
    monkeypatch.setenv("SHEETS_ALLOW_INTERACTIVE", "1")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://example.test/")
    s = get_settings()
    assert s.flight_alert_credit_floor == 11
    assert s.sheets_allow_interactive is True
    assert s.public_base_url == "https://example.test/"


def test_get_settings_sees_the_live_environment_every_call(monkeypatch):
    # Call-time readers (push keys, the Anthropic key) and monkeypatch.setenv in
    # tests rely on this: Settings is not cached.
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    assert get_settings().vapid_private_key == ""
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "abc")
    assert get_settings().vapid_private_key == "abc"


@pytest.mark.parametrize("name,value", [
    ("JWT_EXPIRE_DAYS", "thirty"),
    ("DEPARTURE_LEAD_HOURS", "soon"),
    ("FLIGHT_ALERT_CREDIT_FLOOR", "1.5x"),
])
def test_a_malformed_value_fails_naming_the_field(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError) as err:
        get_settings()
    assert name.lower() in str(err.value)


def test_a_blank_value_means_unset(monkeypatch):
    # The deploy template writes blank lines (`GOOGLE_CLIENT_ID=`); a blank number
    # or flag must fall back to its default rather than fail to parse "".
    monkeypatch.setenv("FLIGHT_ALERT_CREDIT_FLOOR", "")
    monkeypatch.setenv("SHEETS_ALLOW_INTERACTIVE", "")
    monkeypatch.setenv("DEPARTURE_LEAD_HOURS", "")
    s = get_settings()
    assert s.flight_alert_credit_floor == 20
    assert s.sheets_allow_interactive is False
    assert s.departure_lead_hours == 3
