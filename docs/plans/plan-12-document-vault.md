# Plan 12 — Secure offline-accessible document vault

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Goal

Let a user store scans/photos of their own travel documents (passport,
driver's licence, visas) — encrypted at rest, viewable offline once fetched
once, with expiry tracked and pushed as a reminder against upcoming trips.

This supersedes issue #60 ("passport/travel-document expiry reminders"),
not just extends it: #60 only asked for expiry *metadata* (a `UserDocument`
table with `doc_type`/`country`/`expiry_date`, no file storage). This plan
adds the actual document files on top of that same metadata shape, because
storing the expiry date without the document itself solves only half the
real problem — the other half is having the passport photo in hand, offline,
at the border desk.

Grounding in what's already here:
- **Blob storage precedent**: `ItemAttachment` (`backend/models.py`,
  `backend/routers/attachments.py`) already stores files as bytes directly in
  the DB (`LargeBinary` column) rather than on disk — deliberately, so the
  existing single-DB backup story covers attachments too. Same shape here,
  same reasoning. It also sets the size/count precedent this plan reuses:
  10MB/file, 10 files/parent, whole file read into memory (not streamed) on
  both upload and download.
- **Per-user (non-trip-scoped) data precedent**: `UserImportToken` is the
  only existing table keyed on the user directly (`user_email` as primary
  key, no separate `Users` table to FK against — there isn't one anywhere in
  this schema). This plan's tables follow the same shape.
- **Nothing in this codebase encrypts anything today.** `cryptography` is
  only present transitively (via `python-jose`, for JWT signing) — not used
  for data-at-rest anywhere. This plan is the first thing here that needs it
  for real, which is why the key-management section below is flagged as
  critical rather than routine.
- **Auth model**: users are identified purely by email (`get_current_user()`
  in `backend/auth.py` returns `{"email": ...}` from the JWT `sub` claim) —
  no numeric user id anywhere to key against.

## Constraints that shape the design

- **Documents are never trip-shared. Full stop.** Every other piece of data
  in this app is built around trip membership (`require_trip_role`,
  `require_item_role`, the `/shared/{token}` public link). This is the one
  thing that must never go through any of that — no trip permission check
  ever grants access, and it must never be reachable via a share token. Only
  `document.user_email == current user's email` grants access, checked the
  same simple way `/me/import-address` and `/me/emails/{id}` already do.
- **v1 is server-side encryption only — no client-side/local-device
  encryption.** Explicit, deliberate scope cut for this plan (per direct
  instruction), not an oversight: encrypting the offline IndexedDB cache too
  would need a device PIN/passphrase separate from Google login, which adds
  real friction at exactly the moment this feature matters most (showing a
  border agent your passport with no signal). Revisit later as an opt-in
  "extra protection" mode once there's a feel for whether the friction is
  worth it in practice — **do not build that gate now.**
- **Offline access is opt-in per document, not automatic.** A document is
  fetched once (decrypted server-side, sent over HTTPS, decrypted content
  written to a new IndexedDB store client-side) only when the user flips
  "Available offline" for that specific document. Everything else in this
  app that touches offline behavior (the read-only cache from PR #57, the
  write queue from plan 11) is scoped/deliberate rather than blanket —
  match that.
- **Fail closed if the encryption key is missing — same pattern this
  codebase already uses for other optional-but-required config**: compare
  `raise HTTPException(status_code=503, detail="Auth not configured
  (GOOGLE_CLIENT_ID not set)")` in `backend/routers/auth_router.py` and the
  identical shape in `check_flight` for `AERODATABOX_KEY`. Do the same for
  `DOCUMENT_ENCRYPTION_KEY` — **never** fall back to a hardcoded default key
  the way `JWT_SECRET` does (`"dev-secret-change-in-production"`); for an
  encryption key, a hardcoded fallback is equivalent to no encryption at all,
  since it'd be sitting in the public source tree.

## Required key/secret changes — read before implementing

