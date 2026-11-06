"""All environment configuration, in one place (fleet spec CFG-1).

Every setting the app reads from the environment is a field here. Nothing else
under `backend/` may call `os.environ` / `os.getenv` (tests/test_config.py
enforces that), so this class is the complete list, `.env.example` documents
every field, and a typo'd or malformed value fails at startup with the field
name instead of surfacing later as a bad request.

Production loads `.env` through systemd's `EnvironmentFile`; there is no dotenv
file reading here, so a local run sees exactly the process environment.

Use `get_settings()`. It builds a fresh `Settings` from the current environment
on every call (cheap; no caching) so that a module which snapshots a value at
import time behaves as it always did, and a call-time read, or a test using
`monkeypatch.setenv`, still sees the live environment.
"""
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # env_ignore_empty: a line like `FLIGHT_ALERT_CREDIT_FLOOR=` (blank value, as the
    # .env template writes for secrets) means "unset", so numbers and flags fall back
    # to their defaults instead of failing to parse "".
    # hide_input_in_errors: a validation error must name the field, never quote the
    # value (the text lands in the deploy log and the journal; fleet spec lesson 15).
    model_config = SettingsConfigDict(extra="ignore", env_ignore_empty=True, hide_input_in_errors=True)

    # ── Database ─────────────────────────────────────────────────────────────
    database_url: str = "sqlite:///./travel.db"

    # ── Authentication (see backend/auth.py for the fail-closed rules) ───────
    # Kept as raw strings: auth.py's resolve_auth_enabled() distinguishes
    # "unset" from "false" and rejects typos, which a bool field could not.
    auth_enabled: str = ""
    google_client_id: str = ""
    jwt_secret: str = ""            # empty -> auth.py applies its public default
    jwt_expire_days: int = 30
    api_token_expire_days: int = 365
    # Sign-in allowlist, comma-separated; the first entry owns pre-sharing trips.
    allowed_emails: str = ""
    allowed_email: str = ""         # DEPRECATED singular form, read only while allowed_emails is empty

    # ── Server ───────────────────────────────────────────────────────────────
    log_dir: str = "/var/log/travelcomp"
    deploy_secret: str = ""         # GitHub webhook auto-deploy secret
    public_base_url: str = ""       # e.g. https://tripplan.example.com

    # ── Email ingestion ──────────────────────────────────────────────────────
    mail_ingest_secret: str = ""
    mail_domain: str = "tripplan.hups.club"
    mail_store_dir: str = ""        # empty -> <app root>/mail_store

    # ── Documents ────────────────────────────────────────────────────────────
    document_encryption_key: str = ""

    # ── Third-party APIs ─────────────────────────────────────────────────────
    anthropic_api_key: str = ""
    google_places_api_key: str = ""
    google_route_api_key: str = ""          # empty -> falls back to the Places key
    google_static_maps_api_key: str = ""    # empty -> falls back to the route key
    sheets_allow_interactive: bool = False  # 1 = let the Sheets client prompt for OAuth (dev only)

    # ── Flights (AeroDataBox) ────────────────────────────────────────────────
    aerodatabox_key: str = ""
    aerodatabox_webhook_secret: str = ""
    flight_alert_credit_floor: int = 20
    flight_alert_credit_refill: int = 40
    flight_alert_credit_refill_max: int = 40
    flight_alert_coverage_recheck_days: int = 7

    # ── Notifications / web push ─────────────────────────────────────────────
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_contact_email: str = "admin@tripplan.hups.club"
    departure_lead_hours: float = 3
    flight_alert_window_hours: float = 24
    flight_alert_poll_minutes: float = 45
    rail_alert_window_hours: float = 24
    rail_alert_poll_minutes: float = 30


def get_settings() -> Settings:
    """A `Settings` built from the environment as it is right now."""
    return Settings()


def optional(value: str) -> Optional[str]:
    """'' -> None, for settings where unset and empty mean the same."""
    return value or None
