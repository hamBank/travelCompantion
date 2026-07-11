# Plan 13 — Passport MRZ OCR with selectable-field review

Read `docs/plans/README.md` first (conventions, test gates, build workflow),
then `docs/plans/plan-12-document-vault.md` and `plan-12a-document-vault-crud.md`
for the document vault this plan builds on (`UserDocument`/`UserDocumentFile`,
`backend/document_crypto.py`, `backend/routers/vault.py` — all shipped).

## This reverses a stated prior decision — read this first

Every plan-12 document says OCR is out of scope, in near-identical wording:

> - **OCR/auto-extracting the expiry date from a photo — manual entry only.**
> (plan-12-document-vault.md, "Out of scope")

> Key rotation, **OCR auto-extraction**, per-destination validity rules,
> sharing/delegation — all explicitly out of scope for plan 12 as a whole.
> (plan-12a, "Out of scope for this subplan")

> **Out of scope**: ... **OCR/auto-detected expiry dates (plan-12, permanently
> out of scope for all subplans).**
> (plan-12b, "Out of scope")

That "permanently out of scope" framing was correct *at the time* — v1 needed
to ship without OCR's added surface area. This plan is a deliberate reversal
by direct request, not a gap being quietly filled in. It's viable now, and
wasn't a mistake to defer, for a concrete reason: **v1's "server-side
encryption only" constraint (plan-12) means decrypted document bytes already
exist in-process on both upload and download** (`encrypt_bytes`/
`decrypt_bytes` in `backend/document_crypto.py` run server-side, never in the
browser). OCR is just a third place those already-decrypted bytes get read —
it doesn't cross any new trust boundary the vault didn't already establish.

## Goal

Let a user photograph or scan their passport's data page, have the machine-
readable zone (MRZ — the two lines of monospace text at the bottom) read via
Claude's vision capability, and review each extracted field individually
before any of it is written to their `UserDocument` record — never a blind
overwrite.

## Why this isn't a drop-in reuse of `PendingChange`

