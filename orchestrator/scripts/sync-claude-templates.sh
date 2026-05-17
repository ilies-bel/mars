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

# Guard: skip when running inside a git worktree (e.g. an orchestrator task
# worktree). In a worktree, `git rev-parse --git-dir` returns the per-worktree
# path under `.git/worktrees/<name>`, while `--git-common-dir` always points to
# the main repo's `.git`. When the two differ we are in a worktree and MUST NOT
# sync templates — the current CLAUDE.md is the live project file, not the
# canonical framework template source, and overwriting the bundled template would
# dirty the worktree tree and block the subsequent rebase-based merge.
_git_dir="$(git -C "$FRAMEWORK_ROOT" rev-parse --git-dir 2>/dev/null || echo '')"
_git_common="$(git -C "$FRAMEWORK_ROOT" rev-parse --git-common-dir 2>/dev/null || echo '')"
if [ -n "$_git_dir" ] && [ "$_git_dir" != "$_git_common" ]; then
  echo "sync-claude-templates: inside a git worktree — skipping template sync (run from project root to update templates)" >&2
  exit 0
fi

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
# template) and `worktrees/` (live agent worktree checkouts — full repo
# copies, megabytes each, NOT seed templates). Letting either land in the
# committed template source tree dirties the integration working tree and
# fails `merge:preflight`. Prune them so only real template assets ship.
find "$DEST_CLAUDE" -type f -name 'scheduled_tasks.lock' -delete
find "$DEST_CLAUDE" -maxdepth 1 -type d -name 'worktrees' -exec rm -rf {} +

# `cp -RL` preserves source modes; force hooks executable for the case where
# the source bit was somehow stripped (e.g. on a Windows-mounted checkout).
if [ -d "$DEST_CLAUDE/hooks" ]; then
  find "$DEST_CLAUDE/hooks" -type f -name '*.sh' -exec chmod 0755 {} +
fi