**New env var: `DOCUMENT_ENCRYPTION_KEY`.** A new
`scripts/gen_document_key.py`, mirroring the existing
`scripts/gen_vapid_keys.py` exactly in style, generates one (e.g.
`Fernet.generate_key()` or a raw 32-byte AES-GCM key, base64-encoded for
`.env`). `backend/document_crypto.py` reads it via
`os.environ.get("DOCUMENT_ENCRYPTION_KEY", "")` — **empty string is a valid,
expected "not configured" state**, not a footgun default; every vault
endpoint 503s if it's empty (see Constraints above).

**This key is categorically higher-stakes than every other secret in this
app, and that difference needs to be understood before this ships, not
after:**
- Rotating `JWT_SECRET` just logs everyone out — mildly annoying, zero data
  loss. Rotating `VAPID_PRIVATE_KEY` just breaks existing push subscriptions
  until devices re-subscribe — same, zero data loss.
- **Losing or rotating `DOCUMENT_ENCRYPTION_KEY` permanently and
  irrecoverably destroys every stored document.** There is no password-reset
  equivalent — the ciphertext in the DB is just noise without the exact key
  that wrote it. This plan does **not** implement key rotation (see
  Gotchas) — treat the key as write-once for the lifetime of the deployment.
- **Critical deployment step**: generate the key and set it in
  `/opt/travelcomp/.env` *before* anyone stores a single document, and back
  the key up somewhere durable outside that one server (a password manager
  entry is enough — the point is "not only on the disk `pg_dump` also lives
  on"). A server rebuild or a botched `.env` edit that loses this value is a
  full, silent data-loss event for every user's passport/licence scans, with
  no error until someone tries to view one and gets ciphertext back.
- Deploy-checklist wording to add wherever `AERODATABOX_KEY`/`VAPID_*` are
  documented for this server: *"`DOCUMENT_ENCRYPTION_KEY` must be set before
  first use and never regenerated once documents exist. Back it up outside
  the server."*

**Related, flagged but explicitly out of scope for this plan**: `JWT_SECRET`
has always defaulted to a hardcoded insecure value
(`"dev-secret-change-in-production"`) when unset. That was a pre-existing gap
regardless of this feature, but a vault of passport scans raises the stakes
of *any* auth compromise enough that it's worth fixing soon, separately —
don't fold it into this PR, but don't let it sit forever either.

## Data model (`backend/models.py`)

```python
class UserDocument(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_email: str = Field(index=True)          # lowercased, owner — never trip-scoped
    doc_type: str                                 # "passport" | "drivers_license" | "visa" | "other"
    label: str = ""                                # user-given nickname, e.g. "US Passport"
    country: str = ""                              # issuing country
    document_number_encrypted: Optional[bytes] = Field(default=None, sa_column=Column(LargeBinary))
    issued_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None          # unencrypted — the expiry cron queries this directly
    notes: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class UserDocumentFile(SQLModel, table=True):
    """One or more images/scans per document (passport photo page, a visa
    stamp page, a licence's front+back) — same one-to-many shape as
    ItemAttachment, scoped to UserDocument instead of ItineraryItem."""
    id: Optional[int] = Field(default=None, primary_key=True)
    document_id: int = Field(foreign_key="userdocument.id", index=True)
    filename: str
    content_type: str = ""
    size: int = 0
    data_encrypted: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
    created_at: datetime = Field(default_factory=datetime.utcnow)
```

`doc_type`, `label`, `country`, `expiry_date` stay **unencrypted** —
queried directly by the expiry cron and rendered in list views without a
decrypt round-trip. `document_number_encrypted` and every file's
`data_encrypted` are the sensitive payload.

`UserDocumentFile.document_id` is a real FK with no ORM `Relationship()` —
**this exact shape is what plan 68's Postgres CI job caught as a live bug in
`delete_trip`/`delete_stop`** (relationship-less FK columns don't get
ordered correctly by SQLAlchemy's unit-of-work on delete). Delete a
document's files with an explicit `session.flush()` between the file deletes
and the document delete — don't repeat that bug a third time.

Alembic revision as usual: `alembic revision --autogenerate -m "add user
document vault"` → review → `alembic upgrade head` →
`python -m pytest tests/test_alembic_drift.py`.

## Backend implementation steps

### 1. `backend/document_crypto.py` (new)

```python
DOCUMENT_ENCRYPTION_KEY = os.environ.get("DOCUMENT_ENCRYPTION_KEY", "")

class DocumentVaultNotConfigured(Exception): ...

def encrypt_bytes(data: bytes) -> bytes: ...   # AES-GCM via `cryptography`; raises DocumentVaultNotConfigured if key unset
def decrypt_bytes(data: bytes) -> bytes: ...
```

One key for everyone in v1 (not per-user derived) — this is a single-tenant
self-hosted app with no cross-tenant isolation requirement to justify the
extra complexity of per-user key derivation.

### 2. `backend/routers/vault.py` (new — **not** `documents.py`, which already
exists and does something unrelated: parsing uploaded booking
PDFs/screenshots into `PendingChange` rows via Claude. Naming collision risk
flagged explicitly because it's an easy mistake.)

Routes, all under `/me/documents` (matching the existing `/me/*` per-user
namespace in `backend/routers/me.py`), all requiring only
`get_current_user()` — no trip role checks anywhere in this file:

- `GET /me/documents` — list, `doc_type`/`label`/`country`/`expiry_date`
  only (never the encrypted blob).
- `POST /me/documents` — create (metadata only; files added separately).
- `PATCH /me/documents/{id}` — edit metadata. 404 (not 403) if
  `document.user_email != current user` — same "don't confirm existence to
  a non-owner" convention `_owned()` uses in `backend/routers/pending.py`.
- `DELETE /me/documents/{id}` — delete document + its files (flush-ordered,
  see Data model above).
- `POST /me/documents/{id}/files` — upload one file (`UploadFile`,
  `await file.read()`, same 10MB/file + 10-files-per-document caps as
  `ItemAttachment`, `encrypt_bytes()` before storing).
- `GET /me/documents/{id}/files/{file_id}` — `decrypt_bytes()` and return the
  whole blob in one `Response(...)`, same non-streaming shape as
  `GET /attachments/{id}`.
- `DELETE /me/documents/{id}/files/{file_id}`.

Every route: 503 `DocumentVaultNotConfigured` → `HTTPException(503,
"Document vault not configured (set DOCUMENT_ENCRYPTION_KEY)")`.

### 3. Expiry notifications (`backend/notifications.py` +
`scripts/send_notifications.py`)

New `send_document_expiry_reminders(session, *, now=None, sender=send_push)`,
modeled directly on `send_due_notifications`:

- For each `UserDocument` with an `expiry_date`, find that user's trips whose
  `end_date` falls within 6 months of `expiry_date` (issue #60's rule).
- Dedup via `NotificationLog` — but note `NotificationLog.item_id` is
  currently an `ItineraryItem` id; either widen its meaning to "any id from
  the kind's own namespace" (simplest — a document id and an item id won't
  collide in practice since nothing joins across them) or add a
  `NotificationLog.entity` discriminator column if that implicit assumption
  feels too fragile. Pick one and document the choice in the migration.
- `kind = "document_expiry"`. Title/body: "{label} expires {date} — before
  your trip to {trip.name} ends". Timezone care per README §3 — use the same
  deliberate naive-UTC handling as every other date comparison in this file,
  not `date.today()`.
- Wire into `scripts/send_notifications.py`'s `main()` next to the existing
  `send_due_notifications`/`send_flight_alerts` calls, same pattern as plan
  2's step 3.

## Frontend implementation steps

### Part A — Settings UI (`frontend/src/components/UserSettings.jsx`)

New "Documents" section, same shelf as `ImportAddress`/Notifications:
list (type icon, label, country, expiry date — colored warning under 6
months out, reusing whatever warning-color convention `BudgetSummary` or the
date-warnings banner already uses), add/edit/delete, file upload (reuse the
attachment-upload UI pattern from `ItemEditModal`'s existing uploaders), and
a per-document "Available offline" toggle.

### Part B — Viewer + offline cache

- Full-screen image/PDF viewer component for an open document.
- New `frontend/src/vaultOfflineStore.js` (**not** a reuse of
  `offlineQueue.js` — that module is a write queue for outgoing PATCH ops;
  this is a read-side cache of fetched file bytes. Different job, same
  "injectable adapter so vitest can use an in-memory Map" pattern for
  testability). IndexedDB store keyed on `file_id`, populated when the user
  flips "Available offline" (fetch + hold the decrypted bytes as a `Blob`),
  cleared when they flip it back off or delete the document.
- Viewer checks the offline store first; falls back to the network fetch
  when online and not cached.

## Tests

Backend (`tests/test_vault.py`, new; model on `tests/test_attachments.py` for
the upload/size/count-cap shape and `tests/test_notifications.py` for the
expiry-trigger shape):
- CRUD round-trip; uploaded file bytes come back byte-identical after
  encrypt→store→fetch→decrypt.
- **Cross-user isolation is the security-critical case**: user A cannot
  list, read metadata for, download a file from, or delete user B's
  document — 404, not 403 (matches the `_owned()` convention).
- 503 on every vault route when `DOCUMENT_ENCRYPTION_KEY` is unset
  (`monkeypatch.setattr` the module constant, same pattern
  `test_notifications.py`'s `DEPARTURE_LEAD_HOURS` tests already use).
- Size (>10MB) and count (11th file) caps reject with the same status
  `ItemAttachment`'s do.
- Deleting a document cleans up its files (regression test in the same style
  as the `delete_trip`/`delete_stop` cascade tests from #68's Postgres CI
  work — run this suite against both SQLite and the `backend-postgres` CI
  job so a relationship-less-FK ordering bug can't hide again).
- Expiry trigger: document expiring within 6 months of a trip's end date →
  one notification; re-run → no resend (NotificationLog dedup); document
  with no expiry_date → never fires; trip ending >6 months before expiry →
  no fire.

Frontend (`frontend/src/__tests__/`):
- Settings "Documents" section renders/add/edit/delete, mocking `api.js`
  (existing `vi.mock('../api.js')` pattern).
- `vaultOfflineStore.js` round-trip against the in-memory adapter (mirror
  `offlineQueue.test.js`'s structure exactly).
- Offline toggle: flipping it on calls the fetch-and-store path; flipping it
  off clears the stored entry.

## Manual verification

1. Generate and set `DOCUMENT_ENCRYPTION_KEY`; restart.
2. Add a passport document with a photo, expiry date 3 months out, on a trip
   whose end date is within that window — confirm the expiry warning color
   shows in Settings and a push notification fires (or would, via the cron
   script run manually).
3. Toggle "Available offline"; go offline (DevTools network throttling, per
   the pattern already documented for testing the offline write queue);
   reopen the document — the image still renders with no network request.
4. Confirm a second test user cannot see the first user's document via a
   direct API call to `GET /me/documents/{id}` (404).
5. Unset `DOCUMENT_ENCRYPTION_KEY` and confirm every vault route 503s
   cleanly instead of 500ing.

## Out of scope (explicit, revisit later)

- **Client-side/local-device encryption of the offline cache** — the core
  scope cut for v1, per Constraints above. Revisit once there's real signal
  on whether the access-friction is worth it.
- Key rotation / re-encrypting existing documents under a new key.
- OCR/auto-extracting the expiry date from a photo — manual entry only.
- Per-destination validity rules beyond the flat 6-month heuristic.
- Sharing or delegation (e.g. a parent managing a child's passport) —
  single-owner only.

## Gotchas

- Don't name the new router file `documents.py` — it already exists for
  itinerary-document parsing, an unrelated feature.
- Fail closed on a missing key (503), never a hardcoded fallback — this is
  the one place in the codebase where `JWT_SECRET`'s "insecure default, fine
  for now" precedent must **not** be copied.
- `UserDocumentFile`/`UserDocument`'s FK has no ORM `Relationship()` — flush
  between deleting files and deleting the parent document (see Data model).
- Naive UTC throughout for expiry math (README §3) — same discipline as
  every other date comparison in `backend/notifications.py`.
- Never expose a vault route through anything unauthenticated — no share
  tokens, no trip-role checks standing in for ownership checks.
- Frontend build/push workflow applies (README §2) — this touches
  `frontend/src/`.
