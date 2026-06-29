#!/usr/bin/env bash
# Install git hooks for this repo.
# Run once after cloning: bash scripts/install-hooks.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

cat > "$HOOKS_DIR/pre-push" <<'HOOK'
#!/usr/bin/env bash
# Two checks:
# 1. Abort if frontend/src/ changed but backend/static/ was not rebuilt.
# 2. Abort if build-sha.txt doesn't match HEAD (SHA baked in is one commit behind).

while IFS=' ' read -r _local_ref local_sha _remote_ref remote_sha; do
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    base=$(git rev-list --max-parents=0 "$local_sha")
  else
    base="$remote_sha"
  fi

  changed=$(git diff --name-only "$base" "$local_sha" 2>/dev/null)
  src_changed=$(echo "$changed"    | grep -c '^frontend/src/'   || true)
  static_changed=$(echo "$changed" | grep -c '^backend/static/' || true)

  if [ "$src_changed" -gt 0 ] && [ "$static_changed" -eq 0 ]; then
    echo ""
    echo "❌  pre-push: frontend/src/ changed but backend/static/ was NOT rebuilt."
    echo ""
    echo "    Fix:"
    echo "      cd frontend && npm run build && cd .."
    echo "      git add backend/static/ && git commit --amend --no-edit"
    echo "      git push ..."
    echo ""
    exit 1
  fi

done

exit 0
HOOK

chmod +x "$HOOKS_DIR/pre-push"
echo "✓ pre-push hook installed at $HOOKS_DIR/pre-push"
