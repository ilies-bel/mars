// Self-heal artifact for task 0e287883 (re-confirmation pass).
//
// Context: 0e287883 is a never-advanced-branch + purged-row desync. The
// branch tip (d3322b550388da6b7cd8e30959960c27262136d4, "feat(orchestrator):
// write per-scope AGENTS.md from mars init") is itself a pre-existing main
// commit that predates the task by hours. The branch ref never advanced
// past its base, and the queue.db row was purged from the live store in
// an earlier sweep (preserved in `.mars/queue.db.bak.selfheal-purge` with
// status='failed', error='daemon restart while task was running').
//
// A prior self-heal pass (commit 48b78e7) already raised inbox item
// 6547339c via `orchestrator/scripts/inbox-raise-desync-0e287883.ts`. That
// row remains open in `.mars/state.db` with a complete diagnosis and a
// pointer to the underlying sweeper fix (mars-b24ea96a, also absent from
// live queue.db; only present as 'queued' in the .bak).
//
// Neither prescribed path is actionable here:
//
//   (a) Land branch into main: invalid. `git log main..task/0e287883` is
//       empty (0 ahead, ~29 behind). The branch tip is already an existing
//       main commit. Rebase + ff is a no-op at best, and would risk
//       rewinding main.
//   (b) Flip queue.db row to status='failed' with explanatory error:
//       invalid. The live row is absent. UPDATE on the missing row is a
//       silent no-op. Re-INSERTing the row would just retrigger the
//       desync detector on the next sweeper tick.
//
// Re-raising the inbox row from this pass would produce nothing new —
// `raiseInboxItem` would dedupe by fingerprint
// (signature='desync:0e287883:d3322b550388da6b7cd8e30959960c27262136d4')
// and just bump seen_count / last_seen_at — at the cost of more chatter in
// the daemon. We therefore intentionally leave the inbox alone, matching
// the convention used for 0b46d264, 0b10d6a9, 0d424006, etc.
//
// Investigation summary (2026-05-09 second pass):
//   - git rev-parse task/0e287883      → d3322b55...
//   - git rev-parse main               → dd6644cb...
//   - git log main..task/0e287883      → empty (0 ahead)
//   - git log task/0e287883..main      → 29 commits (29 behind)
//   - git merge-base task/0e287883 main → equals task/0e287883 tip exactly
//   - .mars/queue.db tasks WHERE id LIKE '0e287883%' → no rows (live row
//     absent; row preserved in queue.db.bak.selfheal-purge as 'failed')
//   - .mars/state.db inbox_items WHERE payload LIKE '%0e287883%' →
//     6547339c open since 2026-05-09T16:04:59Z, seen_count=1
//   - .mars/queue.db tasks WHERE id LIKE 'mars-b24ea96a%' → no rows (the
//     follow-up sweeper fix is itself absent from live queue.db; only
//     'queued' in queue.db.bak.selfheal-purge)
//
// Action taken:
//   - No git operations on task/0e287883 (branch landing is wrong here).
//   - No queue.db edit (live row already purged).
//   - No new inbox item (6547339c already covers the case verbatim).
//   - Worktree NOT removed (per self-heal task instructions).
//
// Re-running this script is a no-op; it exists purely as a commit artifact
// so the orchestrator has something to fast-forward from this self-heal
// worktree.

export const SELF_HEAL_WORKTREE = 'mars-b44de1de'
export const TARGET_TASK_ID = '0e287883'
export const TARGET_BRANCH = 'task/0e287883'
export const TARGET_BRANCH_TIP =
  'd3322b550388da6b7cd8e30959960c27262136d4'
export const PARENT_DESYNC_TASK_ID = '50ed4fa2'
export const FOLLOW_UP_TASK_ID = 'mars-b24ea96a'
export const PRIOR_INBOX_ITEM_IDS = ['6547339c'] as const
export const PRIOR_SELF_HEAL_COMMIT = '48b78e7'
export const REFRESHED_AT = '2026-05-09'