The instruction was "selectable updates like we use for other data updates,"
pointing at the `PendingChange` review flow (`backend/routers/pending.py`,
`frontend/src/components/PendingReview.jsx`) used for parsed booking
emails/PDFs. Worth being precise about what that pattern actually is before
claiming to reuse it: **`PendingChange` is whole-object accept-or-discard,
not field-level.** Each row proposes one entire `ItineraryItem` (create or
update); the reviewer can hand-edit the proposed values inline before
accepting, and an update's diff is *shown* field-by-field, but there is no
per-field checkbox — Apply commits every field in the row, Discard drops all
of them. It's also structurally `Trip`/`Stop`/`ItemKind`-shaped throughout
(`trip_id`, `suggested_stop_id`, `target_item_id`, `op` applying via
`ItemUpdate`/`ItemCreate`) — none of which exists for a `UserDocument`, which
is deliberately never trip-scoped (plan-12's core constraint).

So this plan takes the *spirit* of that pattern — extracted values are a
proposal, editable, never auto-committed — and implements genuine per-field
selection, which `PendingChange` doesn't have today. It does **not** add a
new persisted queue table: the extraction step is synchronous,
single-document, user-initiated (a "Scan passport" button), and the
proposal only needs to survive one page session, not be revisited later like
an inbox of pending emails. The frontend holds the extraction result in
local state; accepted fields are written via the **existing**
`PATCH /me/documents/{id}` (extended below with a few new fields) — no new
"apply" endpoint, unlike `PendingChange`'s dedicated `/apply` route, because
there's no separate object being created here, just fields on a record the
user already owns and is already looking at.

## Constraints that shape the design

- **Billed-API scoping (README §7).** The OCR endpoint takes an existing,
  owned `UserDocumentFile` id — never raw uploaded bytes in the request body
  — exactly like every other vault route's `_owned_document()` check. A user
  can't relay arbitrary images through this endpoint to spend someone else's
  Claude budget; they can only OCR a file they already own and already paid
  the upload-size-cap cost to store.
- **Fail closed, reuse the existing key.** `documents.py` already reads
  `ANTHROPIC_API_KEY` for booking-document parsing
  (`_ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")`,
  `backend/routers/documents.py:68`). This plan reuses that **same** env var
  — it is not a new secret, and there is no case for a separate
  passport-specific Anthropic key. 503 if unset:
  `HTTPException(503, "Passport OCR not configured (set ANTHROPIC_API_KEY)")`,
  matching the `GOOGLE_CLIENT_ID`/`AERODATABOX_KEY`/`DOCUMENT_ENCRYPTION_KEY`
  precedent.
- **No new secret, but a real new field-level PII question.** MRZ data
  includes the holder's full name, nationality, date of birth, and sex —
  more identifying than anything currently in `UserDocument` besides
  `document_number`. Treat it with the same "encrypted payload, not
  queryable metadata" tier as `document_number_encrypted`, not the
  cleartext `country`/`label`/`expiry_date` tier (see Data model below).
- **No new external dependency.** This codebase has zero OCR libraries today
  (confirmed: no tesseract/OCR anywhere) and `documents.py` never sends an
  image content block to Claude, only PDF/text — but Claude's vision
  capability reads MRZ text directly from a photo without a dedicated OCR
  library, the same way it already reads a PDF's ticket-detail text in
  `documents.py`. No new package in `backend/requirements.txt`.
- **Synchronous, matching this codebase's existing convention.** There is no
  background-task/queue pattern anywhere in this backend
  (`documents.py`'s Claude call blocks the request handler). The OCR call
  does the same — the frontend shows a loading state while it waits, same
  UX as "Parse document" already does for booking imports.
- **Injectable extraction function**, mirroring `flight_live.fetch_flight`'s
  `fetch=` parameter in `backend/notifications.py`'s alert functions — so
  tests never call the real Anthropic API, matching how `test_documents.py`
  only exercises the pure post-processing helpers today (no test in this
  codebase currently calls the real `_call_claude`).

## Data model (`backend/models.py`)

Add to `UserDocument`:

```python
class UserDocument(SQLModel, table=True):
    # ...existing fields unchanged...
    holder_data_encrypted: Optional[bytes] = Field(default=None, sa_column=Column(LargeBinary))
    # Fernet-encrypted JSON: {"holder_name": "...", "nationality": "...",
    # "date_of_birth": "YYYY-MM-DD", "sex": "M"|"F"|"X"|""}
    # Same tier as document_number_encrypted — never queried directly, never
    # in UserDocumentRead, decrypted only by a dedicated route (see below).
```

`country`, `issued_date`, `expiry_date` stay as-is (already unencrypted,
already queried by the plan-12b expiry cron) — MRZ-derived values for those
flow through the **existing** plaintext columns via `PATCH`, same as any
manual edit today.

Alembic: `alembic revision --autogenerate -m "add user document holder data"`
→ review → `alembic upgrade head` → `python -m pytest tests/test_alembic_drift.py`.

## Backend implementation steps

### 1. `backend/passport_ocr.py` (new)

```python
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")   # same var as documents.py
_MODEL = "claude-sonnet-4-6"                               # same model as documents.py

class PassportOcrError(Exception): ...   # message = user-facing detail

def extract_mrz(image_bytes: bytes, content_type: str) -> dict:
    """Send the decrypted image to Claude, return extracted fields.
    Raises PassportOcrError on API failure, refusal, or unparseable JSON."""
```

Mirrors `documents.py::_call_claude`'s shape closely (content-block
construction, `client.messages.stream(...)`, code-fence stripping, JSON
extraction, `record_claude_usage`/`record_external_call` metrics) but:
- Sends one `{"type": "image", "source": {"type": "base64",
  "media_type": content_type, "data": ...}}` block instead of a `document`
  block — `content_type` must be `image/jpeg` or `image/png` (415 for
  anything else, checked by the router before calling this).
- Prompt asks specifically for the passport's MRZ line (TD3 two-line
  format) plus visible printed fields as a cross-check, requesting strict
  JSON:
  `{"document_number": "...", "holder_name": "...", "nationality": "...",
  "date_of_birth": "YYYY-MM-DD", "sex": "M"|"F"|"X", "issuing_country": "...",
  "expiry_date": "YYYY-MM-DD", "confidence": "high"|"medium"|"low",
  "warnings": ["..."]}` — any field the model can't read confidently is
  `null`, not guessed; `warnings` carries things like "MRZ partially
  obscured" or "check digit mismatch on document number" so the review UI
  can surface them per-field.
- No content-hash cache like `documents.py`'s `ProcessedDocument` — this is
  a one-shot user-triggered action on a file they're actively reviewing, not
  an ingestion pipeline that might see accidental duplicate submissions.
  (If real usage shows people mashing "Scan" repeatedly, revisit — Gotchas.)

### 2. `backend/routers/vault.py` — new route

```python
@router.post("/me/documents/{doc_id}/files/{file_id}/scan")
async def scan_passport_file(doc_id, file_id, session=Depends(get_session), user=Depends(get_current_user)):
```

- `_owned_document()` first (existing helper) — 404 if not owned, same as
  every other file route.
- Load the `UserDocumentFile`, 404 if `file_id` doesn't belong to `doc_id`
  (same double-check pattern `download_document_file` already uses).
- 415 if `content_type` isn't `image/jpeg` or `image/png` (a PDF or other
  scan format isn't what MRZ vision extraction is built for here — out of
  scope, see below).
