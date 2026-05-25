import { randomUUID } from 'node:crypto'
import {
  deriveReproCommand,
  buildVerifyReproHint,
  type RanVerifyStep,
} from './lib/derive-repro-command'
import {
  getRecipe,
  hasRecipe,
  type FixRecipeContext,
} from './lib/fix-recipes'
import { type InboxKind, raiseInboxItem } from './lib/inbox'
import { truncateFailure } from './lib/truncate-failure'
import { internalBus } from '../internal-bus'
import {
  getTask,
  MAX_PRIORITY,
  updateTask,
  type Task,
} from './queue'
import {
  getRetryBudget,
  markTaskFailed,
  raiseRetryBudgetExhaustedInbox,
} from './queue-retry'
import { getDefaultTaskStore, type TaskStore } from './lib/task-store'

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const FIX_TASK_AUTHOR_KIND = 'agent'
const FIX_TASK_AUTHOR_NAME = 'fail-fix-handler'
const INVESTIGATOR_AUTHOR_NAME = 'agent:investigator'

export const RECOVERY_FAILED_INBOX_KIND: InboxKind = 'failed'
export const NO_RECIPE_INBOX_KIND: InboxKind = 'failed'
export const FIX_FAIL_LOOP_INBOX_KIND: InboxKind = 'failed'

const DEFAULT_MAX_FIX_ATTEMPTS = 2

/**
 * Cap on the number of fix-task rows we'll ever insert for a single
 * (sourceTaskId, failureSignature) pair. Once the cap is hit, the next
 * dispatch escalates to the inbox instead of looping. The rule is
 * signature-agnostic — no hardcoded signature strings.
 */
export const getMaxFixAttempts = (): number => {
  const raw = process.env.MARS_MAX_FIX_ATTEMPTS
  if (!raw) return DEFAULT_MAX_FIX_ATTEMPTS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_FIX_ATTEMPTS
  return Math.floor(n)
}

/**
 * Count every historical fix-task row for a given (sourceTaskId,
 * failureSignature) pair, regardless of status. Used to drive the
 * fix-fail-loop cap so failed/done/abandoned attempts still count.
 *
 * Stays schema-free — relies only on `fix_for_task_id` and
 * `failure_signature` columns that already exist on `tasks`.
 */
export const countFixTaskAttempts = async (
  sourceTaskId: string,
  failureSignature: string,
  store?: TaskStore,
): Promise<number> => {
  const s = store ?? (await getDefaultTaskStore())
  const r = await s.query({
    sql: `SELECT COUNT(*) AS n FROM tasks
           WHERE fix_for_task_id = ?
             AND failure_signature = ?`,
    args: [sourceTaskId, failureSignature],
  })
  return Number((r.rows[0] as unknown as { n: number }).n)
}

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
  /**
   * TaskStore threaded in from the workflow composition root. When
   * provided, all DB operations run through the store rather than
   * falling back to the module-singleton client.
   */
  store?: TaskStore
}

export interface UpsertFixTaskResult {
  fixTaskId: string
  created: boolean
}

