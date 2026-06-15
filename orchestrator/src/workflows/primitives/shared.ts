/**
 * Pure, dependency-light helpers and sentinels shared between the bundled
 * `implement-workflow.ts` and the git step primitives (`./index.ts`).
 *
 * These were formerly defined inline in `implement-workflow.ts`. They are
 * hoisted here so the primitive surface can reuse them WITHOUT a circular
 * import back into the workflow module (implement-workflow imports the
 * primitives; the primitives import only these pure pieces). `implement-workflow`
 * re-exports every public symbol from this file unchanged, so existing call
 * sites and tests keep importing them from `../implement-workflow`.
 */
import { z } from 'zod'
import { relative } from 'node:path'

import { runTool, nullTraceStore, type TraceCtx } from '../../core/lib/run-tool'
import {
  TASK_TYPES,
  type TaskTag,
  type TaskSpec,
  type Task,
} from '../../core/queue'
import { resolveTaskCwd } from '../../core/lib/resolve-task-cwd'
import { TDD_WORKER_BRIEF } from '../tdd-brief'
import { CONTEXT_GATHERING_BRIEF } from '../context-gathering-brief'
import type { WorkerName } from '../../core/workers'

// ---------------------------------------------------------------------------
// Schemas mirrored from the workflow input contract
// ---------------------------------------------------------------------------

export const planSchema = z
  .object({
    functional: z.string(),
    technical: z.string(),
  })
  .nullable()

// Worker-routing tags list, mirroring {@link Task.tags}.
export const tagSchema: z.ZodType<TaskTag[]> = z.array(z.string()).default(['coder'])

// Task role, mirroring {@link TaskKind}.
export const kindSchema = z.enum(['task', 'fix', 'diagnose']).default('task')

// Structured-task contract. Mirrors {@link TaskSpec} in queue.ts.
export const specSchema = z
  .object({
    files: z.array(z.string()),
    verifyCmd: z.string().nullable(),
    previewCmd: z.string().nullable().default(null),
    doneCriteria: z.array(z.string()),
    taskType: z.enum(TASK_TYPES as readonly ['auto', 'checkpoint']),
    readFirst: z.array(z.string()).default([]),
    prescriptiveAction: z.string().nullable().default(null),
  })
  .nullable()
  .default(null)

// ---------------------------------------------------------------------------
// Failure sentinels (message builders + detectors)
// ---------------------------------------------------------------------------

export const BLOCKERS_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} has incomplete blockers; aborting dispatch (task remains queued)`

// The failure model is THROW: a step that hits a terminal failure performs its
// self-heal side-effects and THEN throws a sentinel-carrying Error. The engine
// records the step failed and returns the thrown Error verbatim on
// `RunResult.error`. We walk the `cause` chain (depth-bounded against cycles)
// so a future wrapping layer is still recognised.
const errorHaystack = (err: unknown): string => {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; cur != null && depth < 10; depth += 1) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      cur = cur.cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join(' :: ')
}

export const isBlockersAbortError = (err: unknown): boolean =>
  errorHaystack(err).includes('has incomplete blockers; aborting dispatch')

// Thrown by the verify step's dirty-main check.
export const MAIN_DIRTY_VERIFY_MESSAGE =
  'integration branch dirty before verify; parked behind main-commiter recovery'

export const isMainDirtyVerifyError = (err: unknown): boolean =>
  errorHaystack(err).includes('verify:main-dirty')

// Thrown by the merge step's dirty-main check.
export const MAIN_DIRTY_MERGE_MESSAGE =
  'integration branch dirty before merge; parked behind main-commiter recovery'

export const isMainDirtyMergeError = (err: unknown): boolean =>
  errorHaystack(err).includes('merge:main-dirty')

// Thrown by the code step when the context token budget fires.
export const CONTEXT_EXHAUSTED_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} aborted by context-budget ceiling: coder hit the context token limit`

export const isContextExhaustedAbortError = (err: unknown): boolean =>
  errorHaystack(err).includes('aborted by context-budget ceiling')

// Thrown by the setup step when a recovery cannot attach to a missing origin worktree.
export const ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE = (taskId: string): string =>
  `recovery ${taskId} aborted: origin worktree is missing and cannot be attached`

export const isOriginWorktreeMissingAbortError = (err: unknown): boolean =>
  errorHaystack(err).includes('origin worktree is missing and cannot be attached')

// Thrown by the code step when the coder process exits non-zero before doing
// any work (e.g. claude rejecting a bad --session-id). Without this the empty
// worktree would pass verify and merge as a false "done".
export const CODER_EXIT_NONZERO_ABORT_MESSAGE = (
  taskId: string,
  exitCode: number,
): string => `coder for task ${taskId} exited ${exitCode} before completing`

