# Plan 17b — Personal totals count trips you're traveling on

Read `docs/plans/README.md` first, then `docs/plans/plan-17-travelers.md`
(D6 is what this implements). Depends on **17a** (`Traveler` table and
`backend/travelers.py::trip_ids_traveled_by`). Mostly backend, plus one
small frontend component change (so this PR follows the two-commit build
rule).

## Goal

A user's lifetime distance — and the new trips / days / countries counts —
add up the trips they are a **traveler** on, not every trip they can open.
Planning a trip for someone else no longer inflates your own numbers.

## Files

- **`backend/distance.py`** — `compute_user_distance_totals`: replace the
  `TripMembership` query with `trip_ids_traveled_by(session, email)` (D6).
  Nothing else about the computation or the `UserDistanceTotal` cache
  changes.
- **`backend/routers/me.py`** — new `GET /me/travel-totals`:
  ```json
  {"trips": 4, "days": 37, "countries": ["JP", "FR"],
   "distance": {"by_mode": {"air": 18234.0, "rail": 812.5}, "total_km": 19046.5}}
  ```
  - `trips`: count of `trip_ids_traveled_by`.
  - `days`: sum over those trips of the trip's span in days (first→last day
    inclusive, computed with the same range rule the calendar uses —
    `trip.start_date/end_date` widened by stop and item dates; reuse the
    helper `validation.py`/17a settled on, don't add a third definition);
    undated trips contribute 0.
  - `countries`: sorted unique `Stop.country` values (non-empty) across
    those trips.
  - `distance`: exactly the existing `/me/distance-totals` payload.
  Keep `GET /me/distance-totals` working unchanged (it's cached client-side
  and documented); it simply now reflects D6 via the shared helper.
- **`frontend/src/api.js`** — `getMyTravelTotals`.
- **`frontend/src/components/DistanceSummary.jsx`** — the "My totals" block
  switches to `getMyTravelTotals`, shows "across N trips you're traveling
  on · D days · C countries" above the by-mode list, and, when the current
  trip's user is *not* a traveler on it, a one-line hint: "You're not listed
  as a traveler on this trip, so it isn't in your totals — add yourself
  under Travelers." (Needs the travelers list: `getTravelers(tripId)` from
  17c if merged, else add the one-line helper here — both PRs adding the
  same one-liner to `api.js` is a trivial merge.)
- **`docs/programmatic-api.md`** — one paragraph under the travelers
  section: totals are traveler-based.

## Tests

`tests/test_distance_endpoints.py` (extend) / `tests/test_me_totals.py` (new):
- A user who is owner of trip A (not a traveler) and traveler on trip B:
  `/me/distance-totals` equals trip B's distance only; add them as a
  traveler on A → both; remove the traveler row (membership intact) → B only.
- `/me/travel-totals`: `trips`, `days` (a 3-day dated trip + an undated
  trip → 3), `countries` sorted/unique/non-empty, `distance` matches
  `/me/distance-totals` exactly.
- A non-member traveler row (no `user_email`) never contributes to anyone.
- Case-insensitivity: traveler `user_email` stored lowercase matches a
  mixed-case JWT email.

`frontend/src/__tests__/DistanceSummary.test.jsx` (extend): renders the
trips/days/countries line from a mocked `getMyTravelTotals`; shows the
not-a-traveler hint only when the current user's email isn't in the
mocked travelers list.

Run both suites; two-commit build; PR per `CLAUDE.md`.
