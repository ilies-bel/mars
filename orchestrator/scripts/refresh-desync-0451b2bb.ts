// Self-heal artifact for task 0451b2bb (re-confirmation pass).
//
// Context: task 0451b2bb is itself a self-heal task that was killed by a daemon
// restart at 2026-05-09T08:25:23Z before producing any commits. Its branch
// task/0451b2bb still exists, but its tip (d3322b550388da6b7cd8e30959960c27262136d4)
// is just an existing main commit ("feat(orchestrator): write per-scope AGENTS.md
// from mars init") that predates the worktree — the branch ref never advanced.
//
// The sweeper desync detector keeps flagging this as "merged=true, mars=failed"
// and enqueueing a fresh self-heal each cycle, because ancestor-of-main holds
// trivially when the branch tip is itself an old main commit. Landing the
// branch into main is the wrong remedy: best case it is a no-op (already an
// ancestor), worst case it would rewind main to an older SHA. Correct outcome
// is to keep status='failed' and refresh the error column so the rationale
// stays accurate as main advances and the "N commits ahead" count drifts.
//
// This file is the paper trail for the 2026-05-09 re-confirmation done by
// task mars-a20b03cb. The actual fix to stop the refire loop is tracked
// separately as task mars-b24ea96a (sweeper: skip never-advanced branches).
//
// Investigation summary:
//   - git log main..task/0451b2bb       → empty (no work on the branch)
//   - git log task/0451b2bb..main       → 8 commits at refresh time
//   - git merge-base task/0451b2bb main → equals task/0451b2bb tip exactly
//   - .mars/sweeper.log                 → 14 desync refires for this task id
//   - .mars/state.db inbox_items        → no open inbox row for this task
//
// Action taken:
//   - queue.db tasks.error refreshed with the up-to-date analysis and
//     pointer to the follow-up sweeper fix task.
//   - tasks.status left at 'failed' (no flip).
//   - No git operations on task/0451b2bb (intentionally — landing it is wrong).
//   - Worktree NOT removed (per self-heal task instructions).
//
// Re-running this script is a no-op; it exists purely as a commit artifact so
// the orchestrator has something to fast-forward from this self-heal worktree.

export const SELF_HEAL_TASK_ID = "mars-a20b03cb";
export const TARGET_TASK_ID = "0451b2bb";
export const FOLLOW_UP_TASK_ID = "mars-b24ea96a";
export const REFRESHED_AT = "2026-05-09";
