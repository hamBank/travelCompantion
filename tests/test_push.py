"""Tests for backend/push.py — VAPID key generation and send-error classification."""
import base64

import pytest

from backend import push


def test_generate_vapid_keypair_shapes():
    priv, pub = push.generate_vapid_keypair()
    # 32-byte private scalar, base64url no padding → 43 chars
    assert len(priv) == 43
    assert "=" not in priv
    # 65-byte uncompressed point (0x04 || X || Y), base64url no padding → 87 chars
    assert len(pub) == 87
    assert "=" not in pub
    raw_pub = base64.urlsafe_b64decode(pub + "==")
    assert raw_pub[0] == 0x04
    assert len(raw_pub) == 65


def test_private_key_accepted_by_py_vapid_and_public_key_matches():
    """Locks in the exact format pywebpush/py_vapid expect: py_vapid.Vapid.from_string
    must accept our private key raw, and the public key it derives must equal ours."""
    py_vapid = pytest.importorskip("py_vapid")
    priv, pub = push.generate_vapid_keypair()

    vv = py_vapid.Vapid.from_string(private_key=priv)
    derived_pub_pem_numbers = vv.public_key.public_numbers()
    x = derived_pub_pem_numbers.x.to_bytes(32, "big")
    y = derived_pub_pem_numbers.y.to_bytes(32, "big")
    derived_raw = b"\x04" + x + y
    derived_b64 = base64.urlsafe_b64encode(derived_raw).rstrip(b"=").decode()

    assert derived_b64 == pub


def test_send_push_without_vapid_keys_raises(monkeypatch):
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    with pytest.raises(push.PushSendError) as exc:
        push.send_push({"endpoint": "https://example.com/x", "keys": {"p256dh": "a", "auth": "b"}}, {"title": "t"})
    assert not exc.value.expired


def test_send_push_classifies_expired_subscription(monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", push.generate_vapid_keypair()[0])

    class FakeResponse:
        status_code = 410

    class FakeWebPushException(Exception):
        def __init__(self):
            super().__init__("gone")
            self.response = FakeResponse()

    def fake_webpush(**kwargs):
        raise FakeWebPushException()

    import pywebpush
    monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
    monkeypatch.setattr(pywebpush, "WebPushException", FakeWebPushException)

    with pytest.raises(push.PushSendError) as exc:
        push.send_push({"endpoint": "https://example.com/x", "keys": {"p256dh": "a", "auth": "b"}}, {"title": "t"})
    assert exc.value.expired
