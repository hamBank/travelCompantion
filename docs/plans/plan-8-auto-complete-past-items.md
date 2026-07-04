# Plan 8 — One-click catch-up for past items

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Goal

Item status (`pending | done | skipped`, cycled manually on cards) drifts from
reality mid-trip: yesterday's flight is still "pending". Rather than silently
auto-writing statuses (multi-user trips, wrong device clocks), show a
**catch-up banner**: "N past items still pending — Mark all done", one tap
batch-updates them. Frontend-only.

## Behavior spec

- Banner appears at the top of the timeline (`TripTimeline.jsx`, same slot as
  the existing date-warnings banner — find `warnings`/`dismissed` there and
  mirror that pattern) when:
  - the user can edit (`canEdit(timeline.role)` — same gate the timeline
    already uses for the import button), and
  - ≥1 item has `status === 'pending'` and an "end time" more than
    `GRACE_HOURS = 6` hours in the past (grace avoids nagging about things
    that just finished or timezone slop).
- Buttons: **Mark all done** (batch `updateItemStatus(id, 'done')` from
  `api.js` for each, then reload the timeline) and **✕** dismiss (per
  session-state only, like the date-warnings `dismissed` flag; reappears next
  mount — intentional).
- Items with no time information are never included.

## Implementation steps

1. **End-time helper (pure, exported, tested).** In
   `frontend/src/components/StopCard.jsx` next to `itemSortKey`/`itemDateKey`:

   ```js
   // Epoch ms when the item is definitively over, or null if undatable.
   export function itemEndMs(item) { ... }
   ```

   - flight/rail/river_transfer: `details.arrive_time` (fallback
     `details.depart_time`).
   - accommodation: `details.checkout` (fallback `details.checkin`).
   - everything else: `scheduled_at`.
   - Convert with the exported `toUtcMs(value, null)` (naive-local convention —
     consistent with how `itemSortKey` treats times; approximation is
     acceptable and documented: a 6h grace absorbs timezone skew).
   - Date-only values (no `T` or `T00:00`): treat as end-of-day — add 24h so a
     dated-but-untimed activity isn't "past" during its own day.

2. **Banner in TripTimeline.** Compute from the unfiltered flattened items
   (the component already builds `allItems`):

   ```js
   const pastPending = allItems.filter(i =>
     i.status === 'pending' &&
     itemEndMs(i) != null &&
     itemEndMs(i) < Date.now() - GRACE_HOURS * 3600_000)
   ```

   Note `allItems` excludes food/purchase kinds — that's fine/desirable here.
   Render the banner using the same visual language as the date-warnings box
   (border/background from `--warning` color-mix — copy those styles). On
   "Mark all done": `await Promise.all(pastPending.map(i =>
   updateItemStatus(i.id, 'done')))` then `load()`; disable the button while
   in flight; surface a failure with the banner turning to the error message
   (keep simple).

3. Add `import { updateItemStatus } from '../api.js'` etc. as needed.

## Tests

- `frontend/src/__tests__/StopCard.test.jsx` — `describe('itemEndMs', ...)`:
  flight uses arrive_time over depart_time; accommodation uses checkout;
  activity uses scheduled_at; date-only value ends at end-of-day (assert
  +24h vs the midnight timestamp); missing everything → null.
- Component-level: optional; if TripTimeline's api mocking is too heavy, the
  helper tests + manual verification suffice (state this in the commit).

## Manual verification

Trip with a pending activity dated last week, a pending flight tomorrow, and a
done item from yesterday → banner says "1 past item…"; Mark all done →
banner disappears, item shows done styling; hide-completed setting still works.

## Gotchas

- `updateItemStatus` PATCHes one item per request — fine at trip scale; don't
  build a new batch endpoint.
- The timeline's `hideCompleted` user setting may make freshly-done items
  vanish — that's correct behavior, not a bug.
- Frontend-only → build/amend/push workflow applies.