export const isCoderExitNonzeroAbortError = (err: unknown): boolean =>
  /coder for task .+ exited -?\d+ before completing/.test(errorHaystack(err))

// Thrown by the merge step's preview gate when a task carries a previewCmd and
// has not yet been validated. The step starts a live dev server, parks the task
// in 'awaiting-validation', raises the action-queue row, then throws this so the
// 'merge' step does NOT checkpoint as completed — the operator's Validate click
// re-queues the task and the engine re-enters merge past the gate. The daemon
// dispatch loop detects this sentinel and suppresses failure handling (the task
// is intentionally parked, not failed).
export const PREVIEW_GATE_MESSAGE = (taskId: string): string =>
  `task ${taskId} parked at preview gate; awaiting operator validation`

export const isPreviewGateError = (err: unknown): boolean =>
  errorHaystack(err).includes('parked at preview gate; awaiting operator validation')

// ---------------------------------------------------------------------------
// Prompt briefs + system-prompt assembly
// ---------------------------------------------------------------------------

// Mandatory footer appended to every implementor prompt.
export const COMMIT_FOOTER = [
  '## Save your work',
  '',
  'Before exiting, stage and commit every file you intend to land:',
  '',
  '```',
  'git add -A',
  'git commit -m "<message describing the change>"',
  '```',
  '',
  '`git add` alone is not enough — staged-but-uncommitted changes are invisible to verify and the merge step. You must run `git commit`.',
  '',
  'Then, as the final action before exiting, self-check that the commit landed on your branch. Run:',
  '',
  '```',
  'git rev-list --count HEAD ^$(git merge-base HEAD @{upstream} 2>/dev/null || git rev-parse origin/main 2>/dev/null || echo HEAD)',
  '```',
  '',
  'or, more simply, count commits since branching off integration:',
  '',
  '```',
  'git rev-list --count $(git rev-parse --abbrev-ref HEAD)@{u}..HEAD 2>/dev/null || git rev-list --count main..HEAD',
  '```',
  '',
  'The number MUST be greater than `0`. If it prints `0`, you have not committed your work — re-run `git commit` and re-check. Do not exit while this number is `0`; the verify step rejects such runs with `verify:has-diff/no-commits-ahead`, which means the agent did not commit.',
  '',
  'A separate failure mode, `verify:dirty-main`, means the merge target was already dirty before your branch landed. That is an operator-owned condition, not your responsibility.',
  '',
  'The orchestrator does not commit on your behalf.',
].join('\n')

// Deviation-rules brief delivered to every Coder session.
export const DEVIATION_RULES = [
  '## Deviation rules — do NOT quit silently',
  '',
  'You WILL discover work not in the brief. Apply these rules without asking. Bailing out without filing one of the artifacts below is not in the menu.',
  '',
  '**Rule 1 — Auto-fix bugs.** If the code you touched in scope doesn\'t work (wrong logic, type errors, null deref, broken validation, race), fix it inline. No permission needed. Log the fix in your final commit message.',
  '',
  '**Rule 2 — Auto-add missing critical functionality.** If correctness/security/operability is missing from your scope (error handling, input validation, auth on a protected route, an index on a hot query, error logging on a failure path), add it. These are correctness requirements, not features.',
  '',
  '**Rule 3 — Auto-fix blocking issues.** If something prevents completing the current task (broken import, missing env var, wrong type, missing referenced file, circular dep), fix it. Exception: a failed package install is NEVER auto-fixed — return a checkpoint and stop (see Rule 4).',
  '',
  '**Rule 4 — Surface architectural changes as new tasks.** When the brief\'s scope would require a new DB table, a new service layer, switching a library, changing auth, or any other architectural decision the user has not signed off on:',
  '',
  '  1. STOP. Do not silently expand scope.',
  '  2. Run `mars task add "<self-contained prompt>" --blocked-by $TASK_ID` to create a follow-up. Set the parent (this task) as a blocker so the parent waits for the new work.',
  '  3. For deferred refactors / observed cleanups that should NOT block this slice, run `mars proposal add "<observation>"` so the loose end is captured but parked in the proposal backlog.',
  '  4. Commit whatever in-scope work is already complete, then exit. The orchestrator will re-dispatch this task once the new blocker resolves.',
  '',
  '**Scope boundary.** Only fix issues your changes touch. Pre-existing warnings, linting errors, or failures in unrelated files are out of scope — file them with `mars proposal add "<observation>"` if interesting; do NOT fix them inline.',
  '',
  '**Fix-attempt cap.** If you have run the verify command 3 times on this task and it still fails for reasons you cannot explain, STOP. File a follow-up task via `mars task add --blocked-by $TASK_ID` describing the failing verify and what you tried, then exit. Do not loop.',
  '',
  '**Explore-trust rule — treat sub-agent summaries as authoritative.** When an Explore or general-purpose sub-agent returns a structured summary citing file paths and line numbers, treat that summary as authoritative orientation. Proceed directly to an Edit or Write within at most TWO follow-up Reads, and only Read ranges the sub-agent did NOT cover. Re-reading a file the sub-agent already summarised counts as analysis paralysis.',
  '',
  '`$TASK_ID` is the id of the task you are executing right now; the orchestrator passes it to you in the brief below.',
].join('\n')

