# Plan 12c — Document vault: Settings UI, viewer, and offline cache

Read `docs/plans/README.md` first (conventions, test gates, build workflow).
Also read `docs/plans/plan-12-document-vault.md` for full context — this
subplan implements the frontend half of it: Settings UI, a full-screen
viewer, and the opt-in per-document offline cache.

## Depends on

**Plan 12a** (`docs/plans/plan-12a-document-vault-crud.md`) must be merged
first — every action below calls the `/me/documents*` API it creates. This
plan does not depend on plan-12b (the expiry cron); the expiry *date* is
already visible via plan-12a's list endpoint regardless of whether reminders
are wired up yet.

## Goal

Let the user manage their documents (passport, licence, visa scans) from
Settings, view them full-screen, and mark individual documents "Available
offline" so the image still renders with no network — the same "opt-in,
never blanket" pattern as the rest of this app's offline behavior (README's
Orientation section; the read-only cache from PR #57 and the write queue
from plan 11 are both scoped, not automatic, and this should match).

## Constraints that shape the design

- **v1 is server-side encryption only.** The offline-cached bytes sit in
  IndexedDB unencrypted once fetched, same trust boundary as everything else
  already cached there (see plan-12's Constraints — this is a deliberate,
  already-made decision, not something to revisit in this subplan).
- **Offline caching is per-document opt-in**, driven by a toggle, not
  automatic on view. Viewing a document while online never silently caches
  it — only flipping the toggle does.
- `vaultOfflineStore.js` is a **new, separate module from
  `offlineQueue.js`** — that module is a write queue for outgoing PATCH ops
  (plan 11); this is a read-side cache of already-fetched file bytes.
  Different job, same testability pattern (injectable adapter so vitest can
  swap in an in-memory `Map` instead of real IndexedDB — mirror
  `offlineQueue.test.js`'s structure).

## Implementation steps

### 1. `frontend/src/api.js`

Add helpers mirroring the existing `req()` pattern used for every other
endpoint: `listDocuments()`, `createDocument(data)`, `updateDocument(id,
data)`, `deleteDocument(id)`, `uploadDocumentFile(id, file)`,
`documentFileUrl(id, fileId)` (or a `fetchDocumentFile(id, fileId)` that
returns a `Blob`, whichever `ItemEditModal`'s existing attachment-upload
helpers already do — match that exactly rather than inventing a new shape).

### 2. Settings "Documents" section (`frontend/src/components/UserSettings.jsx`)

New section on the same shelf as `ImportAddress`/Notifications:

- List view: one row per document — type icon (reuse `frontend/src/kinds.js`
  icon conventions if a matching icon exists, otherwise a small fixed
  icon-per-`doc_type` map), `label`, `country`, `expiry_date` with a
  warning color when within 6 months (reuse whatever color convention
  `BudgetSummary` or the existing date-warning banner uses — don't invent a
  new palette).
- Add/edit form: `doc_type` (select: passport/drivers_license/visa/other),
  `label`, `country`, `issued_date`, `expiry_date`, `notes`. Submitting
  calls `createDocument`/`updateDocument`.
- Delete with the same confirm-gated pattern as `ImportAddress`'s
  "Regenerate address" flow added earlier (confirming/error state, distinct
  button labels to avoid test-selector collisions with the Settings modal's
  own Cancel button — that bit us once already, see `ImportAddress`'s
  "Never mind" button).
- File upload: reuse the attachment-upload UI pattern from
  `ItemEditModal`'s existing uploaders (file input → `uploadDocumentFile`,
  show a thumbnail/filename list, per-file delete).
- Per-document "Available offline" toggle (checkbox or switch) — wired to
  step 4 below.

### 3. Viewer component

New full-screen modal/component (e.g. `frontend/src/components/DocumentViewer.jsx`)
for viewing a single document's files:

- Opened from the Settings list (click a document row or a file thumbnail).
- Image files render directly (`<img>`); non-image content types (PDF) open
  via an `<iframe>` or a "download" fallback — match whatever
  `ItemAttachment`'s existing viewer/download UI already does for non-image
  attachments, don't invent new handling.
