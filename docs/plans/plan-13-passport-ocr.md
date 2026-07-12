# Plan 13 — Passport MRZ OCR (local, offline) with per-field selectable review

**Implementation note (post-build):** this plan was drafted around
`PassportEye`. During implementation, `PassportEye`'s own `setup.py`
(and its abandoned `pdfminer` dependency, unrelated to the actively
maintained `pdfminer.six`) turned out not to build at all under a
modern Python/setuptools — no prebuilt wheel exists on PyPI, only a
source distribution that fails with an `AttributeError: install_layout`
from setuptools' legacy `distutils` compatibility shim. What shipped
instead is `pytesseract` (a thin, actively-maintained wrapper around the
`tesseract` binary) + `mrz` (a small, actively-maintained TD1/TD2/TD3
parser/checksum-validator library) — both install as clean prebuilt
wheels, with a *lighter* dependency footprint than `PassportEye` would
have pulled in (no scipy/scikit-image/scikit-learn/matplotlib/OpenCV).
The tradeoff: `PassportEye` also does automatic MRZ region-detection in
the photo via image processing; this combination doesn't, so
`backend/passport_ocr.py` instead OCRs the whole image with a
whitelisted character set and looks for MRZ-shaped lines in the result
(see its implementation for the exact heuristic). Every design decision
below (per-field checksum validity, local-only, no new secret, the
review UI shape) is unaffected by this swap — only the specific library
name changed. Sections below are left as originally drafted except where
corrected to match what actually shipped.

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

That "permanently out of scope" framing was correct *at the time* — v1
needed to ship without OCR's added surface area. This plan is a deliberate
reversal by direct request, not a gap being quietly filled in — and it goes
further than a straightforward "OK, add OCR now" would: **the extraction
runs entirely locally, on the server, via Tesseract — no passport image or
extracted text is ever sent to Anthropic, or any third party.** That's a
stronger privacy position than the original draft of this plan (which
proposed Claude vision), chosen specifically because passport data is
squarely the kind of thing this app's threat model should minimize exposure
of, and because the machine-readable zone turns out to be an unusually good
fit for local, deterministic OCR (see below).

## Goal

Let a user photograph or scan their passport's data page, have the
machine-readable zone (MRZ — the two 44-character monospace lines at the
bottom of the photo page) read **locally** by Tesseract + a purpose-built
MRZ parser, and review each extracted field individually before any of it
is written to their `UserDocument` record — never a blind overwrite.

## Why local OCR is a good fit here, not just a privacy tradeoff

MRZ is designed to be machine-read: a fixed-width monospace font (OCR-B),
a constrained alphabet (`A-Z0-9<` only, no punctuation/lowercase/diacritics
to confuse a classifier), and — critically — **every field has a check
digit, plus one composite check digit over the whole thing** (ICAO Doc
9303). That means a local parse can be *algorithmically self-validating* in
a way Claude vision's freeform JSON response never was: a field either
satisfies its check digit or it doesn't, full stop, no model-confidence
guessing required. This makes local OCR not just "the private option" but
arguably the *more correct* one for this specific narrow task.

`PassportEye` (PyPI, MIT license) was the originally-planned library for
this — it wraps Tesseract + OpenCV to locate the MRZ region in a photo, OCR
it, parse the two-line TD3 format, and compute all the check digits
automatically. **What shipped is `pytesseract` + `mrz` instead** — see the
Implementation note at the top of this document; the checksum-validation
property described above is identical either way, since `mrz` implements
the same ICAO Doc 9303 check-digit algorithm.

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

- **Billed-API scoping (README §7) — though there's no bill here.** The scan
  endpoint still takes an existing, owned `UserDocumentFile` id, never raw
  uploaded bytes in the request body, matching every other vault route's
  `_owned_document()` check — good hygiene regardless of cost, since it's
  still real (if free) server CPU per call, and still shouldn't be
  relayable against files a user doesn't own.
