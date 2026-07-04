# Plan 10 — "Where is my plane": live aircraft position

Read `docs/plans/README.md` first. **Do plan-2 first if both are scheduled** —
it creates `backend/flight_live.py`, which this plan extends. If plan-2 hasn't
run, do its "step 1" extraction as part of this plan.

## Goal

AeroDataBox's flight-by-number response can include the aircraft's live
position (a `location` object) when requested. Surface it in the existing
"Check flight" panel: coordinates + data age + an "Open in Maps" link. This is
deliberately phase-1 scope — **no embedded map**; a maps link gives the user
the full interactive experience at zero extra API cost.

## Uncertainty to resolve first (timebox: 30 min)

Whether the free/PRO AeroDataBox tier returns `location`, and the exact query
parameter, is unverified. With a real `AERODATABOX_KEY` (or by reading
https://doc.aerodatabox.com/), confirm:

1. The flight-by-number endpoint accepts `?withLocation=true` (believed true).
2. The response's `location` field shape — expected roughly
   `{ "lat": ..., "lon": ..., "reportedAtUtc": "...", "altitude": {...}, "groundSpeed": {...} }`
   (the field exists in their published client schema as
   `AirportFlightContractLocation`), populated only while the flight is
   airborne/trackable.

If the tier never returns location data, STOP and report back instead of
shipping dead UI — the graceful-absence handling below means partial shipping
is safe, but confirm before investing.

## Implementation steps

### 1. Backend — request + parse position

- In `backend/flight_live.py`'s `fetch_flight`, add `withLocation=true` to the
  request query string (httpx: pass `params={"withLocation": "true"}`).
- In `check_flight` (`backend/routers/items.py`), parse defensively:

  ```python
  loc = live.get("location") or {}
  aircraft_position = None
  if loc.get("lat") is not None and loc.get("lon") is not None:
      aircraft_position = {
          "lat": loc["lat"], "lng": loc["lon"],
          "reported_at_utc": loc.get("reportedAtUtc"),
          "ground_speed_kt": (loc.get("groundSpeed") or {}).get("knot"),
          "altitude_ft": (loc.get("altitude") or {}).get("feet"),
      }
  ```

  and include `"aircraft_position": aircraft_position` in the response dict
  (null when absent — which is the common case: pre-departure, after landing,
  or tier limitation).

### 2. Frontend — display in FlightCheckResults

`frontend/src/components/FlightDetailModal.jsx`, in `FlightCheckResults`
(the Live-check panel body). Under the panel header row, when
`result.aircraft_position` is set, add a row:

```
✈ In the air · 480 kt · 36,000 ft · as of 09:41 UTC   Track on map ↗
```

- Elide any null piece (speed/altitude/time each optional).
- Time: `reported_at_utc` → show `HH:MM UTC` (slice, don't date-math).
- Link: `https://maps.google.com/?q={lat},{lng}` with
  `target="_blank" rel="noreferrer"` — same pattern as `placeSearchUrl` in
  `StopCard.jsx`.
- Style consistent with the panel's other text-xs rows; the link in
  `--text-faint` like other external links.
- When `aircraft_position` is null: render nothing (no placeholder — the
  delay/status line already communicates flight state).

## Tests

- Backend (`tests/test_flight_check.py`): extend the existing fake-response
  tests —
  - live flight with a `location` → response `aircraft_position` populated
    (lat/lng mapped, `lon`→`lng` rename verified, speed/altitude extracted);
  - no `location` key → `aircraft_position` is null;
  - partial location (lat/lon only) → nulls for the optional fields;
  - the request includes `withLocation` (assert on the fake client's captured
    params/URL).
- Frontend: extend `frontend/src/__tests__/FlightDetailModal.test.jsx`
  (currently unit-tests `formatStatus`) only if you componentize the row into
  an exported pure helper (e.g. `formatPosition(pos)` returning the display
  string) — do that, and unit-test it: full data, partial data, null → null.

## Manual verification

Stub the flight-check response in the browser console (pattern in README
"Verifying UI changes") with an `aircraft_position` payload → row renders,
link opens Google Maps at the coordinates; stub without position → no row.
If a real key is available, check a currently-airborne flight end-to-end.

## Gotchas

- `lon` vs `lng`: AeroDataBox says `lon`; this codebase consistently uses
  `lng` — translate at the backend boundary as shown.
- Don't add a Static-Maps image endpoint in this phase; if later wanted, model
  it on `gpx_map`/`_static_map_png` in `items.py` (item-scoped, key stays
  server-side — README §7).
- Touches both backend and `frontend/src/` → build/amend/push workflow.
