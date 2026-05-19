#!/usr/bin/env bash
# PreToolUse Edit/Write/NotebookEdit hook: block direct writes to git-tracked
# files when running outside an orchestrator worktree. Enforces the invariant
# that all mutations to tracked files must route through the orchestrator
# (worktree → code → verify → merge).
#
# Exit 2 = block (stderr is surfaced to the model and aborts the tool call).
# Exit 0 = allow.

set -u

# Inside an orchestrator worktree — allow unconditionally.
# Worktrees live under .mars/worktrees/<task-id>/.
case "${CLAUDE_PROJECT_DIR:-}" in
  */.mars/worktrees/*) exit 0 ;;
esac

input="$(cat)"

# Require jq — fail open if absent so the hook never silently breaks sessions.
command -v jq >/dev/null 2>&1 || exit 0

tool_name="$(printf '%s' "$input" | jq -r '.tool_name // ""')"
case "$tool_name" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')"
[ -z "$file_path" ] && exit 0

# Resolve to absolute path.
case "$file_path" in
  /*) abs="$file_path" ;;
  *)  abs="${CLAUDE_PROJECT_DIR:-$PWD}/$file_path" ;;
esac

project_root="${CLAUDE_PROJECT_DIR:-$PWD}"

# Check if the file is already tracked in git.
if git -C "$project_root" ls-files --error-unmatch "$abs" >/dev/null 2>&1; then
  cat >&2 <<BLOCK
[mars] BLOCKED: direct write to git-tracked file outside an orchestrator worktree.
       File: $file_path

       Route this change through the orchestrator instead:
         mars task add "..."          — enqueue for async coding
         /mars:task from Claude Code  — light-shaping wrapper

       Direct edits on main bypass worktree isolation and the verify/merge
       pipeline. If you truly need to edit directly, the user must explicitly
       opt in for this specific change (a prior blanket opt-in does not carry
       over — see CLAUDE.md Routing section).
BLOCK
  exit 2
fi

exit 0