- **No new secret, no external network call at all.** Unlike
  `documents.py`'s `ANTHROPIC_API_KEY`-gated booking parser, this feature
  needs no API key and makes no outbound request. The only "configuration"
  is whether the `tesseract-ocr` binary is installed on the server — a
  packaging/deployment concern, not a secret (see the Deployment step
  below). Fail closed the same way regardless: 503 if the binary isn't
  found, `HTTPException(503, "Passport OCR not available (tesseract-ocr not
  installed on this server)")` — same shape as the `GOOGLE_CLIENT_ID`/
  `AERODATABOX_KEY`/`DOCUMENT_ENCRYPTION_KEY` precedent, just phrased for a
  missing binary instead of a missing env var.
- **A real new field-level PII question, independent of the extraction
  method.** MRZ data includes the holder's full name, nationality, date of
  birth, and sex — more identifying than anything currently in
  `UserDocument` besides `document_number`. Treat it with the same
  "encrypted payload, not queryable metadata" tier as
  `document_number_encrypted`, not the cleartext
  `country`/`label`/`expiry_date` tier (see Data model below).
- **A genuinely new dependency, but a light one.** This backend has zero
  image-processing libraries today. What shipped — `pytesseract` (a thin
  subprocess wrapper) + `mrz` (pure-Python parsing/checksums) + `Pillow`
  (already used nowhere else in this backend either, but a tiny, universal
  dependency) — installs as clean prebuilt wheels with no OpenCV/scipy/
  scikit-image involved (see the Implementation note at the top: the
  originally-planned `PassportEye` would have pulled all of that in, and
  also turned out not to build at all on a modern toolchain). Still worth
  being upfront about as a real addition, just a much smaller one than
  first planned.
- **Synchronous, matching this codebase's existing convention.** There is no
  background-task/queue pattern anywhere in this backend — even
  `documents.py`'s Claude call blocks the request handler. Tesseract on one
  cropped image is fast (well under a second typically); the OCR call does
  the same synchronous thing, frontend shows a loading state while it waits.
- **Injectable extraction function**, mirroring `flight_live.fetch_flight`'s
  `fetch=` parameter in `backend/notifications.py`'s alert functions — so
  tests never need the real `tesseract` binary or a real passport image on
  disk in CI.

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

## Required deployment step (not a secret, but still a real one-time setup)

