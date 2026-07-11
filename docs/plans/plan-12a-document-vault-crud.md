# Plan 12a — Document vault: encrypted CRUD (backend only)

Read `docs/plans/README.md` first (conventions, test gates, build workflow),
then `docs/plans/plan-12-document-vault.md` for the full feature's context
and rationale — this subplan implements only its backend data model,
encryption, and CRUD API. It's written to be executable on its own, but the
"why" behind several decisions below (why no client-side encryption, why
documents are never trip-shared, why the key is high-stakes) is argued in
full in plan 12; this file states the decisions without re-arguing them.

**Deliberately out of scope for this subplan** (each becomes its own
follow-up subplan against plan 12): the Settings UI, the offline
image/file viewer, the IndexedDB offline cache, and the expiry-reminder
notification cron. This subplan's surface is API-only — verified with
`curl`/pytest, no frontend changes, no build/amend step.

## Goal

A user can create a document record (passport/licence/visa metadata),
attach one or more encrypted file scans to it, list/edit/delete their own
documents, and fetch a file back decrypted — all scoped strictly to the
authenticated user, with zero trip-permission involvement anywhere. This is
the foundation plan 12's frontend and notification subplans build on.

## Constraints (decisions carried over from plan 12, stated not re-argued)

- **Owner-only, always.** Every route checks `document.user_email ==
  current_user["email"].lower()` and nothing else — no `require_trip_role`,
  no share-token path, ever reachable for these routes.
- **Fail closed if `DOCUMENT_ENCRYPTION_KEY` is unset** — 503, matching
  `backend/routers/auth_router.py`'s `GOOGLE_CLIENT_ID` check and
  `check_flight`'s `AERODATABOX_KEY` check. No hardcoded fallback key,
  unlike `JWT_SECRET`'s existing (separately flagged) insecure default —
  for an encryption key a hardcoded fallback is equivalent to no encryption.
- **Metadata unencrypted, payload encrypted.** `doc_type`/`label`/`country`/
  `expiry_date` stay in the clear (queried directly, e.g. by the future
  expiry cron, without a decrypt round-trip). File bytes and
  `document_number` are the sensitive payload and get encrypted.
- **Blob-in-DB, not on disk** — same reasoning as `ItemAttachment`: one
  backup story (`pg_dump`/the SQLite file) covers everything, no separate
  uploads directory to keep in sync.
- **404, not 403, on not-owned** — matches `_owned()` in
  `backend/routers/pending.py`: don't confirm a document id exists to
  someone who doesn't own it.

## Required key/secret change — critical, read before implementing

New env var: **`DOCUMENT_ENCRYPTION_KEY`**. New `scripts/gen_document_key.py`,
mirroring `scripts/gen_vapid_keys.py`'s exact style, generates one (32 raw
bytes, base64-encoded for `.env` — `Fernet.generate_key()` is a convenient
way to get exactly that shape if using Fernet; raw AES-GCM works equally
well, just document whichever is chosen in the script's docstring).

**This key is categorically higher-stakes than every other secret in this
app.** Rotating `JWT_SECRET` or `VAPID_PRIVATE_KEY` costs a re-login or a
push re-subscribe — mildly annoying, zero data loss. **Losing or rotating
`DOCUMENT_ENCRYPTION_KEY` permanently and irrecoverably destroys every
stored document — there is no reset path.** The ciphertext already in the DB
is just noise without the exact key that wrote it.

This subplan does not implement key rotation. Treat the key as write-once
for the deployment's lifetime once any document exists.