- **Checks the offline store first** (`vaultOfflineStore.js`, step 4); only
  falls back to a network `fetchDocumentFile` call when the bytes aren't
  cached. This ordering is the actual offline-usefulness of the feature —
  get it right, don't just fetch-then-cache on every open.

### 4. `frontend/src/vaultOfflineStore.js` (new)

IndexedDB store keyed on `file_id`, holding decrypted file bytes as a
`Blob` plus its `content_type`. Shape:

```js
// injectable adapter so vitest can swap in an in-memory Map, mirroring
// offlineQueue.js's testability pattern
export function createVaultOfflineStore(adapter = indexedDbAdapter) { ... }

// store.put(fileId, blob, contentType)
// store.get(fileId) -> { blob, contentType } | undefined
// store.delete(fileId)
// store.has(fileId)
```

- Flipping "Available offline" **on** for a document: fetch each of its
  files' bytes (`fetchDocumentFile`) and `store.put` them.
- Flipping it **off**, or deleting the document: `store.delete` every file
  id that document owned.
- No automatic eviction/size cap in v1 — documents are few and small
  relative to e.g. the flag-image cache; revisit if it becomes a real
  problem (Out of scope below).

### 5. Wire the toggle

The Settings list's "Available offline" toggle calls into
`vaultOfflineStore.js` per step 4, and reflects current cached state via
`store.has(fileId)` for each of the document's files (a document is "on"
only when *all* its files are cached — partial state should just look "off"
and re-fetch everything on toggle, rather than adding a tri-state UI for an
edge case that barely matters at this scale).

## Tests (`frontend/src/__tests__/`, new)

- `UserSettings.test.jsx` (extend existing, or new
  `DocumentSettings.test.jsx`): Documents section renders the list, add
  form submits and calls `api.createDocument`, edit/delete call their
  respective mocks, expiry-within-6-months row gets the warning class —
  all via the existing `vi.mock('../api.js')` pattern.
- `vaultOfflineStore.test.js`: put/get/delete/has round-trip against the
  in-memory adapter, mirroring `offlineQueue.test.js`'s structure exactly.
- `DocumentViewer.test.jsx`: renders cached bytes without calling
  `fetchDocumentFile` when the store has them; falls back to a network
  fetch when it doesn't.
- Offline toggle: flipping on calls fetch-and-store for every file; flipping
  off calls delete for every file; toggling on a document with zero files is
  a no-op (not an error).

## Manual verification

1. With plan-12a already deployed and `DOCUMENT_ENCRYPTION_KEY` set, add a
   passport document with a photo via Settings.
2. Confirm the expiry-date warning color appears when the date is within 6
   months of today (or a trip's end date, once plan-12b is also live).
3. Open the viewer, confirm the image renders.
4. Toggle "Available offline"; go offline (DevTools network throttling, same
   technique already documented for testing the offline write queue);
   reopen the document from Settings — image still renders, Network tab
   shows no request for the file.
5. Toggle offline back off; confirm the entry is gone from IndexedDB
   (DevTools → Application → IndexedDB) and reopening while offline now
   fails gracefully (shows a "not available offline" state, not a crash).
6. Delete the document; confirm any cached file bytes are also removed from
   IndexedDB.

## Out of scope

- Client-side/local-device encryption of the offline-cached bytes — the
  same v1 scope cut as plan-12 itself, not revisited here.
- Automatic/blanket offline caching of all documents — opt-in only, per
  Constraints above.
- Size cap / eviction policy for the offline store.
- OCR/auto-extracted expiry dates — manual entry only, matches plan-12.
- Sharing or delegation UI — single-owner only, matches plan-12.

## Gotchas

- Don't reuse or extend `offlineQueue.js` for this — it's a write queue,
  this is a read cache; keep them separate modules even though both live
  under the "offline" umbrella.
- Test-selector collisions with the Settings modal's own buttons (e.g.
  "Cancel") have bitten this codebase before — use distinct labels for any
  new confirm/cancel affordances in the Documents section, same fix already
  applied to `ImportAddress`.
- This subplan touches `frontend/src/` — the frontend build/push workflow
  applies (README §2): commit source, `npm run build`, commit
  `backend/static/` separately (never amended), then push.
