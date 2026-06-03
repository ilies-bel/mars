import { defineWorkflow, type StepHandle, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'

import { runTool, nullTraceStore, type TraceCtx } from '../core/lib/run-tool'
import {
  cleanWorktreeIfNoCommitsAhead,
  createWorktree,
  removeWorktree,
  verifyChanges,
  loadVerifyScopes,
  selectVerifySteps,
  getChangedFiles,
  mergeBranch,
  checkMergeTargetStatus,
} from '../core/lib/git'
import { createWorker, pickWorkerForTags, Workers, type Worker, type WorkerName } from '../core/workers'
import {
  TASK_TAGS,
  isTaskTag,
  TASK_TYPES,
  type TaskTag,
  type TaskSpec,
  type Task,
} from '../core/queue'
import { resolveContext } from '../core/context'
import {
  installWorktreeDeps,
  ensureLocalDistBuilt,
  WorktreeInstallError,
} from '../core/lib/worktree-install'
import type { ClaudeEvent } from '../core/lib/claude-stream'
import {
  enqueueTask,
  addBlockers,
  hasIncompleteBlockers,
  updateTask,
} from '../core/queue'
import { handleTaskFailureWithFixTask } from '../core/queue-fix-tasks'
import { failureReasonStringToCode } from '../core/lib/failure-reasons'
import { resolveOriginIdForTask } from '../core/lib/origin'
import { type TaskStore } from '../core/lib/task-store'

export const BLOCKERS_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} has incomplete blockers; aborting dispatch (task remains queued)`

// The failure model is THROW: a step that hits a terminal failure performs
// its self-heal side-effects (updateTask + handleTaskFailureWithFixTask) and
// THEN throws a sentinel-carrying Error. The @mars/workflow engine records
// that step `status:'failed'` and `runWorkflow` returns `{status:'failed',
// error}` with the thrown Error verbatim on `RunResult.error` (the engine's
// `toError` passes an Error through unchanged — see packages/workflow's
// workflow.ts). The engine does NOT wrap our Error the way Mastra used to,
// so the common case is a bare sentinel on `err.message`. We still walk the
// `cause` chain (depth-bounded against cycles) so a future wrapping layer —
// or a test that deliberately nests the sentinel on `.cause` — is still
// recognised.
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

// Thrown by the verify step's slice-F.2 dirty-main check. The verify step
// detects an uncommitted state on the integration branch and parks the task
// `blocked` behind a `main-commiter` recovery via `spawnOrAttachMainCommitter`
// before throwing this sentinel. The daemon's `isMainDirtyVerifyError`
// suppresses the misleading `task.completed status=failed` emit so the
// `blocked` state stands.
export const MAIN_DIRTY_VERIFY_MESSAGE =
  'integration branch dirty before verify; parked behind main-commiter recovery'

export const isMainDirtyVerifyError = (err: unknown): boolean =>
  errorHaystack(err).includes('verify:main-dirty')

// Thrown by the code step when the read-span guard trips (agent read without
// acting) and we successfully spawn a diagnose Chore and park the original
// task in `blocked`. The daemon uses it to suppress the misleading
// `task.completed status=failed` emit — the task is already parked
// `blocked` with a real task_blockers edge to the diagnose Chore.
export const TOO_HARD_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} aborted by read-span guard: diagnose Chore spawned, parent parked in blocked`

export const isTooHardAbortError = (err: unknown): boolean =>
  errorHaystack(err).includes('aborted by read-span guard: diagnose Chore spawned')

// Thrown by the code step when the read-span hard-abort ceiling fires
// (MARS_READ_SPAN_ABORT_LIMIT). The worker is killed via its externalAbort
// signal (exit code 138). The task is already marked failed with
// 'exploration-loop' as the abort cause before this sentinel is thrown.
// The daemon uses `isExplorationLoopAbortError` to suppress re-updating the
// task in its exception-catch path so our failure record is not overwritten.
export const EXPLORATION_LOOP_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} aborted by exploration-loop ceiling: coder crossed the read-span hard-abort limit`

export const isExplorationLoopAbortError = (err: unknown): boolean =>
  errorHaystack(err).includes('aborted by exploration-loop ceiling')

// Thrown by the code step when the context token budget fires (the worker's
// maxContextTokens was reached). The worker exits with exitCode 138 and a
// distinct stderr containing "context budget exhausted". The task is marked
// failed with 'context-exhausted' before this sentinel is thrown. The daemon
// uses `isContextExhaustedAbortError` to suppress re-updating the task.
export const CONTEXT_EXHAUSTED_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} aborted by context-budget ceiling: coder hit the context token limit`

export const isContextExhaustedAbortError = (err: unknown): boolean =>
  errorHaystack(err).includes('aborted by context-budget ceiling')

import { summarizeUsage } from '../core/lib/claude-usage'
import { recordSignals } from '../core/lib/reflect-signals'
import { openTraceEventStore, type TraceEventStore } from '../core/lib/trace-events-store'
import { runWorkerWithSpan, runNonLlmStepWithSpan } from '../core/lib/run-worker-with-span'
import { resolveVerifyCwd, type RanVerifyStep } from '../core/lib/derive-repro-command'
import { resolveTaskCwd } from '../core/lib/resolve-task-cwd'
import { relative } from 'node:path'
import {
  createReadSpanWatcher,
  resolveReadSpanLimit,
  resolveReadSpanAbortLimit,
} from '../core/lib/read-span-watch'
import { TDD_WORKER_BRIEF } from './tdd-brief'
import { CONTEXT_GATHERING_BRIEF } from './context-gathering-brief'
import { buildDiagnoseChorePrompt } from '../core/lib/diagnose-chore'

// ---------------------------------------------------------------------------
// Per-phase resume/retry policy table — colocated with the step definitions.
//
// The canonical definitions live in phase-policies.ts (a lean import with no
// transitive heavy dependencies). This file re-exports them so callers that
// prefer the implement-workflow import path still see them here, next to the
// step definitions that produce each FailedPhase value.
// ---------------------------------------------------------------------------
export type {
  ContinuePolicy,
  RetryPolicy,
  PhasePolicy,
} from './phase-policies'
export { PHASE_POLICIES } from './phase-policies'

const planSchema = z
  .object({
    functional: z.string(),
    technical: z.string(),
  })
  .nullable()

// Worker-routing tags list, mirroring {@link Task.tags}. Each element must be
// a non-empty string. Defaults to ['coder'] when the dispatcher omits it
// (legacy/tagless rows). The first element is the primary routing tag.
const tagSchema: z.ZodType<TaskTag[]> = z.array(z.string()).default(['coder'])

// Task role, mirroring {@link TaskKind}. Defaults to 'task' when the
// dispatcher omits it (legacy rows). 'diagnose' marks a diagnose-only
// Chore — exempt from the read-span guard, never commits, short-circuits
// out of verify+merge after recording its verdict.
const kindSchema = z.enum(['task', 'fix', 'diagnose']).default('task')

/**
 * Predicate that the code step consults to decide whether to wire the
 * read-span watcher around a Worker run. Exported so the rule is testable
 * in isolation — the actual call site reproduces this expression literally.
 *
 * - Diagnose Chores are exempt: their whole job is reading (PRD 06e677fb).
 *   Their backstop is the Worker harness's existing time/turn cap.
 * - Every other dispatched task (Coder and Fixer) gets the watcher.
 *   The structured-write Writer exemption was removed with ADR 0019.
 */
export const shouldWireReadSpanWatcher = (
  kind: 'task' | 'fix' | 'diagnose',
): boolean => kind !== 'diagnose'

// Structured-task contract. Mirrors {@link TaskSpec} in queue.ts. Optional so
// legacy free-prose rows still flow through composePrompt unchanged.
const specSchema = z
  .object({
    files: z.array(z.string()),
    verifyCmd: z.string().nullable(),
    doneCriteria: z.array(z.string()),
    taskType: z.enum(TASK_TYPES as readonly ['auto', 'checkpoint']),
    readFirst: z.array(z.string()).default([]),
    prescriptiveAction: z.string().nullable().default(null),
  })
  .nullable()
  .default(null)

// Mandatory footer appended to every implementor prompt. The verify step
// fails any task whose branch has zero commits ahead of integration, so
// exiting without staging and committing produces a `verify:has-diff/
// no-commits-ahead` failure that routes to the recovery recipe. Forcing
// the instruction at the primitive guarantees every implementor —
// user-authored, plan-driven, sliced, or otherwise — sees the same
// commit contract, regardless of what the upstream prompt happened to
// include.
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