const findExistingFixTask = async (
  sourceTaskId: string,
  failureSignature: string,
  store?: TaskStore,
): Promise<string | null> => {
  const s = store ?? (await getDefaultTaskStore())
  const r = await s.query({
    sql: `SELECT id FROM tasks
           WHERE fix_for_task_id = ?
             AND failure_signature = ?
             AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [sourceTaskId, failureSignature],
  })
  if (r.rows.length === 0) return null
  return (r.rows[0] as unknown as { id: string }).id
}

/**
 * For shared recipes: locate ANY outstanding fix-task for this signature,
 * regardless of which source task spawned it. New blocked sources attach
 * to it via a `task_blockers` edge instead of spawning a duplicate.
 */
const findSharedFixTask = async (
  failureSignature: string,
  store?: TaskStore,
): Promise<string | null> => {
  const s = store ?? (await getDefaultTaskStore())
  const r = await s.query({
    sql: `SELECT id FROM tasks
           WHERE failure_signature = ?
             AND fix_for_task_id IS NOT NULL
             AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [failureSignature],
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
  const s = input.store ?? (await getDefaultTaskStore())

  const recipe = getRecipe(input.failureSignature)
  const shared = recipe.shared === true

  // Shared recipes (e.g. dirty merge target) reuse a single in-flight
  // fix-task across every source task that hits the signature. New
  // sources just attach a task_blockers edge — one commit unblocks
  // every dependent at once via onBlockerTaskCompleted.
  const existingId = shared
    ? await findSharedFixTask(input.failureSignature, s)
    : await findExistingFixTask(input.sourceTaskId, input.failureSignature, s)

  const source = await getTask(input.sourceTaskId, s)
  if (!source) {
    throw new Error(`source task ${input.sourceTaskId} not found`)
  }
  const nextRetryCount = source.retryCount + 1
  const errorSummary = truncate(
    `${input.failingStep}: ${input.truncatedError}`,
    1000,
  )
  const now = new Date().toISOString()

  if (existingId) {
    // Attach this source to the existing fix-task and park it.
    await s.batch(
      [
        {
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
              VALUES (?, ?, ?)`,
          args: [input.sourceTaskId, existingId, now],
        },
        {
          sql: `UPDATE tasks
                 SET status = 'blocked',
                     retry_count = ?,
                     error = ?,
                     updated_at = ?
               WHERE id = ?`,
          args: [nextRetryCount, errorSummary, now, input.sourceTaskId],
        },
      ],
      'write',
    )
    internalBus().emit('task.blocked', {
      taskId: input.sourceTaskId,
      fixTaskId: existingId,
      failureSignature: input.failureSignature,
      failingStep: input.failingStep,
    })
    return { fixTaskId: existingId, created: false }
  }

  // Inline the source task's prompt so recipes that re-do the original
  // work (e.g. verify:has-diff/no-commits-ahead) don't burn turns
  // re-fetching it from .mars/queue.db. Handlers should already set
  // `originalPrompt`; backfill from the source row if a direct caller
  // forgot. Default to '' only when the source genuinely has no prompt.
  const incomingPrompt = input.recipeContext.originalPrompt
  const recipeContextWithSource: FixRecipeContext = {
    ...input.recipeContext,
    originalPrompt:
      incomingPrompt && incomingPrompt.trim().length > 0
        ? incomingPrompt
        : source.prompt ?? '',
  }
  const prompt = recipe.buildPrompt(recipeContextWithSource)
  const fixTaskId = randomUUID().slice(0, 8)
  // Shared remediations run at top priority — every other queued task is
  // waiting on this one resource (e.g. a clean main). Non-shared fix-tasks
  // stay at default priority; they only unblock the single source.
  const fixPriority = shared ? MAX_PRIORITY : 0

  await s.batch(
    [
      {
        sql: `INSERT INTO tasks (
              id, prompt, status,
              author_kind, author_name,
              fix_for_task_id, failure_signature,
              retry_count, origin_id, priority,
              created_at, updated_at
            ) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        args: [
          fixTaskId,
          prompt,
          FIX_TASK_AUTHOR_KIND,
          FIX_TASK_AUTHOR_NAME,
          input.sourceTaskId,
          input.failureSignature,
          source.originId,
          fixPriority,
          now,
          now,
        ],
      },
      {
        sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
            VALUES (?, ?, ?)`,
        args: [input.sourceTaskId, fixTaskId, now],
      },
      {
        sql: `UPDATE tasks
               SET status = 'blocked',
                   retry_count = ?,
                   error = ?,
                   updated_at = ?
             WHERE id = ?`,
        args: [nextRetryCount, errorSummary, now, input.sourceTaskId],
      },
      // Append-only ledger row for the sweeper's per-(parent,signature)
      // dedup + budget logic. Lives inside the same batch as the
      // fix-task INSERT so a rollback leaves no stray attempt row.
      {
        sql: `INSERT INTO self_heal_attempts (
              parent_task_id, failure_signature, fix_task_id, created_at
            ) VALUES (?, ?, ?, ?)`,
        args: [input.sourceTaskId, input.failureSignature, fixTaskId, now],
      },
    ],
    'write',
  )

  internalBus().emit('task.blocked', {
    taskId: input.sourceTaskId,
    fixTaskId,
    failureSignature: input.failureSignature,
    failingStep: input.failingStep,
  })

  return { fixTaskId, created: true }
}

// TODO: the orchestrator's verify step should reject any commit whose diff
// contains the `[DEBUG-` tag prefix produced by Phase 4 of this prompt.
// That gate is tracked as a separate task; until it lands, Phase 6 here is
// the only enforcement, and a missed grep-and-remove will only be caught
// by code review.
const buildInvestigatorPrompt = (input: {
  sourceTaskId: string
  originTaskId: string
  failingStep: string
  failureSignature: string
  truncatedError: string
  branch: string | null
  worktreePath: string | null
  reproCommand: string | null
  originalPrompt: string
}): string => {
  const worktreeLine = input.worktreePath
    ? `Worktree path (run repros from here): ${input.worktreePath}`
    : `Worktree path: <unknown — the failing task's worktree may have been cleaned up. If you cannot reach it, treat the failure as not-locally-reproducible and prefer option (b).>`

  const reproSection = input.reproCommand
    ? ['## Reproduce', '', '```', input.reproCommand, '```', '']
    : []

  const originalPromptSection =
    input.originalPrompt.trim().length > 0
      ? [
          `## Original task prompt`,
          '',
          `This is what the failing task was trying to do. Use it to judge whether the failure is a real product bug or a malformed task — outcome (b) is correct whenever the prompt itself is the problem (ambiguous, underspecified, or asking for the impossible).`,
          '',
          input.originalPrompt.trim(),
          '',
        ]
      : []

  return [
    `# Investigator task — diagnose the failure, then decide`,
    '',
    `Task ${input.sourceTaskId} (origin ${input.originTaskId}) failed with a signature that has no registered recovery recipe. Your job is NOT to fix the failing task. Your job is to DIAGNOSE the failure first, and only then decide between two outcomes — both of which are equally first-class:`,
    `  (a) the failure is mechanically recoverable by a coding agent and you can name a single root cause → propose a draft recipe by editing orchestrator/src/mastra/lib/fix-recipes.ts (and, if the signature ends in \`/unclassified\`, orchestrator/src/mastra/lib/failure-signature.ts), add a vitest test, and commit; or`,
    `  (b) **no recipe is the right answer** → file an inbox item via \`mars inbox raise --from -\` with priority='high' explaining the diagnosis and why a recipe would be wrong here.`,
    '',
    `Outcome (b) is NOT a fallback. It is the correct outcome whenever the failure is environmental, requires human credentials, depends on a flaky external dependency, or stems from an underspecified original task prompt. Examples that MUST route to inbox: a flaky network call, a missing API key, an ambiguous task description, a real product bug in the target repo, a one-off race condition you cannot deterministically reproduce. Writing a recipe for any of these would produce a vibe-recipe that pattern-matches noise.`,
    '',
    `Read docs/adr/0002-recipe-per-failure-signature.md before editing — every recipe must obey the contract there (recipe binds to a technical-key signature, recovery has retry budget 0, etc.).`,
    '',
    `## Failure context`,
    '',
    `Failing step: ${input.failingStep}`,
    `Failure signature: ${input.failureSignature}`,
    input.branch ? `Branch: ${input.branch}` : null,
    worktreeLine,
    `Originally failing task: ${input.sourceTaskId}`,
    `Origin task: ${input.originTaskId}`,
    '',
    'Last error output (tail-truncated):',
    '```',
    input.truncatedError,
    '```',
    '',
    ...originalPromptSection,
    ...reproSection,
    `## Diagnose discipline — work in this order`,
    '',
    `### Phase 1 — feedback loop first`,
    '',
    `Before forming any hypothesis, identify the **deterministic command** that reproduces the failure from the worktree path above. This is the single most important step. A diagnosis without a feedback loop is a guess.`,
    '',
    ` - If you can find a repro command, run it and confirm it reproduces the failure deterministically (same exit code, same key error string). Record the exact command.`,
    ` - If you CANNOT find a deterministic repro — e.g. the failure depends on network, on a credential you don't have, on timing, or on state that's already gone — say so explicitly in your commit message or inbox note and choose outcome (b). You MUST NOT draft a recipe without a repro. A recipe keyed to a failure you cannot trigger is a vibe-recipe.`,
    '',
    `### Phase 2 — 3–5 ranked falsifiable hypotheses`,
    '',
    `Before picking a signature slug or writing any recipe body, list 3–5 candidate root causes ranked by likelihood. Each hypothesis MUST be falsifiable and stated as:`,
    '',
    `> If <X> is the cause, then <Y> would change the outcome (running command Z, or observing signal W).`,
    '',
    `If you cannot phrase a candidate as a falsifiable "if/then", drop it — it's not a hypothesis, it's a vibe. Three sharp hypotheses beat five fuzzy ones.`,
    '',
    `Include this ranked list verbatim in the commit message (outcome a) OR in the inbox body (outcome b). The next person reading \`git log fix-recipes.ts\` or the inbox item must be able to see the alternatives you considered and ruled out.`,
    '',
    `### Phase 3 — pick the winning hypothesis by experiment, not by feel`,
    '',
    `Use the feedback loop from Phase 1 to falsify hypotheses one at a time, top-down. The first hypothesis whose "if/then" survives every check it predicts is your winner. If every hypothesis is falsified, return to Phase 2 with what you learned and generate new ones — do NOT pick the "least falsified" and pretend.`,
    '',
    `### Phase 4 — tagged debug logs (only if you instrument)`,
    '',
    `If you add any temporary logging, print statements, or instrumentation while diagnosing, prefix every such line with a unique tag of the form \`[DEBUG-<8hex>]\` (e.g. \`[DEBUG-a1b2c3d4]\`). Pick one tag for this entire session and reuse it. The tag makes the noise greppable and removable.`,
    '',
    `### Phase 5 — decide (a) or (b)`,
    '',
    `Apply the recipe test:`,
    ` - Can you name a single mechanical root cause that a coding agent could fix in a deterministic, bounded sequence of edits? → (a).`,
    ` - Is the cause environmental, credential-bound, human-judgement-bound, flaky, or rooted in an underspecified task prompt? → (b).`,
    '',
    `When in doubt, prefer (b). A missing recipe is recoverable next time the signature appears; a wrong recipe poisons every future occurrence.`,
    '',
    `### Phase 6 — grep-and-remove every \`[DEBUG-\` line BEFORE you commit`,
    '',
    `Run a search for your unique \`[DEBUG-<8hex>]\` tag across the worktree and remove every match. The orchestrator's verify step will reject any commit whose diff contains the \`[DEBUG-\` prefix, so a missed line will fail the merge. Re-grep after removal to confirm zero matches.`,
    '',
    `## What 'a draft recipe' means (outcome a only)`,
    '',
    `Add an entry to \`recipeList\` in orchestrator/src/mastra/lib/fix-recipes.ts. Its \`signature\` field MUST equal the signature above. Its \`buildPrompt\` returns the prompt for a recovery agent — concrete steps, exact paths, what to commit. Mirror the style of the existing recipes (\`merge:preflight/uncommitted-changes\`, \`setup:install/install-frozen-lockfile\`, \`verify:has-diff/no-commits-ahead\`).`,
    '',
    `If the signature ends in \`/unclassified\`, you must also add a rule to \`errorClassRules\` in orchestrator/src/mastra/lib/failure-signature.ts so future occurrences of this error map to a stable slug instead of \`unclassified\`. Pick the slug carefully — it becomes part of the technical-key signature contract.`,
    '',
    `## Commit message contract (outcome a only)`,
    '',
    `The commit that introduces the recipe MUST state, in plain prose, which of your ranked hypotheses the recipe is keyed to and why the others were ruled out. The next person reading \`git log fix-recipes.ts\` should learn the reasoning, not just see the recipe body. Include the deterministic repro command from Phase 1 in the commit message.`,
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
    'Do one of these now:',
    `  - Fix the underlying issue in the worktree, then run 'mars continue ${input.recoveryTaskId}' to resume on the existing worktree, or 'mars restart ${input.recoveryTaskId}' to wipe and re-run from setup.`,
    `  - Abandon the original task: run 'mars unblock ${input.originTaskId}'.`,
    `Then close this item: 'mars inbox resolve <item-id>'.`,
    '',
    `Why you're seeing this: recovery task ${input.recoveryTaskId} failed and the orchestrator will not retry it (recovery budget is 0 by design — see ADR 0002). Task ${input.originTaskId} stays 'blocked' until you act.`,
    '',
    'Context:',
    `  Failing step: ${input.failingStep}`,
    `  Failure signature: ${input.failureSignature}`,
    input.branch ? `  Branch: ${input.branch}` : null,
    input.worktreePath ? `  Worktree: ${input.worktreePath}` : null,
    input.claudeSessionId ? `  Claude session: ${input.claudeSessionId}` : null,
    '',
    'Last error output (tail-truncated):',
    '```',
    input.truncatedError,
    '```',
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
    `Wait for investigator task ${input.investigatorTaskId} to merge a draft recipe, then do one of these:`,
    `  - Re-attempt with the new recipe: run 'mars continue ${input.sourceTaskId}' to resume on the existing worktree, or 'mars restart ${input.sourceTaskId}' to wipe and re-run from setup.`,
    `  - Decide the failure is unrecoverable: run 'mars unblock ${input.originTaskId}'.`,
    `Then close this item: 'mars inbox resolve <item-id>'.`,
    '',
    `Why you're seeing this: task ${input.sourceTaskId} (origin ${input.originTaskId}) failed with signature \`${input.failureSignature}\` and no recovery recipe is registered for it. Investigator ${input.investigatorTaskId} is queued to propose one — it does not fix the failing task. Task ${input.sourceTaskId} is marked 'failed'; use mars continue or mars restart to retry once a recipe is available.`,
    '',
    'Context:',
    `  Failing step: ${input.failingStep}`,
    `  Failure signature: ${input.failureSignature}`,
    input.branch ? `  Branch: ${input.branch}` : null,
    '',
    'Last error output (tail-truncated):',
    '```',
    input.truncatedError,
    '```',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

const buildFixFailLoopBody = (input: {
  sourceTaskId: string
  originTaskId: string
  failingStep: string
  failureSignature: string
  branch: string | null
  truncatedError: string
  attempts: number
  cap: number
}): string => {
  return [
    'Do one of these now:',
    `  - Diagnose the root cause from the source task and its recovery history, then run 'mars continue ${input.sourceTaskId}' to resume on the existing worktree, or 'mars restart ${input.sourceTaskId}' to wipe and re-run from setup.`,
    `  - Abandon the source task: run 'mars unblock ${input.sourceTaskId}'.`,
    `Then close this item: 'mars inbox resolve <item-id>'.`,
    '',
    `Why you're seeing this: task ${input.sourceTaskId} (origin ${input.originTaskId}) hit the fix-fail retry cap of ${input.cap} for signature \`${input.failureSignature}\` after ${input.attempts} attempt(s). The orchestrator has stopped auto-retrying this pair. Task ${input.sourceTaskId} stays 'blocked' until you act.`,
    '',
    'Context:',
    `  Failing step: ${input.failingStep}`,
    `  Failure signature: ${input.failureSignature}`,
    input.branch ? `  Branch: ${input.branch}` : null,
    `  Prior fix-task attempts: ${input.attempts}`,
    `  Cap (MARS_MAX_FIX_ATTEMPTS): ${input.cap}`,
    '',
    'Last error output (tail-truncated):',
    '```',
    input.truncatedError,
    '```',
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
  reproCommand: string | null
  store?: TaskStore
}): Promise<SpawnInvestigatorResult> => {
  const s = input.store ?? (await getDefaultTaskStore())
  const investigatorPrompt = buildInvestigatorPrompt({
    sourceTaskId: input.sourceTask.id,
    originTaskId: input.sourceTask.originId,
    failingStep: input.failingStep,
    failureSignature: input.failureSignature,
    truncatedError: input.truncatedError,
    branch: input.branch,
    worktreePath: input.sourceTask.worktreePath,
    reproCommand: input.reproCommand,
    originalPrompt: input.sourceTask.prompt ?? '',
  })

  const investigatorTaskId = randomUUID().slice(0, 8)
  const errorSummary = truncate(
    `${input.failingStep}: ${input.truncatedError}`,
    1000,
  )
  const now = new Date().toISOString()

  await s.batch(
    [
      {
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
      },
      // Source task: mark it failed. There is no task_blockers edge to wait on —
      // the investigator does not unblock the source (a merged recipe doesn't
      // retroactively fix the past failure). Human resolves via mars continue /
      // mars restart once the investigator merges a recipe.
      {
        sql: `UPDATE tasks
               SET status = 'failed',
                   retry_count = retry_count + 1,
                   error = ?,
                   updated_at = ?
             WHERE id = ?`,
        args: [errorSummary, now, input.sourceTask.id],
      },
    ],
    'write',
  )

  const inboxItemId = await raiseInboxItem({
    kind: NO_RECIPE_INBOX_KIND,
    category: 'orchestrator',
    priority: 'high',
    title: `Retry or abandon ${input.sourceTask.id}: no recovery recipe for ${input.failureSignature}`,
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
    // Collapse all failure-kinds for the same origin into one row.
    originTaskId: input.sourceTask.originId,
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
  /**
   * All verify steps that actually ran for this task, in order, carrying
   * their exact commands and directories. When present, the reproduce
   * command is derived from these records via {@link buildVerifyReproHint}
   * rather than the hardcoded JavaScript-specific mapping in
   * {@link deriveReproCommand}. Pass this from the verify step so
   * multi-language and full-stack failures produce accurate repro hints.
   */
  ranVerifySteps?: readonly RanVerifyStep[]
  /**
   * TaskStore threaded in from the workflow composition root. When
   * provided, getTask and updateTask calls inside this handler route
   * through the store rather than going through the module-singleton client.
   */
  store?: TaskStore
}

export interface HandleTaskFailureViaTaskResult {
  outcome:
    | 'blocked'
    | 'failed'
    | 'escalated'
    | 'fix-fail-loop'
    | 'no-recipe'
    | 'noop'
  fixTaskId?: string
  failureSignature?: string
  retryCount?: number
  inboxItemId?: string
  investigatorTaskId?: string
  attempts?: number
}

/**
 * Failure-handler entrypoint. Terminal outcomes:
 *
 *  - `blocked`: original task → blocked, recovery fix-task enqueued from
 *     the registered recipe for the computed signature.
 *  - `escalated`: the failing task is itself a recovery (fix_for_task_id
 *     set). Recovery has a retry budget of 0; we mark it failed and
 *     raise a `recovery-failed` inbox item for human attention.
 *  - `no-recipe`: signature has no recipe registered. Original task →
 *     failed, an Investigator task is queued to propose a draft recipe,
 *     and a `no-recipe` inbox item is raised.
 *  - `fix-fail-loop`: (sourceTaskId, failureSignature) pair has already
 *     burned its fix-task attempts cap (`MARS_MAX_FIX_ATTEMPTS`, default
 *     2). No new fix task is inserted; a deduped `fix-fail-loop` inbox
 *     item is raised and the source task stays in `blocked` with its
 *     existing error summary.
 *
 * Plus `failed` when the legacy retry budget for the original task is
 * exhausted, and `noop` when the task row vanished.
 */
export const CANCELLED_FAILURE_REASON = 'cancelled'

export const handleTaskFailureWithFixTask = async (
  input: HandleTaskFailureViaTaskInput,
): Promise<HandleTaskFailureViaTaskResult> => {
  const s = input.store ?? (await getDefaultTaskStore())
  const task: Task | null = await getTask(input.taskId, s)
  if (!task) return { outcome: 'noop' }

  // PRD slice 2/4 (mars-9234e1b2): cancellation gate. When the
  // stop-task RPC (slice 1) marks a task failed with
  // failure_reason='cancelled', self-heal must NOT spawn a fix-task —
  // the user explicitly killed it. Skip regardless of how this handler
  // was reached (workflow exitCode-137 path, in-flight abort, or any
  // later call site). Centralised here so every call site honours the
  // gate without auditing five workflow branches.
  if (task.failureReason === CANCELLED_FAILURE_REASON) {
    // eslint-disable-next-line no-console
    console.log(
      `[failure-handler] task ${input.taskId} failure is cancelled-by-user, skipping fix-task spawn`,
    )
    return { outcome: 'noop' }
  }

  const { computeFailureSignature } = await import('./lib/failure-signature')

  // Diagnose Chores are terminal: a failing diagnose Chore must never
  // spawn a fix task or investigator — that would re-introduce the
  // unbounded recursion the Chore was created to break. Mark it failed
  // directly; the daemon's failure callback (slice 6) raises the operator
  // inbox item for explicit resolution.
  if (task.kind === 'diagnose') {
    const failureSignature = computeFailureSignature(
      input.failingStep,
      input.errorOutput,
    )
    await markTaskFailed(
      input.taskId,
      `diagnose_chore_failed:${failureSignature}`,
    )
    return {
      outcome: 'failed',
      failureSignature,
      retryCount: task.retryCount,
    }
  }

  // Re-use the already-imported computeFailureSignature below.
  const failureSignature = computeFailureSignature(
    input.failingStep,
    input.errorOutput,
  )
  const truncatedError = truncateFailure(input.errorOutput)
  const branch = input.branch ?? task.branch
  const reproCommand =
    input.ranVerifySteps && input.ranVerifySteps.length > 0
      ? buildVerifyReproHint(input.ranVerifySteps)
      : deriveReproCommand(input.failingStep, task.worktreePath)

  // Kill-switch: when MARS_RECOVERY_DISABLED=1, never spawn fix-tasks or
  // Investigators. Mark the failing task failed and stop. Recovery (fix-
  // tasks already in flight) is escalated to inbox as usual so a partial
  // disable doesn't leave them silently dangling.
  if (process.env.MARS_RECOVERY_DISABLED === '1' && task.fixForTaskId === null) {
    await markTaskFailed(
      input.taskId,
      `recovery_disabled:${failureSignature}: ${truncatedError.slice(0, 500)}`,
    )
    return {
      outcome: 'failed',
      failureSignature,
      retryCount: task.retryCount,
    }
  }

  // Recovery (fix-task) failures escalate to inbox; never spawn another
  // recovery. See ADR 0002 — this is the rule that broke the cascade.
  if (task.fixForTaskId !== null) {
    await updateTask(input.taskId, {
      status: 'failed',
      error: `recovery_failed:${failureSignature}: ${truncatedError.slice(0, 500)}`,
    }, s)

    const originId = task.originId
    const inboxSignature = `${originId}:${failureSignature}`
    const inboxItemId = await raiseInboxItem({
      kind: RECOVERY_FAILED_INBOX_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: `Fix and retry ${input.taskId}, or abandon ${originId}: recovery failed at ${input.failingStep}`,
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
      // Collapse all failure-kinds for the same origin into one row.
      originTaskId: originId,
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

  if (task.retryCount > budget) {
    await markTaskFailed(
      input.taskId,
      `retry_budget_exhausted:${failureSignature}`,
    )
    await raiseRetryBudgetExhaustedInbox({
      taskId: input.taskId,
      lastStep: input.failingStep,
      retryCount: task.retryCount,
      lastErrorSignature: failureSignature,
      lastErrorSummary: truncatedError,
      branch,
      worktreePath: task.worktreePath,
    })
    return {
      outcome: 'failed',
      failureSignature,
      retryCount: task.retryCount,
    }
  }

  // FUTURE: unrelated-flake short-circuit goes here, BEFORE the recipe
  // lookup. When `input.failingStep === 'verify:test-failed'`, compare
  // the failing test file paths against `task.spec?.files`; if there is
  // zero overlap AND the same tests already fail on integrationBranch,
  // park the source in a new `'flake-blocked'` status, raise an inbox
  // item, and return without enqueueing a fix-task. Dependencies (file
  // separately, then wire here):
  //   - parser for failing test paths (idea 5710b256)
  //   - 'flake-blocked' TaskStatus + plumbing (idea abfca8d8)
  //   - integration-branch re-run helper (idea b4da8c0e)
  //   - structured failure-context plumbing on this entrypoint
  //     (idea adee06a6) — must extend HandleTaskFailureViaTaskInput
  //     with spec.files + pre-computed integration re-run results,
  //     since classifyError today only sees errorOutput.
  // No recipe for this signature — do NOT fall back to a generic prompt
  // (that's what produced the cascade). Mark the source 'failed',
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
        reproCommand,
        store: s,
      })
    return {
      outcome: 'no-recipe',
      failureSignature,
      retryCount: task.retryCount + 1,
      investigatorTaskId,
      inboxItemId,
    }
  }

  // Fix-fail-loop cap. Count every historical fix-task row for this
  // (sourceTaskId, failureSignature) pair regardless of status. When
  // the cap is hit, stop inserting new fix tasks and escalate to the
  // inbox; repeat escalations dedupe on (kind, signature) fingerprint
  // and bump seenCount on the existing row. Source task stays in
  // 'blocked' with its existing error summary — never silently flipped
  // back to 'queued'.
  const cap = getMaxFixAttempts()
  const priorAttempts = await countFixTaskAttempts(
    input.taskId,
    failureSignature,
    s,
  )
  if (priorAttempts >= cap) {
    // AUDIT (mars-88a4e657): safe site for the "blocked-implies-edge"
    // invariant. We re-stamp 'blocked' here AFTER `priorAttempts >= cap`,
    // which means at least one earlier `upsertFixTask` call already
    // inserted a `task_blockers` edge for this (sourceTaskId, signature)
    // pair in the same transaction that first blocked the task. The edge
    // survives until explicitly cleared by `mars unblock`, so this branch
    // re-stamps a status the row already has.
    const now = new Date().toISOString()
    await s.execute({
      sql: `UPDATE tasks
               SET status = 'blocked', updated_at = ?
             WHERE id = ?`,
      args: [now, input.taskId],
    })

    const inboxItemId = await raiseInboxItem({
      kind: FIX_FAIL_LOOP_INBOX_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: `Diagnose and retry, or abandon ${input.taskId}: fix-fail loop on ${failureSignature}`,
      body: buildFixFailLoopBody({
        sourceTaskId: input.taskId,
        originTaskId: task.originId,
        failingStep: input.failingStep,
        failureSignature,
        branch,
        truncatedError,
        attempts: priorAttempts,
        cap,
      }),
      payload: {
        sourceTaskId: input.taskId,
        originTaskId: task.originId,
        failingStep: input.failingStep,
        failureSignature,
        attempts: priorAttempts,
        cap,
        branch,
      },
      context: {
        repoRoot: process.env.MARS_REPO ?? null,
      },
      raisedBy: 'agent:fail-fix-handler',
      // Dedup on the failure signature so repeat escalations bump
      // seenCount instead of spawning new rows. No signature string is
      // hardcoded — the value flows from the classifier.
      signature: failureSignature,
      // Collapse all failure-kinds for the same origin into one row.
      originTaskId: task.originId,
      occurrence: {
        at: now,
        sourceTaskId: input.taskId,
        failingStep: input.failingStep,
        attempts: priorAttempts,
      },
    })

    internalBus().emit('task.blocked', {
      taskId: input.taskId,
      fixTaskId: null,
      failureSignature,
      failingStep: input.failingStep,
    })

    return {
      outcome: 'fix-fail-loop',
      failureSignature,
      retryCount: task.retryCount,
      inboxItemId,
      attempts: priorAttempts,
    }
  }

  const baseRecipeContext: FixRecipeContext = input.recipeContext ?? {
    targetPath: task.worktreePath ?? '',
    statusOutput: truncatedError,
    targetBranch: branch ?? '',
    originalPrompt: task.prompt ?? '',
  }
  // Always populate `originalPrompt` from the loaded source task so the
  // recovery agent receives the original intent verbatim, not just the
  // incident. Default to '' only when the source genuinely has no prompt.
  const incomingOriginalPrompt = baseRecipeContext.originalPrompt
  const recipeContext: FixRecipeContext = {
    ...baseRecipeContext,
    reproCommand: baseRecipeContext.reproCommand ?? reproCommand,
    originalPrompt:
      incomingOriginalPrompt && incomingOriginalPrompt.trim().length > 0
        ? incomingOriginalPrompt
        : task.prompt ?? '',
  }

  const result = await upsertFixTask({
    sourceTaskId: input.taskId,
    failureSignature,
    failingStep: input.failingStep,
    truncatedError,
    branch,
    recipeContext,
    store: s,
  })

  return {
    outcome: 'blocked',
    fixTaskId: result.fixTaskId,
    failureSignature,
    retryCount: task.retryCount + 1,
  }
}
