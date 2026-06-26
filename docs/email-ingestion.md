# Email ingestion runbook

Forward a booking confirmation to a personal address and it shows up in the
app's **pending imports** to review. This document covers the one-time
server/DNS setup. The application side is already deployed — these steps wire a
mail server to it.

```
 inbound email ─▶ postfix (MX for the domain) ─▶ pipe transport (user=travelcomp)
        │                                              │  stdin = raw message
        │                                              ▼
        │                              scripts/mail_ingest_wrapper.sh ${recipient}
        │                                  (sources .env, runs mail_ingest.py)
        │                                              │  POST raw + X-Ingest-Secret
        ▼                                              ▼
                                    POST /ingest/email  (localhost:8000, secret-auth)
                                          stores raw.eml + attachments, resolves the
                                          user from import+<token>@…, creates pending
```

The pipe is authenticated to the API by a shared secret; the email *author* is
never trusted. Everything it produces is **pending** until the user applies it
in the app.

---

## 0. Prerequisites

- Root on the server (`anto@camelidcastle.hups.club`).
- The app deployed under `/opt/travelcomp` (service `travelcomp`, user
  `travelcomp`, venv `/opt/travelcomp/.venv`).
- A domain you control for the address. This runbook uses
  **`tripplan.hups.club`** (the app's own domain) — substitute yours.
- Inbound TCP **port 25** reachable from the internet (cloud firewall + host).

> If you'd rather not run an MX yourself, you can instead point an existing
> mailbox's filter/forward at the endpoint, or trigger ingestion from any
> process that can `POST` a raw `.eml` — see **Testing without a mail server**.

---

## 1. DNS

Add an MX record for the mail domain pointing at the server host, and make sure
that host has an A record.

```
tripplan.hups.club.        MX   10  camelidcastle.hups.club.
camelidcastle.hups.club.   A        <server-ip>
```

Verify once propagated:

```sh
dig +short MX tripplan.hups.club
dig +short A  camelidcastle.hups.club
```

---

## 2. App configuration (`.env`)

Add to `/opt/travelcomp/.env` (owned by `travelcomp`, `chmod 600`):

```sh
MAIL_INGEST_SECRET=<paste output of: openssl rand -hex 32>
MAIL_DOMAIN=tripplan.hups.club
# optional, defaults to /opt/travelcomp/mail_store
# MAIL_STORE_DIR=/opt/travelcomp/mail_store
```

Restart so the API picks up the secret:

```sh
sudo systemctl restart travelcomp
# 403 (not 401/404) means the endpoint is up and demanding the secret:
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8000/ingest/email --data x
```

Make the wrapper executable (the shim itself needs no venv — stdlib only):

```sh
sudo chmod +x /opt/travelcomp/scripts/mail_ingest_wrapper.sh /opt/travelcomp/mail_ingest.py
```

---

## 3. Install & configure postfix

```sh
sudo apt-get update && sudo apt-get install -y postfix
# choose "Internet Site"; system mail name: camelidcastle.hups.club
```

Edit `/etc/postfix/main.cf` (append/adjust):

```ini
myhostname = camelidcastle.hups.club
inet_interfaces = all
inet_protocols = ipv4

# Accept local delivery for the mail domain so `import@…` is ours.
mydestination = $myhostname, localhost.$mydomain, localhost, tripplan.hups.club

# import+<token>@…  → the +<token> is the address extension we read.
recipient_delimiter = +

# Route the import mailbox to our pipe transport.
transport_maps = hash:/etc/postfix/transport

# Only accept mail we can actually deliver (keeps you from being an open relay
# and drops spam to random local users).
smtpd_recipient_restrictions =
    permit_mynetworks,
    reject_unauth_destination
```

Create `/etc/postfix/transport`:

```
import@tripplan.hups.club    travelcomp:
```

```sh
sudo postmap /etc/postfix/transport
```

Create `/etc/postfix/local_recipients` — this tells Postfix to accept the
`import` address before routing it. Without this, Postfix rejects at RCPT
time with "User unknown in local recipient table" because `import` is not a
real Unix user. With `recipient_delimiter = +`, a lookup for `import+TOKEN@…`
automatically falls back to `import@…`, so one entry covers all tokens:

```
import@tripplan.hups.club OK
```

```sh
sudo postmap /etc/postfix/local_recipients
sudo postconf -e "local_recipient_maps = hash:/etc/postfix/local_recipients"
```

Add the pipe service to the end of `/etc/postfix/master.cf`:

```
travelcomp unix  -       n       n       -       -       pipe
  flags=Rq user=travelcomp argv=/opt/travelcomp/scripts/mail_ingest_wrapper.sh ${recipient}
```

- `user=travelcomp` lets the wrapper read the `chmod 600` `.env`.
- `${recipient}` passes the full `import+<token>@…` so the token is preserved
  even though `recipient_delimiter` strips it for routing lookups.
- `flags=Rq` adds a `Return-Path` and quotes args safely.

Apply:

```sh
sudo postfix check && sudo systemctl restart postfix
```

---

## 4. Each user: get the forwarding address

In the app, open **⚙ Settings → "Forward bookings by email"** and copy the
address (`import+<token>@tripplan.hups.club`). It's generated on first view and
is stable. Forward (or auto-forward via a Gmail filter) booking confirmations
there.

---

## 5. End-to-end test

From the server, hand a sample message straight to postfix as if it arrived:

```sh
TOKEN=<your token from Settings>
printf 'From: test@example.com\nTo: import+%s@tripplan.hups.club\nSubject: Test booking\n\nQF1 SYD->LAX 2026-08-01 09:00\n' "$TOKEN" \
  | sendmail -i -- "import+$TOKEN@tripplan.hups.club"
```

Or skip the MTA and exercise the endpoint directly:

```sh
. /opt/travelcomp/.env
curl -s -X POST http://127.0.0.1:8000/ingest/email \
  -H "X-Ingest-Secret: $MAIL_INGEST_SECRET" \
  -H "X-Original-To: import+$TOKEN@tripplan.hups.club" \
  --data-binary @sample.eml
# → {"id":N,"resolved":true,"items":K}
```

Then in the app, the footer shows **📥 Imports (N)** — open it, pick a trip and
stop per item, and **Add to trip**.

---

## 6. Verify & troubleshoot

```sh
# Mail flow
sudo tail -f /var/log/mail.log              # postfix accept/deliver/pipe lines
sudo postqueue -p                            # stuck mail (pipe failures requeue)

# API side
sudo journalctl -u travelcomp -f             # ingest + parse errors

# What got stored / parsed
ls -la /opt/travelcomp/mail_store/           # one uuid dir per received email
sudo -u travelcomp /opt/travelcomp/.venv/bin/python - <<'PY'
from backend.database import engine
from sqlmodel import Session, select
from backend.models import IngestedEmail
with Session(engine) as s:
    for e in s.exec(select(IngestedEmail)).all():
        print(e.id, e.status, e.item_count, e.resolved_user_email, repr(e.parse_error))
PY
```

| Symptom | Likely cause |
|---|---|
| `curl` to `/ingest/email` returns **401** | `/ingest/` not in the API allowlist, or you hit it through Apache. Use `127.0.0.1:8000` directly. |
| returns **403** | Missing/incorrect `X-Ingest-Secret` (must equal `.env`'s `MAIL_INGEST_SECRET`). |
| `resolved:false`, `IngestedEmail.status=error "unknown recipient token"` | The `+token` didn't match a `UserImportToken`. Re-copy the address from Settings; check `recipient_delimiter = +`. |
| `status=received`, no items | `ANTHROPIC_API_KEY` not set — the email is saved but not parsed. Set it and re-send. |
| `status=error` with a parse message | Claude/extraction failed; the raw email is still in `mail_store/` for inspection. |
| `550 5.1.1 User unknown in local recipient table` | `local_recipient_maps` not configured — Postfix rejects at RCPT before routing. Create `/etc/postfix/local_recipients` with `import@domain OK`, run `postmap` and `postconf -e "local_recipient_maps = hash:/etc/postfix/local_recipients"`, then `postfix reload`. |
| pipe never runs (`mail.log` shows delivery to a local mailbox) | `mydestination`/`transport` mismatch, or `postmap` not run after editing `/etc/postfix/transport`. |
| pipe runs but `mail_ingest: post failed` | API down, wrong `INGEST_URL`, or `.env` not readable by `travelcomp`. |

**Security & housekeeping**
- The endpoint is localhost-only — Apache never proxies `/ingest/`. Keep it that way.
- The `+token` is a low-value bearer string: it can only create *pending* items
  for that user, which still require manual review. Rotate by deleting the
  user's `UserImportToken` row (a new one is generated on next Settings view).
- `mail_store/` grows one directory per email and is git-ignored. Prune old
  entries periodically (e.g. a cron `find /opt/travelcomp/mail_store -mtime +90
  -type d -empty -delete` after a retention policy is agreed).
- Consider greylisting/rate-limiting at postfix if the address ever leaks.