// Deviation-rules brief delivered to every Coder session. The rules are a
// near-verbatim port of gsd-build/get-shit-done's gsd-executor contract —
// they force the agent to reclassify off-plan findings into one of four
// buckets (auto-fix bug, auto-add missing critical, auto-fix blocker,
// surface architectural change as a follow-up task) instead of bailing.
// Combined with the in-stream read/grep span guard in claude-stream-watch,
// these are the primary anti-"agent quit early" levers — see #5 in the
// PR description.
//
// IMPORTANT: these are now part of CODER_SYSTEM_PROMPT (standing Session
// instructions), NOT the per-Task prompt. composePrompt must NOT include them.
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
  '**Explore-trust rule — treat sub-agent summaries as authoritative.** When an Explore or general-purpose sub-agent returns a structured summary citing file paths and line numbers, treat that summary as authoritative orientation. Proceed directly to an Edit or Write within at most TWO follow-up Reads, and only Read ranges the sub-agent did NOT cover. Re-reading a file the sub-agent already summarised counts as analysis paralysis and trips the read-span watcher.',
  '',
  '`$TASK_ID` is the id of the task you are executing right now; the orchestrator passes it to you in the brief below.',
].join('\n')

// Three concrete failure modes observed across real coder transcripts
// (mars-07988fba, mars-8304c7d9). Delivered per-Task in the composePrompt
// body (not the standing Session instructions) so the rules are visible in
// the task context window without relying on the agent recalling them from
// a long system prompt. Not injected for diagnose Chores.
export const CODING_DISCIPLINE = [
  '## Coding discipline',
  '',
  '- **No single-caller helpers.** Only extract a function when two or more call sites use it. A helper with one caller fails the deletion test — inline it.',
  '- **Test observable behaviour, not internal state.** Never assert on private fields, internal queues, or implementation details. A test that breaks on a safe internal refactor is a bad test.',
  '- **Cross-boundary changes need real-boundary verification.** When you add a cap, limit, or guard on a subprocess or external call, include at least one test (or documented manual step) against the real binary or service — stub-only tests can pass while the real path misbehaves.',
].join('\n')

// Build the Coder Worker's standing Session instructions for a given
// read-span limit. The limit is threaded in so the stated budget in the
// instructions always equals the value the guard actually enforces — there
// is no second hardcoded number. Call `buildCoderSystemPrompt(resolveReadSpanLimit())`
// at dispatch time so `MARS_READ_SPAN_LIMIT` overrides are reflected without
// restarting the daemon.
//
// The read-span guard section tells the Coder how many consecutive
// Read/Grep/Glob calls without an action trigger the advisory log line.
// Phrasing mirrors the watcher's own invariant: log-only, no abort.
export const buildCoderSystemPrompt = (readSpanLimit: number): string => {
  const readSpanGuard = [
    '## Read-span guard',
    '',
    `A watcher observes consecutive Read/Grep/Glob tool calls without an interleaving action-class call (Edit/Write/Bash/NotebookEdit). When your streak first reaches **${readSpanLimit}**, the watcher logs one advisory warning. It does not abort your run or kill the process. Override the threshold with \`MARS_READ_SPAN_LIMIT=<n>\`.`,
  ].join('\n')
  return [TDD_WORKER_BRIEF, readSpanGuard, CONTEXT_GATHERING_BRIEF, DEVIATION_RULES].join('\n\n')
}

// Standing Session instructions for the Coder Worker. The test-driven-
// development operating philosophy, the read-span guard budget, and the
// deviation rules are all passed once, as the Worker's Session-level system
// prompt, so they are present for the whole Session and never re-sent inside
// the per-Task prompt. This means the Coder does not re-absorb ~150+ lines
// of boilerplate at the top of every Task and a retry does not replay it
// verbatim — keeping the per-task prompt focused on the actual work.
//
// This export is computed at module-load time using the current env so it
// stays usable as a static reference. Production dispatch uses
// `resolveWorkerSystemPrompt` which re-calls `buildCoderSystemPrompt` at
// call time so live `MARS_READ_SPAN_LIMIT` overrides take effect immediately.
export const CODER_SYSTEM_PROMPT = buildCoderSystemPrompt(resolveReadSpanLimit())

// Resolve the standing Session instructions a dispatched Worker is launched
// with. Every dispatched task uses the Coder standing instructions: TDD
// operating philosophy, read-span guard budget (dynamic — read from env at
// call time), and deviation rules. The structured-write accommodation lane
// (Writer system prompt) was removed by ADR 0019.
// Centralised here so the code step does not assemble the system prompt inline
// and the surface is a single auditable seam.
export const resolveWorkerSystemPrompt = (
  _tag: TaskTag,
): string => buildCoderSystemPrompt(resolveReadSpanLimit())

/**
 * Pick the Worker that should handle a dispatched Task.
 *
 * Routing rules (highest priority first):
 *  1. kind === 'fix'  → Fixer  (recovery resilience; Opus, backlog-mutation denied)
 *  2. otherwise       → Coder  (default implementation worker; 'coder' is the only tag)
 *
 * The structured-write Writer routing via tag was removed by ADR 0019.
 * This helper covers the kind-based override and is testable in isolation.
 */
export const pickWorkerForTask = (task: Pick<Task, 'kind'>): WorkerName =>
  task.kind === 'fix' ? 'Fixer' : 'Coder'

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

// Test runners (vitest) print passing tests first and the failing
// assertion + final summary LAST, so the tail carries the real signal.
// But an early spawn/import crash aborts *before* any test runs and its
// only signal is at the very TOP of the output. Keeping the tail alone
// would discard that. So we retain a small head (catches early crashes)
// AND the tail (catches the assertion diff + final FAIL summary), joined
// by an elision marker so triage knows the middle was dropped. The full
// output is still persisted verbatim to the transcript.
export const failureExcerpt = (
  output: string,
  tailMax = 2000,
  headMax = 1000,
): string => {
  // No point eliding when head+tail would already cover everything.
  if (output.length <= tailMax + headMax) return output
  return `${output.slice(0, headMax)}\n…[middle elided]…\n${output.slice(-tailMax)}`
}

