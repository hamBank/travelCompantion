"""Web Push: VAPID key handling and sending notifications to subscribed devices.

VAPID keys are generated once (see scripts/gen_vapid_keys.py) and stored as
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars — both raw base64url (no padding):
  * private key: the 32-byte EC private scalar (what py_vapid's Vapid.from_string
    / pywebpush's vapid_private_key= expects directly, no PEM needed)
  * public key:  the 65-byte uncompressed EC point (0x04 || X || Y) — this is the
    exact format the browser's PushManager.subscribe({applicationServerKey}) needs
"""
import base64
import os
from typing import Optional

from cryptography.hazmat.primitives.asymmetric import ec


def generate_vapid_keypair() -> tuple[str, str]:
    """Generate a fresh VAPID (private_b64, public_b64) pair — see module docstring for format."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    d = private_key.private_numbers().private_value.to_bytes(32, "big")
    private_b64 = base64.urlsafe_b64encode(d).rstrip(b"=").decode()

    pub = private_key.public_key().public_numbers()
    x = pub.x.to_bytes(32, "big")
    y = pub.y.to_bytes(32, "big")
    raw_public = b"\x04" + x + y
    public_b64 = base64.urlsafe_b64encode(raw_public).rstrip(b"=").decode()

    return private_b64, public_b64


def get_vapid_public_key() -> Optional[str]:
    return os.environ.get("VAPID_PUBLIC_KEY") or None


def get_vapid_private_key() -> Optional[str]:
    return os.environ.get("VAPID_PRIVATE_KEY") or None


def vapid_claims_for(endpoint: str) -> dict:
    """Minimal VAPID claims. pywebpush fills in 'aud' from the endpoint if absent."""
    contact = os.environ.get("VAPID_CONTACT_EMAIL", "admin@tripplan.hups.club")
    return {"sub": f"mailto:{contact}"}


class PushSendError(Exception):
    """Raised when a push send fails. `expired` is True on 404/410 — caller
    should delete the subscription rather than retry."""
    def __init__(self, message: str, expired: bool = False):
        super().__init__(message)
        self.expired = expired


def send_push(subscription_info: dict, payload: dict) -> None:
    """Send one Web Push notification. Raises PushSendError on failure."""
    from pywebpush import webpush, WebPushException
    import json

    private_key = get_vapid_private_key()
    if not private_key:
        raise PushSendError("VAPID keys not configured", expired=False)

    try:
        webpush(
            subscription_info=subscription_info,
            data=json.dumps(payload),
            vapid_private_key=private_key,
            vapid_claims=vapid_claims_for(subscription_info.get("endpoint", "")),
        )
    except WebPushException as e:
        status = getattr(e.response, "status_code", None) if e.response is not None else None
        expired = status in (404, 410)
        raise PushSendError(str(e), expired=expired) from e
