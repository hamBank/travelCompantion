"""Tests for backend/rate_limit.py's per-service call spacing."""
import time

from backend.rate_limit import throttle, _last_call


def test_first_call_does_not_wait():
    _last_call.pop("test-svc-1", None)
    start = time.monotonic()
    throttle("test-svc-1", min_interval=1.2)
    assert time.monotonic() - start < 0.05


def test_second_call_waits_out_the_remaining_interval():
    _last_call.pop("test-svc-2", None)
    throttle("test-svc-2", min_interval=0.2)
    start = time.monotonic()
    throttle("test-svc-2", min_interval=0.2)
    elapsed = time.monotonic() - start
    assert elapsed >= 0.15  # allow a little scheduling slack


def test_call_after_interval_has_elapsed_does_not_wait():
    _last_call.pop("test-svc-3", None)
    throttle("test-svc-3", min_interval=0.05)
    time.sleep(0.1)
    start = time.monotonic()
    throttle("test-svc-3", min_interval=0.05)
    assert time.monotonic() - start < 0.05


def test_different_services_do_not_throttle_each_other():
    _last_call.pop("test-svc-4a", None)
    _last_call.pop("test-svc-4b", None)
    throttle("test-svc-4a", min_interval=5.0)
    start = time.monotonic()
    throttle("test-svc-4b", min_interval=5.0)
    assert time.monotonic() - start < 0.05
