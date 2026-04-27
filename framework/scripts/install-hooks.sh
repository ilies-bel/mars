#!/usr/bin/env bash
# Install Mars git hooks into .git/hooks/. Idempotent.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_SRC="$REPO_ROOT/framework/scripts/pre-commit"
HOOK_DST="$REPO_ROOT/.git/hooks/pre-commit"

ln -sf "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_SRC"
echo "Installed pre-commit hook -> $HOOK_DST"
