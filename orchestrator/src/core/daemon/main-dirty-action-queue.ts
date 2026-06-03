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
import { raiseActionQueueItem, supersedeActionQueueItemsForOrigin } from '../lib/action-queue'
import { getDefaultTaskStore } from '../store/task-store'
import { MAIN_COMMITER_RECIPE } from '../lib/main-dirty'
import { buildEventInsert } from '../lib/outbox'
import { internalBus } from '../../internal-bus'

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
 * because of this committer. Each dependent's `task_blockers` edge pointing at
 * `committerTaskId` is deleted; if no other active (non-terminal) blocker
 * remains the task is flipped from `blocked` back to `queued` so it can
 * re-dispatch once the operator cleans main.
 *
 * This prevents the deadlock where a permanently-failed committer left its
 * dependents blocked forever. The companion fix in `main-dirty.ts` (removing
 * `'failed'` from `ACTIVE_COMMITTER_STATUSES`) ensures new tasks at dispatch
 * time also never attach to a failed committer — they always spawn a fresh one.
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
): Promise<void> => {
  const s = await getDefaultTaskStore()
  const now = new Date().toISOString()

  // Find all tasks currently `blocked` on this committer.
  const r = await s.query({
    sql: `SELECT t.id AS id
            FROM task_blockers tb
            JOIN tasks t ON t.id = tb.task_id
           WHERE tb.blocker_task_id = ?
             AND t.status = 'blocked'`,
    args: [committerTaskId],
  })

  const dependents = r.rows as unknown as Array<{ id: string }>
  if (dependents.length === 0) return

  let released = 0

  for (const row of dependents) {
    const flipped = await s.atomic(async (scope) => {
      // Remove the dead committer's blocker edge. Within this transaction the
      // deletion is immediately visible to the subquery in the UPDATE below.
      await scope.execute({
        sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
        args: [row.id, committerTaskId],
      })
      // Re-queue only when no other non-terminal blocker still exists.
      const upd = await scope.execute({
        sql: `UPDATE tasks
                 SET updated_at = ?, status = 'queued'
               WHERE id = ? AND status = 'blocked'
                 AND NOT EXISTS (
                   SELECT 1
                     FROM task_blockers b
                     JOIN tasks t2 ON t2.id = b.blocker_task_id
                    WHERE b.task_id = ?
                      AND t2.status NOT IN ('done', 'failed')
                      AND b.state IN ('confirmed', 'pending-review')
                 )`,
        args: [now, row.id, row.id],
      })
      const didFlip = (upd.rowsAffected ?? 0) > 0
      if (didFlip) {
        await scope.execute(
          buildEventInsert('task.unblocked', {
            taskId: row.id,
            blockerTaskId: committerTaskId,
          }),
        )
      }
      return didFlip
    })
    if (flipped) {
      internalBus().emit('task.unblocked', {
        taskId: row.id,
        blockerTaskId: committerTaskId,
      })
      released++
      log(
        `[main-dirty] re-queued task ${row.id} released from failed committer ${committerTaskId}`,
      )
    } else {
      log(
        `[main-dirty] task ${row.id}: committer edge removed but other active blockers remain; left in blocked`,
      )
    }
  }

  log(
    `[main-dirty] released ${released}/${dependents.length} dependent(s) from failed committer ${committerTaskId}`,
  )
}
