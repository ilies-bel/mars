// Self-heal artifact for task 0b10d6a9 (first re-confirmation pass).
//
// Context: task 0b10d6a9 was killed by a daemon restart while running, before
// it could produce any commits or signal rows (queue.db.task_signals has no
// entries for this task id; tasks.error already reads "daemon restart while
// task was running"). Its branch task/0b10d6a9 still exists, but its tip
// (d3322b550388da6b7cd8e30959960c27262136d4) is just an existing main commit
// ("feat(orchestrator): write per-scope AGENTS.md from mars init") that
// predates the worktree — the branch ref never advanced.
//
// The sweeper desync detector flags this as "merged=true, mars=failed" because
// ancestor-of-main holds trivially when the branch tip is itself an old main
// commit. This is the same "never-advanced branch" pattern as task 0451b2bb
// (see commits df8a1af, 8d73825 and orchestrator/scripts/refresh-desync-
// 0451b2bb.ts / inbox-raise-desync-0451b2bb.ts).
//
// Resolution chosen: path (b) — keep status='failed' and refresh tasks.error
// with the up-to-date desync rationale so the row is self-explanatory and any
// future refire of this self-heal can no-op cleanly. Path (a) (rebase + ff)
// is wrong here for the same reason as 0451b2bb: best case no-op (already an
// ancestor of main), worst case rewinds main to an older SHA.
//
// Investigation summary (2026-05-09):
//   - git log main..task/0b10d6a9       → empty (no work on the branch)
//   - git log task/0b10d6a9..main       → 35+ commits at refresh time
//   - git merge-base task/0b10d6a9 main → equals task/0b10d6a9 tip exactly
//   - queue.db tasks.status             → 'failed' (unchanged)
//   - queue.db task_signals             → no rows for this task id
//   - .mars/worktrees/0b10d6a9          → present, clean, on task/0b10d6a9
//
// Action taken:
//   - queue.db tasks.error refreshed with the desync analysis and a pointer
//     to the follow-up sweeper fix task (mars-b24ea96a).
//   - tasks.status left at 'failed' (no flip).
//   - No git operations on task/0b10d6a9 (intentionally — landing is wrong).
//   - Worktree NOT removed (per self-heal task instructions).
//   - No new inbox row raised: the row exists, the error column is clear,
//     and the underlying refire loop is already tracked by the existing
//     follow-up task (mars-b24ea96a) and its escalation inbox row 9e4603ea.
//
// Re-running this script is a no-op; it exists purely as a commit artifact so
// the orchestrator has something to fast-forward from this self-heal worktree.

export const SELF_HEAL_TASK_ID = "mars-389fcf08";
export const TARGET_TASK_ID = "0b10d6a9";
export const TARGET_BRANCH = "task/0b10d6a9";
export const BRANCH_TIP = "d3322b550388da6b7cd8e30959960c27262136d4";
export const FOLLOW_UP_TASK_ID = "mars-b24ea96a";
export const REFRESHED_AT = "2026-05-09";
