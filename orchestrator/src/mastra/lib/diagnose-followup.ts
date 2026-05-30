import {
  addBlockers,
  enqueueTask,
  getClient,
  getTask,
  initQueue,
  updateTask,
} from '../queue'
import { getDiagnosis, type StoredDiagnosis } from './diagnose'
import { raiseActionQueueItem } from './action-queue'

/**
 * Verdict-driven branch invoked exactly once when a diagnose Chore reaches
 * `done`. Encodes the PRD 06e677fb invariants:
 *
 *   - At most one fix attempt per diagnosis. On a root-cause verdict, a
 *     fresh task (kind='task') seeded with the recorded diagnosis is
 *     enqueued and the original task is re-parked behind it. The Chore's
 *     stale blocker edge is removed in the same transaction so the
 *     parent's blocker set is replaced, not appended to.
 *   - Inconclusive (or no recorded verdict, treated identically per the
 *     PRD's "exit without verdict = inconclusive" rule) → parent goes to
 *     `failed`, exactly one actionable actionQueue item is raised with the
 *     verdict body, dedup'd on the parent task id.
 *   - The function never spawns another diagnose Chore.
 *
 * The function is idempotent under double-invocation: a second call for
 * the same chore is a no-op if the parent is no longer parked behind a
 * diagnose Chore. Dedup of the actionQueue item and auto-close when the
 * parent reaches done/purged/dropped are both provided by origin-keyed
 * fingerprinting: originTaskId=parentTaskId in raiseActionQueueItem.
 */
export interface DiagnoseFollowupOutcome {
  /** What the verdict-driven branch decided to do. */
  action: 'fix-dispatched' | 'action-queue-raised' | 'noop'
  /** When action='fix-dispatched', the id of the new fix attempt. */
  fixTaskId?: string
  /** When action='action-queue-raised', the id of the raised/dedup'd actionQueue item. */
  actionQueueItemId?: string
  /** The parent task id the Chore was diagnosing. */
  parentTaskId: string | null
  /** Verdict kind as read from the store. */
  verdictKind: StoredDiagnosis['kind']
}

