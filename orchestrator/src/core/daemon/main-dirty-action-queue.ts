/**
 * Slice F.2: actionQueue-side helpers for `main-commiter` recoveries.
 *
 * Two distinct concerns live here, both keyed off the recovery's
 * `recovery_payload`:
 *
 * 1. `sweepStaleFailedMainCommiterActionQueue`: on committer SUCCESS, scan for
 *    open actionQueue rows raised by previously-failed committer attempts whose
 *    `dirtyMainHash` is no longer the current state of main. Those rows
 *    describe a state that the just-succeeded committer fixed; resolve them
 *    with `SupersedeReason: 'origin-done'`.
 *
 * 2. `raiseAggregatedMainCommiterFailureRow`: on committer FAILURE, raise
 *    one actionQueue row whose body lists every task currently `blocked` on this
 *    committer. Overrides the generic `action-queue-repopulator` row for this
 *    specific recovery so the operator sees the affected cohort at a glance.
 */
import { execFileSync } from 'node:child_process'
import { raiseActionQueueItem, supersedeActionQueueItemsForOrigin } from '../lib/action-queue'
import { getDefaultTaskStore } from '../store/task-store'
import { MAIN_COMMITER_RECIPE } from '../lib/main-dirty'
import { Arc } from '../arc'

/**
 * SQL fragment that matches an open actionQueue row associated with a recovery
 * whose `recovery_payload.recipe = 'main-commiter'`. We can't filter on
 * the action_queue_items table alone (it carries no payload-shape pointer at the
 * recipe level beyond the title/raisedBy strings); the canonical query is
 * a join through the recovery task id stored on the actionQueue row's payload.
 *
 * Implementation note: rather than crack open the actionQueue payload, we use
 * the convention that a `main-commiter` failure actionQueue row records the
 * `recoveryTaskId` in its payload — the same shape the recovery-failed
 * pipeline already uses. We join tasks via that pointer and filter by
 * recipe and a non-matching hash.
 */
const FIND_STALE_COMMITTER_ACTION_QUEUE_ROWS_SQL = `
  SELECT i.id AS actionQueue_id,
         i.origin_task_id AS origin_task_id
    FROM action_queue_items i
    JOIN tasks t
      ON t.id = COALESCE(
           json_extract(i.payload, '$.recoveryTaskId'),
           i.origin_task_id
         )
   WHERE i.state = 'open'
     AND t.kind = 'fix'
     AND json_extract(t.recovery_payload, '$.recipe') = ?
     AND json_extract(t.recovery_payload, '$.dirtyMainHash') != ?
     AND t.status = 'failed'
`

/**
 * Scan for `failed`-committer actionQueue rows whose hash is NOT the freshly-
 * resolved hash, and supersede them with `origin-done`. A clean main
 * after a successful committer means those stale rows describe a state
 * that no longer exists.
 *
 * `freshHash` is the hash carried on the just-succeeded committer's
 * `recovery_payload`. Empty-string hash is a degenerate case (the diff
 * compute failed during spawn); we still run the sweep, comparing
 * against `""`, which simply matches no other row.
 *
 * The function is idempotent: rerunning when no stale rows exist is a
 * silent no-op.
 */
export const sweepStaleFailedMainCommiterActionQueue = async (
  freshHash: string,
  freshRecoveryTaskId: string,
  log: (msg: string) => void,
): Promise<void> => {
  const s = await getDefaultTaskStore()
  const r = await s.query({
    sql: FIND_STALE_COMMITTER_ACTION_QUEUE_ROWS_SQL,
    args: [MAIN_COMMITER_RECIPE, freshHash],
  })
  if (r.rows.length === 0) return
  const seenOrigins = new Set<string>()
  for (const row of r.rows as unknown as Array<{
    actionQueue_id: string
    origin_task_id: string | null
  }>) {
    if (row.origin_task_id === null || row.origin_task_id.length === 0) continue
    if (seenOrigins.has(row.origin_task_id)) continue
    seenOrigins.add(row.origin_task_id)
    const closed = await supersedeActionQueueItemsForOrigin(
      row.origin_task_id,
      'origin-done',
      `daemon:main-commiter-success:${freshRecoveryTaskId}`,
    )
    if (closed.length > 0) {
      log(
        `[main-dirty] swept ${closed.length} stale failed-committer actionQueue row(s) tied to origin ${row.origin_task_id} after committer ${freshRecoveryTaskId} succeeded`,
      )
    }
  }
}

/**
 * On committer FAILURE, raise a single aggregated actionQueue row that lists
 * every task currently blocked on this committer. Overrides the generic
 * `action-queue-repopulator` shape for this kind of failure so the operator
 * sees the cohort at a glance.
 *
 * Cohort enumeration: query `task_blockers WHERE blocker_task_id =
 * <committer-id>` and resolve each `task_id` to its `(id, prompt,
 * status)`. The dependent count drives the title's `N tasks blocked`
 * suffix; status of each dependent is rendered alongside the id so the
 * operator can tell which are still parked vs. cleared by some other
 * path.
 *
 * Idempotent on the committer task id (signature keys on it). A repeated
 * failure of the same recovery bumps `seenCount` rather than inserting
 * a duplicate row.
 */
