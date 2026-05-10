import { randomUUID } from 'node:crypto'
import {
  getRecipe,
  hasRecipe,
  type FixRecipeContext,
} from './lib/fix-recipes'
import { raiseInboxItem } from './lib/inbox'
import { getClient, getTask, initQueue, updateTask, type Task } from './queue'
import { getRetryBudget, markTaskDropped } from './queue-retry'

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const FIX_TASK_AUTHOR_KIND = 'agent'
const FIX_TASK_AUTHOR_NAME = 'fail-fix-handler'
const INVESTIGATOR_AUTHOR_NAME = 'agent:investigator'

export const RECOVERY_FAILED_INBOX_KIND = 'recovery-failed'
export const NO_RECIPE_INBOX_KIND = 'no-recipe'

export interface UpsertFixTaskInput {
  sourceTaskId: string
  failureSignature: string
  failingStep: string
  truncatedError: string
  branch: string | null
  /**
   * Recipe context handed to the recipe's `buildPrompt`. Required — the
   * generic prompt builder is gone (see ADR 0002). Callers that don't
   * have meaningful context can pass an empty `statusOutput`; the recipe
   * decides whether to use the rest of the fields.
   */
  recipeContext: FixRecipeContext
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
 *
 * Caller must guarantee a recipe exists for `input.failureSignature` —
 * `upsertFixTask` will throw if it doesn't. Use `hasRecipe(signature)`
 * before calling.
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

