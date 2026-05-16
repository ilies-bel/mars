#!/usr/bin/env bash
# Copy the framework's `.claude/` config and root `CLAUDE.md` into the
# orchestrator's template tree, so that `mars init` ships a self-contained
# Claude Code setup. Runs as `prebuild`/`pretest`, so the bundled tree is
# always fresh.
#
# Symlinks (e.g. `.claude/skills/mastra → .agents/skills/mastra` in the
# framework repo) are dereferenced with `cp -RL` so the resulting templates
# tree is portable to repos that don't ship `.agents/`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRAMEWORK_ROOT="$(cd "$ORCH_ROOT/.." && pwd)"

SRC_CLAUDE="$FRAMEWORK_ROOT/.claude"
SRC_CLAUDE_MD="$FRAMEWORK_ROOT/CLAUDE.md"
DEST_DIR="$ORCH_ROOT/src/init/templates"
DEST_CLAUDE="$DEST_DIR/claude"
DEST_CLAUDE_MD="$DEST_DIR/CLAUDE.md"

if [ ! -d "$SRC_CLAUDE" ]; then
  echo "sync-claude-templates: source $SRC_CLAUDE does not exist" >&2
  exit 1
fi
if [ ! -f "$SRC_CLAUDE_MD" ]; then
  echo "sync-claude-templates: source $SRC_CLAUDE_MD does not exist" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
rm -rf "$DEST_CLAUDE"
cp -RL "$SRC_CLAUDE" "$DEST_CLAUDE"
cp "$SRC_CLAUDE_MD" "$DEST_CLAUDE_MD"

# `cp -RL` copies the *entire* live `.claude/` tree, which includes Claude
# Code runtime artifacts the harness writes there at run time — notably
# `scheduled_tasks.lock` (a live pid/sessionId/timestamp lock, NOT a seed
# template). Letting it land in the committed template source tree dirties
# the integration working tree and fails `merge:preflight`. Prune any such
# runtime locks from the destination so only real template assets ship.
find "$DEST_CLAUDE" -type f -name 'scheduled_tasks.lock' -delete

# `cp -RL` preserves source modes; force hooks executable for the case where
# the source bit was somehow stripped (e.g. on a Windows-mounted checkout).
if [ -d "$DEST_CLAUDE/hooks" ]; then
  find "$DEST_CLAUDE/hooks" -type f -name '*.sh' -exec chmod 0755 {} +
fi
