import type { FixRecipeContext } from '../lib/fix-recipes'
import { getRetryBudget } from '../lib/retry-budget'
import { getDefaultTaskStore } from '../store/task-store'
import { countFixTaskAttempts, upsertFixTask } from '../queue-fix-tasks'
import { recordStewardIntervention } from '../steward-ledger'

export interface SweepCandidate {
  /** The parent task that needs self-healing. */
  taskId: string
  /** The failure signature driving this heal attempt. */
  failureSignature: string
  /** The workflow step where the failure occurred (e.g. 'verify:typecheck'). */
  failingStep: string
  /** Truncated error text passed to the recovery recipe's prompt builder. */
  truncatedError: string
  /** Branch the parent task was running on, or null. */
  branch: string | null
  /** Recipe context forwarded to the fix-task prompt builder. */
  recipeContext: FixRecipeContext
}

export type SweepOutcome =
  | { kind: 'enqueued'; fixTaskId: string }
  | { kind: 'skipped-in-flight'; existingFixTaskId: string }
  | { kind: 'skipped-budget-exhausted'; attempts: number; budget: number }

/**
 * Returns the id of any in-flight self-heal task for the given failure
 * signature, across all parent tasks (signature-scoped, not parent-scoped).
 * "In-flight" means queued, running, verifying, or merging — blocked and
 * draft are excluded so a stuck self-heal does not permanently suppress
 * new attempts.
 */
export const findInFlightSelfHealBySignature = async (
  failureSignature: string,
): Promise<string | null> => {
  const store = await getDefaultTaskStore()
  const r = await store.query({
    sql: `SELECT id FROM tasks
           WHERE failure_signature = ?
             AND fix_for_task_id IS NOT NULL
             AND status IN ('queued','running','verifying','merging','vega-reconciling')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [failureSignature],
  })
  if (r.rows.length === 0) return null
  return (r.rows[0] as unknown as { id: string }).id
}

/**
 * Attempt to enqueue a self-heal for the given sweep candidate.
 *
 * Before enqueuing, performs a signature-scoped in-flight check: if ANY
 * self-heal task with the same failure signature is already queued, running,
 * verifying, or merging (regardless of which parent spawned it), the enqueue
 * is skipped and the parent task's status is left untouched. A log line is
 * emitted via `log` to record the skip.
 *
 * This is deliberately broader than the per-(parent, signature) dedup inside
 * `upsertFixTask` so that four concurrent parents hitting the same signature
 * cannot each spawn their own fix task at the same sweeper tick.
 */
export const sweepOne = async (
  candidate: SweepCandidate,
  log: (msg: string) => void = (msg) => console.log(msg),
): Promise<SweepOutcome> => {
  const budget = getRetryBudget(candidate.failureSignature)
  const attempts = await countFixTaskAttempts(
    candidate.taskId,
    candidate.failureSignature,
  )
  if (attempts >= budget) {
    log(
      `[sweeper] skipping enqueue for ${candidate.taskId}/${candidate.failureSignature}: ` +
        `budget exhausted (${attempts}/${budget} attempts used)`,
    )
    return { kind: 'skipped-budget-exhausted', attempts, budget }
  }

  const existingId = await findInFlightSelfHealBySignature(
    candidate.failureSignature,
  )

  if (existingId !== null) {
    log(
      `[sweeper] skipping enqueue for signature ${candidate.failureSignature}: ` +
        `in-flight self-heal ${existingId} already exists`,
    )
    return { kind: 'skipped-in-flight', existingFixTaskId: existingId }
  }

  const result = await upsertFixTask({
    sourceTaskId: candidate.taskId,
    failureSignature: candidate.failureSignature,
    failingStep: candidate.failingStep,
    truncatedError: candidate.truncatedError,
    branch: candidate.branch,
    recipeContext: candidate.recipeContext,
  })

  await recordStewardIntervention({
    targetKind: 'task',
    targetId: candidate.taskId,
    targetVersion: candidate.failureSignature,
    recipeId: candidate.failureSignature,
    rationale: `Sweeper ${result.created ? 'created' : 'reused'} a recovery after ${candidate.failingStep}.`,
    outcome: result.created ? 'recovery-created' : 'recovery-reused',
  })

  return { kind: 'enqueued', fixTaskId: result.fixTaskId }
}