const findParentForDiagnoseChore = async (
  choreId: string,
): Promise<string | null> => {
  const r = await getClient().execute({
    sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ? LIMIT 1`,
    args: [choreId],
  })
  if (r.rows.length === 0) return null
  return (r.rows[0] as unknown as { task_id: string }).task_id
}

const removeBlockerEdge = async (
  parentTaskId: string,
  blockerTaskId: string,
): Promise<void> => {
  await getClient().execute({
    sql: `DELETE FROM task_blockers
           WHERE task_id = ? AND blocker_task_id = ?`,
    args: [parentTaskId, blockerTaskId],
  })
}

const buildFixPrompt = (
  parentTaskId: string,
  parentPrompt: string,
  evidence: string,
  involvedFiles: readonly string[],
  fixDirection: string,
): string => {
  const filesBlock =
    involvedFiles.length === 0
      ? '(none recorded)'
      : involvedFiles.map((f) => `  - ${f}`).join('\n')
  return [
    `# Fix attempt for ${parentTaskId} (seeded by diagnose Chore)`,
    '',
    `A diagnose Chore investigated this task and recorded a root cause. The diagnosis is below — do NOT re-investigate from scratch. Make the change described in the fix direction.`,
    '',
    '## Diagnosis evidence',
    '',
    evidence,
    '',
    '## Involved files',
    '',
    filesBlock,
    '',
    '## Fix direction',
    '',
    fixDirection,
    '',
    '## Original task prompt (verbatim)',
    '',
    parentPrompt.trim(),
    '',
    '## Save your work',
    '',
    'Stage and commit when verify passes (`git add -A && git commit -m "<message>"`). Do not exit without committing.',
  ].join('\n')
}

const buildInconclusiveActionQueueBody = (
  parentTaskId: string,
  verdict: StoredDiagnosis,
): string => {
  if (verdict.kind === 'inconclusive') {
    return [
      `The diagnose Chore investigating ${parentTaskId} returned an inconclusive verdict — no root cause was identified, so no fix was dispatched. Resolve this item explicitly: either re-scope the task with new context, drop it, or restart with a sharper prompt.`,
      '',
      '## What the Chore checked',
      '',
      verdict.whatChecked,
      '',
      '## Why the work could not be scoped',
      '',
      verdict.whyUnscoped,
    ].join('\n')
  }
  return [
    `The diagnose Chore investigating ${parentTaskId} reached done WITHOUT recording a verdict. Per the diagnose contract this is treated as inconclusive: no fix is dispatched, and the original task is parked failed for explicit operator resolution.`,
    '',
    'Re-scope the task, drop it, or restart with a sharper prompt.',
  ].join('\n')
}

export const runDiagnoseFollowup = async (
  choreId: string,
): Promise<DiagnoseFollowupOutcome> => {
  await initQueue()
  const chore = await getTask(choreId)
  if (!chore || chore.kind !== 'diagnose') {
    return { action: 'noop', parentTaskId: null, verdictKind: 'no-verdict' }
  }
  const parentTaskId = await findParentForDiagnoseChore(choreId)
  if (!parentTaskId) {
    // Either the parent was already resolved/cleared, or the edge was
    // never created (e.g. the Chore spawn happened but addBlockers failed).
    // Nothing actionable from here.
    return { action: 'noop', parentTaskId: null, verdictKind: 'no-verdict' }
  }
  const parent = await getTask(parentTaskId)
  if (!parent) {
    return { action: 'noop', parentTaskId, verdictKind: 'no-verdict' }
  }

  const verdict = await getDiagnosis(choreId)

  if (verdict.kind === 'root-cause-found') {
    const fixPrompt = buildFixPrompt(
      parentTaskId,
      parent.prompt,
      verdict.evidence,
      verdict.involvedFiles,
      verdict.fixDirection,
    )
    const fix = await enqueueTask(fixPrompt, undefined, {
      skipTriage: true,
      originId: parent.originId,
      kind: 'task',
    })
    // Swap blockers: remove the (now-done) diagnose Chore edge before
    // adding the new fix's edge so the parent is parked behind exactly
    // one outstanding task (the fix). Re-stamp 'blocked' explicitly — the
    // generic on-blocker-completed path will otherwise re-queue the parent
    // the moment the diagnose Chore lands done.
    await removeBlockerEdge(parentTaskId, choreId)
    await addBlockers(parentTaskId, [fix.id])
    await updateTask(parentTaskId, {
      status: 'blocked',
      failedPhase: null,
    })
    return {
      action: 'fix-dispatched',
      fixTaskId: fix.id,
      parentTaskId,
      verdictKind: verdict.kind,
    }
  }

  // Inconclusive OR no-verdict — both deliberately collapse to the same
  // operator-resolution branch (PRD 06e677fb).
  await removeBlockerEdge(parentTaskId, choreId)
  await updateTask(parentTaskId, {
    status: 'failed',
    failedPhase: 'code',
    failureReason: `diagnose chore ${verdict.kind}`,
    failureReasonCode: 'unknown',
  })
  const actionQueueItemId = await raiseActionQueueItem({
    kind: 'diagnose-inconclusive',
    category: 'orchestrator',
    priority: 'high',
    title: `Diagnose Chore for ${parentTaskId} returned ${verdict.kind === 'inconclusive' ? 'inconclusive' : 'no verdict'}`,
    body: buildInconclusiveActionQueueBody(parentTaskId, verdict),
    payload: {
      parentTaskId,
      // originTaskId in the payload allows extractEntityId (view/action-queue.ts)
      // to resolve the parent task for UI rendering. Without it the view falls
      // through to `return row.id` and shows a bogus '(unknown task)' row.
      originTaskId: parentTaskId,
      choreId,
      verdictKind: verdict.kind,
    },
    context: {},
    raisedBy: 'diagnose-followup',
    // Origin-keyed dedup: re-processing the same dead end collapses onto the
    // existing item. Also lets dismissAlertsOnStatusChange close this row
    // automatically when the parent task transitions to done/purged/dropped —
    // without originTaskId the fingerprint was kind+signature-keyed and the
    // alert-dismisser (which queries by computeOriginFingerprint) could never
    // find it, leaving stale rows open forever.
    originTaskId: parentTaskId,
    signature: parentTaskId,
  })
  return {
    action: 'action-queue-raised',
    actionQueueItemId,
    parentTaskId,
    verdictKind: verdict.kind,
  }
}
