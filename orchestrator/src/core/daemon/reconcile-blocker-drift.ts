/**
 * Startup reconciler: finds tasks that are in status='queued' but still have
 * incomplete blocker edges and demotes them back to 'blocked'.
 *
 * INVARIANT (CLAUDE.md § Blockers):
 *   A task MUST NOT be in status='queued' while any of its task_blockers
 *   edges points to a non-'done' task.
 *
 * This module is the catch-all safety net. It runs early in daemon startup —
 * before the reconcile loop re-seeds the dispatch queue — so the dispatcher
 * never encounters incorrectly-queued rows during the boot burst. Promotion
 * paths (Arc.unblockByCompletion, promoteDraftToQueued) already gate on this
 * invariant; this sweep repairs any drift that slipped through (e.g. due to
 * a crash between the blocker check and the status write, or a code bug in a
 * non-standard promotion path).
 */

import { Arc } from '../arc'
import { hasIncompleteBlockers, listTasks, updateTask } from '../queue'
import { getDefaultDomainTaskStore, runCompositionRootMigrations } from '../store/task-store'

/**
 * Scan all `queued` tasks and demote any that still have incomplete blocker
 * edges back to `blocked`. Returns the IDs of tasks that were demoted.
 *
 * Idempotent: running it on a clean queue produces an empty result with no
 * side effects.
 */
export const repairQueuedWithIncompleteBlockers = async (): Promise<string[]> => {
  await runCompositionRootMigrations()
  const queued = await listTasks('queued')
  const demoted: string[] = []

  for (const t of queued) {
    if (await hasIncompleteBlockers(t.id)) {
      await updateTask(t.id, { status: 'blocked' }).catch(() => {})
      demoted.push(t.id)
    }
  }

  return demoted
}

/**
 * Scan for origins stranded in `blocked` behind their OWN failed recovery Chore
 * and fail each one, so the operator can `mars restart` / `mars purge` it.
 *
 * The live path (`Arc.failStrandedOriginOnRecoveryFailure`, driven by the
 * blocker-resolution subscriber on `task.terminal { reason: 'failed' }`) handles
 * this going forward. This sweep is the catch-all for rows that were stranded
 * BEFORE that path existed, or by a crash between the recovery's failure and the
 * subscriber draining — the same "a crash never strands dependents permanently"
 * guarantee the queued-with-incomplete-blockers repair above provides.
 *
 * Scope is deliberately narrow — only the origin↔its-own-recovery edge
 * (`task_blockers.blocker_task_id = <recovery>` AND
 * `recovery.fix_for_task_id = <origin>`), which ADR-0040 names as the single
 * legitimate blocker edge involving a recovery task. A task blocked on an
 * ordinary failed prerequisite keeps waiting: the failure does not cascade.
 *
 * Returns the ids of the origins that were failed. Idempotent: a second pass
 * finds nothing because the rows are no longer `blocked`.
 */
export const failOriginsStrandedOnFailedRecovery = async (): Promise<string[]> => {
  await runCompositionRootMigrations()
  const store = getDefaultDomainTaskStore()

  const rows = await store.query({
    sql: `SELECT DISTINCT origin.id AS id
            FROM tasks origin
            JOIN task_blockers b ON b.task_id = origin.id
            JOIN tasks recovery ON recovery.id = b.blocker_task_id
           WHERE origin.status = 'blocked'
             AND recovery.status = 'failed'
             AND recovery.fix_for_task_id = origin.id
             AND b.state IN ('confirmed', 'pending-review')`,
  })

  const failed: string[] = []
  for (const row of rows.rows) {
    const originId = (row as unknown as { id: string }).id
    // Re-resolve the recovery through the aggregate rather than trusting the
    // join: the write funnel re-checks both endpoints and owns the transition.
    const recoveryRows = await store.query({
      sql: `SELECT id FROM tasks
             WHERE fix_for_task_id = ? AND status = 'failed'
             ORDER BY created_at DESC
             LIMIT 1`,
      args: [originId],
    })
    const recoveryId = (recoveryRows.rows[0] as unknown as { id: string } | undefined)?.id
    if (!recoveryId) continue
    // `main-commiter` recoveries are excluded inside the write funnel (their
    // dead-committer release path re-queues the source instead) — the call below
    // is a no-op for them, so no filter is needed here.
    const result = await Arc.failStrandedOriginOnRecoveryFailure(recoveryId).catch(
      () => null,
    )
    if (result?.outcomes.some((o) => o.outcome === 'failed')) failed.push(originId)
  }

  return failed
}
