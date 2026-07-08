"""Field-level compare-and-set for offline queue replay (plan 11).

Each PATCH request may carry an optional `base` — the value the client last
saw for each field/key it's changing. Comparing against `base` (rather than
relying on a version column) gives per-field conflict detection and, for
free, idempotent replay: a field whose current server value already equals
the incoming value is treated as already-applied and skipped rather than
flagged as a conflict.
"""
from typing import Optional


def resolve_fields(current_values: dict, base: dict, changes: dict, prefix: str = "") -> tuple[dict, list]:
    """Compare `changes` against `current_values` using `base` as the
    client's reference point.

    Returns (to_apply, conflicts):
      - to_apply: {key: value} subset of `changes` that should actually be
        written (excludes fields already matching the incoming value).
      - conflicts: [{"field", "base", "server", "mine"}, ...] for fields
        where the server value diverged from `base` AND doesn't already
        match `changes` (a real concurrent edit, not just a replay).

    A key in `changes` with no matching entry in `base` is applied directly
    (nothing to compare against, so trust the incoming value).
    """
    conflicts = []
    to_apply = {}
    for key, incoming in changes.items():
        current = current_values.get(key)
        if key not in base:
            to_apply[key] = incoming
            continue
        base_val = base[key]
        if current == base_val:
            to_apply[key] = incoming
        elif current == incoming:
            continue  # already applied — idempotent replay, nothing to do
        else:
            conflicts.append({"field": f"{prefix}{key}", "base": base_val, "server": current, "mine": incoming})
    return to_apply, conflicts
