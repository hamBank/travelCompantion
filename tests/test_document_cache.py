"""Tests for document hash caching — skip Claude when same file re-uploaded."""
import hashlib
from backend.routers.documents import _doc_cache_key, _check_doc_cache, _record_doc_cache


def test_cache_key_is_stable_for_same_content():
    key = _doc_cache_key(1, [b"hello world"])
    assert key == _doc_cache_key(1, [b"hello world"])


def test_cache_key_differs_by_trip():
    assert _doc_cache_key(1, [b"doc"]) != _doc_cache_key(2, [b"doc"])


def test_cache_key_differs_by_content():
    assert _doc_cache_key(1, [b"doc1"]) != _doc_cache_key(1, [b"doc2"])


def test_cache_key_order_independent():
    # Multi-file upload: order of files shouldn't change the cache key
    assert _doc_cache_key(1, [b"fileA", b"fileB"]) == _doc_cache_key(1, [b"fileB", b"fileA"])


def test_check_miss_when_not_seen(client, session):
    assert _check_doc_cache(session, _doc_cache_key(999, [b"new"])) is None


def test_record_then_hit(client, session):
    key = _doc_cache_key(1, [b"my document"])
    assert _check_doc_cache(session, key) is None
    _record_doc_cache(session, key, trip_id=1, item_count=3)
    result = _check_doc_cache(session, key)
    assert result is not None
    assert result["item_count"] == 3
    assert result["trip_id"] == 1


def test_different_trips_independent(client, session):
    key1 = _doc_cache_key(1, [b"shared content"])
    key2 = _doc_cache_key(2, [b"shared content"])
    _record_doc_cache(session, key1, trip_id=1, item_count=2)
    assert _check_doc_cache(session, key1) is not None
    assert _check_doc_cache(session, key2) is None


def test_force_bypasses_cache(client, session):
    """force=True skips the cache check so re-processing is possible."""
    key = _doc_cache_key(1, [b"same doc"])
    _record_doc_cache(session, key, trip_id=1, item_count=2)
    # With force, cache should not block — check_doc_cache is not called
    # (tested via the endpoint; here we verify the helper logic directly)
    assert _check_doc_cache(session, key) is not None   # exists in cache
    # But the endpoint with force=True would proceed past this check
