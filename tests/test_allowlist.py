"""CFG-4 (ALLOWED_EMAILS, comma list; ALLOWED_EMAIL still read for one release)
and CFG-5 (the auth-disabled dev identity is dev@localhost)."""
import logging

import pytest

from backend import auth
from backend.allowlist import parse_allowed_emails


@pytest.fixture(autouse=True)
def _logger_enabled():
    # alembic/env.py's fileConfig() (run by the migration tests) disables every
    # logger that already exists; re-enable ours so caplog can see it.
    logging.getLogger("backend.allowlist").disabled = False


def test_comma_list_is_trimmed_lowercased_deduplicated_in_order():
    env = {"ALLOWED_EMAILS": " Me@Example.com, you@example.com ,,me@example.com"}
    assert parse_allowed_emails(env) == ["me@example.com", "you@example.com"]


def test_nothing_set_means_nobody_listed():
    assert parse_allowed_emails({}) == []
    assert parse_allowed_emails({"ALLOWED_EMAILS": " , "}) == []


def test_legacy_singular_is_still_read_with_a_deprecation_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="backend.allowlist"):
        assert parse_allowed_emails({"ALLOWED_EMAIL": "Old@Example.com"}) == ["old@example.com"]
    assert "ALLOWED_EMAIL is deprecated" in caplog.text


def test_plural_wins_outright_and_is_never_merged_with_the_legacy_value(caplog):
    # A stale singular value must not quietly widen who can sign in.
    env = {"ALLOWED_EMAILS": "new@example.com", "ALLOWED_EMAIL": "old@example.com"}
    with caplog.at_level(logging.WARNING, logger="backend.allowlist"):
        assert parse_allowed_emails(env) == ["new@example.com"]
    assert "deprecated" not in caplog.text


def test_every_listed_address_passes_the_sign_in_gate(session, monkeypatch):
    monkeypatch.setattr(auth, "ALLOWED_EMAILS", ["a@example.com", "b@example.com"])
    assert auth.email_authorised(session, "A@example.com")
    assert auth.email_authorised(session, "b@example.com")
    assert not auth.email_authorised(session, "c@example.com")


def test_dev_identity_is_dev_at_localhost():
    assert auth.DEV_USER_EMAIL == "dev@localhost"
