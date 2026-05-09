// Self-heal artifact for task 0b46d264 (re-confirmation pass).
//
// Context: task 0b46d264 produced real work that landed on main. Its branch
// tip (23a7d2295f1c232c378cb080f733a3add590aad3, "fix(orchestrator): clear
// blocker_id on retry-budget drop and add mars unblock") is already an
// ancestor of main (5 behind, 0 ahead). The queue.db row for 0b46d264 is
// no longer present — it has been purged in a prior cleanup pass — so
// neither prescribed path is actionable here:
//
//   (a) Land branch into main: invalid. The branch is already an ancestor
//       of main; `git log main..task/0b46d264` is empty. There is nothing
//       to fast-forward.
//   (b) Flip queue.db row to status='failed' with explanatory error:
//       invalid. There is no row to update.
//
// The desync is also already documented in two open inbox items in
// .mars/state.db (kept across self-heal passes by fingerprint dedupe):
//
//   - 10ea8083 (kind=desync-undecidable, raised 2026-05-09T05:13:12Z)
//   - 9224d89b (kind=desync-self-heal-ambiguous, raised 2026-05-09T05:14:56Z)
//
// A prior self-heal pass (commit 5c96491) already raised the inbox via a
// dedicated raise script. Raising another inbox item from this pass would
// produce nothing new — `raiseInboxItem` would dedupe by fingerprint and
// just bump `seen_count` / `last_seen_at` — at the cost of more chatter
// in the daemon. We therefore intentionally leave the inbox alone.
//
// Investigation summary:
//   - git rev-list --left-right --count main...task/0b46d264 → "5  0"
//   - git merge-base main task/0b46d264 → 23a7d22 (== branch tip)
//   - git log main..task/0b46d264 → empty
//   - sqlite3 .mars/queue.db "SELECT ... WHERE id LIKE '%0b46d264%'" → no row
//   - sqlite3 .mars/state.db inbox_items LIKE '%0b46d264%' → 2 open items
//
// Action taken:
//   - No git operations on task/0b46d264 (branch is already in main).
//   - No queue.db edit (row already purged).
//   - No new inbox item (existing items already cover the case).
//   - Worktree NOT removed (per self-heal task instructions).
//
// Re-running this script is a no-op; it exists purely as a commit artifact
// so the orchestrator has something to fast-forward from this self-heal
// worktree.

export const SELF_HEAL_WORKTREE = "mars-a9bd954e";
export const TARGET_TASK_ID = "0b46d264";
export const TARGET_BRANCH = "task/0b46d264";
export const TARGET_BRANCH_TIP = "23a7d2295f1c232c378cb080f733a3add590aad3";
export const PRIOR_INBOX_ITEM_IDS = ["10ea8083", "9224d89b"] as const;
export const PRIOR_SELF_HEAL_COMMIT = "5c96491";
export const REFRESHED_AT = "2026-05-09";
