/**
 * Slice F.2: inbox-side helpers for `main-commiter` recoveries.
 *
 * Two distinct concerns live here, both keyed off the recovery's
 * `recovery_payload`:
 *
 * 1. `sweepStaleFailedMainCommiterInbox`: on committer SUCCESS, scan for
 *    open inbox rows raised by previously-failed committer attempts whose
 *    `dirtyMainHash` is no longer the current state of main. Those rows
 *    describe a state that the just-succeeded committer fixed; resolve them
 *    with `SupersedeReason: 'origin-done'`.
 *
 * 2. `raiseAggregatedMainCommiterFailureRow`: on committer FAILURE, raise
 *    one inbox row whose body lists every task currently `blocked` on this
 *    committer. Overrides the generic `inbox-repopulator` row for this
 *    specific recovery so the operator sees the affected cohort at a glance.
 */
import { raiseInboxItem, supersedeInboxItemsForOrigin } from '../lib/inbox'
import { getDefaultTaskStore } from '../lib/task-store'
import { MAIN_COMMITER_RECIPE } from '../lib/main-dirty'

/**
 * SQL fragment that matches an open inbox row associated with a recovery
 * whose `recovery_payload.recipe = 'main-commiter'`. We can't filter on
 * the inbox_items table alone (it carries no payload-shape pointer at the
 * recipe level beyond the title/raisedBy strings); the canonical query is
 * a join through the recovery task id stored on the inbox row's payload.
 *
 * Implementation note: rather than crack open the inbox payload, we use
 * the convention that a `main-commiter` failure inbox row records the
 * `recoveryTaskId` in its payload — the same shape the recovery-failed
 * pipeline already uses. We join tasks via that pointer and filter by
 * recipe and a non-matching hash.
 */
const FIND_STALE_COMMITTER_INBOX_ROWS_SQL = `
  SELECT i.id AS inbox_id,
         i.origin_task_id AS origin_task_id
    FROM inbox_items i
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
 * Scan for `failed`-committer inbox rows whose hash is NOT the freshly-
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
export const sweepStaleFailedMainCommiterInbox = async (
  freshHash: string,
  freshRecoveryTaskId: string,
  log: (msg: string) => void,
): Promise<void> => {
  const s = await getDefaultTaskStore()
  const r = await s.query({
    sql: FIND_STALE_COMMITTER_INBOX_ROWS_SQL,
    args: [MAIN_COMMITER_RECIPE, freshHash],
  })
  if (r.rows.length === 0) return
  const seenOrigins = new Set<string>()
  for (const row of r.rows as unknown as Array<{
    inbox_id: string
    origin_task_id: string | null
  }>) {
    if (row.origin_task_id === null || row.origin_task_id.length === 0) continue
    if (seenOrigins.has(row.origin_task_id)) continue
    seenOrigins.add(row.origin_task_id)
    const closed = await supersedeInboxItemsForOrigin(
      row.origin_task_id,
      'origin-done',
      `daemon:main-commiter-success:${freshRecoveryTaskId}`,
    )
    if (closed.length > 0) {
      log(
        `[main-dirty] swept ${closed.length} stale failed-committer inbox row(s) tied to origin ${row.origin_task_id} after committer ${freshRecoveryTaskId} succeeded`,
      )
    }
  }
}

/**
 * On committer FAILURE, raise a single aggregated inbox row that lists
 * every task currently blocked on this committer. Overrides the generic
 * `inbox-repopulator` shape for this kind of failure so the operator
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
    log(`[main-dirty] aggregated-row: committer ${recoveryTaskId} not found; skipping inbox raise`)
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

  const inboxItemId = await raiseInboxItem({
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
    `[main-dirty] aggregated-row: raised inbox ${inboxItemId} for failed committer ${recoveryTaskId} with ${n} blocked dependent(s)`,
  )
  return inboxItemId
}
