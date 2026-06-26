#!/usr/bin/env python3
"""Postfix → Travel Companion email ingest shim.

Reads a raw RFC822 message on stdin and POSTs it to the local ingest endpoint
with the shared secret. Stdlib-only so it needs no virtualenv.

Postfix wiring (one option, via aliases — adjust to your setup):

    # /etc/aliases  (or a transport/virtual map)
    import: "|/opt/travelcomp/mail_ingest.py ${recipient}"

    # and ensure recipient_delimiter = + in main.cf so import+<token>@…
    # is delivered to the `import` alias with the +token preserved.

Environment (read from the process / systemd drop-in):
    MAIL_INGEST_SECRET   shared secret, must match the API's .env
    INGEST_URL           default http://127.0.0.1:8000/ingest/email

Exit codes: 0 = accepted; 75 (EX_TEMPFAIL) = transient failure so postfix retries.
"""
import os
import sys
import urllib.request

SECRET = os.environ.get("MAIL_INGEST_SECRET", "")
URL = os.environ.get("INGEST_URL", "http://127.0.0.1:8000/ingest/email")


def main() -> int:
    raw = sys.stdin.buffer.read()
    if not raw:
        sys.stderr.write("mail_ingest: empty stdin\n")
        return 75
    recipient = ""
    if len(sys.argv) > 1:
        recipient = sys.argv[1]
    recipient = recipient or os.environ.get("ORIGINAL_RECIPIENT", "")

    req = urllib.request.Request(
        URL, data=raw, method="POST",
        headers={
            "X-Ingest-Secret": SECRET,
            "X-Original-To": recipient,
            "Content-Type": "message/rfc822",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            r.read()
        return 0
    except Exception as e:  # transient → let postfix retry
        sys.stderr.write(f"mail_ingest: post failed: {e}\n")
        return 75


if __name__ == "__main__":
    sys.exit(main())