  const recipe = getRecipe(input.failureSignature)
  const prompt = recipe.buildPrompt(input.recipeContext)

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

const buildInvestigatorPrompt = (input: {
  sourceTaskId: string
  originTaskId: string
  failingStep: string
  failureSignature: string
  truncatedError: string
  branch: string | null
}): string => {
  return [
    `# Investigator task — propose a recovery recipe`,
    '',
    `Task ${input.sourceTaskId} (origin ${input.originTaskId}) failed with a signature that has no registered recovery recipe. Your job is NOT to fix the failing task. Your job is to read the failure, decide if it's recoverable by a coding agent, and either:`,
    '  (a) propose a draft recipe by editing orchestrator/src/mastra/lib/fix-recipes.ts and (if needed) orchestrator/src/mastra/lib/failure-signature.ts to add a matching error-class rule, then commit; or',
    `  (b) if the failure is fundamentally not recoverable by an agent (e.g. a real product bug, an environmental issue requiring human credentials, an underspecified original task), file a 'mars inbox raise --from -' item with priority='high' explaining why no recipe should be added.`,
    '',
    `Read docs/adr/0002-recipe-per-failure-signature.md before editing — every recipe must obey the contract there (recipe binds to a technical-key signature, recovery has retry budget 0, etc.).`,
    '',
    `## Failure context`,
    '',
    `Failing step: ${input.failingStep}`,
    `Failure signature: ${input.failureSignature}`,
    input.branch ? `Branch: ${input.branch}` : null,
    `Originally failing task: ${input.sourceTaskId}`,
    `Origin task: ${input.originTaskId}`,
    '',
    'First error output (truncated):',
    '```',
    input.truncatedError,
    '```',
    '',
    `## What 'a draft recipe' means`,
    '',
    `Add an entry to \`recipeList\` in orchestrator/src/mastra/lib/fix-recipes.ts. Its \`signature\` field MUST equal the signature above. Its \`buildPrompt\` returns the prompt for a recovery agent — concrete steps, exact paths, what to commit. Mirror the style of the existing recipes (\`merge:preflight/uncommitted-changes\`, \`setup:install/install-frozen-lockfile\`, \`verify:has-diff/no-commits-ahead\`).`,
    '',
    `If the signature ends in \`/unclassified\`, you must also add a rule to \`errorClassRules\` in orchestrator/src/mastra/lib/failure-signature.ts so future occurrences of this error map to a stable slug instead of \`unclassified\`. Pick the slug carefully — it becomes part of the technical-key signature contract.`,
    '',
    `## Boundaries`,
    '',
    ` - Do NOT modify the original failing task's row, branch, or worktree.`,
    ` - Do NOT add a generic catch-all recipe — recipes must be specific to a signature.`,
    ` - Do NOT bypass the registry by editing the failure handler.`,
    ` - Add a vitest test exercising the new recipe (mirror the existing tests in orchestrator/src/mastra/lib/__tests__/fix-recipes.test.ts).`,
    '',
    `Save your work: stage and commit your changes (recipe + test + any classifier rule).`,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

const buildRecoveryEscalationBody = (input: {
  recoveryTaskId: string
  originTaskId: string
  failingStep: string
  failureSignature: string
  branch: string | null
  worktreePath: string | null
  claudeSessionId: string | null
  truncatedError: string
}): string => {
  return [
    `Recovery task ${input.recoveryTaskId} failed and the orchestrator did NOT enqueue another recovery (recovery has retry budget 0 by design — see ADR 0002).`,
    `Original task: ${input.originTaskId} (still in 'blocked' status).`,
    '',
    `Failing step: ${input.failingStep}`,
    `Failure signature: ${input.failureSignature}`,
    input.branch ? `Branch: ${input.branch}` : null,
    input.worktreePath ? `Worktree: ${input.worktreePath}` : null,
    input.claudeSessionId ? `Claude session: ${input.claudeSessionId}` : null,
    '',
    'First error output (truncated):',
    '```',
    input.truncatedError,
    '```',
    '',
    'Resolve options:',
    `  - inspect the worktree, fix the underlying issue, then 'mars retry ${input.recoveryTaskId}' to re-attempt`,
    `  - 'mars unblock ${input.originTaskId}' to abandon the original task`,
    `  - 'mars inbox resolve <item-id>' once handled`,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

const buildNoRecipeBody = (input: {
  sourceTaskId: string
  originTaskId: string
  investigatorTaskId: string
  failingStep: string
  failureSignature: string
  branch: string | null
  truncatedError: string
}): string => {
  return [
    `Task ${input.sourceTaskId} (origin ${input.originTaskId}) failed with signature \`${input.failureSignature}\`, which has no registered recovery recipe.`,
    `An Investigator task (${input.investigatorTaskId}) has been queued to propose a draft recipe; it does NOT fix the failing task.`,
    `The failing task is parked in 'blocked' until a recipe lands and you decide what to do.`,
    '',
    `Failing step: ${input.failingStep}`,
    `Failure signature: ${input.failureSignature}`,
    input.branch ? `Branch: ${input.branch}` : null,
    '',
    'First error output (truncated):',
    '```',
    input.truncatedError,
    '```',
    '',
    'Once the investigator has merged its draft recipe:',
    `  - 'mars retry ${input.sourceTaskId}' to re-attempt the original task with the new recipe in scope`,
    `  - 'mars unblock ${input.originTaskId}' if you decide the failure is unrecoverable`,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

interface SpawnInvestigatorResult {
  investigatorTaskId: string
  inboxItemId: string
}

const spawnInvestigatorAndRaiseInbox = async (input: {
  sourceTask: Task
  failingStep: string
  failureSignature: string
  branch: string | null
  truncatedError: string
}): Promise<SpawnInvestigatorResult> => {
  const c = getClient()
  const investigatorPrompt = buildInvestigatorPrompt({
    sourceTaskId: input.sourceTask.id,
    originTaskId: input.sourceTask.originId,
    failingStep: input.failingStep,
    failureSignature: input.failureSignature,
    truncatedError: input.truncatedError,
    branch: input.branch,
  })

  const investigatorTaskId = randomUUID().slice(0, 8)
  const errorSummary = truncate(
    `${input.failingStep}: ${input.truncatedError}`,
    1000,
  )
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
        investigatorTaskId,
        investigatorPrompt,
        FIX_TASK_AUTHOR_KIND,
        INVESTIGATOR_AUTHOR_NAME,
        // Investigator is not a fix-task for the source — it doesn't
        // unblock it. Linking via fix_for_task_id would put the source
        // back on the unblock-on-done path, which is wrong (a merged
        // recipe doesn't fix the failure that already happened).
        null,
        input.failureSignature,
        input.sourceTask.originId,
        now,
        now,
      ],
    })
    // Source task: park it in blocked. No task_blockers row — there is
    // nothing to unblock against. Human resolves via mars retry/unblock.
    await tx.execute({
      sql: `UPDATE tasks
               SET status = 'blocked',
                   retry_count = retry_count + 1,
                   error = ?,
                   updated_at = ?
             WHERE id = ?`,
      args: [errorSummary, now, input.sourceTask.id],
    })
    await tx.commit()
  } catch (error: unknown) {
    tx.close()
    throw error
  }

  const inboxItemId = await raiseInboxItem({
    kind: NO_RECIPE_INBOX_KIND,
    category: 'orchestrator',
    priority: 'high',
    title: `no recovery recipe for ${input.failureSignature}`,
    body: buildNoRecipeBody({
      sourceTaskId: input.sourceTask.id,
      originTaskId: input.sourceTask.originId,
      investigatorTaskId,
      failingStep: input.failingStep,
      failureSignature: input.failureSignature,
      branch: input.branch,
      truncatedError: input.truncatedError,
    }),
    payload: {
      sourceTaskId: input.sourceTask.id,
      originTaskId: input.sourceTask.originId,
      investigatorTaskId,
      failingStep: input.failingStep,
      failureSignature: input.failureSignature,
      branch: input.branch,
    },
    context: {
      repoRoot: process.env.MARS_REPO ?? null,
    },
    raisedBy: 'agent:fail-fix-handler',
    // Dedup so a flapping signature doesn't spawn a herd of investigators.
    signature: input.failureSignature,
    occurrence: {
      at: now,
      sourceTaskId: input.sourceTask.id,
      failingStep: input.failingStep,
    },
  })

  return { investigatorTaskId, inboxItemId }
}

export interface HandleTaskFailureViaTaskInput {
  taskId: string
  failingStep: string
  errorOutput: string
  branch?: string | null
  /**
   * Optional structured context for recipes that need it (e.g. the
   * `merge:preflight/uncommitted-changes` recipe wants `statusOutput`).
   * If omitted, an empty context is synthesized — recipes that ignore
   * those fields work either way.
   */
  recipeContext?: FixRecipeContext
}

export interface HandleTaskFailureViaTaskResult {
  outcome: 'blocked' | 'dropped' | 'escalated' | 'no-recipe' | 'noop'
  fixTaskId?: string
  failureSignature?: string
  retryCount?: number
  inboxItemId?: string
  investigatorTaskId?: string
}

/**
 * Failure-handler entrypoint. Three terminal outcomes:
 *
 *  - `blocked`: original task → blocked, recovery fix-task enqueued from
 *     the registered recipe for the computed signature.
 *  - `escalated`: the failing task is itself a recovery (fix_for_task_id
 *     set). Recovery has a retry budget of 0; we mark it failed and
 *     raise a `recovery-failed` inbox item for human attention.
 *  - `no-recipe`: signature has no recipe registered. Original task →
 *     blocked, an Investigator task is queued to propose a draft recipe,
 *     and a `no-recipe` inbox item is raised.
 *
 * Plus `dropped` when the legacy retry budget for the original task is
 * exhausted, and `noop` when the task row vanished.
 */
export const handleTaskFailureWithFixTask = async (
  input: HandleTaskFailureViaTaskInput,
): Promise<HandleTaskFailureViaTaskResult> => {
  await initQueue()
  const task: Task | null = await getTask(input.taskId)
  if (!task) return { outcome: 'noop' }

  const { computeFailureSignature } = await import('./lib/failure-signature')
  const failureSignature = computeFailureSignature(
    input.failingStep,
    input.errorOutput,
  )
  const truncatedError = input.errorOutput.slice(0, 2000)
  const branch = input.branch ?? task.branch

  // Recovery (fix-task) failures escalate to inbox; never spawn another
  // recovery. See ADR 0002 — this is the rule that broke the cascade.
  if (task.fixForTaskId !== null) {
    await updateTask(input.taskId, {
      status: 'failed',
      error: `recovery_failed:${failureSignature}: ${truncatedError.slice(0, 500)}`,
    })

    const originId = task.originId
    const inboxSignature = `${originId}:${failureSignature}`
    const inboxItemId = await raiseInboxItem({
      kind: RECOVERY_FAILED_INBOX_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: `recovery for ${originId} failed (${input.failingStep})`,
      body: buildRecoveryEscalationBody({
        recoveryTaskId: input.taskId,
        originTaskId: originId,
        failingStep: input.failingStep,
        failureSignature,
        branch,
        worktreePath: task.worktreePath,
        claudeSessionId: task.claudeSessionId,
        truncatedError,
      }),
      payload: {
        recoveryTaskId: input.taskId,
        originTaskId: originId,
        failingStep: input.failingStep,
        failureSignature,
        branch,
        worktreePath: task.worktreePath,
        claudeSessionId: task.claudeSessionId,
      },
      context: {
        repoRoot: process.env.MARS_REPO ?? null,
      },
      raisedBy: 'agent:fail-fix-handler',
      signature: inboxSignature,
      occurrence: {
        at: new Date().toISOString(),
        recoveryTaskId: input.taskId,
        failingStep: input.failingStep,
      },
    })

    return {
      outcome: 'escalated',
      failureSignature,
      retryCount: task.retryCount,
      inboxItemId,
    }
  }

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

  // No recipe for this signature — do NOT fall back to a generic prompt
  // (that's what produced the cascade). Park the source in 'blocked',
  // queue an Investigator task to propose a draft recipe, and raise an
  // inbox item.
  if (!hasRecipe(failureSignature)) {
    const { investigatorTaskId, inboxItemId } =
      await spawnInvestigatorAndRaiseInbox({
        sourceTask: task,
        failingStep: input.failingStep,
        failureSignature,
        branch,
        truncatedError,
      })
    return {
      outcome: 'no-recipe',
      failureSignature,
      retryCount: task.retryCount + 1,
      investigatorTaskId,
      inboxItemId,
    }
  }

  const recipeContext: FixRecipeContext = input.recipeContext ?? {
    targetPath: task.worktreePath ?? '',
    statusOutput: truncatedError,
    targetBranch: branch ?? '',
  }

  const result = await upsertFixTask({
    sourceTaskId: input.taskId,
    failureSignature,
    failingStep: input.failingStep,
    truncatedError,
    branch,
    recipeContext,
  })

  return {
    outcome: 'blocked',
    fixTaskId: result.fixTaskId,
    failureSignature,
    retryCount: task.retryCount + 1,
  }
}
