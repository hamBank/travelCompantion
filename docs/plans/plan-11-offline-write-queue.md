# Plan 11 — Offline write queue with basic conflict resolution

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Goal

Read-only offline shipped in PR #57: the service worker serves the app shell
and cached trip/weather data with no network, and the UI forces the viewer
role offline so edit affordances hide. This plan adds the write side: let the
traveller make itinerary changes with no connection — queued locally, applied
optimistically to the UI, replayed automatically on reconnect — with a basic
but principled resolution scheme for the case where the same data changed on
the server while they were offline (e.g. a travel partner edited it from
another device).

## Constraints that shape the design

- **The PATCH surface is column-granular, and `details` is one column.**
  `PATCH /items/{id}` (backend/routers/items.py `update_item`) sets whole
  fields from `exclude_unset` input; the `details` JSON blob is replaced
  wholesale (`flag_modified(item, 'details')`). Two offline edits touching
  *different keys inside details* would clobber each other under naive
  replay. Conflict detection must therefore operate at top-level-column
  granularity for scalar columns AND per-key granularity inside `details`.
- **There is no `updated_at`/version column on items or stops**, and adding
  one is not required: detect conflicts by *comparing values* — each queued
  op carries the base value of every field it changes, as seen at edit time.
  No schema migration, and it gives field-level (not row-level) precision
  for free.
- **`data_version` is global and useless per-entity** (a process-wide counter
  bumped on any flush — see backend/database.py). It stays what it is: the
  refetch trigger. Do not try to use it for conflict detection.
- **PR #57's offline read-only gating must evolve, not break.**
  `effectiveRole(role, online)` in frontend/src/roles.js currently forces
  viewer offline. Queueable actions must re-enable selectively; everything
  non-queueable (deletes, imports, member management, uploads, moves) stays
  hidden offline exactly as today.
- **Replay must be idempotent** — reconnects flicker, tabs duplicate, the
  same queue may flush twice. Value-comparison gives idempotency almost for
  free (see Design), so no server-side op-log table is needed.
- **`ItemHistory` already audits item changes** (`record_item_history`,
  `source` field). Replayed writes must pass `source="offline-sync"` so the
  history view distinguishes them.

## Design

### Client: the queue (`frontend/src/offlineQueue.js`, new)

IndexedDB-backed (survives tab close/app restart — localStorage is not
durable enough across PWA eviction and is synchronous). One store, `ops`,
entries:

```js
{
  id: crypto.randomUUID(),
  ts: Date.now(),
  entity: "item" | "stop" | "packing",   // maps to PATCH /items/{k}, /stops/{k}, /packing/{k}
  entityId: 123,
  changes: { status: "done" },            // what the user set
  base:    { status: "pending" },         // what they saw when they set it
  // for details edits, changes/base hold ONLY the touched details keys:
  // changes: { details: { notes: "new" } }, base: { details: { notes: "old" } }
}
```

Module API (pure logic separated from the IDB adapter so vitest can inject an
in-memory Map — same pattern the weather module uses for `fetch_json`):

- `enqueue(op)` — **coalesces** per (entity, entityId, field): a second
  offline edit to the same field keeps the *first* op's `base` and the *last*
  op's value (the user's intent is "from what I originally saw, to my final
  answer"). Different fields on the same entity merge into one op.
- `pending()` / `count()` — drive the UI badge.
- `flush(sender)` — FIFO replay; on per-op success remove it; on 409 move it
  to a `conflicts` store; on network failure stop (retry on next trigger).
- Flush triggers: the `online` event, app startup, and before the
  data_version poller's refetch (ordering below).

### Server: compare-and-set on the existing PATCH endpoints

Extend `ItemUpdate`/`StopUpdate`/packing-update models with one optional
field: `base: Optional[dict]`. Semantics in the handler, per changed field:

- **scalar column**: if `base` has a value for this field and
  `current != base[field]` and `current != incoming` → conflict.
  If `current == incoming` → already applied (idempotent replay) → treat as
  success, skip the write.
- **`details`**: iterate the keys present in `changes.details`; same rule
  per key against `current.details[key]`; non-conflicting keys merge into
  the current details dict (NOT wholesale replacement when `base` is
  present — this is the behavioural change that makes concurrent
  different-key edits safe).
- Requests **without** `base` behave exactly as today (wholesale set) — the
  online UI keeps its current semantics, zero regression risk.
- Any conflict → **409** with
  `{"conflicts": [{"field": "status", "base": "pending", "server": "done", "mine": "cancelled"}], "current": <full entity>}`
  and NOTHING from that op is applied (all-or-nothing per op keeps reasoning
  simple; fields are usually coalesced into one op per entity anyway).
