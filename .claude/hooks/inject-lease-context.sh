#!/usr/bin/env bash
# SessionStart hook: inject task context when opening a Claude Code session
# inside a Mars-leased worktree (.mars/worktrees/<task-id>/).
#
# If the worktree belongs to an active lease (status 'awaiting-human'), this
# script emits structured context to stdout so Claude receives it as part of
# its session context — task id, intent, done-criteria with check state, the
# last 10 progress journal entries, the current Step guide (stepName +
# leaseNote from the action-queue row), and the Foreground-session discipline
# rules using the step-done vocabulary.
#
# Uses the `mars` CLI for task-data queries; reads action_queue_items and
# tasks from mars.db via sqlite3 for the Step guide (read-only, never writes).
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

# ── Query the Step guide from the action queue ───────────────────────────────
# The action_queue_items row for this task carries the pipeline's per-step
# instructions: stepName (which step) and leaseNote (what to do in this step).
# Falls back to tasks.lease_note if no action-queue row is present yet.
# Fail open — the guide is advisory and the hook must never block.
step_name=""
step_note=""
mars_db="$state_dir/mars.db"
if [ -f "$mars_db" ] && command -v sqlite3 >/dev/null 2>&1; then
  safe_id="$(printf '%s' "$task_id" | tr -cd 'a-zA-Z0-9-')"
  aq_row="$(sqlite3 "$mars_db" \
    "SELECT COALESCE(json_extract(payload,'$.stepName'),''), COALESCE(json_extract(payload,'$.leaseNote'),'') FROM action_queue_items WHERE kind='awaiting-human' AND state='open' AND origin_task_id='$safe_id' ORDER BY raised_at DESC LIMIT 1" \
    2>/dev/null)" || true
  if [ -n "$aq_row" ]; then
    step_name="${aq_row%%|*}"
    step_note="${aq_row#*|}"
  fi
  # Fallback: read lease_note from the tasks table when no action-queue row exists yet.
  if [ -z "$step_name" ] && [ -z "$step_note" ]; then
    step_note="$(sqlite3 "$mars_db" \
      "SELECT COALESCE(lease_note,'') FROM tasks WHERE id='$safe_id' LIMIT 1" \
      2>/dev/null)" || step_note=""
  fi
fi

# ── Emit context to stdout ────────────────────────────────────────────────────
cat <<CONTEXT
━━━ Mars Lease Context ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are working inside a Mars-leased worktree.

Task: $task_id
Repo: $repo_root

$task_output
CONTEXT

if [ -n "$step_name" ] || [ -n "$step_note" ]; then
  printf '\n'
  [ -n "$step_name" ] && printf '━━━ Step guide: %s ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' "$step_name" \
                       || printf '━━━ Step guide ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  printf '\n'
  [ -n "$step_note" ] && printf '%s\n' "$step_note"
  printf '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
fi

cat <<DISCIPLINE

━━━ Foreground-session discipline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You hold the lease on this worktree.  Follow these rules:

  • Journal progress at each milestone (keeps the pipeline informed):
      mars --repo "$repo_root" task note $task_id "<what you did>"

  • Check off done-criteria as you complete them (1-based index):
      mars --repo "$repo_root" task check $task_id <n>

  • Commit your changes as you go so nothing is lost:
      git add -A && git commit -m "<message>"

  • When this step is done, advance the pipeline (lease follows you to the
    next manual step automatically):
      mars --repo "$repo_root" step done $task_id

  • If you need to abandon the work, bail out explicitly:
      mars --repo "$repo_root" release $task_id --abort

  Note: 'mars step done' is the per-step verb — it advances the pipeline and
  re-grants the lease at the next manual park.  'mars release --abort' routes
  the task to the failure path; use it only when the work cannot proceed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DISCIPLINE

exit 0