- 503 via the same `_require_vault_configured()`-style check, but against
  `passport_ocr.ANTHROPIC_API_KEY` instead of `DOCUMENT_ENCRYPTION_KEY` —
  **two independent fail-closed checks on this one route**: the vault key
  (to decrypt the stored file at all) and the Anthropic key (to OCR it).
  Check the vault key first (cheaper, no external call attempted).
- `decrypt_bytes(doc_file.data_encrypted)`, call
  `passport_ocr.extract_mrz(content, doc_file.content_type)`.
- Returns the raw extraction dict directly — **no DB write in this route**.
  The response is the proposal; nothing is applied until a subsequent
  `PATCH /me/documents/{doc_id}` call, same as how a manual edit already
  works, just pre-filled by this endpoint's response instead of by hand.

### 3. `PATCH /me/documents/{doc_id}` — extend `UserDocumentPatch`

Add optional `holder_name`, `nationality`, `date_of_birth`, `sex` fields,
handled the same sentinel-checked way `document_number` already is
(`"__unset__"` distinguishes "not provided" from "explicitly cleared"):
encrypt the four into one JSON blob and write to `holder_data_encrypted`
only when any of them is present in the patch body — partial holder-field
updates re-encrypt all four together (decrypt existing blob first if
present, merge, re-encrypt), since they're one encrypted unit, not four
independent ones.

### 4. `GET /me/documents/{doc_id}/holder`

Mirrors `GET /me/documents/{doc_id}/number` exactly: decrypt
`holder_data_encrypted`, return the JSON object, 404 if none stored, 503 if
`DOCUMENT_ENCRYPTION_KEY` unset. Needed so the Settings UI can show/edit
these fields without carrying decrypted PII in the list/detail response.

## Frontend implementation steps

### 1. `frontend/src/api.js`

`scanPassportFile(docId, fileId)` → `POST .../scan`, returns the extraction
dict. `getDocumentHolder(docId)` → `GET .../holder`. Extend the existing
`updateDocument` call sites to be able to pass the four new fields (no new
helper needed — `updateDocument` already accepts an arbitrary patch body).

### 2. Settings "Documents" section (`frontend/src/components/UserSettings.jsx`)

In the expanded `DocumentRow` (where file upload/offline-toggle already
live): a "Scan passport" button next to each image file, visible only when
`content_type` starts with `image/`. Clicking it:
1. Calls `scanPassportFile`, shows a loading state (same
   spinner/disabled-button convention `uploading`/`saving` already use in
   this component).
2. On success, opens a review list — one row per extracted field
   (`document_number`, `holder_name`, `nationality`, `date_of_birth`, `sex`,
   `issuing_country` → mapped to the existing `country` field,
   `expiry_date`), each row: **current value (if any) struck through →
   extracted value**, a checkbox (checked by default unless the field's
   `warnings` flagged it, or the field is `null`), and the extracted value
   is itself editable inline before accepting — same "edit the proposed
   value, then commit" affordance `PendingReview.jsx` already gives its
   name field, applied here per-field instead of to one whole object.
3. Any field-specific `warnings` string renders under that row in
   `var(--warning)`, not blocking the checkbox, just informational.
4. A single "Apply selected" button builds one patch object from the
   checked rows only and calls `updateDocument` — unchecked fields are
   simply omitted from the patch, leaving the existing value untouched
   (this is why `UserDocumentPatch`'s partial-update/`exclude_unset`
   semantics matter here — no sentinel dance needed on the frontend side).
5. On failure (503/415/502 from the scan call, or a save failure), show the
   error inline the same way every other error in this component already
   does (`var(--error)` text), without discarding the extraction result the
   user might want to retry applying.

No new frontend module needed beyond this — it's UI state local to
`DocumentRow`, not persisted, not offline-cached (the extraction result
itself is never written to `vaultOfflineStore.js`; only the file bytes are,
unchanged from plan-12c).

## Tests

Backend (`tests/test_passport_ocr.py`, new):
- `extract_mrz` unit tests via an injected fake Anthropic client/response
  (mirroring how `flight_live`/`rail_live`'s `fetch=` injection is tested in
  `tests/test_flight_alerts.py`) — never call the real API. Cover: happy
  path JSON parse, code-fence stripping, refusal (`stop_reason ==
  "refusal"`), malformed JSON, API error.
- Router tests (`client` fixture), with `vault.py`'s scan route's call to
  `passport_ocr.extract_mrz` monkeypatched to a canned fake:
  - 415 when the target file's `content_type` isn't an image.
  - 503 when `DOCUMENT_ENCRYPTION_KEY` unset (checked before any Anthropic
    call — assert the fake extractor was never invoked).
  - 503 when `ANTHROPIC_API_KEY` unset.
  - Cross-user isolation: scanning another user's file 404s (extend the
    existing parametrized isolation test in `tests/test_vault.py` with a
    `"scan"` case, matching its established pattern rather than
    duplicating a new test file's worth of isolation checks).
  - Successful scan returns the extraction dict verbatim, does **not**
    write to the `UserDocument` row (assert a subsequent `GET` is
    unchanged).