// Build the "## Worktree orientation" preamble. Disclosing the resolved
// verify cwd up-front kills the recurring 2-3 read tax we used to see
// (pwd / ls / ls .github/workflows/) and keeps orientation cheap.
//
// Note: the worker process is still spawned at `worktreeRoot` (see
// the code step below). We *disclose* the project subdirectory here rather
// than `cd`-ing the worker, so:
//   - Mars CLI commands continue to resolve `repoRoot()` from the
//     worktree root (the CLAUDE.md cwd trap),
//   - multi-subproject slices (e.g. `.github/` + `orchestrator/`) still
//     work without an arbitrary baseline cwd,
//   - a session-long cd doesn't ripple into every Bash invocation.
const renderOrientation = (
  worktreeRoot: string,
  taskCwd: string,
): string => {
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
  // Diagnose Chore short-circuit: the prompt arrives fully composed from
  // buildDiagnoseChorePrompt (forbids commits, requires a `mars diagnose
  // set` recording). Passing it through plan/orientation/spec/commit-
  // footer assembly would (a) re-inject COMMIT_FOOTER, contradicting the
  // Chore's "do not commit" contract, and (b) bolt on a spec block the
  // Chore has no use for. Hand the prompt back verbatim.
  if (kind === 'diagnose') return prompt.trim()
  const sections: string[] = [prompt.trim()]
  if (plan?.functional?.trim()) {
    sections.push(`## Functional plan\n\n${plan.functional.trim()}`)
  }
  if (plan?.technical?.trim()) {
    sections.push(`## Technical plan\n\n${plan.technical.trim()}`)
  }
  // Orientation must come BEFORE the structured-task spec block so the
  // agent sees its cwd before reading <files> / <verify>. Skipped when
  // worktreeRoot is unknown (legacy call sites / unit tests with no path).
  if (worktreeRoot.length > 0) {
    const taskCwd = resolveTaskCwd(worktreeRoot, spec?.files ?? [])
    sections.push(renderOrientation(worktreeRoot, taskCwd))
  }
  const specBlock = renderSpec(spec, taskId)
  if (specBlock !== null) sections.push(specBlock)
  // Deviation rules are NOT included here — they are part of
  // CODER_SYSTEM_PROMPT (standing Session instructions) and must not
  // appear in the per-Task prompt.
  sections.push(CODING_DISCIPLINE)
  sections.push(COMMIT_FOOTER)
  return sections.join('\n\n')
}

// Post-coder worktree classifier.
//
// After the dispatched coder session returns, the workflow inspects the
// worktree to tell apart three end-states:
//
//   - 'dirty-no-commits' — the agent wrote files but never staged/committed
//     them. Verify will reject the run with `has-diff/no-commits-ahead`;
//     surfacing it here gives operators a clear, file-listed log line so
//     the wasted run is debuggable from the workflow log alone.
//   - 'clean-with-commits' — the agent committed at least once. Normal
//     success path; the guard does not fire.
//   - 'clean-no-work' — the tree is clean and zero commits ahead. The
//     agent set up the worktree but produced nothing. Also passes through
//     the guard; verify's no-commits-ahead check owns that failure mode.
//   - 'error' — git itself failed (e.g. missing integration branch). The
//     classifier never throws; the caller decides whether to retry or log.
//
// The function is pure: it shells out to git and returns the result.
// Logging lives at the call site (the code step below) so the same
// classifier is reusable from tests without spying on console.
export interface PostCoderStateArgs {
  worktreePath: string
  integrationBranch: string
  /** Optional trace context; when populated, the git shell-outs emit
   *  `tool_invoked` events under `phase: 'code'`. */
  traceCtx?: TraceCtx
}

export type PostCoderState =
  | { kind: 'dirty-no-commits'; dirtyFiles: string[] }
  | { kind: 'clean-with-commits'; commitsAhead: number }
  | { kind: 'clean-no-work' }
  | { kind: 'error'; error: string }

// Parse `git status --porcelain=v1` into a list of paths. Each non-empty
// line is `XY <path>` where XY is the status code; rename lines use
// `XY <orig> -> <new>` and we take the new path.
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
    // --untracked-files=all so a wholly-new directory is listed file-by-file
    // rather than collapsed to its top-level path. The dirty-file list is
    // for operators reading the run log; per-file detail is what they want.
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

// ---------------------------------------------------------------------------
// @mars/workflow port (was: four Mastra createStep + createWorkflow().then())
//
// The pipeline is now one imperative async function. Native TS control flow
// is the source of truth; `ctx.step(name, fn)` wraps each durable unit. The
// four step NAMES are load-bearing and unchanged ('setup-worktree',
// 'run-claude-code', 'verify', 'merge') — they key checkpoint-resume and the
// trace-view node label.
//
// Resume is the engine's job: the daemon dispatches with `runId: task.id`, so
// a `mars continue` re-dispatch re-runs this function from the top and every
// step whose record is already `'completed'` short-circuits (its `fn` is not
// re-invoked; the recorded return value is handed back). There is no
// `resumeFrom`/`resumeRank`/`STEP_ORDER` bookkeeping any more, and no
// rehydrate-from-DB branch in setup — the engine returns the recorded
// `{ path, branch }` output instead.
// ---------------------------------------------------------------------------

// Services injected at `runWorkflow` time (replaces Mastra's
// `requestContext.get('taskStore')`). The daemon wires `{ store: TaskStore }`
// from the composition root; steps read `ctx.services.store`.
export interface ImplementServices {
  store: TaskStore
}

// Validated workflow input. Mirrors the former Mastra inputSchema minus
// `resumeFrom` (resume is now engine-driven via runId).
const implementInputSchema = z.object({
  taskId: z.string(),
  prompt: z.string(),
  plan: planSchema.default(null),
  tags: tagSchema,
  kind: kindSchema,
  integrationBranch: z.string().default('main'),
  spec: specSchema,
})

export type ImplementInput = z.infer<typeof implementInputSchema>

export interface ImplementOutput {
  taskId: string
  success: boolean
  message: string
}

// Output of the setup step. Recorded by the engine so a resumed run reuses
// the persisted branch + worktree WITHOUT re-reading the DB or re-creating
// the worktree (the recorded value is returned in place of re-running `fn`).
interface SetupResult {
  path: string
  branch: string
}

// Output of the verify step. On the throw model a failed verify never
// returns — it throws — so reaching merge always means verify passed. The
// `verified` flag is retained purely so the recorded step result is
// self-describing in the trace view; it is no longer read by a later step.
interface VerifyResult {
  verified: true
}

export const implementWorkflow = defineWorkflow<
  ImplementInput,
  ImplementOutput,
  ImplementServices