- Successful replayed ops record history with `source="offline-sync"`.

### Conflict resolution policy (the "basic" system)

1. **Disjoint-field/key edits auto-merge silently.** Partner checked off a
   packing item while you edited a flight's notes → both land, no ceremony.
   This is the overwhelmingly common case for a 2-person trip.
2. **Same-field clash: server wins by default, loudly.** The op moves to the
   `conflicts` store; a dismissible banner ("1 change couldn't sync") opens a
   list showing, per conflict: the field, *your* value, and the *server's*
   value, with two buttons — **Keep theirs** (discard the op) and **Apply
   mine** (re-send the op *without* `base`, i.e. explicit last-writer-wins,
   which cannot 409).
3. No three-way text merging, no vector clocks, no CRDTs. Explicitly out of
   scope; the audit trail (`ItemHistory`) is the backstop if someone picks
   wrong.

### UI integration

- **Selective offline editability**: add `QUEUEABLE_OFFLINE` awareness rather
  than reverting #57's viewer-forcing. Concretely: `effectiveRole` stays; a
  new hook `useCanQueueEdit()` returns true when offline for the specific
  affordances wired to the queue. Wire, in priority order:
  1. item/stop **status cycling** (StopCard) — the #1 mid-trip action,
  2. **packing check/uncheck** (PackingList),
  3. the **item edit modal's Save** (full PATCH through the queue).
  Everything else keeps hiding offline.
- **Optimistic rendering**: on enqueue, apply the change to the local React
  state immediately (status cyclers and packing toggles already do local
  state updates — keep them; the queue write replaces the failed network
  call). Add a small ⏳/↻ marker on entities with queued ops and a global
  "n changes waiting to sync" line next to the existing offline banner.
- **Refetch ordering**: the data_version poller and manual reloads must not
  clobber optimistic state: when the queue is non-empty, `load()` flushes
  first and only refetches after the flush settles (conflicts included —
  conflicted ops are out of the queue by then, parked in `conflicts`).

## Implementation steps

1. `frontend/src/offlineQueue.js` + vitest (`offlineQueue.test.js`): coalescing
   rules, FIFO flush, 409 → conflicts store, idempotent double-flush. IDB
   adapter injectable; tests run against an in-memory adapter.
2. Backend compare-and-set: `base` on item/stop/packing PATCH handlers +
   pytest: merge disjoint details keys, scalar conflict 409 shape, idempotent
   replay (current == incoming), no-`base` requests unchanged, history rows
   get `source="offline-sync"`.
3. Wire status cycling + packing toggles through the queue when offline;
   `useCanQueueEdit` hook; pending badge + conflict banner/list UI.
4. Item edit modal Save through the queue (details-key base capture at
   modal-open time).
5. Refetch-ordering guard in TripTimeline's `load()`/poller.
6. E2E (extend the Playwright pattern used to verify PR #57, committed this
   time as `scripts/offline_e2e.py`, runnable locally): go offline → cycle a
   status → reload offline (op survives) → go online → server state updated;
   plus a scripted conflict (server-side change while offline) → banner
   appears → "Apply mine" wins.

Steps 1–3 are the PR-sized core. Steps 4–6 can ride in the same PR if green
quickly, else follow-up — the feature is already useful after step 3.

## Out of scope (explicit non-goals)

- Offline **creates** (temp-ID reconciliation chains), **deletes**
  (edit-vs-delete semantics), **moves**, attachments/uploads, imports,
  member/share management. All stay online-only and hidden offline.
- Cross-entity transactional replay. Ops are independent.
- Multi-tab queue locking: IDB is shared and replay is idempotent, so the
  worst case (two tabs flush concurrently) is harmless duplicate no-ops —
  documented, accepted.

## Risks / edge cases

- **JWT expiry mid-offline**: tokens last 30 days (JWT_EXPIRE_DAYS) — a queue
  older than that fails auth on flush. Surface as "sign in to sync" rather
  than dropping ops.
- **Details-blob writers that aren't the edit modal** (enrich autofill,
  wash-lookup, GPX attach) still do wholesale replacement online — fine, but
  the compare-and-set merge path must never run without `base` present.
- **Queue vs. cached-read staleness**: the SW cache may serve data older than
  a queued op after an offline reload; optimistic overlay (re-applying
  pending ops over fetched/cached data at render time) is the fix if this
  proves visible in practice — start without it, verify in the e2e.