- `PATCH` tests: holder fields round-trip through `holder_data_encrypted`
  and are readable only via `GET .../holder`; never appear in
  `GET /me/documents` or `GET /me/documents/{id}`; partial holder-field
  patches merge rather than clobber the other three; `document_number`
  behavior (already tested in `test_vault.py`) stays unaffected —
  regression-check the existing `test_vault.py` suite stays green
  unmodified aside from the new isolation case above.
- Alembic drift guard stays green after the new migration.

Frontend (`frontend/src/__tests__/DocumentSettings.test.jsx`, extended):
- "Scan passport" button appears only for image files.
- Clicking it calls `api.scanPassportFile` and renders one row per returned
  field with a pre-checked/unchecked state matching `warnings`.
- Unchecking a field and clicking "Apply selected" calls `updateDocument`
  with only the checked fields in the payload.
- Editing an extracted value inline before applying sends the edited value,
  not the original extraction.
- A 503/415 from the scan call renders the existing error-text convention,
  doesn't crash, and leaves the row usable to retry.

## Manual verification

1. Set `ANTHROPIC_API_KEY` and `DOCUMENT_ENCRYPTION_KEY`; restart.
2. Upload a passport photo-page image to a document in Settings.
3. Click "Scan passport" — confirm each MRZ-derivable field appears with a
   sensible extracted value and a working edit/checkbox per row.
4. Uncheck `nationality`, edit `document_number` to a deliberately wrong
   value, click "Apply selected" — confirm only the edited document number
   and the still-checked fields changed; `GET /me/documents/{id}` shows the
   edited number; `nationality` is untouched (still whatever it was before,
   including "never set").
5. `GET /me/documents/{id}/holder` — confirm it returns the accepted
   holder fields and that `GET /me/documents/{id}` never includes them.
6. Unset `ANTHROPIC_API_KEY`, click "Scan passport" again — confirm a clean
   503, not a 500, and the existing document/file are untouched.
7. Try scanning a non-image file (e.g. upload a PDF as a document file) —
   confirm 415, not a Claude call (check no `anthropic` request logged).

## Out of scope

- **Non-image scan formats** (PDF passport scans) — MRZ vision extraction
  targets photographs; a PDF-of-a-scan path could reuse `documents.py`'s
  PDF-to-Claude machinery later, but isn't this plan's job.
- **Automatic scan-on-upload.** Scanning is a deliberate button click, never
  triggered by the upload itself — matches every other "opt-in, never
  blanket" precedent in this app's offline/vault features (plan-12c's
  Constraints).
- **Non-passport MRZ formats** (national ID cards, some driver's licences
  have their own machine-readable zones) — passport TD3 format only;
  extending to other `doc_type`s is a follow-up if there's real demand.
- **Confidence-based auto-accept.** Even a "high confidence" extraction
  still requires the user to click Apply — there's no threshold at which
  this plan writes data without a human in the loop.
- **Content-hash caching of scans** (unlike `documents.py`'s
  `ProcessedDocument` dedup) — see Gotchas for when to revisit.
- **A real MRZ checksum validator.** Claude's `warnings` field is a
  best-effort signal, not a computed check-digit verification — a
  dedicated MRZ-checksum library could be added later if OCR accuracy in
  practice turns out to need it.

## Gotchas

- **Two independent 503 checks on one route** (vault key, then Anthropic
  key) — don't collapse them into one generic "not configured" message; the
  operator needs to know *which* env var is actually missing.
- **`holder_data_encrypted` is one encrypted JSON blob for four fields, not
  four columns** — a partial patch (e.g. only `sex` changed) must
  decrypt-merge-reencrypt the existing blob, not overwrite it with a
  partial object that loses the other three fields. Test this explicitly
  (see Tests).
- Same relationship-less-FK-adjacent caution as always doesn't apply here
  (no new FK'd table), but the same "never let an encrypted column leak
  into a `Read` model" mistake that's easy with `document_number_encrypted`
  applies equally to `holder_data_encrypted` — go through explicit `Read`
  models, never a naive `model_dump()`.
- If real-world usage shows users repeatedly re-scanning the same
  unchanged photo (e.g. retrying after an unrelated apply failure), revisit
  the "no caching" decision above — cheap to add later via the same
  content-hash approach `documents.py` already has a working example of.
- This plan touches `frontend/src/` — the frontend build/push workflow
  applies (README §2): commit source, `npm run build`, commit
  `backend/static/` separately (never amended), then push.
