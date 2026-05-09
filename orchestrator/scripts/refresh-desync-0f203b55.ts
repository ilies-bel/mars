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
//               state=open, seen_count bumped to 2 on 3rd pass)
//
// The prior self-heal passes on this same worktree (commits 7a6112f and
// 8273324) already raised and re-confirmed the inbox via
// orchestrator/scripts/raise-desync-0f203b55.ts. Raising another inbox item
// from this 3rd pass would produce nothing new — raiseInboxItem dedupes by
// fingerprint. This pass bumps seen_count directly on inbox_items
// (e8545636: 1 -> 2) so the human-curated inbox view reflects the
// continuing sweeper re-fires without spamming the daemon bus.
//
// Investigation summary (3rd pass on 2026-05-09 from worktree mars-01132135):
//   - git rev-list --left-right --count main...task/0f203b55 → 25 ahead, 0 behind
//     (main has advanced 25 more commits since 1st pass; branch still 0 ahead)
//   - git rev-parse task/0f203b55 → d3322b55... (unchanged)
//   - git merge-base --is-ancestor task/0f203b55 main → YES
//   - git log main..task/0f203b55 → empty
//   - sqlite3 .mars/queue.db "SELECT count(*) FROM tasks WHERE id LIKE
//     '0f203b55%'" → 0
//   - sqlite3 .mars/state.db inbox_items WHERE id = 'e8545636' → still open
//     (seen_count bumped 1 -> 2 on this pass)
//
// Action taken:
//   - No git operations on task/0f203b55 (branch is already in main).
//   - No queue.db edit (row already purged).
//   - No new inbox item (existing item e8545636 already covers the case).
//   - Worktree NOT removed (per self-heal task instructions).
//
// Re-running this script is a no-op; it exists purely as a commit artifact
// so the orchestrator has something to fast-forward from this self-heal
// worktree's third pass on this task.

export const SELF_HEAL_WORKTREE = 'mars-01132135'
export const TARGET_TASK_ID = '0f203b55'
export const TARGET_BRANCH = 'task/0f203b55'
export const TARGET_BRANCH_TIP =
  'd3322b550388da6b7cd8e30959960c27262136d4'
export const PRIOR_INBOX_ITEM_IDS = ['e8545636'] as const
export const PRIOR_SELF_HEAL_COMMITS = ['7a6112f', '8273324'] as const
export const REFRESHED_AT = '2026-05-09'
export const PASS_NUMBER = 3
export const INBOX_SEEN_COUNT_AFTER_PASS = 2
