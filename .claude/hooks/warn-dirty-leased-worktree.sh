#!/usr/bin/env bash
# Stop hook: warn (but never block) when a session ends inside a Mars-leased
# worktree with either uncommitted changes or no progress journal entries.
#
# Uncommitted changes are invisible to `mars release` — the pipeline re-queues
# the task and a fresh worker would start from the committed state, losing
# any un-committed work.  No journal entries is a signal that the session
# produced no recorded progress, which may confuse the operator.
#
# Both warnings are advisory only.  This hook ALWAYS exits 0; it never
# prevents a session from ending.

set -u

# ── Guard: only activate inside a Mars-leased worktree ───────────────────────
case "${CLAUDE_PROJECT_DIR:-}" in
  */.mars/worktrees/*) ;;
  *) exit 0 ;;
esac

task_id="$(basename "$CLAUDE_PROJECT_DIR")"
worktrees_dir="$(dirname "$CLAUDE_PROJECT_DIR")"
state_dir="$(dirname "$worktrees_dir")"
repo_root="$(dirname "$state_dir")"

# mars CLI is required; fail open if absent.
command -v mars >/dev/null 2>&1 || exit 0

# Only warn for leased (awaiting-human) tasks.
task_output="$(mars --repo "$repo_root" task show "$task_id" 2>/dev/null)" || exit 0
[ -z "$task_output" ] && exit 0

case "$task_output" in
  *"awaiting-human"*) ;;
  *) exit 0 ;;
esac

warned=0

# ── Check 1: uncommitted changes ─────────────────────────────────────────────
dirty="$(git -C "$CLAUDE_PROJECT_DIR" status --porcelain 2>/dev/null)"
if [ -n "$dirty" ]; then
  cat >&2 <<WARN
[mars] WARNING: session ending with uncommitted changes in leased worktree.
       Task: $task_id

       Uncommitted work is invisible to 'mars release' and will be lost once
       the pipeline re-queues the task and a fresh worker starts.

       Commit before releasing:
         git add -A && git commit -m "wip: ..."
         mars --repo "$repo_root" release $task_id
WARN
  warned=1
fi

# ── Check 2: no journal entries recorded ─────────────────────────────────────
case "$task_output" in
  *"--- journal"*)
    # At least one journal entry exists — good.
    ;;
  *)
    cat >&2 <<WARN
[mars] WARNING: no progress journal entries recorded for task $task_id.
       The operator and the pipeline have no record of what was done.

       Log progress before releasing:
         mars --repo "$repo_root" task note $task_id "<what you did>"
WARN
    warned=1
    ;;
esac

# ── Summary hint when either check fired ─────────────────────────────────────
if [ "$warned" -eq 1 ]; then
  cat >&2 <<HINT
[mars] When ready:
         mars --repo "$repo_root" release $task_id           # continue pipeline
         mars --repo "$repo_root" release $task_id --abort   # bail out
HINT
fi

exit 0
