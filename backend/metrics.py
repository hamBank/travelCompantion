"""Prometheus metrics — single source of truth for all custom counters/histograms.

HTTP metrics are registered automatically by prometheus-fastapi-instrumentator
in main.py.  Everything below is application-level.
"""
import logging
from prometheus_client import Counter, Histogram

_external_logger = logging.getLogger("travelcomp.external")

# ── External (third-party) API calls ─────────────────────────────────────────
# Every outbound call to a service we don't control — Overpass, Nominatim,
# Google Maps (geocode/routes/elevation/static maps), AviationStack,
# AeroDataBox, OpenTopoData, pywebpush — increments this so total-request and
# error-rate can be graphed per service, without needing to reproduce a
# one-off failure (e.g. an upstream 429) to know it happened.

external_requests = Counter(
    "travelcomp_external_requests_total",
    "Outbound calls to third-party APIs",
    ["service", "status"],   # status: success | error
)


def record_external_call(service: str, ok: bool, error: str = "") -> None:
    """Call from a try/except (or finally, with `ok` computed beforehand)
    around any outbound request to a third-party API. Always increments the
    counter; only logs on failure, at warning level, so a specific incident
    can be found in app.log without flooding it with routine successes."""
    external_requests.labels(service=service, status="success" if ok else "error").inc()
    if not ok:
        _external_logger.warning("external call failed: service=%s error=%s", service, error)


# ── Email ingestion ────────────────────────────────────────────────────────────

email_ingested = Counter(
    "travelcomp_email_ingested_total",
    "Emails received by the ingest endpoint",
    ["status"],          # parsed | error | skipped (no token)
)

# ── Claude API ────────────────────────────────────────────────────────────────

claude_requests = Counter(
    "travelcomp_claude_requests_total",
    "Claude API requests made by the document parser",
    ["status"],          # success | error
)

claude_duration = Histogram(
    "travelcomp_claude_duration_seconds",
    "Wall-clock time for a Claude streaming request (first token → final message)",
    buckets=[1, 5, 10, 20, 30, 60, 90, 120, 180, 300],
)

claude_tokens = Counter(
    "travelcomp_claude_tokens_total",
    "Tokens consumed by Claude API calls",
    ["type"],            # input | output | cache_read | cache_write
)

# Estimated cost in USD using Sonnet 4.6 public rates:
#   input $3.00/MTok, cache_read $0.30/MTok, cache_write $3.75/MTok, output $15.00/MTok
claude_cost = Counter(
    "travelcomp_claude_cost_dollars_total",
    "Estimated Claude API spend in USD (Sonnet 4.6 rates)",
)

claude_cost_per_request = Histogram(
    "travelcomp_claude_cost_per_request_dollars",
    "Estimated USD cost of a single Claude parse request (Sonnet 4.6 rates)",
    buckets=[0.002, 0.005, 0.01, 0.02, 0.05, 0.10, 0.20, 0.50, 1.00],
)

# ── Pending changes ───────────────────────────────────────────────────────────

pending_created = Counter(
    "travelcomp_pending_changes_total",
    "Pending changes created by document/email parsing",
    ["op", "kind"],      # op: create|update  kind: flight|hotel|…
)

pending_decided = Counter(
    "travelcomp_pending_decided_total",
    "Pending changes resolved by a user",
    ["decision"],        # applied | discarded
)

# ── Pricing constants (Sonnet 4.6) ────────────────────────────────────────────

_PRICE_INPUT        = 3.00  / 1_000_000   # $/token
_PRICE_OUTPUT       = 15.00 / 1_000_000
_PRICE_CACHE_READ   = 0.30  / 1_000_000
_PRICE_CACHE_WRITE  = 3.75  / 1_000_000


def record_claude_usage(usage, elapsed_s: float, status: str = "success"):
    """Update all Claude metrics from an Anthropic Usage object."""
    claude_requests.labels(status=status).inc()
    claude_duration.observe(elapsed_s)

    if usage is None:
        return

    inp  = getattr(usage, "input_tokens",                0) or 0
    out  = getattr(usage, "output_tokens",               0) or 0
    cr   = getattr(usage, "cache_read_input_tokens",     0) or 0
    cw   = getattr(usage, "cache_creation_input_tokens", 0) or 0

    claude_tokens.labels(type="input").inc(inp)
    claude_tokens.labels(type="output").inc(out)
    if cr: claude_tokens.labels(type="cache_read").inc(cr)
    if cw: claude_tokens.labels(type="cache_write").inc(cw)

    cost = inp * _PRICE_INPUT + out * _PRICE_OUTPUT + cr * _PRICE_CACHE_READ + cw * _PRICE_CACHE_WRITE
    claude_cost.inc(cost)
    claude_cost_per_request.observe(cost)
