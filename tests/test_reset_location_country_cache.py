from sqlmodel import Session, select

from backend.models import LocationTimezone
from scripts.reset_location_country_cache import reset_all_countries


def test_reset_all_countries_clears_country_but_keeps_zone(session: Session):
    session.add(LocationTimezone(location="Brunsberg, Värmland, Sweden", iana_zone="Europe/Stockholm", country="Sverige"))
    session.commit()

    n = reset_all_countries(session)

    assert n == 1
    row = session.get(LocationTimezone, "Brunsberg, Värmland, Sweden")
    assert row.country is None
    assert row.iana_zone == "Europe/Stockholm"  # untouched — not language-dependent


def test_reset_all_countries_skips_rows_already_null(session: Session):
    session.add(LocationTimezone(location="Somewhere", iana_zone="Europe/Paris", country=None))
    session.commit()

    n = reset_all_countries(session)

    assert n == 0


def test_reset_all_countries_handles_a_mix(session: Session):
    session.add(LocationTimezone(location="Rome", iana_zone="Europe/Rome", country="Italy"))
    session.add(LocationTimezone(location="Nice", iana_zone="Europe/Paris", country=None))
    session.commit()

    n = reset_all_countries(session)

    assert n == 1
    locations = {r.location: r.country for r in session.exec(select(LocationTimezone)).all()}
    assert locations == {"Rome": None, "Nice": None}