>({
  id: 'implement',
  inputSchema: implementInputSchema,
  fn: async (
    ctx: WorkflowCtx<ImplementServices>,
    input: ImplementInput,
  ): Promise<ImplementOutput> => {
    const store = ctx.services.store

    // One trace store for every shell-out the workflow issues across all
    // four phases. Opened once at the top so each step doesn't re-open it.
    // Failure to open is non-fatal — `nullTraceStore` keeps the wrapper
    // type-clean while silently dropping events.
    const workflowTraceStore: TraceEventStore =
      (await openTraceEventStore(resolveContext().stateDbPath).catch(() => undefined)) ??
      nullTraceStore
    // Resolve origin id once for the whole workflow so every trace event has
    // a stable origin attribution. resolveOriginIdForTask falls back to the
    // task id itself, so the chain never hands `null` back even on a fresh
    // task that hasn't acquired an origin row yet.
    const workflowOriginId = await resolveOriginIdForTask(input.taskId).catch(
      () => input.taskId,
    )
    const buildCtx = (phase: 'setup' | 'code' | 'verify' | 'merge'): TraceCtx => ({
      store: workflowTraceStore,
      taskId: input.taskId,
      originId: workflowOriginId,
      phase,
    })

    // ── setup-worktree ─────────────────────────────────────────────────────
    const { path: worktreePath, branch } = await ctx.step(
      'setup-worktree',
      async (handle: StepHandle): Promise<SetupResult> => {
        // `hasIncompleteBlockers` checks the task-dependency junction
        // (`task_blockers`), NOT the removed question/answer feature. The
        // orchestrator does not read, wait on, or branch based on question
        // rows — the planner emits ideas, not questions, and a task
        // progresses through draft → queued → running purely on plan
        // completeness (PRD eb6f8cc6). Do not reintroduce question-gating
        // here.
        //
        // Check blockers BEFORE starting the span: an abort due to incomplete
        // blockers means no setup work ran at all, so no span should be emitted.
        if (await hasIncompleteBlockers(input.taskId, store)) {
          throw new Error(BLOCKERS_ABORT_MESSAGE(input.taskId))
        }

        // Dirty integration-branch detection lives in two places now:
        //   - dispatch-time, before runWorkflow is called at all
        //     (`runMainDirtyDispatchCheck` in `daemon/main-dirty-dispatch.ts`),
        //   - verify-time, at the top of the verify step below
        //     (sentinel `verify:main-dirty`).
        // Both route through `spawnOrAttachMainCommitter` and park the task
        // behind the `main-commiter` recovery. The legacy setup-time
        // `checkSetupPreflight` backstop was retired in slice K.

        const setupSpanStore = workflowTraceStore === nullTraceStore ? undefined : workflowTraceStore
        return await runNonLlmStepWithSpan({
          stepName: 'setup-worktree',
          workflowInstanceId: ctx.runId,
          originId: workflowOriginId,
          phase: 'setup',
          traceStore: setupSpanStore,
          fn: async () => {
        await updateTask(input.taskId, { status: 'running' }, store)
        const ref = await createWorktree({
          taskId: input.taskId,
          integrationBranch: input.integrationBranch,
          traceCtx: buildCtx('setup'),
        })
        await updateTask(input.taskId, {
          branch: ref.branch,
          worktreePath: ref.path,
        }, store)

        // Capture the integration HEAD SHA at setup time so the task row
        // records which commit the worktree branched from. Non-fatal: a
        // missed capture (e.g. the branch does not exist yet in a fresh repo)
        // is better than a failed setup. The column is nullable for exactly
        // this case. Also record it on the step handle so the per-step record
        // anchors on the SHA this step ran against (engine resume metadata).
        try {
          const { repoRoot } = resolveContext()
          const r = await runTool(
            {
              tool: 'git',
              argv: ['rev-parse', input.integrationBranch],
              cwd: repoRoot,
              taskId: input.taskId,
              originId: workflowOriginId,
              phase: 'setup',
            },
            workflowTraceStore,
          )
          if (r.exitCode !== 0) throw new Error(`rev-parse exit ${r.exitCode}`)
          const headSha = r.stdout.trim()
          handle.setSha(headSha)
          await updateTask(input.taskId, { integrationHeadSha: headSha }, store)
        } catch {
          // Non-fatal: leave integration_head_sha as null.
        }

        try {
          const summary = await installWorktreeDeps({
            worktreeRoot: ref.path,
            log: (line) => console.log(line),
            traceCtx: buildCtx('setup'),
          })
          if (summary.sites.length > 0) {
            console.log(
              `[setup] task ${input.taskId} install completed in ${(
                summary.totalDurationMs / 1000
              ).toFixed(1)}s (${summary.sites.length} manifest${summary.sites.length === 1 ? '' : 's'})`,
            )
          }
          // Safety net: verify that local file: packages (e.g. @mars/workflow)
          // have their dist/ available after install.  The primary guard is the
          // preinstall script in orchestrator/package.json, which builds dist
          // before pnpm copies files to the virtual store.  This call handles
          // any residual case where the preinstall did not run or was skipped
          // (e.g. non-standard install invocation).
          for (const site of summary.sites) {
            await ensureLocalDistBuilt(
              site.dir,
              async (cmd, args, cwd) => {
                const r = await runTool(
                  {
                    tool: cmd,
                    argv: [...args],
                    cwd,
                    timeoutMs: 120_000,
                    taskId: input.taskId,
                    originId: workflowOriginId,
                    phase: 'setup',
                  },
                  workflowTraceStore,
                )
                return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
              },
              (line) => console.log(line),
            )
          }
        } catch (error: unknown) {
          const isInstallErr = error instanceof WorktreeInstallError
          const errorOutput = isInstallErr ? error.message : String(error)
          const failSummary = errorOutput.slice(0, 1000)
          await updateTask(input.taskId, {
            status: 'failed',
            error: failSummary,
            failedPhase: 'setup',
            failureReason: failSummary,
            failureReasonCode: failureReasonStringToCode(failSummary),
          }, store)
          await handleTaskFailureWithFixTask({
            taskId: input.taskId,
            failingStep: 'setup:install',
            // Lead with a classifier-friendly summary; the recipe gets the
            // raw error via recipeContext.statusOutput.
            errorOutput: `frozen-lockfile install failed\n${errorOutput}`,
            branch: ref.branch,
            store,
            recipeContext: {
              targetPath: isInstallErr ? error.site.dir : ref.path,
              statusOutput: errorOutput,
              targetBranch: ref.branch,
              // Handler backfills from task.prompt when '' is passed.
              originalPrompt: '',
            },
          }).catch((err) => {
            console.error(
              `[failure-handler] task ${input.taskId} setup:install handling errored:`,
              err,
            )
          })
          // Throw so the engine records the step failed. install failures
          // stamp failedPhase 'setup' — a non-resumable, pre-coding failure.
          throw error instanceof Error ? error : new Error(errorOutput)
        }

        // Recorded by the engine; a resumed run reuses this without
        // re-creating the worktree or re-reading the DB.
        return { path: ref.path, branch: ref.branch }
          },
        })
      },
    )

    // ── run-claude-code ─────────────────────────────────────────────────────
    await ctx.step('run-claude-code', async (handle: StepHandle): Promise<void> => {
      // Sweep stray untracked files from a previous failed attempt on this
      // branch BEFORE invoking the agent. Without this, a re-dispatch of a
      // source task that the orchestrator unblocked after a recovery inherits
      // the prior Coder's debris (e.g. files written under a wrongly-nested
      // path that the previous run never staged) and burns turns inspecting
      // them before getting to the actual work. The clean is gated on
      // `rev-list --count <integration>..HEAD == 0`, so any commits the agent
      // already produced are preserved.
      try {
        const cleanResult = await cleanWorktreeIfNoCommitsAhead({
          worktreePath,
          integrationBranch: input.integrationBranch,
          traceCtx: buildCtx('code'),
        })
        if (cleanResult.cleaned && cleanResult.output.trim().length > 0) {
          console.log(
            `[clean] task ${input.taskId} ${cleanResult.reason}\n${cleanResult.output.trim()}`,
          )
        } else if (!cleanResult.cleaned) {
          console.log(
            `[clean] task ${input.taskId} skipped: ${cleanResult.reason}`,
          )
        }
      } catch (err) {
        // Clean is a best-effort hygiene step; never fail the dispatch on it.
        console.error(
          `[clean] task ${input.taskId} threw, continuing without clean:`,
          err,
        )
      }

      const originId = await resolveOriginIdForTask(input.taskId)
      // Use the first valid tag as the primary routing tag, defaulting to 'coder'.
      const primaryTag: TaskTag = input.tags.find(isTaskTag) ?? 'coder'
      const fullPrompt = composePrompt(
        input.prompt,
        input.plan,
        primaryTag,
        input.spec ?? null,
        input.taskId,
        worktreePath,
        input.kind,
      )
      // Kind-aware routing: fix tasks go to the Fixer Worker (Opus, backlog-
      // mutation denied); everything else selects a Worker by intersecting the
      // task's tag list against each registered Worker's tag set.
      // Kind takes precedence over tags for the fix → Fixer path because a
      // recovery task must always land on the higher-resilience Worker.
      //
      // Registry workers: operator-declared Workers from .mars/worker-registry.json
      // are loaded here and merged with built-in Workers so their tag sets are
      // visible to pickWorkerForTags. A registry entry for a built-in name
      // overrides that built-in's config; a novel name appends a new Worker.
      const { listMergedWorkers } = await import('../core/workers/persisted-registry')
      const declarations = listMergedWorkers(resolveContext().stateDir)
      const allWorkers: Record<string, Worker> = { ...Workers }
      for (const decl of declarations) {
        if (!(decl.name in allWorkers)) {
          allWorkers[decl.name] = createWorker({
            name: decl.name,
            model: decl.model,
            ...(decl.fallbackModel !== undefined ? { fallbackModel: decl.fallbackModel } : {}),
            effort: decl.effort,
            permissionMode: decl.permissionMode,
            bare: decl.bare,
            disallowedTools: decl.disallowedTools,
            outputFormat: decl.outputFormat,
            maxContextTokens: 0,
            runtime: decl.runtime,
            ...(decl.tags !== undefined ? { tags: decl.tags } : {}),
          })
        }
      }
      const worker =
        input.kind === 'fix'
          ? Workers.Fixer
          : pickWorkerForTags(input.tags, allWorkers)
      // Read/Grep span watcher (gsd-style analysis-paralysis signal). When the
      // threshold is reached AND the agent has taken zero actions for the
      // entire run, a single diagnose Chore is spawned and the original task
      // is parked in `blocked` behind it (see the post-run check below).
      // Diagnose Chores are exempt (their job IS heavy reading; PRD 06e677fb —
      // their backstop is the time/turn cap). Every other dispatched task gets
      // the watcher.
      // AbortController bridged into the worker via externalAbort. When the
      // read-span hard-abort ceiling fires (MARS_READ_SPAN_ABORT_LIMIT) the
      // onAbort callback signals this controller; the worker exits with
      // exitCode 138 (the 'external abort' exit code). The exploration-loop
      // check below then handles the aftermath.
      const ac = new AbortController()
      let spanCeilingAborted = false
      const watcher = shouldWireReadSpanWatcher(input.kind)
        ? createReadSpanWatcher({
            limit: resolveReadSpanLimit(),
            onThreshold: (info) => {
              console.log(
                `[span] task ${input.taskId}: ${info.limit} consecutive Read/Grep/Glob calls without action (trace=${info.trace.map((t) => t.tool).join('+')}).`,
              )
            },
            abortLimit: resolveReadSpanAbortLimit(),
            onAbort: (info) => {
              spanCeilingAborted = true
              ac.abort()
              console.log(
                `[span] task ${input.taskId}: abort ceiling hit (${info.limit} reads without action); signalling external abort`,
              )
            },
          })
        : null
      // Reuse the workflow-level trace store opened at the top of `fn`. A
      // null store (workflow couldn't open one) is forwarded as-is — the
      // worker span wrapper handles undefined gracefully.
      const workerTraceStore =
        workflowTraceStore === nullTraceStore ? undefined : workflowTraceStore
      const r = await runWorkerWithSpan({
        worker,
        prompt: fullPrompt,
        runOptions: {
          cwd: worktreePath,
          systemPrompt: resolveWorkerSystemPrompt(primaryTag),
          externalAbort: ac.signal,
          onEvent: async (event) => {
            watcher?.observe(event)
            // Was `writer.write({type:'claude-event', event})`; the engine's
            // progress emitter replaces the Mastra workflow writer.
            ctx.emit('claude-event', event)
          },
        },
        traceStore: workerTraceStore,
        stepName: 'run-claude-code',
        workflowInstanceId: ctx.runId,
        originId,
        phase: 'code',
      })
      // Per-run read/action summary. Emitted on every wired run so paralysis
      // patterns are greppable in bulk (e.g. zero-action runs with a high
      // max-streak), not just when the threshold was tripped.
      if (watcher) {
        console.log(
          `[span-summary] task ${input.taskId}: maxStreak=${watcher.maxStreak} totalReads=${watcher.totalReads} totalActions=${watcher.totalActions} tripped=${watcher.thresholdEverReached}`,
        )
      }
      // Context-budget hard abort: the worker was killed because its context
      // token budget (maxContextTokens) was exhausted. The worker exits with
      // exitCode 138 and stderr containing "context budget exhausted".
      // Treat this as a failure with reason 'context-exhausted', enqueue
      // exactly one follow-up task blocked by this task, and exit WITHOUT
      // triggering the Fixer pipeline (same shape as exploration-loop).
      // This check runs BEFORE the exploration-loop check because both use
      // exitCode 138; the two are disambiguated by the stderr string.
      if (r.exitCode === 138 && r.stderr.includes('context budget exhausted')) {
        const followUpPrompt = [
          `## context-exhausted follow-up for task ${input.taskId}`,
          '',
          `Task \`${input.taskId}\` was killed because the coder's context token`,
          `budget was exhausted (maxContextTokens limit). The run was stopped`,
          `before Claude Code could auto-compact the context window.`,
          '',
          `Inspect the coder transcript for task \`${input.taskId}\` to understand`,
          `what the coder was doing when it ran out of context. Once the original`,
          `task is restarted or resolved, this follow-up will unblock automatically.`,
        ].join('\n')
        try {
          const followUp = await enqueueTask(followUpPrompt, undefined, {
            skipTriage: true,
          })
          await addBlockers(followUp.id, [input.taskId])
          await updateTask(
            input.taskId,
            {
              status: 'failed',
              error: `context-exhausted: coder hit the context token budget limit`,
              failedPhase: 'code',
              failureReason: 'context-exhausted',
              failureReasonCode: 'context-exhausted',
            },
            store,
          )
          console.log(
            `[ctx] task ${input.taskId}: context-exhausted abort; follow-up ${followUp.id} enqueued and blocked by this task`,
          )
          throw new Error(CONTEXT_EXHAUSTED_ABORT_MESSAGE(input.taskId))
        } catch (err) {
          if (err instanceof Error && isContextExhaustedAbortError(err)) throw err
          console.error(
            `[ctx] task ${input.taskId}: failed to handle context-exhausted abort:`,
            err,
          )
          await updateTask(
            input.taskId,
            {
              status: 'failed',
              error: `context-exhausted abort (follow-up failed: ${String(err).slice(0, 400)})`,
              failedPhase: 'code',
              failureReasonCode: 'context-exhausted',
              failureReason: 'context-exhausted',
            },
            store,
          ).catch(() => {})
          throw err instanceof Error ? err : new Error(String(err))
        }
      }

      // Exploration-loop hard abort: the worker was killed by the read-span
      // abort ceiling (MARS_READ_SPAN_ABORT_LIMIT). The worker exits with
      // exitCode 138. Record 'exploration-loop' as the abort cause, enqueue
      // exactly one follow-up task blocked by this task so the operator can
      // inspect the transcript, and exit WITHOUT triggering the Fixer pipeline
      // (no handleTaskFailureWithFixTask call). This check runs before the
      // lower-threshold 'diagnose Chore' guard below so the two paths are
      // mutually exclusive.
      if (spanCeilingAborted && r.exitCode === 138) {
        const followUpPrompt = [
          `## exploration-loop follow-up for task ${input.taskId}`,
          '',
          `Task \`${input.taskId}\` was aborted by the read-span hard-abort ceiling`,
          `(MARS_READ_SPAN_ABORT_LIMIT). The coder crossed the ceiling after`,
          `${watcher!.maxStreak} consecutive reads without taking any action.`,
          '',
          `Inspect the coder transcript for task \`${input.taskId}\` to understand`,
          `why it stalled in an exploration-loop. Once the original task is`,
          `restarted or resolved, this follow-up will unblock automatically.`,
        ].join('\n')
        try {
          const followUp = await enqueueTask(followUpPrompt, undefined, {
            skipTriage: true,
          })
          await addBlockers(followUp.id, [input.taskId])
          await updateTask(
            input.taskId,
            {
              status: 'failed',
              error: `exploration-loop: coder hit the read-span abort ceiling (maxStreak=${watcher!.maxStreak})`,
              failedPhase: 'code',
              failureReason: 'exploration-loop',
              failureReasonCode: 'exploration-loop',
            },
            store,
          )
          console.log(
            `[span] task ${input.taskId}: exploration-loop abort; follow-up ${followUp.id} enqueued and blocked by this task`,
          )
          throw new Error(EXPLORATION_LOOP_ABORT_MESSAGE(input.taskId))
        } catch (err) {
          if (err instanceof Error && isExplorationLoopAbortError(err)) throw err
          console.error(
            `[span] task ${input.taskId}: failed to handle exploration-loop abort:`,
            err,
          )
          await updateTask(
            input.taskId,
            {
              status: 'failed',
              error: `exploration-loop abort (follow-up failed: ${String(err).slice(0, 400)})`,
              failedPhase: 'code',
              failureReasonCode: 'exploration-loop',
              failureReason: 'exploration-loop',
            },
            store,
          ).catch(() => {})
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
      // Read-span guard: if the agent tripped the threshold AND never took any
      // action during the entire run, spawn a single diagnose Chore and park
      // the original task behind it. The Chore has a bounded contract:
      // investigate only, record one structured verdict, never attempt the
      // parent's work. See PRD 06e677fb; the old three-way free-form
      // instruction is gone.
      if (watcher?.thresholdEverReached && watcher.totalActions === 0) {
        const diagnosePrompt = buildDiagnoseChorePrompt(
          input.taskId,
          input.prompt,
          watcher.trace,
        )
        try {
          const child = await enqueueTask(diagnosePrompt, undefined, {
            skipTriage: true,
            kind: 'diagnose',
            originId,
          })
          const errorSummary =
            `too_hard:no-action-after-reads: maxStreak=${watcher.maxStreak}; diagnose Chore=${child.id}`.slice(0, 1000)
          await updateTask(
            input.taskId,
            { status: 'blocked', error: errorSummary, failedPhase: 'code' },
            store,
          )
          await addBlockers(input.taskId, [child.id])
          console.log(
            `[span] task ${input.taskId}: ${watcher.maxStreak} reads without action; spawned diagnose Chore ${child.id} as blocker; parent → blocked`,
          )
          // Throw the sentinel: the engine records run-claude-code `failed` and
          // the daemon's `isTooHardAbortError` suppression keeps the misleading
          // `task.completed status=failed` emit from firing.
          throw new Error(TOO_HARD_ABORT_MESSAGE(input.taskId))
        } catch (err) {
          if (err instanceof Error && isTooHardAbortError(err)) throw err
          // Spawn failed — park the task failed; don't silently swallow.
          console.error(
            `[span] task ${input.taskId}: failed to spawn diagnose Chore:`,
            err,
          )
          await updateTask(
            input.taskId,
            {
              status: 'failed',
              error: `diagnose Chore spawn failed: ${String(err).slice(0, 500)}`,
              failedPhase: 'code',
              failureReason: `diagnose Chore spawn failed: ${String(err).slice(0, 500)}`,
              failureReasonCode: failureReasonStringToCode(
                `diagnose Chore spawn failed: ${String(err)}`,
              ),
            },
            store,
          ).catch(() => {})
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
      // Classify the worktree end-state. Only the 'dirty-no-commits' case is
      // worth a log line — it's the new failure mode the post-test commit
      // guard is being built to detect. Clean-success and clean-no-work are
      // already covered by verify's existing signal. Errors are logged at
      // warn level so a flaky git invocation doesn't pollute the success
      // path. Best-effort: never fails the dispatch.
      try {
        const postState = await detectPostCoderState({
          worktreePath,
          integrationBranch: input.integrationBranch,
          traceCtx: buildCtx('code'),
        })
        if (postState.kind === 'dirty-no-commits') {
          console.log(
            `[post-coder] task ${input.taskId}: dirty tree with 0 commits ahead of ${input.integrationBranch} — ${postState.dirtyFiles.length} uncommitted path(s):\n  ${postState.dirtyFiles.join('\n  ')}`,
          )
        } else if (postState.kind === 'error') {
          console.warn(
            `[post-coder] task ${input.taskId}: classifier error: ${postState.error}`,
          )
        }
      } catch (err) {
        console.warn(
          `[post-coder] task ${input.taskId}: classifier threw, continuing:`,
          err,
        )
      }

      const usage = summarizeUsage(r.conversation)
      if (r.sessionId) {
        // The claudeSessionId is the transcript key — record it on the step
        // record so the trace view can reference the full transcript by key
        // (replaces the Mastra tracingContext.currentSpan.update metadata).
        handle.setTranscriptKey(r.sessionId)
        await updateTask(input.taskId, { claudeSessionId: r.sessionId }, store)
      }
      await recordSignals(input.taskId, 'run-claude-code', usage, store).catch(() => {
        // signal capture must never fail the task
      })
      // Transcript and usage are now captured in the step_spans row opened
      // by runWorkerWithSpan above. The legacy upsertTranscript call has been
      // removed in favour of the span lifecycle (see PRD 436f14c7).
    })

    // ── verify ───────────────────────────────────────────────────────────
    await ctx.step('verify', async (): Promise<VerifyResult> => {
      // Diagnose Chore short-circuit: the Chore never commits and never
      // produces a verifiable artefact. Its deliverable is the structured
      // verdict in the diagnoses table; the merge step then cleans up the
      // empty worktree and the post-completion branch in the daemon reads
      // the verdict and either dispatches one fix or raises an actionQueue item.
      if (input.kind === 'diagnose') {
        return { verified: true }
      }

      // Wrap the real verify work in a non-LLM span so it shows up in the
      // unified trace surface alongside the setup / code / merge spans.
      // capturedVerifyOutput is set inside fn() and read by getCommandOutput
      // after fn() completes so the span carries the full verify output.
      let capturedVerifyOutput: string | undefined
      const verifySpanStore = workflowTraceStore === nullTraceStore ? undefined : workflowTraceStore
      return await runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: ctx.runId,
        originId: workflowOriginId,
        phase: 'verify',
        traceStore: verifySpanStore,
        getCommandOutput: () => capturedVerifyOutput,
        fn: async (): Promise<VerifyResult> => {
      // Slice F.2: verify-time dirty-main check. Runs at the top of the
      // verify step, BEFORE typecheck/test/lint. If the integration branch
      // is dirty right now, we park this task behind a `main-commiter`
      // recovery and abort the step — verify cannot legitimately land work
      // on a dirty tree, and the failure model says short-circuit verify
      // for this exact case (no `verify:typecheck` recorded, etc.).
      //
      // Recovery (kind='fix') tasks are exempt by design — the committer
      // itself must be able to run against the dirty branch.
      if (input.kind !== 'fix') {
        try {
          const { checkIntegrationBranchDirty, MAIN_COMMITER_RECIPE, spawnOrAttachMainCommitter } =
            await import('../core/lib/main-dirty')
          const { loadRecipeCatalog } = await import('../core/lib/recipes')
          const verifyTopCtx = resolveContext()
          const detection = await checkIntegrationBranchDirty({
            repoRoot: verifyTopCtx.repoRoot,
            traceCtx: buildCtx('verify'),
          })
          if (detection.dirty) {
            const catalog = await loadRecipeCatalog(verifyTopCtx.stateDir)
            const recipe = catalog.get(MAIN_COMMITER_RECIPE)
            if (recipe) {
              const resolution = await spawnOrAttachMainCommitter({
                sourceTaskId: input.taskId,
                detection,
                integrationBranch: input.integrationBranch,
                dispatchPhase: 'verify',
                recipePrompt: recipe.prompt,
                sourceOriginId: workflowOriginId,
                traceStore: workflowTraceStore,
                store,
              })
              console.log(
                `[main-dirty] verify-time: task ${input.taskId} parked blocked on main-commiter ${resolution.fixTaskId} (${
                  resolution.spawned
                    ? 'spawned fresh'
                    : `attached to existing committer in status=${resolution.attachedToStatus}`
                })`,
              )
              // Throw to abort the verify step. The detection-throw is
              // suppressed by `isMainDirtyVerifyError` in the daemon so the
              // misleading `task.completed status=failed` emit is skipped —
              // the source task is already `blocked` with a real
              // task_blockers edge.
              throw new Error(
                `task ${input.taskId} verify:main-dirty: ${MAIN_DIRTY_VERIFY_MESSAGE}`,
              )
            }
            console.log(
              `[main-dirty] verify-time: integration branch is dirty but recipe '${MAIN_COMMITER_RECIPE}' is missing from the catalog; falling through to standard verify`,
            )
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('verify:main-dirty')) {
            throw err
          }
          console.warn(
            `[main-dirty] verify-time check threw, continuing with verify: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }

      // Entering verify for real: clear the previous failure stamp so a
      // subsequent failure records this run's phase.
      await updateTask(input.taskId, {
        status: 'verifying',
        failedPhase: null,
      }, store)
      const verifyCwd = resolveVerifyCwd(worktreePath)
      const verifyCtx = resolveContext()
      // Scope-aware verify-step selection: look at the files the task actually
      // changed between its branch and integration, then run the root scope's
      // steps (the repo-wide floor) plus every narrower scope whose subtree a
      // changed file falls in — each in its own directory.
      const scopes = await loadVerifyScopes(verifyCtx.supervisorsManifest)
      const changedFiles = await getChangedFiles(
        worktreePath,
        input.integrationBranch,
        branch,
        buildCtx('verify'),
      )
      const steps = selectVerifySteps(scopes, changedFiles)
      // The diff / commits-ahead gate runs for every dispatched task — there
      // is no skip option (ADR 0019). It fails only a branch that has diverged
      // from integration without landing a commit on it; a branch whose tip
      // equals integration (legitimate no-op, e.g. the main-committer leaving
      // an already-clean tree) or is an ancestor of it (work already merged)
      // passes — the integration branch is clean and nothing is un-merged.
      const r = await verifyChanges({
        cwd: verifyCwd,
        steps,
        branch,
        integrationBranch: input.integrationBranch,
        traceCtx: buildCtx('verify'),
      })

      const verifyOutput = r.steps
        .map((s) => `=== ${s.name} (${s.passed ? 'pass' : 'fail'}) ===\n${s.output}`)
        .join('\n\n')
      capturedVerifyOutput = verifyOutput

      if (!r.passed) {
        const failed = r.steps.filter((s) => !s.passed)
        const summary = failed
          .map((s) => `${s.name}:\n${failureExcerpt(s.output)}`)
          .join('\n\n')
        const firstFailedName = failed[0]?.name ?? 'verify'
        const firstFailedOutput = failed[0]
          ? failureExcerpt(failed[0].output)
          : summary
        // Build a list of every step that actually ran with its exact command
        // and directory. Steps that carry cmd/stepDir (all steps routed through
        // runVerifyStep) form the ranVerifySteps array used to produce an
        // accurate, language-agnostic reproduce hint. Steps without cmd (e.g.
        // the synthetic has-diff check) are omitted so the hint stays runnable.
        const ranVerifySteps: RanVerifyStep[] = r.steps
          .filter((s): s is typeof s & { cmd: string; stepDir: string } =>
            s.cmd !== undefined && s.stepDir !== undefined,
          )
          .map((s) => ({
            name: s.name,
            cmd: s.cmd,
            args: s.args ?? [],
            stepDir: s.stepDir,
            passed: s.passed,
          }))
        await updateTask(input.taskId, {
          status: 'failed',
          error: summary,
          failedPhase: 'verify',
          failureReason: `verify:${firstFailedName}`,
          failureReasonCode: failureReasonStringToCode(
            `verify:${firstFailedName}`,
          ),
        }, store)
        // Wrap the recovery dispatch in its own span so it is visible as a
        // distinct step in the trace surface alongside setup/verify/merge.
        await runNonLlmStepWithSpan({
          stepName: 'recovery-dispatch',
          workflowInstanceId: ctx.runId,
          originId: workflowOriginId,
          phase: 'verify',
          traceStore: verifySpanStore,
          fn: () => handleTaskFailureWithFixTask({
            taskId: input.taskId,
            failingStep: `verify:${firstFailedName}`,
            errorOutput: firstFailedOutput,
            branch,
            ranVerifySteps,
            store,
            recipeContext: {
              targetPath: worktreePath,
              statusOutput: firstFailedOutput,
              targetBranch: branch,
              integrationBranch: input.integrationBranch,
              // Handler backfills from task.prompt when '' is passed.
              originalPrompt: '',
            },
          }),
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${input.taskId} verify failure handling errored:`,
            err,
          )
        })
        // Throw instead of returning `{verified:false}`: the engine records
        // verify `failed` and stops the run before merge. The self-heal
        // side-effects above already spawned the recovery task.
        throw new Error(`task ${input.taskId} verify:${firstFailedName} failed`)
      }

      // Verify passed → return normally so the merge step runs.
      return { verified: true }
        },
      })
    })

    // ── merge ──────────────────────────────────────────────────────────────
    // The verify step throws on failure, so reaching here always means verify
    // passed — the former `if (!inputData.verified)` early return is now
    // unreachable and has been dropped.
    return await ctx.step('merge', async (): Promise<ImplementOutput> => {
      const originId = await resolveOriginIdForTask(input.taskId)
      void originId // resolved for potential future use within this step

      // Diagnose Chore short-circuit: the Chore never commits and therefore
      // has nothing to merge. Its deliverable is the structured verdict in
      // the diagnoses table, which the daemon reads via the post-completion
      // branch (see PRD 06e677fb). Clean up the worktree and mark done; the
      // verdict-driven follow-up (one fix, or one actionQueue item) runs from the
      // task.completed event in daemon/server.ts.
      if (input.kind === 'diagnose') {
        await removeWorktree({ path: worktreePath, branch }, true, false, buildCtx('merge'))
        await updateTask(input.taskId, { status: 'done', failedPhase: null }, store)
        return {
          taskId: input.taskId,
          success: true,
          message: 'diagnose Chore complete; verdict-driven branch runs in daemon',
        }
      }

      const mergeSpanStore = workflowTraceStore === nullTraceStore ? undefined : workflowTraceStore
      // Capture Vega info when a conflicted merge routes to the vcs-supervisor.
      // Set inside fn() after mergeBranch returns; read by getVegaInfo() after
      // fn() completes so the single step_ended event carries the session info.
      let vegaSpanInfo: { workerName: string; sessionId: string | null } | null = null
      return await runNonLlmStepWithSpan({
        stepName: 'merge',
        workflowInstanceId: ctx.runId,
        originId: workflowOriginId,
        phase: 'merge',
        traceStore: mergeSpanStore,
        getVegaInfo: () => vegaSpanInfo,
        fn: async (): Promise<ImplementOutput> => {
      // Any unhandled throw from mergeBranch (e.g. an unexpected git failure)
      // must transition the task to a terminal status. Otherwise the queue row
      // stays at 'merging' forever and `mars list` hides the failure.
      try {
        // Entering merge for real: clear any previous failure stamp so a
        // subsequent failure records this run's phase.
        await updateTask(input.taskId, {
          status: 'merging',
          failedPhase: null,
        }, store)

        const targetStatus = await checkMergeTargetStatus({
          integrationBranch: input.integrationBranch,
          taskBranch: branch,
          traceCtx: buildCtx('merge'),
        })
        if (targetStatus.kind === 'needs-rebase') {
          // Diverged / behind integration — recoverable, NOT a failure.
          // mergeBranch Step 1 rebases the task branch onto integration
          // (escalating to the vcs-supervisor on conflict) before the
          // --ff-only merge. Parking here is the bug that dead-looped every
          // lapped branch through the retry budget. Fall through to merge.
          console.log(
            `[merge:preflight] task ${input.taskId} ${targetStatus.statusOutput}; proceeding to rebase-before-ff`,
          )
        }
        if (targetStatus.kind === 'dirty') {
          const errorMsg = `merge target has uncommitted changes; cannot fast-forward into ${input.integrationBranch}`
          await updateTask(input.taskId, {
            status: 'failed',
            error: errorMsg,
            failedPhase: 'merge',
            failureReason: 'verify:main-dirty',
            failureReasonCode: 'verify:main-dirty',
          }, store)
          await handleTaskFailureWithFixTask({
            taskId: input.taskId,
            failingStep: 'merge:preflight',
            // Classifier-friendly lead line; raw porcelain via recipeContext.
            errorOutput: `merge target ${targetStatus.targetPath} has uncommitted changes blocking fast-forward\n${targetStatus.statusOutput}`,
            branch,
            store,
            recipeContext: {
              targetPath: targetStatus.targetPath,
              statusOutput: targetStatus.statusOutput,
              targetBranch: input.integrationBranch,
              // Handler backfills from task.prompt when '' is passed.
              originalPrompt: '',
            },
          }).catch((err) => {
            console.error(
              `[failure-handler] task ${input.taskId} dirty-merge-target handling errored:`,
              err,
            )
          })
          // Throw instead of returning `{success:false}`: the engine records
          // merge `failed`. The self-heal handler above already spawned the
          // recovery task and parked the source `blocked`/`failed`.
          throw new Error(
            `task ${input.taskId} merge:preflight detected dirty target ${input.integrationBranch}`,
          )
        }
        if (targetStatus.kind === 'error') {
          const errorMsg = `merge pre-flight git status failed: ${targetStatus.error.message}`.slice(0, 1000)
          await updateTask(input.taskId, {
            status: 'failed',
            error: errorMsg,
            failedPhase: 'merge',
            failureReason: errorMsg,
            failureReasonCode: failureReasonStringToCode(errorMsg),
          }, store)
          throw new Error(
            `task ${input.taskId} merge pre-flight failed: ${targetStatus.error.message}`,
          )
        }

        const supervisorConversation: ClaudeEvent[] = []
        const m = await mergeBranch({
          branch,
          worktreePath,
          integrationBranch: input.integrationBranch,
          lockTimeoutMs: 5 * 60 * 1000,
          traceCtx: buildCtx('merge'),
          onVegaStart: async () => {
            // Fast-forward failed; a live Vega session is being spawned. Leave
            // the idempotent `merging` phase so `mars list`/`mars show` surface
            // the conflict-resolution session as `vega-reconciling`.
            await updateTask(input.taskId, { status: 'vega-reconciling' }, store)
          },
          onSupervisorEvent: async (event) => {
            supervisorConversation.push(event)
            // Was `writer.write({type:'vcs-supervisor-event', event})`.
            ctx.emit('vcs-supervisor-event', event)
          },
        })

        if (supervisorConversation.length > 0) {
          const supervisorUsage = summarizeUsage(supervisorConversation)
          await recordSignals(input.taskId, 'vcs-supervisor', supervisorUsage, store).catch(() => {
            // signal capture must never fail the task
          })
        }

        // Upgrade the merge span to a Vega Session when the conflict was
        // resolved by the vcs-supervisor. vegaSpanInfo is read by getVegaInfo()
        // after fn() returns so the single step_ended event carries the worker
        // name and session id (the Session invariant: worker IS NOT NULL iff
        // this is a Session).
        if (m.conflictResolved) {
          vegaSpanInfo = { workerName: 'Vega', sessionId: m.vegaSessionId }
        }

        if (m.aborted) {
          const errorMsg = `merge aborted by vcs-supervisor; worktree retained at ${worktreePath}\n${m.output.slice(0, 1000)}`
          await updateTask(input.taskId, {
            status: 'failed',
            error: errorMsg,
            failedPhase: 'merge',
            failureReason: 'merge:vcs-supervisor-aborted',
            failureReasonCode: 'merge:vcs-supervisor-aborted',
          }, store)
          await handleTaskFailureWithFixTask({
            taskId: input.taskId,
            failingStep: 'merge:vcs-supervisor-aborted',
            errorOutput: m.output,
            branch,
            store,
          }).catch((err) => {
            console.error(
              `[failure-handler] task ${input.taskId} merge abort handling errored:`,
              err,
            )
          })
          throw new Error(
            `task ${input.taskId} merge aborted; vcs-supervisor could not reconcile`,
          )
        }

        await removeWorktree({ path: worktreePath, branch }, true, false, buildCtx('merge'))
        await updateTask(input.taskId, { status: 'done', failedPhase: null }, store)

        return {
          taskId: input.taskId,
          success: true,
          message: m.conflictResolved
            ? 'merged with vcs-supervisor conflict resolution'
            : 'merged cleanly',
        }
      } catch (error: unknown) {
        // Re-throw our own already-handled merge aborts verbatim: their
        // self-heal side-effects (updateTask + handleTaskFailureWithFixTask)
        // already ran above, so the outer crash handler must NOT double-handle
        // them. Only a genuinely UNHANDLED throw from mergeBranch reaches the
        // crash-stamp path below.
        if (
          error instanceof Error &&
          (error.message.includes('merge:preflight') ||
            error.message.includes('merge pre-flight failed') ||
            error.message.includes('merge aborted; vcs-supervisor could not reconcile'))
        ) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[merge] task ${input.taskId} crashed:`, error)
        const crashMsg = `merge step crashed: ${message}`.slice(0, 1000)
        await updateTask(input.taskId, {
          status: 'failed',
          error: crashMsg,
          failedPhase: 'merge',
          failureReason: crashMsg,
          failureReasonCode: failureReasonStringToCode(crashMsg),
        }, store)
        await handleTaskFailureWithFixTask({
          taskId: input.taskId,
          failingStep: 'merge:crashed',
          errorOutput: message,
          branch,
          store,
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${input.taskId} merge crash handling errored:`,
            err,
          )
        })
        // Throw so the engine records merge `failed`.
        throw error instanceof Error ? error : new Error(message)
      }
        },
      })
    })
  },
})