// Three concrete failure modes observed across real coder transcripts.
export const CODING_DISCIPLINE = [
  '## Coding discipline',
  '',
  '- **No single-caller helpers.** Only extract a function when two or more call sites use it. A helper with one caller fails the deletion test — inline it.',
  '- **Test observable behaviour, not internal state.** Never assert on private fields, internal queues, or implementation details. A test that breaks on a safe internal refactor is a bad test.',
  '- **Cross-boundary changes need real-boundary verification.** When you add a cap, limit, or guard on a subprocess or external call, include at least one test (or documented manual step) against the real binary or service — stub-only tests can pass while the real path misbehaves.',
].join('\n')

// Build the Coder Worker's standing Session instructions.
export const buildCoderSystemPrompt = (): string =>
  [TDD_WORKER_BRIEF, CONTEXT_GATHERING_BRIEF, DEVIATION_RULES].join('\n\n')

// Standing Session instructions for the Coder Worker.
export const CODER_SYSTEM_PROMPT = buildCoderSystemPrompt()

// Resolve the standing Session instructions a dispatched Worker is launched with.
export const resolveWorkerSystemPrompt = (_tag: TaskTag): string =>
  buildCoderSystemPrompt()

/**
 * Pick the Worker that should handle a dispatched Task. fix → Fixer; else Coder.
 */
export const pickWorkerForTask = (task: Pick<Task, 'kind'>): WorkerName =>
  task.kind === 'fix' ? 'Fixer' : 'Coder'

/**
 * Decide whether a dispatched task's setup step should ATTACH to its origin's
 * existing worktree (true) or CREATE a fresh `task/<id>` worktree (false).
 */
export const recoveryAttachesToOrigin = (
  kind: 'task' | 'fix' | 'diagnose',
  isMainCommiter: boolean,
): boolean => kind === 'fix' && !isMainCommiter

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

const renderSpec = (spec: TaskSpec | null, taskId: string): string | null => {
  if (!spec) return null
  const parts: string[] = []
  if (spec.taskType === 'checkpoint') {
    parts.push(
      `<task_type>checkpoint — pause for human verification before merge</task_type>`,
    )
  } else {
    parts.push(`<task_type>auto — execute end-to-end and commit</task_type>`)
  }
  if (spec.files.length > 0) {
    const lines = spec.files.map((f) => `  - ${f}`).join('\n')
    parts.push(`<files>\n${lines}\n</files>`)
  }
  const readFirst = spec.readFirst ?? []
  if (readFirst.length > 0) {
    const lines = readFirst.map((f, i) => `  ${i + 1}. ${f}`).join('\n')
    parts.push(`<read_first>\n${lines}\n</read_first>`)
  }
  const prescriptiveAction = spec.prescriptiveAction ?? null
  if (prescriptiveAction && prescriptiveAction.trim().length > 0) {
    parts.push(
      `<prescriptive_action>\n${prescriptiveAction.trim()}\n</prescriptive_action>`,
    )
  }
  if (spec.verifyCmd && spec.verifyCmd.trim().length > 0) {
    parts.push(`<verify>\n${spec.verifyCmd.trim()}\n</verify>`)
  }
  if (spec.doneCriteria.length > 0) {
    const lines = spec.doneCriteria.map((c) => `  - [ ] ${c}`).join('\n')
    parts.push(`<done>\n${lines}\n</done>`)
  }
  parts.push(`<task_id>${taskId}</task_id>`)
  return `## Structured-task contract\n\n${parts.join('\n\n')}`
}

// Build the "## Worktree orientation" preamble.
const renderOrientation = (worktreeRoot: string, taskCwd: string): string => {
  if (taskCwd === worktreeRoot) {
    return [
      '## Worktree orientation',
      '',
      `You operate from this worktree root: ${worktreeRoot}`,
      '',
      'Run verification, typecheck, and build commands from the worktree root.',
    ].join('\n')
  }
  const sub = relative(worktreeRoot, taskCwd) || '.'
  return [
    '## Worktree orientation',
    '',
    `You are at worktree root: ${worktreeRoot}`,
    `Project subdirectory for tests, typecheck, and build commands: ${taskCwd}`,
    '',
    'Run verification commands from the project subdirectory:',
    `  cd ${sub} && <verifyCmd>`,
  ].join('\n')
}

