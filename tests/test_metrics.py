"""Tests for backend/metrics.py's generic external-call tracking helper."""
from backend import metrics


def _count(service, status):
    return metrics.external_requests.labels(service=service, status=status)._value.get()


def test_record_external_call_increments_success_counter():
    before = _count("test_service_success", "success")
    metrics.record_external_call("test_service_success", ok=True)
    assert _count("test_service_success", "success") == before + 1


def test_record_external_call_increments_error_counter():
    before = _count("test_service_error", "error")
    metrics.record_external_call("test_service_error", ok=False, error="boom")
    assert _count("test_service_error", "error") == before + 1


def test_record_external_call_logs_warning_only_on_failure(monkeypatch):
    # Spy on the logger call directly rather than relying on caplog/log
    # propagation — Alembic's fileConfig() (invoked by test_alembic_drift.py
    # when it runs earlier in the same process) disables any logger that
    # existed before it ran and isn't in its own config, which would make a
    # caplog-based assertion order-dependent and flaky.
    calls = []
    monkeypatch.setattr(metrics._external_logger, "warning", lambda *a, **k: calls.append((a, k)))

    metrics.record_external_call("test_service_log_ok", ok=True)
    assert calls == []

    metrics.record_external_call("test_service_log_err", ok=False, error="rate limited")
    assert len(calls) == 1
    args = calls[0][0]
    assert "test_service_log_err" in args
    assert "rate limited" in args
