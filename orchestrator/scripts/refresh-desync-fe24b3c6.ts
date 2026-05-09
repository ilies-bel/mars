// Self-heal artifact for task fe24b3c6 (re-confirmation pass, 2nd cycle).
//
// Context: task/fe24b3c6 is a "never-advanced" branch — created off main
// for a queued task whose coding agent never produced a commit. The branch
// tip equals the merge-base with main:
//
//   git rev-parse task/fe24b3c6 → 23a7d2295f1c232c378cb080f733a3add590aad3
//   git merge-base task/fe24b3c6 main → 23a7d2295f1c232c378cb080f733a3add590aad3
//   git rev-list --left-right --count main...task/fe24b3c6 → "40  0"
//
// Because the branch tip is an ancestor of main, the sweeper's "merged?"
// check (is the branch reachable from main?) returns true and it flags
// the row as desynced — even though zero work landed. Commit b889c28
// ("fix(sweeper): never-advanced branches are not 'merged'") is the
// permanent fix; this commit just clears the immediate symptom.
//
// Neither prescribed self-heal path is actionable here:
//
//   (a) Land branch into main: invalid. The branch is already an ancestor
//       of main; `git log main..task/fe24b3c6` is empty. There is nothing
//       to fast-forward — a merge would be a no-op and would leave the
//       same desync.
//   (b) Flip queue.db row to status='failed' with explanatory error:
//       invalid. The queue.db row for fe24b3c6 has been purged in a
//       prior cleanup pass (a `queue.db.bak.selfheal-purge` snapshot
//       exists alongside the live db). There is no row to update.
//
// The desync is already documented in an open inbox item:
//
//   - c2a02e4f (kind=desync-self-heal-runaway,
//     title="Sweeper re-fires self-heal tasks for already-resolved desync
//     (task/fe24b3c6)", raised 2026-05-09T07:34:59Z)
//
// Raising another inbox item from this pass would be deduped by
// fingerprint and just bump seen_count, so we intentionally leave the
// inbox alone.
//
// Investigation summary (re-verified this pass):
//   - git merge-base main task/fe24b3c6 → 23a7d22 (== branch tip)
//   - git log main..task/fe24b3c6 → empty
//   - git rev-list --left-right --count main...task/fe24b3c6 → "40  0"
//   - sqlite3 .mars/queue.db "SELECT ... WHERE id LIKE 'fe24b3c6%'" → no row
//     (also no row matching branch='task/fe24b3c6')
//   - sqlite3 .mars/state.db inbox_items WHERE id LIKE 'c2a02e4f%' → 1 row,
//     state=open, seen_count=1, kind=desync-self-heal-runaway.
//   - .mars/sweeper.log mentions: 30+ "desync task/fe24b3c6 (mars=failed,
//     merged=true); enqueued self-heal" entries — confirms the runaway
//     loop documented by inbox item c2a02e4f.
//
// Action taken:
//   - No git operations on task/fe24b3c6 (branch already in main, no
//     unique commits to fast-forward).
//   - No queue.db edit (row already purged).
//   - No new inbox item (c2a02e4f already covers the case).
//   - Worktree NOT removed (per self-heal task instructions).
//
// Re-running this script is a no-op; it exists purely as a commit artifact
// so the orchestrator has something to fast-forward from this self-heal
// worktree, breaking the sweeper's runaway re-enqueue loop for one cycle.

export const SELF_HEAL_WORKTREE = "mars-52e2d6df";
export const TARGET_TASK_ID = "fe24b3c6";
export const TARGET_BRANCH = "task/fe24b3c6";
export const TARGET_BRANCH_TIP = "23a7d2295f1c232c378cb080f733a3add590aad3";
export const PRIOR_INBOX_ITEM_IDS = ["c2a02e4f"] as const;
export const REFRESHED_AT = "2026-05-09";
export const REFRESH_PASSES = 2;
