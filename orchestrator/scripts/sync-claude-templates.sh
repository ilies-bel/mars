#!/usr/bin/env bash
# Copy the framework's `.claude/` config into the orchestrator's template
# tree, so that `mars init` ships a self-contained Claude Code setup. Runs
# as `prebuild`/`pretest`, so the bundled tree is always fresh.
#
# The bundled `templates/CLAUDE.md` is intentionally NOT synced from the
# framework's own root `CLAUDE.md` — the two have diverged: the template
# carries Mars-meta content for target repos, while the framework's own
# CLAUDE.md describes the mars-framework codebase itself. Edit
# `orchestrator/src/init/templates/CLAUDE.md` directly when the template
# needs to change.
#
# Symlinks (e.g. `.claude/skills/mastra → .agents/skills/mastra` in the
# framework repo) are dereferenced (`rsync -aL`) so the resulting templates
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
DEST_DIR="$ORCH_ROOT/src/init/templates"
DEST_CLAUDE="$DEST_DIR/claude"

if [ ! -d "$SRC_CLAUDE" ]; then
  echo "sync-claude-templates: source $SRC_CLAUDE does not exist" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# Sync the framework's `.claude/` tree into the bundle, dereferencing symlinks
# so the result is portable to repos that don't ship `.agents/` etc.
# Runtime-only artifacts are EXCLUDED DURING COPY so we never traverse or copy
# the multi-GB `worktrees/` tree:
#   - worktrees/           live agent worktree checkouts (full repo copies, NOT templates)
#   - scheduled_tasks.lock live pid/sessionId lock, NOT a seed template
#   - settings.local.json  per-developer local override, gitignored, NOT a seed template
# rsync --delete removes stale files from the destination that no longer exist
# in the source, keeping the bundle in sync without a full rm-and-recopy.
rsync -aL --delete \
  --exclude='worktrees/' \
  --exclude='scheduled_tasks.lock' \
  --exclude='settings.local.json' \
  "$SRC_CLAUDE/" "$DEST_CLAUDE/"

# rsync preserves source modes; force hooks executable for the case where
# the source bit was somehow stripped (e.g. on a Windows-mounted checkout).
if [ -d "$DEST_CLAUDE/hooks" ]; then
  find "$DEST_CLAUDE/hooks" -type f -name '*.sh' -exec chmod 0755 {} +
fi
