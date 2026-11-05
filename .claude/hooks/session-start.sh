#!/bin/bash
# Fleet spec PRC-2: make a fresh Claude Code on the web session able to run the
# test suites (`python -m pytest tests/ -q`, `cd frontend && npx vitest run`)
# without any manual setup.
set -euo pipefail

# Only runs in Claude Code on the web — a local checkout is assumed to already
# have the venv/node_modules the developer wants.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --- Backend ----------------------------------------------------------------
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r backend/requirements.txt

# backend.auth refuses to import with auth neither configured nor explicitly
# off (fleet spec CFG-3); no Google OAuth secret exists in this environment, so
# say "off" on purpose — for this hook and for the whole session.
export AUTH_ENABLED=false
{
  echo "export AUTH_ENABLED=false"
  echo "export PATH=\"$CLAUDE_PROJECT_DIR/.venv/bin:\$PATH\""
} >> "$CLAUDE_ENV_FILE"

# --- Frontend ---------------------------------------------------------------
cd frontend
npm ci --no-audit --no-fund
