#!/usr/bin/env python3
"""Check the app's configuration the way the service will see it, before restarting it.

    scripts/check_config.py /opt/travelcomp/.env

deploy.sh runs this after pulling new code and BEFORE `systemctl restart`. It loads the
env file (systemd EnvironmentFile style: KEY=VALUE, optional quotes, no shell
expansion, so an unquoted `SHEET_NAMES=Itinerary 2026` is fine) and imports
`backend.auth`, which refuses to import when authentication is unsafe (neither enabled
nor explicitly disabled, or enabled with a missing/default JWT_SECRET). Exit 1 means the
deploy should abort and leave the running service untouched, instead of restarting
into a crash loop.

It also builds the database engine (without connecting), so a DATABASE_URL that names a
driver this venv does not have (`+psycopg2` after the fleet moved to psycopg3, say) aborts
the deploy here instead of crashing the service after the restart.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Settings the service gets only from its env file: don't let the deploy's own
# environment leak in and hide a problem.
_CHECKED = ("AUTH_ENABLED", "GOOGLE_CLIENT_ID", "JWT_SECRET", "DATABASE_URL")


def load_env_file(path: str) -> dict:
    values = {}
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def describe(error: Exception) -> str:
    """The reason, never the values: str() of a pydantic ValidationError quotes its
    input, and this output lands in the deploy log (fleet spec lesson 15)."""
    errors = getattr(error, "errors", None)
    if callable(errors):
        try:
            return "; ".join(
                ".".join(str(p) for p in err.get("loc", ())) + (": " if err.get("loc") else "") + err.get("msg", "")
                for err in errors(include_input=False)
            )
        except TypeError:  # not pydantic's signature
            pass
    return str(error)


def check_database_driver() -> None:
    """create_engine() imports the DBAPI named in the URL but does not connect, so this
    fails for a missing or misspelt driver and succeeds without needing the database."""
    from sqlalchemy import create_engine

    from backend.config import get_settings

    create_engine(get_settings().database_url).dispose()


def main(argv) -> int:
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    for key in _CHECKED:
        os.environ.pop(key, None)
    os.environ.update(load_env_file(argv[1]))
    try:
        check_database_driver()
    except Exception as e:
        print(f"DATABASE_URL: the database driver cannot be loaded ({type(e).__name__}: {describe(e)}). "
              "Install it in the venv or fix the URL's +driver part.", file=sys.stderr)
        return 1
    try:
        import backend.auth  # noqa: F401  (raises ConfigError when unsafe)
    except Exception as e:  # ConfigError, or anything else that would stop startup
        print(f"{type(e).__name__}: {describe(e)}", file=sys.stderr)
        return 1
    print("configuration OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
