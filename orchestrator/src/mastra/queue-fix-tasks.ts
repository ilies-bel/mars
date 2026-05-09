import { randomUUID } from 'node:crypto'
import { getRecipe, type FixRecipeContext } from './lib/fix-recipes'
import { getClient, getTask, initQueue, type Task } from './queue'
import { getRetryBudget, markTaskDropped } from './queue-retry'

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const FIX_TASK_AUTHOR_KIND = 'agent'
const FIX_TASK_AUTHOR_NAME = 'fail-fix-handler'

const buildGenericFixPrompt = ({
  sourceTaskId,
  failingStep,
  failureSignature,
  truncatedError,
  branch,
}: {
  sourceTaskId: string
  failingStep: string
  failureSignature: string
  truncatedError: string
  branch: string | null
}): string => {
  return [
    `Fix the failure that blocked task ${sourceTaskId}.`,
    '',
    `Failing step: ${failingStep}`,
    `Failure signature: ${failureSignature}`,
    branch ? `Branch: ${branch}` : null,
    '',
    `First error output (truncated):`,
    '```',
    truncatedError,
    '```',
    '',
    `Save your work: stage and commit any changes you make.`,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

export interface UpsertFixTaskInput {
  sourceTaskId: string
  failureSignature: string
  failingStep: string
  truncatedError: string
  branch: string | null
  recipeSignature?: string
  recipeContext?: FixRecipeContext
}

export interface UpsertFixTaskResult {
  fixTaskId: string
  created: boolean
}

const findExistingFixTask = async (
  sourceTaskId: string,
  failureSignature: string,
): Promise<string | null> => {
  const r = await getClient().execute({
    sql: `SELECT id FROM tasks
           WHERE fix_for_task_id = ?
             AND failure_signature = ?
             AND status IN ('queued','running','verifying','merging','draft','blocked')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [sourceTaskId, failureSignature],
  })
  if (r.rows.length === 0) return null
  return (r.rows[0] as unknown as { id: string }).id
}

/**
 * Atomically:
 *  - INSERT a new runnable fix-task row (status='queued', skip triage),
 *  - INSERT a task_blockers row linking the source task to the fix task,
 *  - UPDATE the source task to status='blocked' with retry_count incremented.
 *
 * Idempotent on (sourceTaskId, failureSignature): if a fix task is already
 * outstanding for that pair, the existing task is reused.
 */
export const upsertFixTask = async (
  input: UpsertFixTaskInput,
): Promise<UpsertFixTaskResult> => {
  await initQueue()
  const c = getClient()

  const existingId = await findExistingFixTask(
    input.sourceTaskId,
    input.failureSignature,
  )
  if (existingId) {
    return { fixTaskId: existingId, created: false }
  }

  const truncatedError = truncate(input.truncatedError, 2000)
  let prompt: string
  if (input.recipeSignature) {
    if (!input.recipeContext) {
      throw new Error(
        `recipeContext is required when recipeSignature is set (signature=${input.recipeSignature})`,
      )
    }
    const recipe = getRecipe(input.recipeSignature)
    prompt = recipe.buildPrompt(input.recipeContext)
  } else {
    prompt = buildGenericFixPrompt({
      sourceTaskId: input.sourceTaskId,
      failingStep: input.failingStep,
      failureSignature: input.failureSignature,
      truncatedError,
      branch: input.branch,
    })
  }

  const source = await getTask(input.sourceTaskId)
  if (!source) {
    throw new Error(`source task ${input.sourceTaskId} not found`)
  }
  const nextRetryCount = source.retryCount + 1
  const errorSummary = truncate(
    `${input.failingStep}: ${input.truncatedError}`,
    1000,
  )
  const fixTaskId = randomUUID().slice(0, 8)
  const now = new Date().toISOString()

  const tx = await c.transaction('write')
  try {
    await tx.execute({
      sql: `INSERT INTO tasks (
              id, prompt, status,
              author_kind, author_name,
              fix_for_task_id, failure_signature,
              retry_count, origin_id,
              created_at, updated_at
            ) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?)`,
      args: [
        fixTaskId,
        prompt,
        FIX_TASK_AUTHOR_KIND,
        FIX_TASK_AUTHOR_NAME,
        input.sourceTaskId,
        input.failureSignature,
        source.originId,
        now,
        now,
      ],
    })
    await tx.execute({
      sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
            VALUES (?, ?, ?)`,
      args: [input.sourceTaskId, fixTaskId, now],
    })
    await tx.execute({
      sql: `UPDATE tasks
               SET status = 'blocked',
                   retry_count = ?,
                   error = ?,
                   updated_at = ?
             WHERE id = ?`,
      args: [nextRetryCount, errorSummary, now, input.sourceTaskId],
    })
    await tx.commit()
  } catch (error: unknown) {
    tx.close()
    throw error
  }

  return { fixTaskId, created: true }
}

export interface HandleTaskFailureViaTaskInput {
  taskId: string
  failingStep: string
  errorOutput: string
  branch?: string | null
  recipeSignature?: string
  recipeContext?: FixRecipeContext
}

export interface HandleTaskFailureViaTaskResult {
  outcome: 'blocked' | 'dropped' | 'noop'
  fixTaskId?: string
  failureSignature?: string
  retryCount?: number
}

/**
 * Failure-handler entrypoint that creates a runnable fix-task instead of a
 * fix-suggestion proposal. Replaces the kind='fix' suggestion path.
 */
export const handleTaskFailureWithFixTask = async (
  input: HandleTaskFailureViaTaskInput,
): Promise<HandleTaskFailureViaTaskResult> => {
  await initQueue()
  const task: Task | null = await getTask(input.taskId)
  if (!task) return { outcome: 'noop' }

  const { computeFailureSignature } = await import('./lib/failure-signature')
  const failureSignature = input.recipeSignature
    ? input.recipeSignature
    : computeFailureSignature(input.failingStep, input.errorOutput)
  const budget = getRetryBudget()

  if (task.retryCount >= budget) {
    await markTaskDropped(
      input.taskId,
      `retry_budget_exhausted:${failureSignature}`,
    )
    return {
      outcome: 'dropped',
      failureSignature,
      retryCount: task.retryCount,
    }
  }

  const truncatedError = input.errorOutput.slice(0, 2000)
  const branch = input.branch ?? task.branch
  const result = await upsertFixTask({
    sourceTaskId: input.taskId,
    failureSignature,
    failingStep: input.failingStep,
    truncatedError,
    branch,
    recipeSignature: input.recipeSignature,
    recipeContext: input.recipeContext,
  })

  return {
    outcome: 'blocked',
    fixTaskId: result.fixTaskId,
    failureSignature,
    retryCount: task.retryCount + 1,
  }
}
