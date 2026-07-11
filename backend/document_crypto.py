"""Server-side encryption for the document vault (UserDocument /
UserDocumentFile). v1 is server-side only — see docs/plans/plan-12-document-vault.md
for why client-side encryption is a deliberate, later cut, not an oversight.

DOCUMENT_ENCRYPTION_KEY is categorically higher-stakes than every other
secret in this app: losing or rotating it permanently and irrecoverably
destroys every stored document (there is no reset path, unlike JWT_SECRET or
VAPID_PRIVATE_KEY). Generate it with scripts/gen_document_key.py, set it
before first use, and back it up outside the server — see .env.example.
"""
import os

from cryptography.fernet import Fernet, InvalidToken  # noqa: F401  (re-exported for callers)

DOCUMENT_ENCRYPTION_KEY = os.environ.get("DOCUMENT_ENCRYPTION_KEY", "")


class DocumentVaultNotConfigured(Exception):
    """Raised by encrypt/decrypt when DOCUMENT_ENCRYPTION_KEY is unset —
    callers (backend/routers/vault.py) translate this into a 503, never a
    fallback key."""


def _fernet() -> Fernet:
    if not DOCUMENT_ENCRYPTION_KEY:
        raise DocumentVaultNotConfigured()
    return Fernet(DOCUMENT_ENCRYPTION_KEY.encode())


def encrypt_bytes(data: bytes) -> bytes:
    return _fernet().encrypt(data)


def decrypt_bytes(data: bytes) -> bytes:
    return _fernet().decrypt(data)
