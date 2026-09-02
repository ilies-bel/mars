/**
 * Boot-time reconcile: raise action-queue rows for any task sitting in
 * status='failed' that has no open action-queue row.
 *
 * The invariant "every failed task has an open action-queue row" holds for
 * the happy path (task.blocked → taskBlockedActionQueueRaiser raises a row),
 * but several routes write status='failed' directly without emitting
 * task.blocked:
 *
 *   - diagnose Chore failures (handleTaskFailureWithFixTask's kind='diagnose' branch)
 *   - MARS_RECOVERY_DISABLED=1 (kill-switch early return)
 *   - failStrandedOriginOnRecoveryFailure (called by drainBlockerResolution)
 *   - boot-time strandedOriginRecoveryRepair
 *   - any crash between a status='failed' write and the subscriber raising the row
 *
 * This sweep is the safety net that closes that gap permanently — idempotent,
 * the same defensive shape as orphanedBlockedScan. It is defensive belt-and-
 * suspenders: each of those in-flight paths was also patched to raise its own
 * row, but the sweep heals rows that were stranded before this fix existed and
 * any future crash window.
 */

import { getDefaultDomainTaskStore } from '../store/task-store-default'
import { raiseActionQueueItem } from '../lib/action-queue'

/**
 * Raise an open action-queue row for every task in status='failed' that
 * currently has no open row.
 *
 * Idempotent: {@link raiseActionQueueItem} deduplicates via the origin-keyed
 * fingerprint — a row that already exists has its seen_count bumped and no
 * duplicate is inserted. A second sweep pass therefore produces no new rows
 * when the first pass healed everything.
 *
 * @returns The number of rows newly raised (bumped-seen-count calls do not
 *   count — only INSERT calls).
 */
export const raiseOrphanedFailedTaskRows = async (): Promise<number> => {
  const store = getDefaultDomainTaskStore()

  // Find tasks that are 'failed' and have no open action-queue row keyed to
  // their effective arc origin (COALESCE(origin_id, id)).  The origin_task_id
  // column in action_queue_items is set to the resolved origin at raise time,
  // which equals COALESCE(t.origin_id, t.id) for all task-backed raises.
  const rows = await store.query({
    sql: `SELECT t.id,
                 t.failure_signature,
                 t.failure_reason,
                 t.failed_phase,
                 COALESCE(t.origin_id, t.id) AS effective_origin
            FROM tasks t
           WHERE t.status = 'failed'
             AND NOT EXISTS (
               SELECT 1
                 FROM action_queue_items a
                WHERE a.status = 'open'
                  AND a.origin_task_id = COALESCE(t.origin_id, t.id)
             )`,
  })

  let raised = 0
  for (const raw of rows.rows) {
    const row = raw as unknown as {
      id: string
      failure_signature: string | null
      failure_reason: string | null
      failed_phase: string | null
      effective_origin: string
    }

    const sig = row.failure_signature ?? row.failure_reason ?? 'unknown'
    const phase = row.failed_phase ?? 'unknown'

    // Use the same signature format the taskBlockedActionQueueRaiser uses so
    // the row is deduped correctly if a live raise races with this sweep.
    const existing = await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${row.id} failed (recovered by boot sweep)`,
      body:
        `Task ${row.id} is in \`failed\` status (phase: ${phase}, ` +
        `signature: ${sig}) but had no open action-queue row. ` +
        `This row was raised by the daemon boot-time orphaned-failed reconciler. ` +
        `Run \`mars restart ${row.id}\` to retry, or \`mars drop ${row.id}\` to abandon.`,
      payload: {
        taskId: row.id,
        failureSignature: sig,
        failedPhase: phase,
        raisedBy: 'boot:orphaned-failed-scan',
      },
      context: {},
      raisedBy: 'startup:orphaned-failed-scan',
      // Same signature as taskBlockedActionQueueRaiser so the two paths
      // produce the same fingerprint when the task's effective origin is
      // the task itself (i.e. origin_id IS NULL).  For arcs whose origin_id
      // is set the fingerprint is keyed on the arc root and any earlier live
      // raise (or an earlier sweep pass) will already match.
      signature: `task.blocked:${row.id}`,
      originTaskId: row.effective_origin,
    })

    // raiseActionQueueItem returns the id of the affected row (new or
    // existing).  We count only freshly inserted rows by tracking whether
    // the caller-visible count increased; however since raiseActionQueueItem
    // does not distinguish insert vs bump we simply increment for every task
    // the NOT EXISTS guard passed — those are definitionally missing rows.
    void existing
    raised++
  }

  return raised
}
