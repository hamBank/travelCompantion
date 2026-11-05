"""The sign-in allowlist: who may authenticate at all (fleet spec CFG-4).

`ALLOWED_EMAILS` is a comma-separated list. The old singular `ALLOWED_EMAIL`
is still read when `ALLOWED_EMAILS` is unset or empty, so an existing server
`.env` keeps working through the rename (it logs a deprecation warning). If
both are set, `ALLOWED_EMAILS` wins outright: the two are never merged, so a
stale singular value can't quietly widen who may sign in.

No imports from the rest of the app, so database.py can use it without pulling
in backend.auth (which validates the auth config at import).
"""
import logging
from typing import Mapping

log = logging.getLogger(__name__)


def _split(raw: str) -> list[str]:
    seen: list[str] = []
    for part in (raw or "").split(","):
        email = part.strip().lower()
        if email and email not in seen:
            seen.append(email)
    return seen


def parse_allowed_emails(env: Mapping[str, str]) -> list[str]:
    """Lower-cased, de-duplicated, in the order written. Empty = nobody listed
    (the sign-in gate is then open and per-trip membership gates access)."""
    emails = _split(env.get("ALLOWED_EMAILS", ""))
    if emails:
        return emails
    legacy = _split(env.get("ALLOWED_EMAIL", ""))
    if legacy:
        log.warning("ALLOWED_EMAIL is deprecated; rename it to ALLOWED_EMAILS "
                    "(comma-separated) in .env")
    return legacy
