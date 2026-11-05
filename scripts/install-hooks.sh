#!/usr/bin/env bash
# Install (or tidy up) git hooks for this repo.
# Run after cloning, and once on existing clones: bash scripts/install-hooks.sh
#
# There are currently NO hooks to install. The old pre-push hook enforced "rebuild
# and commit backend/static/ with every frontend change"; backend/static/ is now
# build output that deploy.sh produces and git ignores (fleet spec BLD-1), so that
# hook would wrongly BLOCK any push that touches frontend/src/. This script removes
# it if it is still installed. Add future hooks here.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/.git/hooks/pre-push"

if [ -f "$HOOK" ] && grep -q "backend/static" "$HOOK"; then
  rm -f "$HOOK"
  echo "✓ removed the obsolete pre-push hook (it required committing backend/static/)"
else
  echo "✓ nothing to do: no obsolete pre-push hook installed"
fi