export const composePrompt = (
  prompt: string,
  plan: z.infer<typeof planSchema>,
  tag: TaskTag = 'coder',
  spec: TaskSpec | null = null,
  taskId = '',
  worktreeRoot = '',
  kind: 'task' | 'fix' | 'diagnose' = 'task',
): string => {
  // Diagnose Chore short-circuit: the prompt arrives fully composed.
  if (kind === 'diagnose') return prompt.trim()
  const sections: string[] = [prompt.trim()]
  if (plan?.functional?.trim()) {
    sections.push(`## Functional plan\n\n${plan.functional.trim()}`)
  }
  if (plan?.technical?.trim()) {
    sections.push(`## Technical plan\n\n${plan.technical.trim()}`)
  }
  // Orientation must come BEFORE the structured-task spec block.
  if (worktreeRoot.length > 0) {
    const taskCwd = resolveTaskCwd(worktreeRoot, spec?.files ?? [])
    sections.push(renderOrientation(worktreeRoot, taskCwd))
  }
  const specBlock = renderSpec(spec, taskId)
  if (specBlock !== null) sections.push(specBlock)
  sections.push(CODING_DISCIPLINE)
  sections.push(COMMIT_FOOTER)
  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Failure excerpt
// ---------------------------------------------------------------------------

// Retain a small head (catches early crashes) AND the tail (catches the
// assertion diff + final FAIL summary), joined by an elision marker.
export const failureExcerpt = (
  output: string,
  tailMax = 2000,
  headMax = 1000,
): string => {
  if (output.length <= tailMax + headMax) return output
  return `${output.slice(0, headMax)}\n…[middle elided]…\n${output.slice(-tailMax)}`
}

// ---------------------------------------------------------------------------
// Post-coder worktree classifier
// ---------------------------------------------------------------------------

export interface PostCoderStateArgs {
  worktreePath: string
  integrationBranch: string
  /** Optional trace context; when populated, the git shell-outs emit events. */
  traceCtx?: TraceCtx
}

export type PostCoderState =
  | { kind: 'dirty-no-commits'; dirtyFiles: string[] }
  | { kind: 'clean-with-commits'; commitsAhead: number }
  | { kind: 'clean-no-work' }
  | { kind: 'error'; error: string }

// Parse `git status --porcelain=v1` into a list of paths.
const parsePorcelainPaths = (raw: string): string[] => {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    const after = line.slice(3)
    const arrowIdx = after.indexOf(' -> ')
    const path = arrowIdx === -1 ? after : after.slice(arrowIdx + 4)
    out.push(path.replace(/^"|"$/g, ''))
  }
  return out
}

export const detectPostCoderState = async (
  args: PostCoderStateArgs,
): Promise<PostCoderState> => {
  const store = args.traceCtx?.store ?? nullTraceStore
  const baseCtx = {
    taskId: args.traceCtx?.taskId ?? null,
    originId: args.traceCtx?.originId ?? null,
    phase: args.traceCtx?.phase ?? ('code' as const),
  }

  let commitsAhead: number
  try {
    const r = await runTool(
      {
        tool: 'git',
        argv: ['rev-list', '--count', `${args.integrationBranch}..HEAD`],
        cwd: args.worktreePath,
        ...baseCtx,
      },
      store,
    )
    if (r.exitCode !== 0) {
      return {
        kind: 'error',
        error: `rev-list ${args.integrationBranch}..HEAD failed (exit ${r.exitCode}): ${r.stderr}`,
      }
    }
    const parsed = Number.parseInt(r.stdout.trim(), 10)
    if (!Number.isInteger(parsed)) {
      return { kind: 'error', error: `rev-list emitted non-integer: ${r.stdout.trim()}` }
    }
    commitsAhead = parsed
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', error: `rev-list ${args.integrationBranch}..HEAD failed: ${message}` }
  }

  let dirtyFiles: string[]
  try {
    const r = await runTool(
      {
        tool: 'git',
        argv: ['status', '--porcelain=v1', '--untracked-files=all'],
        cwd: args.worktreePath,
        ...baseCtx,
      },
      store,
    )
    if (r.exitCode !== 0) {
      return { kind: 'error', error: `git status failed (exit ${r.exitCode}): ${r.stderr}` }
    }
    dirtyFiles = parsePorcelainPaths(r.stdout)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', error: `git status failed: ${message}` }
  }

  if (commitsAhead > 0) {
    return { kind: 'clean-with-commits', commitsAhead }
  }
  if (dirtyFiles.length === 0) {
    return { kind: 'clean-no-work' }
  }
  return { kind: 'dirty-no-commits', dirtyFiles }
}
