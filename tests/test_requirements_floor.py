"""Guard: requirements.txt must declare the SQLModel floor the code actually needs.

backend/models.py annotates local wall-clock datetime fields as pydantic's
NaiveDatetime, which only maps to a SQLAlchemy column type from SQLModel 0.0.45
(see CLAUDE.md, "Model datetime fields"). On older SQLModel, importing
backend.models raises:

    ValueError: <class 'pydantic.types.NaiveDatetime'> has no matching SQLAlchemy type

The tests themselves can't catch a too-old *production* venv — they run in
whatever environment CI built fresh. What went wrong on 2026-10-28 was that
requirements.txt still floored sqlmodel at 0.0.19, so `pip install -r` saw
prod's existing 0.0.39 as "already satisfied", never upgraded it, and the deploy's
`alembic upgrade head` died importing models.py. Declaring the true floor makes
pip upgrade the venv on the next deploy.
"""
import re
from pathlib import Path

from packaging.specifiers import SpecifierSet
from packaging.version import Version

REQUIREMENTS = Path(__file__).resolve().parent.parent / "backend" / "requirements.txt"

# First SQLModel release that maps NaiveDatetime (verified: 0.0.44 and 0.0.39
# both raise the ValueError above; 0.0.45 maps it to DateTime).
MIN_SQLMODEL = Version("0.0.45")


def _sqlmodel_specifier() -> SpecifierSet:
    for line in REQUIREMENTS.read_text().splitlines():
        m = re.match(r"^\s*sqlmodel\s*(.*?)\s*(?:#.*)?$", line, re.IGNORECASE)
        if m:
            return SpecifierSet(m.group(1))
    raise AssertionError("sqlmodel is not listed in backend/requirements.txt")


def test_sqlmodel_floor_excludes_versions_without_naivedatetime_support():
    spec = _sqlmodel_specifier()
    for old in ("0.0.19", "0.0.38", "0.0.39", "0.0.44"):
        assert not spec.contains(Version(old)), (
            f"requirements.txt allows sqlmodel {old}, which can't map NaiveDatetime — "
            f"an already-installed older venv would never be upgraded. "
            f"Floor must be >= {MIN_SQLMODEL}."
        )


def test_sqlmodel_floor_still_allows_the_minimum_and_newer():
    spec = _sqlmodel_specifier()
    assert spec.contains(MIN_SQLMODEL)
    assert spec.contains(Version("0.0.48"))


def test_sqlmodel_is_capped_below_the_next_untested_release():
    # Fleet spec STK-5: pre-1.0 sqlmodel can change datetime mapping in any
    # release, so a floor alone lets the next deploy pull in an untested one.
    spec = _sqlmodel_specifier()
    assert spec.contains(Version("0.0.48")), "cap must still allow the tested release"
    assert not spec.contains(Version("0.0.49")), (
        "requirements.txt has no cap below the next untested sqlmodel release; "
        "run the suite on the new version, then raise the cap on purpose."
    )