`tesseract-ocr` is a system package, not something `pip install` can supply.
Mirror the exact precedent `deploy.sh` already has for Postgres (`if !
command -v psql &>/dev/null; then apt-get install -y -qq postgresql ...;
fi`, deploy.sh's "Ensure Postgres present" step): add an equivalent
idempotent block —

```bash
if ! command -v tesseract &>/dev/null; then
  info "Installing tesseract-ocr"
  apt-get update -qq && apt-get install -y -qq tesseract-ocr \
    && ok "tesseract-ocr installed" || warn "tesseract-ocr install failed"
fi
```

Without this, the feature 503s cleanly (see Constraints) rather than being
silently broken — but it should still be a deploy-time step, not something
discovered by a 503 in production the first time a user clicks "Scan
passport."

**Correction (post-build): CI needs no changes.** `pytesseract` is a pure
Python subprocess wrapper — `import pytesseract` (and thus `import
backend.passport_ocr`) succeeds with no `tesseract` binary present at all;
the binary is only invoked lazily when a route actually calls
`pytesseract.image_to_string(...)`, and every test that would trigger that
mocks it first (see Tests below). Verified directly: the full backend suite
passes with `tesseract` moved out of `PATH` entirely. `.github/workflows/
ci.yml` was left unchanged.

## Backend implementation steps

### 1. `backend/requirements.txt`

Shipped as `pytesseract>=0.3.10` and `mrz>=0.6.0` (see the Implementation
note at the top of this document for why, not `passporteye`).

### 2. `backend/passport_ocr.py` (new)

```python
import shutil

class PassportOcrNotAvailable(Exception):
    """Raised when the tesseract binary isn't installed — callers (the
    router) translate this into a 503, matching the fail-closed convention
    used for every other optional-but-required config in this codebase."""

class PassportOcrError(Exception):
    """Raised when a photo is readable but no valid-looking MRZ text could
    be found or parsed in it."""

def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None

def extract_mrz(image_bytes: bytes) -> dict:
    """Run local OCR + MRZ parsing against a decrypted passport photo.
    Raises PassportOcrNotAvailable if tesseract isn't installed,
    PassportOcrError if no valid-looking MRZ was found or it failed to
    parse. Returns a dict of extracted fields plus per-field check-digit
    validity."""
```

Implementation notes (what actually shipped):
- `pytesseract.image_to_string()` takes a file path or a PIL image, not raw
  bytes — write the decrypted image to a `tempfile.NamedTemporaryFile`
  first (via PIL, which also normalizes odd input formats to grayscale
  PNG). **This is the one place decrypted passport bytes touch disk**
  (everywhere else, `decrypt_bytes()`'s output only ever lives in a Python
  variable). Use the default `NamedTemporaryFile` (already
  `0600`/owner-only permissions via `mkstemp` on POSIX), and delete it in a
  `finally` block immediately after the OCR call returns, success or
  failure — don't let it outlive the request.
- Since this combination has no automatic MRZ region-detection (unlike
  `PassportEye`'s image-processing pipeline), OCR the whole photo with
  `--psm 6` (treat as one uniform text block) and a **character whitelist**
  restricted to the MRZ alphabet (`A-Z0-9<`) — verified experimentally this
  dramatically improves accuracy over an unrestricted whitelist, since long
  runs of filler `<` characters are otherwise easily misread as `c`/`@`/
  other glyphs. Then scan the recognized text line-by-line for the last two
  lines that look MRZ-shaped (some length slack for OCR dropout) — the
  *last* two, since the MRZ sits at the bottom of the photo page and other
  printed text is more likely to appear above it. Fewer than two such
  lines found → raise `PassportOcrError("Could not locate a
  machine-readable zone in this image.")` — the router turns this into a
  422, not a 500.
  - **Fix (post-launch regression, real-world report):** a genuine
    Australian passport photo — background patterning behind the MRZ
    print, uneven lighting, ordinary phone-camera blur/noise — 422'd. Root
    cause, confirmed by reproducing it with a synthetic image simulating
    the same conditions: the true MRZ line OCR'd to only 29 of its 44
    characters, just under the original 30-char line-length floor, so it
    was silently filtered out before ever reaching the checksum parser.
    Two changes: **(1)** the floor dropped from 30 to 20 — still
    comfortably above the length of the other printed field values on a
    photo page (names, nationality, etc., which pass through the same
    whitelist and would otherwise also be false-positive candidates), but
    tolerant of realistic dropout. **(2)** `extract_mrz` now tries a short,
    cheap **preprocessing ladder** before giving up — raw grayscale, then
    `ImageOps.autocontrast`, then an Otsu-thresholded binarization (Otsu's
    method implemented via PIL's built-in `histogram()`, no numpy
    dependency added) — stopping at the first variant that yields two
    MRZ-shaped lines. No single fixed contrast treatment generalizes
    across every photo's lighting, so this tries a few in order rather
    than committing to one. Verified against the same reproduction case:
    the raw pass still fails, but the binarized variant recovers the
    document number, DOB, and expiry date all correctly checksum-valid.
  - **Second fix (post-launch regression, real-world report):** a
    different real photo produced a holder name that was a garbled mix of
    letters *and digits* — reported directly ("WUTH<<ANTONY<JOHN<<<<<<"
    read as something including data from the second line"). Root cause,
    confirmed by reproduction: with no automatic MRZ-region cropping,
    tesseract can split the true line 2 into two separate output lines on
    a busy/noisy photo. Both fragments still satisfy the plain length/
    alphabet shape check, so the old "last two shape-matching lines" pick
    silently grabbed two fragments of line 2 and treated the digit-heavy
    first one as line 1. Fix: `_find_mrz_lines` now uses a real ICAO 9303
    structural invariant instead of positional luck — **line 1 (document
    type/issuing country/name) never contains a digit; only line 2
    (document number/dates/checksums) does.** It searches backward for the
    last digit-bearing candidate (line 2), then continues backward from
    there for the nearest digit-free candidate (line 1); if no such pair
    exists, it now correctly returns nothing (422) rather than pairing up
    two fragments of the same real line. Verified against the reproduction
    case: the holder name now recovers correctly even though only a
    fragment of line 2 survives (the digit-based fields on that
    incomplete fragment are, correctly, flagged invalid rather than
    silently wrong-looking).
  - **Third fix (post-launch regression, real-world report):** a further
    report ("scan passport is now totally failing") against a real
    Australian passport photo. The MRZ text/checksum layer was
    independently re-verified as fully correct against this exact
    specimen's real MRZ (manually transcribed and run through
    `TD3CodeChecker` directly — document number, DOB, sex, expiry, and
    country all matched the printed page exactly), and two escalating
    synthetic reproductions built from that same ground-truth MRZ (busy
    layout, rotation, glare band, blur, sensor noise, JPEG
    recompression) both **succeeded** against the code as it stood —
    the exact real-world failure mechanism for this specific photo was
    not conclusively reproduced. Given no automatic MRZ-region cropping
    was still a known, already-documented gap (see "Out of scope"
    above) and the clearest remaining lever for a busy real photo,
    `extract_mrz` now crops to the bottom 35% of the photo first (via
    new `_bottom_strip()`, upscaling via `Image.LANCZOS` if the crop
    ends up under 120px tall) — that's where the MRZ always sits on a
    TD3 passport page (ICAO 9303) — and tries the existing 3-variant
    contrast ladder against *that* region before falling back to the
    full, uncropped photo. Restricting OCR to just the MRZ strip removes
    almost all the visual noise a full page carries (portrait photo,
    security/guilloche patterning, differently-fonted printed fields)
    that a whole-image OCR pass has to contend with. Verified
    non-regressing against both synthetic reproductions and the full
    test suite (SQLite and Postgres); not confirmed to resolve the
    specific reported case, since the failure was never reproduced.
  - **Fourth fix (post-launch regression, real-world report):** the bottom-
    strip crop above measurably improved things — a follow-up report said
    every field extracted correctly except holder_name, which came back as
    the literal text `"None None"`. Root cause, confirmed by reproduction:
    the `mrz` package's own identifier parser sets its internal name/
    surname fields to Python `None` when the identifier fails its
    structural checks (here: three `<<`-separated groups instead of two —
    OCR noise inserting an extra separator into a given name is a
    plausible real-world trigger), but `fields()` then stringifies them
    unconditionally, leaking the literal text `"None"` rather than an
    empty value. `extract_mrz` now filters that placeholder out of
    holder_name the same as any other missing part, so a malformed
    identifier now correctly produces an empty holder_name instead of
    garbage text — consistent with every other field's fail-closed
    behavior in this module. Verified via a new reproduction test and the
    full test suite (SQLite and Postgres).
  - **Preprocessing investigation (benchmarked, three improvements):** a
    systematic benchmark (synthetic passport pages, 15 controlled
    degradations — rotation/blur/noise/JPEG/glare/shadow/vignette/low-res
    — scored by character accuracy against the known ground-truth MRZ,
    same production tesseract config) found the ladder's one structural
    blind spot: its only binarization was **global** Otsu — one threshold
    for the whole strip — so any shadow band, glare edge, or illumination
    gradient crossing the MRZ erased the text on the wrong side of the
    cut before tesseract ever saw it. Every shadow-over-MRZ case scored
    0.00 (a user-facing 422). Three changes shipped: **(1)** a fourth
    ladder rung, `_adaptive_mean_binarize` — local adaptive-mean
    threshold via C-speed PIL primitives (BoxBlur + subtract + point LUT
    + median despeckle), no numpy — which took those cases to 0.88–0.93
    with zero regression elsewhere (it's a fallback rung; clean photos
    still stop at the global rungs first). **(2)** checksum-guided
    variant selection: the ladder previously stopped at the first
    MRZ-shaped read even when every check digit failed, measurably
    leaving better later reads on the table (a glare case stopped at ~90%
    char accuracy when a later rung read ~98%); `extract_mrz` now stops
    early only on a fully checksum-valid read, otherwise keeps the
    best-scoring candidate across rungs (the full-photo fallback region
    still only runs when the strip yields nothing, keeping the expensive
    pass off the common path). **(3)** MRZ-specific traineddata: real
    MRZs are OCR-B, which the stock eng model was never trained on;
    deploy.sh now installs DoubangoTelecom's `mrz.traineddata`
    (verified post-download via `--list-langs`, removed if corrupt) and
    the code auto-prefers it when present (`_tess_config()`), with a
    per-call eng fallback if the model file turns out broken at OCR
    time. Note the model's real-world gain could NOT be benchmarked in
    the dev sandbox (no network access to fetch it; the synthetic bench
    uses a non-OCR-B font anyway) — it's a deploy-time bet with a clean
    degradation path, not a measured win. Benchmarked deltas for (1)+(2):
    mean exact-field accuracy 0.47 → 0.62, fully-checksum-valid rate 0.40
    → 0.47, mean latency 0.93s → 0.84s, no case worse. Also tested and
    **rejected**: projection-profile deskew (net negative — estimates its
    angle from the same binarization the shadow corrupts), fixed-height
    strip rescaling (broke low-res images that currently pass), border
    padding (no effect), Sauvola thresholding (no win over adaptive-mean,
    ~10× slower without numpy).
- Pad each candidate line to 44 characters, join with `\n`, and hand the
  result to `mrz.checker.td3.TD3CodeChecker(mrz_text, check_expiry=False,
  compute_warnings=True)`. `checker.fields()` returns the parsed string
  values (`document_number`, `name`, `surname`, `nationality`,
  `birth_date`, `sex`, `country`, `expiry_date` — all still MRZ-encoded,
  e.g. `<`-padded and 2-digit-year dates). The checker instance's own
  `_hash`-suffixed attributes (`document_number_hash`, `birth_date_hash`,
  `expiry_date_hash`, `final_hash`) are **booleans** — the check-digit
  validity signal (verified via a real, checksum-valid ICAO Doc 9303 TD3
  specimen and a deliberately-corrupted one; the bare, non-`_hash`
  attributes on the checker are a different, date-relative "is not
  expired" signal, not checksum validity — easy to mix up, don't). Build
  the response dict from these:
  ```python
  {
    "document_number": f.document_number.rstrip("<"),
    "document_number_valid": bool(checker.document_number_hash),
    "holder_name": <f.name + f.surname, "<" -> " ", collapsed>,
    "nationality": f.nationality.rstrip("<"),
    "date_of_birth": <iso date>, "date_of_birth_valid": bool(checker.birth_date_hash),
    "sex": f.sex if f.sex in ("M", "F") else "",
    "issuing_country": f.country.rstrip("<"),
    "expiry_date": <iso date>, "expiry_date_valid": bool(checker.expiry_date_hash),
    "overall_valid": bool(checker.final_hash),
  }
  ```
  This replaces the earlier Claude-vision design's freeform `"confidence"`/
  `"warnings"` strings with something strictly better: **deterministic,
  per-field pass/fail from real check digits**, not a language model's
  self-report. The review UI (below) pre-unchecks any field whose
  `..._valid` companion is `false`, and shows a short "check digit didn't
  match" note instead of a vague warning string.
- MRZ dates are 2-digit years (`YYMMDD`) with no explicit century — convert
  to ISO with a heuristic: date of birth must be in the past (if
  `YY` would place it in the future relative to today, subtract 100 years);
  expiry dates default to 20YY. Documented and unit-tested inline in code
  (`tests/test_passport_ocr.py`) — it's a well-known MRZ gotcha, not a bug
  when it occasionally needs a manual correction (which the per-field
  review step exists to catch anyway).
- No content-hash cache like `documents.py`'s `ProcessedDocument` — OCR is
  free and near-instant here (no reason to dedupe a local CPU-bound call
  the way you'd dedupe a billed Claude call).

### 3. `backend/routers/vault.py` — new route

```python
@router.post("/me/documents/{doc_id}/files/{file_id}/scan")
async def scan_passport_file(doc_id, file_id, session=Depends(get_session), user=Depends(get_current_user)):
```

- `_owned_document()` first (existing helper) — 404 if not owned, same as
  every other file route.
- Load the `UserDocumentFile`, 404 if `file_id` doesn't belong to `doc_id`
  (same double-check pattern `download_document_file` already uses).
- 415 if `content_type` isn't `image/jpeg` or `image/png` — MRZ region
  detection expects a photo, not a PDF.
- `_require_vault_configured()` first (need to decrypt the stored file at
  all), **then** `if not passport_ocr.tesseract_available(): raise
  HTTPException(503, ...)` — two independent, differently-worded 503s so
  whoever's debugging a broken deploy knows which one is actually missing.
- `decrypt_bytes(doc_file.data_encrypted)`, call
  `passport_ocr.extract_mrz(content)`. `PassportOcrError` → 422 (readable
  request, just no usable MRZ found); `PassportOcrNotAvailable` → 503 (this
  is really the tesseract-missing check above firing late, e.g. a race
  where the binary was removed mid-process — belt and suspenders).
- Returns the extraction dict directly — **no DB write in this route**.
  The response is the proposal; nothing is applied until a subsequent
  `PATCH /me/documents/{doc_id}` call, same as how a manual edit already
  works, just pre-filled by this endpoint's response instead of by hand.

### 4. `PATCH /me/documents/{doc_id}` — extend `UserDocumentPatch`

Add optional `holder_name`, `nationality`, `date_of_birth`, `sex` fields,
handled the same sentinel-checked way `document_number` already is
(`"__unset__"` distinguishes "not provided" from "explicitly cleared"):
encrypt the four into one JSON blob and write to `holder_data_encrypted`
only when any of them is present in the patch body — partial holder-field
updates re-encrypt all four together (decrypt existing blob first if
present, merge, re-encrypt), since they're one encrypted unit, not four
independent ones.

### 5. `GET /me/documents/{doc_id}/holder`

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
   extracted value**, a checkbox (checked by default, **unchecked
   automatically if that field's `..._valid` companion is `false`**), and
   the extracted value is itself editable inline before accepting — same
   "edit the proposed value, then commit" affordance `PendingReview.jsx`
   already gives its name field, applied here per-field instead of to one
   whole object.
3. Any field whose check digit failed shows a short note under the row
   ("Check digit didn't match — verify before applying") in
   `var(--warning)`, not blocking the checkbox (the user can still
   check/apply it after visually confirming against the photo), just
   informational.
4. A single "Apply selected" button builds one patch object from the
   checked rows only and calls `updateDocument` — unchecked fields are
   simply omitted from the patch, leaving the existing value untouched
   (this is why `UserDocumentPatch`'s partial-update/`exclude_unset`
   semantics matter here — no sentinel dance needed on the frontend side).
5. On failure (503/415/422 from the scan call, or a save failure), show the
   error inline the same way every other error in this component already
   does (`var(--error)` text), without discarding the extraction result the
   user might want to retry applying.

No new frontend module needed beyond this — it's UI state local to
`DocumentRow`, not persisted, not offline-cached (the extraction result
itself is never written to `vaultOfflineStore.js`; only the file bytes are,
unchanged from plan-12c).

## Tests

Backend (`tests/test_passport_ocr.py`, new, 13 tests as shipped):
- `_find_mrz_lines`/`_pad44` pure unit tests: picks the last two MRZ-shaped
  lines, tolerates a little OCR dropout via length slack, returns nothing
  when there aren't two candidates.
- `_mrz_date_to_iso` century-inference unit tests: a birth year in the past
  resolves to the correct century; a birth year that would be "in the
  future" as 20YY rolls back to 19YY; expiry defaults to 20YY; malformed
  input returns `None`.
- `tesseract_available()`: monkeypatch `shutil.which`.
- `extract_mrz` via an injected fake `pytesseract.image_to_string`
  (mirroring how `flight_live`/`rail_live`'s `fetch=` injection is tested in
  `tests/test_flight_alerts.py`) — never calls the real Tesseract binary.
  Cover: `PassportOcrNotAvailable` when tesseract is "missing";
  `PassportOcrError` when the OCR'd text has no MRZ-shaped lines; the full
  happy path against a real, checksum-valid ICAO Doc 9303 TD3 specimen
  (all fields + all `..._valid` flags `True`); a corrupted-digit variant of
  the same specimen (that field's `..._valid` and `overall_valid` both
  `False`).
- `tesseract_available()`: monkeypatch `shutil.which` to simulate present/
  absent.
- Router tests (`client` fixture), with `vault.py`'s scan route's call to
  `passport_ocr.extract_mrz` monkeypatched to a canned fake:
  - 415 when the target file's `content_type` isn't an image.
  - 503 when `DOCUMENT_ENCRYPTION_KEY` unset (checked first — assert the
    fake extractor was never invoked).
  - 503 when `tesseract_available()` is patched to `False`.
  - 422 when the fake extractor raises `PassportOcrError`.
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
- **No test in this suite requires the real `tesseract` binary** — verified
  directly by moving `tesseract` out of `PATH` and re-running the full
  backend suite (626 passed). No CI changes were needed (see the
  Deployment section's correction above).

Frontend (`frontend/src/__tests__/DocumentSettings.test.jsx`, extended):
- "Scan passport" button appears only for image files.
- Clicking it calls `api.scanPassportFile` and renders one row per returned
  field, pre-unchecked for any field with `..._valid: false`.
- Unchecking a field and clicking "Apply selected" calls `updateDocument`
  with only the checked fields in the payload.
- Editing an extracted value inline before applying sends the edited value,
  not the original extraction.
- A 503/415/422 from the scan call renders the existing error-text
  convention, doesn't crash, and leaves the row usable to retry.

## Manual verification

1. `sudo apt-get install -y tesseract-ocr` (or confirm `deploy.sh`'s new
   step did it); `pip install -r backend/requirements.txt`; ensure
   `DOCUMENT_ENCRYPTION_KEY` is set; restart.
2. Upload a real (or sample/specimen) passport photo-page image to a
   document in Settings.
3. Click "Scan passport" — confirm each MRZ-derivable field appears with a
   sensible extracted value, correct check/uncheck defaults, and a working
   edit-then-apply flow per row.
4. Deliberately photograph the MRZ at an angle / with glare and confirm a
   clean 422 ("Could not locate a machine-readable zone...") rather than a
   500 or a silently-wrong extraction — this is the main real-world
   accuracy risk with phone photos (see Out of scope / Gotchas).
5. Uncheck `nationality`, edit `document_number` to a deliberately wrong
   value, click "Apply selected" — confirm only the edited document number
   and the still-checked fields changed; `GET /me/documents/{id}` shows the
   edited number; `nationality` is untouched.
6. `GET /me/documents/{id}/holder` — confirm it returns the accepted
   holder fields and that `GET /me/documents/{id}` never includes them.
7. Uninstall/rename the `tesseract` binary temporarily, click "Scan
   passport" again — confirm a clean 503, not a 500, and the existing
   document/file are untouched.
8. Try scanning a non-image file (e.g. upload a PDF as a document file) —
   confirm 415.
9. Inspect `/tmp` (or wherever `NamedTemporaryFile` lands) during and
   immediately after a scan to confirm the decrypted image's temp file is
   gone once the request completes, not left behind.

## Out of scope

- **Non-image scan formats** (PDF passport scans) — MRZ extraction targets
  photographs; a PDF-of-a-scan path would need rasterizing the PDF to an
  image first, not this plan's job.
- **Automatic scan-on-upload.** Scanning is a deliberate button click, never
  triggered by the upload itself — matches every other "opt-in, never
  blanket" precedent in this app's offline/vault features (plan-12c's
  Constraints).
- **Non-passport MRZ formats** (national ID cards, some driver's licences
  have their own machine-readable zones, typically TD1/TD2) — only TD3
  (passport) parsing shipped (via the `mrz` package's `TD3CodeChecker`);
  extending to other `doc_type`s is a follow-up if there's real demand.
- **Confidence-based auto-accept.** Even a fully check-digit-valid
  extraction still requires the user to click Apply — there's no threshold
  at which this plan writes data without a human in the loop.
- **A capture-guide overlay in the upload UI** (e.g. an on-screen box to
  align the MRZ strip to before taking the photo) — the single biggest
  lever for real-world accuracy with phone cameras, per the research behind
  this plan, but a separate, purely-frontend follow-up; this plan ships
  usable even with a plain file picker, just with lower first-try success
  on poorly-angled photos.
- **Content-hash caching of scans** — not needed; OCR here is free and
  local, unlike the billed-Claude case `documents.py` caches against.

## Gotchas

- **Two independent 503 checks on one route** (vault key, then tesseract
  availability) — don't collapse them into one generic "not configured"
  message; whoever's debugging a broken deploy needs to know which one is
  actually missing.
- **`holder_data_encrypted` is one encrypted JSON blob for four fields, not
  four columns** — a partial patch (e.g. only `sex` changed) must
  decrypt-merge-reencrypt the existing blob, not overwrite it with a
  partial object that loses the other three fields. Test this explicitly
  (see Tests).
- The same "never let an encrypted column leak into a `Read` model"
  mistake that's easy with `document_number_encrypted` applies equally to
  `holder_data_encrypted` — go through explicit `Read` models, never a
  naive `model_dump()`.
- **The temp-file step is the one place decrypted passport bytes touch
  disk in this entire app** — everywhere else, decrypted bytes only ever
  live in a Python variable in-process. Keep the `NamedTemporaryFile`
  window as short as possible (write → OCR → delete in `finally`,
  immediately), and don't be tempted to "optimize" by reusing a fixed
  path across requests.
- **2-digit MRZ year century inference** is a known sharp edge — get the
  heuristic right and unit-test it explicitly (a DOB century boundary case,
  an expiry century boundary case), since a silently-wrong century is far
  more confusing to a user than an outright failed extraction.
- **Real-world phone-photo accuracy is the main open risk**, not the
  parsing logic — Tesseract is less forgiving of skew/glare/crop than a
  vision-LLM would have been. The per-field check-digit validity (auto-
  unchecking failed fields) is this plan's mitigation; a capture-guide
  overlay (Out of scope) is the natural next lever if that's not enough in
  practice.
- This plan touches `frontend/src/` — the frontend build/push workflow
  applies (README §2): commit source, `npm run build`, commit
  `backend/static/` separately (never amended), then push.
