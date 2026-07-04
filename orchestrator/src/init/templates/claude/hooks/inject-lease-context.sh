#!/usr/bin/env bash
# SessionStart hook: inject task context when opening a Claude Code session
# inside a Mars-leased worktree (.mars/worktrees/<task-id>/).
#
# If the worktree belongs to an active lease (status 'awaiting-human'), this
# script emits structured context to stdout so Claude receives it as part of
# its session context — task id, intent, done-criteria with check state, the
# last 10 progress journal entries, and the Foreground-session discipline rules.
#
# Uses the `mars` CLI for all task-data queries; never reads mars.db directly.
# Always exits 0 — must never block a session from starting.

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

# mars CLI is required; fail open if it's absent so the hook never blocks a
# session from starting.
command -v mars >/dev/null 2>&1 || exit 0

# ── Query task data ───────────────────────────────────────────────────────────
task_output="$(mars --repo "$repo_root" task show "$task_id" 2>/dev/null)" || exit 0
[ -z "$task_output" ] && exit 0

# Only inject context for leased (awaiting-human) tasks.  A task that is not
# leased yet (e.g. someone manually opened a session in a queued-task worktree)
# does not warrant the lease-discipline reminder.
case "$task_output" in
  *"awaiting-human"*) ;;
  *) exit 0 ;;
esac

# ── Emit context to stdout ────────────────────────────────────────────────────
cat <<CONTEXT
━━━ Mars Lease Context ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are working inside a Mars-leased worktree.

Task: $task_id
Repo: $repo_root

$task_output

━━━ Foreground-session discipline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You hold the lease on this worktree.  Follow these rules:

  • Journal progress at each milestone (keeps the pipeline informed):
      mars --repo "$repo_root" task note $task_id "<what you did>"

  • Check off done-criteria as you complete them (1-based index):
      mars --repo "$repo_root" task check $task_id <n>

  • Commit your changes as you go so nothing is lost on release:
      git add -A && git commit -m "<message>"

  • When you finish, release the lease so the pipeline continues:
      mars --repo "$repo_root" release $task_id

  • If you need to abandon the work, bail out explicitly:
      mars --repo "$repo_root" release $task_id --abort

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT

exit 0
