// Self-heal artifact for task 0f203b55 (re-confirmation pass; same worktree
// mars-01132135 as the original raise).
//
// Context: task 0f203b55 was conservatively flipped to status='failed' on a
// daemon restart while it was running. Its branch tip
// (d3322b550388da6b7cd8e30959960c27262136d4, "feat(orchestrator): write
// per-scope AGENTS.md from mars init") is already an ancestor of main
// (38 behind, 0 ahead). The queue.db row for 0f203b55 is no longer present —
// it was purged in a prior cleanup pass — so neither prescribed path is
// actionable:
//
//   (a) Land branch into main: invalid. The branch is already an ancestor
//       of main; `git log main..task/0f203b55` is empty. There is nothing
//       to fast-forward.
//   (b) Flip queue.db row to status='failed' with explanatory error:
//       invalid. There is no row to update.
//
// An open inbox item already documents the desync in .mars/state.db
// (kept across self-heal passes by fingerprint dedupe):
//
//   - e8545636 (kind=desync-self-heal-ambiguous,
//               signature='desync-self-heal-ambiguous:0f203b55',
//               raised 2026-05-09T16:07:52.411Z by self-heal:mars-01132135,
//               state=open, seen_count=1)
//
// The prior self-heal pass on this same worktree (commit 7a6112f) already
// raised the inbox via orchestrator/scripts/raise-desync-0f203b55.ts.
// Raising another inbox item from this pass would produce nothing new —
// raiseInboxItem dedupes by fingerprint and would just bump seen_count /
// last_seen_at — at the cost of more chatter on the daemon bus. We
// therefore intentionally leave the inbox alone.
//
// Investigation summary (re-run on 2026-05-09 from worktree mars-01132135):
//   - git rev-list --left-right --count main...task/0f203b55 → "38  0"
//   - git rev-parse task/0f203b55 → d3322b55...
//   - git merge-base task/0f203b55 main → d3322b55... (== branch tip)
//   - git log main..task/0f203b55 → empty
//   - sqlite3 .mars/queue.db "SELECT count(*) FROM tasks WHERE id LIKE
//     '0f203b55%'" → 0
//   - sqlite3 .mars/state.db inbox_items WHERE
//     signature='desync-self-heal-ambiguous:0f203b55' → 1 open item
//     (id e8545636, raised by self-heal:mars-01132135)
//
// Action taken:
//   - No git operations on task/0f203b55 (branch is already in main).
//   - No queue.db edit (row already purged).
//   - No new inbox item (existing item e8545636 already covers the case).
//   - Worktree NOT removed (per self-heal task instructions).
//
// Re-running this script is a no-op; it exists purely as a commit artifact
// so the orchestrator has something to fast-forward from this self-heal
// worktree's second pass on this task.

export const SELF_HEAL_WORKTREE = 'mars-01132135'
export const TARGET_TASK_ID = '0f203b55'
export const TARGET_BRANCH = 'task/0f203b55'
export const TARGET_BRANCH_TIP =
  'd3322b550388da6b7cd8e30959960c27262136d4'
export const PRIOR_INBOX_ITEM_IDS = ['e8545636'] as const
export const PRIOR_SELF_HEAL_COMMIT = '7a6112f'
export const REFRESHED_AT = '2026-05-09'