**Critical deployment step**: generate and set `DOCUMENT_ENCRYPTION_KEY` in
`/opt/travelcomp/.env` *before* this endpoint set is exposed to real use, and
back the key up somewhere durable outside that one server (a password
manager entry is sufficient — the goal is "not only on the disk `pg_dump`
also lives on"). Add to whatever deploy checklist already documents
`AERODATABOX_KEY`/`VAPID_*`: *"`DOCUMENT_ENCRYPTION_KEY` must be set before
first use and never regenerated once documents exist. Back it up outside the
server."*

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
    expiry_date: Optional[datetime] = None          # unencrypted — queried directly by the (future) expiry cron
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

`UserDocumentFile.document_id` is a real FK with **no ORM `Relationship()`**
— this exact shape is what issue #68's Postgres CI job caught as a live bug
in `delete_trip`/`delete_stop` (SQLAlchemy's unit-of-work doesn't order
relationship-less FK deletes correctly; silently fine on SQLite, a
`ForeignKeyViolation` 500 on Postgres). When deleting a document, delete its
files first and `session.flush()` before deleting the document row — don't
repeat that bug a third time. Run the new tests against
**both** `python -m pytest -q` and the `backend-postgres` CI job (see
`docs/postgres-migration.md`) so an ordering regression here can't hide.

Alembic: `alembic revision --autogenerate -m "add user document vault"` →
review the generated file → `alembic upgrade head` →
`python -m pytest tests/test_alembic_drift.py` must stay green.

## Implementation steps

### 1. `backend/document_crypto.py` (new)

```python
import os
from cryptography.fernet import Fernet, InvalidToken

DOCUMENT_ENCRYPTION_KEY = os.environ.get("DOCUMENT_ENCRYPTION_KEY", "")


class DocumentVaultNotConfigured(Exception):
    """Raised by encrypt/decrypt when DOCUMENT_ENCRYPTION_KEY is unset —
    callers (the router) translate this into a 503, never a fallback key."""


def _fernet() -> Fernet:
    if not DOCUMENT_ENCRYPTION_KEY:
        raise DocumentVaultNotConfigured()
    return Fernet(DOCUMENT_ENCRYPTION_KEY.encode())


def encrypt_bytes(data: bytes) -> bytes:
    return _fernet().encrypt(data)


def decrypt_bytes(data: bytes) -> bytes:
    return _fernet().decrypt(data)
```

Fernet (from `cryptography`, already a transitive dependency via
`python-jose[cryptography]` — add `cryptography` explicitly to
`backend/requirements.txt` rather than relying on the transitive pin) is a
reasonable default: authenticated encryption (AES-128-CBC + HMAC), handles
the nonce/IV internally, and `InvalidToken` on wrong-key/corrupted-data
gives a clean failure mode. One key for everyone — no per-user key
derivation; this is a single-tenant self-hosted app, not a multi-tenant
system that needs cross-tenant key isolation.

### 2. `backend/routers/vault.py` (new)

**Do not name this file `documents.py`** — that name is already taken by
the unrelated router that parses uploaded booking PDFs/screenshots into
`PendingChange` rows via Claude. Register it in `backend/main.py` next to
the other routers: `app.include_router(vault.router, tags=["vault"])`.

All routes under `/me/documents` (matching the existing `/me/*` per-user
namespace in `backend/routers/me.py`), all via `get_current_user()` only —
no trip role checks anywhere in this file. A shared helper mirrors `_owned()`
in `pending.py`:

```python
def _owned_document(session: Session, user: dict, doc_id: int) -> UserDocument:
    doc = session.get(UserDocument, doc_id)
    if not doc or doc.user_email != user["email"].lower():
        raise HTTPException(status_code=404, detail="Document not found")
    return doc
```

Routes:

- **`GET /me/documents`** — list the current user's documents. Response
  model omits `document_number_encrypted` entirely (a `UserDocumentRead`
  without that field, same convention as `ItemAttachmentRead` omitting
  `data`).
- **`POST /me/documents`** — create. Body: `doc_type`, `label`, `country`,
  `document_number` (plaintext in the request; encrypt before storing —
  `None`/absent stays `None`, don't encrypt an empty value), `issued_date`,
  `expiry_date`, `notes`. 503 via `DocumentVaultNotConfigured` if
  `document_number` was provided and the key is unset (creating without a
  number still works with the key unset, since nothing needs encrypting in
  that case — decide whether that's actually desired or whether ALL vault
  routes should 503 uniformly regardless of whether this particular request
  needed the key; uniform-503 is simpler to reason about and is the
  recommended choice, even though it's technically stricter than necessary).
- **`GET /me/documents/{id}`** — one document's metadata (still no
  `document_number` — see below).
- **`GET /me/documents/{id}/number`** — separate route to decrypt and
  return just `document_number`, so the common list/detail views never
  trigger a decrypt for a field most renders don't need. 404 if none stored.
- **`PATCH /me/documents/{id}`** — edit metadata (same fields as create,
  `exclude_unset`). Re-encrypt `document_number` if provided.
- **`DELETE /me/documents/{id}`** — delete the document and all its files:
  delete `UserDocumentFile` rows for this `document_id`, `session.flush()`,
  then delete the `UserDocument` row, then `session.commit()`.
- **`POST /me/documents/{id}/files`** — upload one file. `UploadFile`,
  `await file.read()` fully into memory (not streamed — same as
  `ItemAttachment`), same caps: reuse the exact constants pattern from
  `backend/routers/attachments.py` (`_MAX_SIZE = 10 * 1024 * 1024`,
  `_MAX_COUNT = 10` per document, 413 on either breach).
  `encrypt_bytes(await file.read())` before storing.
- **`GET /me/documents/{id}/files/{file_id}`** — `_owned_document()` first
  (so a file under someone else's document 404s even if `file_id` alone
  would resolve), then load the file row, `decrypt_bytes(...)`, return the
  whole blob in one `Response(content=..., media_type=..., headers=
  {"Content-Disposition": 'inline; filename="..."'})` — same non-streaming
  shape as `GET /attachments/{id}`.
- **`DELETE /me/documents/{id}/files/{file_id}`** — `_owned_document()`
  first, same reasoning.

Every route wraps `encrypt_bytes`/`decrypt_bytes` calls and turns a caught
`DocumentVaultNotConfigured` into
`HTTPException(status_code=503, detail="Document vault not configured (set DOCUMENT_ENCRYPTION_KEY)")`.

## Tests (`tests/test_vault.py`, new)

Model the upload/size/count-cap shape on `tests/test_attachments.py` and the
cross-user-isolation shape on the newest cascade-delete tests in
`tests/test_trips.py`/`tests/test_stops.py` (from #68's Postgres CI work).

- CRUD round-trip: create → list shows it → edit → delete → 404 after.
- Uploaded file bytes come back **byte-identical** after
  encrypt→store→fetch→decrypt (this is the core correctness property of the
  whole feature — get this test right).
- `document_number` never appears in `GET /me/documents` or
  `GET /me/documents/{id}` responses; `GET .../number` returns it correctly
  and 404s when none was set.
- **Cross-user isolation (the security-critical case)**: user A cannot
  list, view metadata for, fetch a file from, or delete user B's document —
  every one of those is a 404, not a 403 or a 200 with someone else's data.
  Write this as one parametrized test hitting all four routes rather than
  four near-duplicate tests, so a future new route is more likely to get
  added to the same list.
- 503 on every vault route when `DOCUMENT_ENCRYPTION_KEY` is unset
  (`monkeypatch.setattr` the module constant — same pattern
  `tests/test_notifications.py`'s `DEPARTURE_LEAD_HOURS` tests already use
  for a module-level config constant).
- Size (>10MB) and count (11th file) caps reject with the same status
  `ItemAttachment`'s do.
- Deleting a document cleans up its files — regression test in the same
  style as the `delete_trip`/`delete_stop` cascade tests from #68. Run
  `tests/test_vault.py` (along with the full suite) against a real Postgres
  locally before pushing, the same way #68's PR was verified, since this
  table has the exact relationship-less-FK shape that bit `delete_trip`.
- Alembic drift guard (`tests/test_alembic_drift.py`) stays green after the
  new migration.

## Manual verification

1. Generate and set `DOCUMENT_ENCRYPTION_KEY`; restart the backend.
2. `curl -X POST /me/documents` with a passport's metadata (as the dev-mode
   `dev@local` user, or a real bearer token) → note the returned `id`.
3. `curl -X POST /me/documents/{id}/files -F file=@passport.jpg` → note the
   returned file `id`.
4. `curl /me/documents/{id}/files/{file_id}` → save the response body, diff
   it byte-for-byte against `passport.jpg` — must be identical.
5. Inspect the DB directly (`sqlite3 travel.db` or `psql`) and confirm
   `user_document_file.data_encrypted` is not human-readable / not a valid
   JPEG header — i.e. actually encrypted, not just copied through.
6. As a second user (or by hand-editing `user_email` in the DB for a test
   row), confirm `GET /me/documents/{id}` 404s.
7. Unset `DOCUMENT_ENCRYPTION_KEY`, restart, confirm every vault route 503s
   instead of 500ing.

## Out of scope for this subplan

Everything plan 12 describes beyond the backend CRUD surface above:

- The Settings "Documents" UI (`frontend/src/components/UserSettings.jsx`).
- The full-screen document viewer.
- The offline IndexedDB cache / "Available offline" toggle
  (`frontend/src/vaultOfflineStore.js` in plan 12's numbering).
- The expiry-reminder notification cron
  (`send_document_expiry_reminders` in plan 12's numbering) — note this
  subplan's `expiry_date` field is exactly what that future subplan will
  query, so nothing here blocks it, but implementing the actual reminder
  logic is not part of this PR.
- Key rotation, OCR auto-extraction, per-destination validity rules,
  sharing/delegation — all explicitly out of scope for plan 12 as a whole,
  see its own "Out of scope" section.

## Gotchas

- Don't name the new router file `documents.py` (see step 2).
- Fail closed on a missing key (503), never a hardcoded fallback.
- Flush between deleting a document's files and deleting the document
  itself — the relationship-less FK ordering issue from #68.
- `document_number` is the one metadata-adjacent field that IS encrypted —
  don't let it leak into a list/detail response by accident (easy mistake:
  a naive `UserDocument.model_dump()` would include the encrypted column
  as raw bytes in a JSON response and fail to serialize, or worse, leak the
  ciphertext — always go through the explicit `UserDocumentRead` model).
- This is a backend-only PR: no `frontend/src/` changes, so the
  build/amend workflow (README §2) does not apply — plain commit and push.
