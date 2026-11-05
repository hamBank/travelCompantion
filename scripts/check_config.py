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
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Settings the service gets only from its env file: don't let the deploy's own
# environment leak in and hide a problem.
_CHECKED = ("AUTH_ENABLED", "GOOGLE_CLIENT_ID", "JWT_SECRET")


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


def main(argv) -> int:
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    for key in _CHECKED:
        os.environ.pop(key, None)
    os.environ.update(load_env_file(argv[1]))
    try:
        import backend.auth  # noqa: F401  (raises ConfigError when unsafe)
    except Exception as e:  # ConfigError, or anything else that would stop startup
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print("configuration OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