export const raiseAggregatedMainCommiterFailureRow = async (
  recoveryTaskId: string,
  log: (msg: string) => void,
): Promise<string | null> => {
  const s = await getDefaultTaskStore()
  const cohort = await s.query({
    sql: `SELECT t.id AS id, t.prompt AS prompt, t.status AS status
            FROM task_blockers tb
            JOIN tasks t ON t.id = tb.task_id
           WHERE tb.blocker_task_id = ?
           ORDER BY t.created_at ASC`,
    args: [recoveryTaskId],
  })
  // Resolve the committer row to extract payload + origin for context.
  const fixRow = await s.query({
    sql: `SELECT origin_id, recovery_payload, error FROM tasks WHERE id = ?`,
    args: [recoveryTaskId],
  })
  if (fixRow.rows.length === 0) {
    log(`[main-dirty] aggregated-row: committer ${recoveryTaskId} not found; skipping actionQueue raise`)
    return null
  }
  const fix = fixRow.rows[0] as unknown as {
    origin_id: string
    recovery_payload: string | null
    error: string | null
  }
  const dependents = cohort.rows as unknown as Array<{
    id: string
    prompt: string | null
    status: string
  }>
  const n = dependents.length
  const title =
    n === 0
      ? `main-committer failed — no tasks currently blocked`
      : `main-committer failed — ${n} task${n === 1 ? '' : 's'} blocked`
  const cohortLines =
    dependents.length === 0
      ? ['(no tasks currently waiting on this committer)']
      : dependents.map((d) => {
          const summary =
            d.prompt && d.prompt.length > 0
              ? d.prompt.replace(/\s+/g, ' ').slice(0, 80)
              : '(no prompt)'
          return `- \`${d.id}\` [${d.status}] — ${summary}`
        })
  const body = [
    `Recovery task \`${recoveryTaskId}\` (recipe: \`${MAIN_COMMITER_RECIPE}\`) failed.`,
    `The orchestrator will not retry it (recovery budget is 0 — see ADR-0002).`,
    '',
    `Tasks currently blocked on this committer (${n}):`,
    '',
    ...cohortLines,
    '',
    fix.error ? `Last committer error (truncated):\n\`\`\`\n${fix.error}\n\`\`\`` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')

  const actionQueueItemId = await raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title,
    body,
    payload: {
      recoveryTaskId,
      recipe: MAIN_COMMITER_RECIPE,
      cohort: dependents.map((d) => ({
        taskId: d.id,
        status: d.status,
      })),
    },
    context: {
      repoRoot: process.env.MARS_REPO ?? null,
    },
    raisedBy: 'daemon:main-commiter-failed',
    // Signature keys on the committer task id so repeat failures of the
    // same recovery (theoretically impossible — recovery budget is 0 —
    // but the test path may re-mark a fix as failed) dedupe on the row.
    signature: `main-commiter:${recoveryTaskId}`,
    originTaskId: fix.origin_id,
    occurrence: {
      at: new Date().toISOString(),
      recoveryTaskId,
      dependentCount: n,
    },
  })
  log(
    `[main-dirty] aggregated-row: raised actionQueue ${actionQueueItemId} for failed committer ${recoveryTaskId} with ${n} blocked dependent(s)`,
  )
  return actionQueueItemId
}

/**
 * On committer FAILURE, release every task that is currently blocked solely
 * because of this committer — BUT only when main is actually clean.
 *
 * Precondition check: runs `git status --porcelain` in `repoRoot`. If main is
 * still dirty, releasing dependents would immediately re-park them behind a
 * NEW committer (they re-detect dirty main at dispatch → spawn fresh committer →
 * block → new committer fails → loop). Instead, keep dependents blocked and
 * rely on the operator action-queue item already raised by
 * `raiseAggregatedMainCommiterFailureRow` to surface the problem.
 *
 * When main IS clean (the committer failure raced with a concurrent merge that
 * happened to clean the branch), release proceeds as before: each dependent's
 * `task_blockers` edge to `committerTaskId` is deleted; tasks with no remaining
 * active blockers are flipped from `blocked` back to `queued`.
 *
 * Tasks with other active blockers (besides the failed committer) have their
 * committer edge removed but remain in `blocked` state, waiting for those
 * other prerequisites.
 *
 * Idempotent: a second call finds no edges or no blocked rows and is a no-op.
 */
export const releaseMainCommitterDependents = async (
  committerTaskId: string,
  log: (msg: string) => void,
  repoRoot: string,
): Promise<void> => {
  // Guard: verify main is clean before releasing dependents. A failed committer
  // over a still-dirty main must NOT re-queue dependents — they would re-detect
  // dirty main, park behind a new committer, and repeat until retry budgets
  // are exhausted. Keep them blocked; the operator action-queue item already
  // raised by raiseAggregatedMainCommiterFailureRow tells the human what happened.
  if (!repoRoot) {
    log(
      `[main-dirty] committer ${committerTaskId}: repoRoot not set; keeping dependents blocked for safety`,
    )
    return
  }
  let mainIsDirty: boolean
  try {
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    mainIsDirty = statusOutput.trim().length > 0
  } catch (err) {
    // Cannot check git status — err on the side of caution.
    log(
      `[main-dirty] committer ${committerTaskId}: could not check git status at ${repoRoot}: ${(err as Error).message}; keeping dependents blocked`,
    )
    return
  }

  if (mainIsDirty) {
    log(
      `[main-dirty] committer ${committerTaskId} failed and main is still dirty; dependents kept blocked — operator must resolve`,
    )
    return
  }

  // Main is clean. ADR-0052 sole-writer: the status write (blocked -> queued),
  // the edge delete, and the task.unblocked emit all live in the Arc aggregate.
  // This is a thin delegating wrapper with no task-table write of its own.
  await Arc.releaseMainCommitterDependents(committerTaskId, log)
}
