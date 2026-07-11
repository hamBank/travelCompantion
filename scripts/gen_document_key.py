#!/usr/bin/env python3
"""Generate a document-vault encryption key and print a .env line to paste in.

Uses Fernet (from `cryptography`) — a URL-safe base64-encoded 32-byte key,
generated via Fernet.generate_key(). Run once per deployment, BEFORE any
document is stored:

    python scripts/gen_document_key.py

CRITICAL: losing or rotating this key after documents exist permanently and
irrecoverably destroys them — there is no reset path. Back it up somewhere
durable outside the server (e.g. a password manager entry), not only in
.env on the one disk that pg_dump also lives on.
"""
from cryptography.fernet import Fernet

if __name__ == "__main__":
    key = Fernet.generate_key().decode()
    print("# Add to .env — back this up outside the server before storing any documents.")
    print("# Losing or rotating it after documents exist destroys them irrecoverably.")
    print(f"DOCUMENT_ENCRYPTION_KEY={key}")
