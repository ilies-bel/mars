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
  MERGE_MODES,
  type TaskTag,
  type TaskSpec,
  type Task,
} from '../../core/queue'
import { resolveTaskCwd } from '../../core/lib/resolve-task-cwd'
import { readWorkerPromptOverride } from '../../core/daemon/config'
import { composeCodexPrompt } from '../../core/workers/providers/codex-headless'
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
    doneCriteria: z.array(z.string()),
    mergeMode: z.enum(MERGE_MODES as readonly ['auto', 'gated']),
    readFirst: z.array(z.string()).default([]),
    prescriptiveAction: z.string().nullable().default(null),
  })
  .nullable()
  .default(null)

// ---------------------------------------------------------------------------
// Failure sentinels (message builders)
// ---------------------------------------------------------------------------
//
// Sentinel detection is no longer done via `is*Error` predicate functions.
// Throw sites (in primitives/index.ts) throw `WorkflowTerminalError` with a
// `kind` discriminant; the dispatch loop in server.ts does a single
// `instanceof WorkflowTerminalError` check and switches on `kind`.
// The message builders are kept so the thrown error carries a human-readable
// description in its `.message`.

export const BLOCKERS_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} has incomplete blockers; aborting dispatch (task remains queued)`

// Thrown by the verify step's dirty-main check.
export const MAIN_DIRTY_VERIFY_MESSAGE =
  'integration branch dirty before verify; parked behind main-commiter recovery'

// Thrown by the merge step's dirty-main check.
export const MAIN_DIRTY_MERGE_MESSAGE =
  'integration branch dirty before merge; parked behind main-commiter recovery'

// Thrown by the code step when the context token budget fires.
export const CONTEXT_EXHAUSTED_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} aborted by context-budget ceiling: coder hit the context token limit`

// Thrown by the setup step when a recovery cannot attach to a missing origin worktree.
export const ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE = (taskId: string): string =>
  `recovery ${taskId} aborted: origin worktree is missing and cannot be attached`

// Thrown when a task's worktree cannot be brought up to date with the
// integration branch because replaying its branch conflicts. The rebase is
// aborted and the worktree left exactly as found.
export const WORKTREE_REBASE_CONFLICT_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} aborted: its worktree cannot be replayed onto the integration branch (conflict); nothing was discarded`

// Thrown by the code step when the coder process exits non-zero before doing
// any work (e.g. claude rejecting a bad --session-id). Without this the empty
// worktree would pass verify and merge as a false "done".
export const CODER_EXIT_NONZERO_ABORT_MESSAGE = (
  taskId: string,
  exitCode: number,
): string => `coder for task ${taskId} exited ${exitCode} before completing`

// Thrown by the code step when the coder exits 0 but leaves real work
// UNCOMMITTED on the branch — either shape, `dirty-no-commits` (committed
// nothing at all) or `dirty-with-commits` (committed once, then kept working
// and left the rest dirty) — AND neither the corrective coder turn nor the
// orchestrator's deterministic auto-commit net could land it.
// Without this the dirty-no-commits worktree falls straight through: verify's
// has-diff gate reads 0 commits ahead and PASSES it as a benign no-op, then the
// merge step rebases an empty branch and dispatches the vcs-supervisor with a
// prompt hardcoded to "a rebase just conflicted / is in progress" — which is
// false, so Vega aborts (merge:vcs-supervisor-aborted) and the first-principles
// recovery inherits the same uncommittable tree and idles until the phantom-task
// watchdog ceiling kills it. (Observed end-to-end on task mars-c6cab686 /
// fix-64929590, 2026-06-19: a forgotten `git commit` cost ~2h of wall-clock.)
// Catching it here, at the earliest point, converts the silent fall-through into
// one cheap recovery whose only job is to commit the work already in the tree.
export const CODER_UNCOMMITTED_ABORT_MESSAGE = (taskId: string): string =>
  `coder for task ${taskId} left uncommitted work the auto-commit net could not land`

/**
 * Failing-step id stamped on `failure_reason` for the coder-left-uncommitted
 * terminal path. `failure_reason` doubles as the fine-grained failing step for
 * the durable recovery-spawn subscriber (`asStepId(task.failureReason)`), which
 * recomputes the signature as `computeFailureSignature(step, error)`. It must
 * therefore be the bare step id whose combination with the error text lands on
 * {@link CODER_UNCOMMITTED_SIGNATURE} — the prose lives in `error`.
 */
export const CODER_UNCOMMITTED_STEP = 'code'

// Structured failure signature stamped on the task when the coder left work
// uncommitted AND the orchestrator's deterministic auto-commit was refused.
// Registered in both `failure-kinds.ts` (operator-facing copy + action menu)
// and `fix-recipes.ts` (the recovery prompt), so the action queue can name the
// failure and self-heal knows how to fix it.
export const CODER_UNCOMMITTED_SIGNATURE = `${CODER_UNCOMMITTED_STEP}/uncommitted-changes`

// Thrown by the code step when the provider rejects the run due to a rate or
// spend limit (NOT a code failure). The task is re-queued with its worktree
// intact; no recovery fix-task is spawned. The daemon catches this sentinel to
// pause dispatch until the resetsAt epoch + jitter and raise exactly one
// level-triggered 'provider-rate-limited' action-queue row.
export const QUOTA_REJECTED_ABORT_MESSAGE = (
  taskId: string,
  resetsAt: number,
): string =>
  `task ${taskId} env-rejected: provider rate limit reached (resetsAt=${resetsAt})`

// Thrown by the awaitHuman primitive when a task is parked for live human work.
//
// The sentinel embeds the step name so the daemon can locate the correct
// workflow_step_runs row and patch it to 'completed'. Once 'completed', the
// engine short-circuits the step on every future re-dispatch (after the
// operator releases the lease), making the park idempotent keyed on
// (runId, stepName). This mirrors the preview-gate sentinel but for the
// 'awaiting-human' status instead of 'awaiting-validation'.
export const AWAIT_HUMAN_MESSAGE = (taskId: string, stepName: string): string =>
  `task ${taskId} parked at await-human step '${stepName}'; awaiting lease release`

// ---------------------------------------------------------------------------
// Prompt briefs + system-prompt assembly
// ---------------------------------------------------------------------------

// Mandatory exit condition placed before every implementor prompt. It is
// deliberately user-role text: Codex has no system-instruction argument.
export const COMMIT_EXIT_CONDITION = [
  '## Commit exit condition',
  '',
  'This run is not complete until `git rev-list --count main..HEAD` returns greater than `0`. Commit before you exit.',
].join('\n')

// Mandatory detailed commit procedure appended to every implementor prompt.
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
  'Then, as the final action before exiting, run the commit exit-condition command above. If it prints `0`, you have not committed your work — re-run `git commit` and re-check. Do not exit while it is `0`; the verify step rejects such runs with `verify:has-diff/no-commits-ahead`, which means the agent did not commit.',
  '',
  'A separate failure mode, `verify:dirty-main`, means the merge target was already dirty before your branch landed. That is an operator-owned condition, not your responsibility.',
  '',
  'The orchestrator does not commit on your behalf.',
  '',
  '## Verify-command discipline — never mask test exit codes',
  '',
  'When judging whether tests pass, run the test command WITHOUT a pipe to `tail`, `head`, or `grep`. A pipeline such as `npx vitest run 2>&1 | tail -25` reports `tail`\'s exit code (always 0), not vitest\'s — a red suite reads as green. Instead:',
  '',
  '- Run the test command directly and let it print its own summary: `npx vitest run`',
  '- Or capture output to a temp file: `npx vitest run > /tmp/test-out.txt 2>&1; cat /tmp/test-out.txt`',
  '- Or use `set -o pipefail` before any pipeline so the leftmost non-zero exit propagates',
  '- Or parse the runner\'s own `N failed` summary line from captured output',
  '',
  'Never assert "tests pass" solely from the exit code of a pipeline whose last stage is `tail`, `head`, or `grep`.',
].join('\n')

// Deviation-rules brief delivered to every Coder session.
export const DEVIATION_RULES = [
  '## Deviation rules — do NOT quit silently',
  '',
  'You WILL discover work not in the brief. Apply these rules without asking. Bailing out without filing one of the artifacts below is not in the menu.',
  '',
  '**Worker coordination.** Use the worker-safe Mars MCP tools as the primary path: `mars_task_note` to journal progress or blockers, `mars_task_check` to mark done criteria, `mars_task_add_blocked_followup` to file a follow-up blocked by this task, and `mars_proposal_add_draft` to capture a deferred proposal.',
  'If the MCP server is unavailable, fall back to `mars task note`, `mars task check`, `mars task add --blocked-by $TASK_ID`, and `mars proposal add` respectively.',
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
  '  2. Call `mars_task_add_blocked_followup` to create a follow-up. It sets this task as the blocker so the parent waits for the new work.',
  '  3. For deferred refactors / observed cleanups that should NOT block this slice, call `mars_proposal_add_draft` so the loose end is captured but parked in the proposal backlog.',
  '  4. Stop after filing the follow-up. The orchestrator will re-dispatch this task once the new blocker resolves.',
  '',
  '**Scope boundary.** Only fix issues your changes touch. Pre-existing warnings, linting errors, or failures in unrelated files are out of scope — capture them with `mars_proposal_add_draft` if interesting; do NOT fix them inline.',
  '',
  '**Fix-attempt cap.** If you have run the verify command 3 times on this task and it still fails for reasons you cannot explain, STOP. Use `mars_task_add_blocked_followup` to describe the failing verify and what you tried, then exit. Do not loop.',
  '',
  '**Explore-trust rule — treat sub-agent summaries as authoritative.** When an Explore or general-purpose sub-agent returns a structured summary citing file paths and line numbers, treat that summary as authoritative orientation. Proceed directly to an Edit or Write within at most TWO follow-up Reads, and only Read ranges the sub-agent did NOT cover. Re-reading a file the sub-agent already summarised counts as analysis paralysis.',
  '',
  '**Rule 6 — Prove pre-existing test failures against the merge base.** If the test suite ends with failures you believe are pre-existing (inherited from the merge base and unrelated to your change), you MUST prove this claim before asserting `tests pass`:',
  '',
  '  1. Restore the file(s) to their merge-base content with `git checkout $(git merge-base HEAD origin/main) -- <file>`, run `npx vitest run <failing-file>`, then restore your version with `git checkout HEAD -- <file>` (or re-apply your edit). **Never use `git stash`** — `refs/stash` is shared by every worktree in this repo and is addressed by position, so a `stash pop` here can silently swallow another task\'s work.',
  '  2. Quote BOTH result summaries verbatim in your final message: the branch-tip run result and the merge-base baseline run result.',
  '  3. If the baseline check cannot be run (checkout conflict, missing merge base, harness restriction), your final message MUST use the literal phrase `pre-existing UNVERIFIED` instead of `tests pass`.',
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
  '- **Iterate against the narrowest test file first.** Run only the test file(s) directly touched by your change on each iteration; run the full suite once at the end to confirm nothing else broke.',
].join('\n')

// Build the Coder Worker's standing Session instructions.
const defaultCoderSystemPrompt = (): string =>
  [TDD_WORKER_BRIEF, CONTEXT_GATHERING_BRIEF, DEVIATION_RULES].join('\n\n')

// This is the production composition seam for the persistent Steward
// override. It applies only to Mars-owned standing instructions, never to a
// Task's operator-authored prompt body.
export const buildCoderSystemPrompt = (): string =>
  readWorkerPromptOverride('Coder.system') ?? defaultCoderSystemPrompt()

/** Read the baseline text for a block before any persisted Steward edit. */
export const defaultWorkerPromptBlock = (block: 'Coder.system' | 'COMMIT_FOOTER'): string =>
  block === 'Coder.system' ? defaultCoderSystemPrompt() : COMMIT_FOOTER

/** Read the live Mars-owned block text used by the production composer. */
export const workerPromptBlock = (block: 'Coder.system' | 'COMMIT_FOOTER'): string =>
  block === 'Coder.system'
    ? buildCoderSystemPrompt()
    : readWorkerPromptOverride('COMMIT_FOOTER') ?? COMMIT_FOOTER

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
  if (spec.mergeMode === 'gated') {
    parts.push(
      `<merge_mode>gated — pause for human verification before merge</merge_mode>`,
    )
  } else {
    parts.push(`<merge_mode>auto — execute end-to-end and commit</merge_mode>`)
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
  _tag: TaskTag = 'coder',
  spec: TaskSpec | null = null,
  taskId = '',
  worktreeRoot = '',
  kind: 'task' | 'fix' | 'diagnose' = 'task',
  lessons: string[] = [],
): string => {
  // Diagnose Chore short-circuit: the prompt arrives fully composed.
  if (kind === 'diagnose') return prompt.trim()
  const sections: string[] = [COMMIT_EXIT_CONDITION, prompt.trim()]
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
  if (lessons.length > 0) {
    const items = lessons.map((l) => `  - ${l}`).join('\n')
    sections.push(`## Lessons\n\n<lessons>\n${items}\n</lessons>`)
  }
  sections.push(CODING_DISCIPLINE)
  sections.push(workerPromptBlock('COMMIT_FOOTER'))
  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Worker prompt inspection
// ---------------------------------------------------------------------------

/** A section measured from the exact prompt text the selected provider receives. */
export interface WorkerPromptSection {
  name: string
  channel: 'system' | 'user'
  byteOffset: number
  tokenOffset: number
  depthPercent: number
  bytes: number
  tokens: number
}

export interface WorkerPromptMeasurement {
  worker: WorkerName
  provider: 'claude' | 'codex'
  /** Exact provider transport distinction, rather than a generic "system" label. */
  assembly: 'codex-inlined-mars-system-instructions' | 'claude-append-system-prompt'
  totalBytes: number
  totalTokens: number
  boilerplateToTaskRatio: number
  sections: WorkerPromptSection[]
  duplicatedDirectives: string[]
}

// Tokenizers vary by provider and are not available in the standalone Mars
// binary. This stable lexical estimate is deliberately labelled as tokens in
// the report only alongside byte offsets; callers must not use it for model
// billing or context-limit enforcement.
const estimatedTokens = (text: string): number =>
  text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length

const markdownSections = (text: string, channel: 'system' | 'user'): Array<{ name: string; channel: 'system' | 'user'; start: number; text: string }> => {
  const headings = [...text.matchAll(/^##\s+.+$/gmu)]
  if (headings.length === 0) {
    return [{ name: channel === 'system' ? 'Coder.system' : 'Task', channel, start: 0, text }]
  }
  const sections: Array<{ name: string; channel: 'system' | 'user'; start: number; text: string }> = []
  if (headings[0]!.index! > 0) {
    sections.push({ name: channel === 'system' ? 'Coder.system preamble' : 'Task preamble', channel, start: 0, text: text.slice(0, headings[0]!.index) })
  }
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    const start = heading.index!
    const end = headings[index + 1]?.index ?? text.length
    sections.push({ name: heading[0], channel, start, text: text.slice(start, end) })
  }
  return sections
}

const directiveLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.replace(/^[-*\d.\s#>`]+/u, '').replace(/[`*_]/gu, '').trim().toLowerCase())
    .filter((line) => line.length >= 24 && /(?:must|never|do not|always|before|commit|verify)/u.test(line))

/**
 * Inspect a real Coder dispatch composition. It deliberately calls the same
 * `buildCoderSystemPrompt` and `composePrompt` functions used by workflow
 * dispatch; it is not a parallel prompt template.
 */
export const measureWorkerDispatchPrompt = (
  worker: WorkerName = 'Coder',
  taskPrompt = 'Implement the requested change.',
  provider: 'claude' | 'codex' = 'codex',
): WorkerPromptMeasurement => {
  if (worker !== 'Coder') {
    throw new Error(`prompt measurement currently supports Coder; received '${worker}'`)
  }
  const system = buildCoderSystemPrompt()
  const user = composePrompt(taskPrompt, null, 'coder')
  const inlinedPrefix = '<mars_system_instructions>\n'
  const inlinedSuffix = '</mars_system_instructions>\n\n'
  const wire =
    provider === 'codex'
      ? composeCodexPrompt(user, system)
      : `${system}\n\n${user}`
  const totalBytes = Buffer.byteLength(wire)
  const totalTokens = estimatedTokens(wire)
  const sections = [...markdownSections(system, 'system'), ...markdownSections(user, 'user')].map((section) => {
    const wirePrefix =
      section.channel === 'system'
        ? provider === 'codex'
          ? `${inlinedPrefix}${system.slice(0, section.start)}`
          : system.slice(0, section.start)
        : provider === 'codex'
          ? `${inlinedPrefix}${system}${inlinedSuffix}${user.slice(0, section.start)}`
          : `${system}\n\n${user.slice(0, section.start)}`
    const byteOffset = Buffer.byteLength(wirePrefix)
    const tokenOffset = estimatedTokens(wirePrefix)
    const bytes = Buffer.byteLength(section.text)
    const tokens = estimatedTokens(section.text)
    return {
      name: section.name,
      channel: section.channel,
      byteOffset,
      tokenOffset,
      depthPercent: totalBytes === 0 ? 0 : (byteOffset / totalBytes) * 100,
      bytes,
      tokens,
    }
  })
  const systemDirectives = new Set(directiveLines(system))
  const duplicatedDirectives = [...new Set(directiveLines(user).filter((line) => systemDirectives.has(line)))]
  return {
    worker,
    provider,
    assembly:
      provider === 'codex'
        ? 'codex-inlined-mars-system-instructions'
        : 'claude-append-system-prompt',
    totalBytes,
    totalTokens,
    boilerplateToTaskRatio: taskPrompt.trim().length === 0 ? Infinity : (totalBytes - Buffer.byteLength(taskPrompt.trim())) / Buffer.byteLength(taskPrompt.trim()),
    sections,
    duplicatedDirectives,
  }
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
  | { kind: 'dirty-with-commits'; dirtyFiles: string[]; commitsAhead: number }
  | { kind: 'clean-with-commits'; commitsAhead: number }
  | { kind: 'clean-no-work' }
  | { kind: 'error'; error: string }

/**
 * First line of the coder-left-uncommitted failure output. Contains
 * "has uncommitted changes", which is what `classifyError` keys the
 * `uncommitted-changes` slug off — keep the phrase intact when editing, or the
 * signature stops resolving to {@link CODER_UNCOMMITTED_SIGNATURE} and the
 * failure degrades to `unclassified`.
 */
export const coderUncommittedSummary = (
  taskId: string,
  fileCount: number,
): string =>
  `task ${taskId} worktree has uncommitted changes after the code step: coder left ${fileCount} path(s) uncommitted`

/**
 * Full failure output for the terminal coder-left-uncommitted path: the
 * summary line, the offending file list, why the auto-commit net could not
 * land it, and the worktree location so the retained tree is inspected in the
 * right context.
 *
 * Reaching this text means BOTH recovery stages were exhausted — the coder got
 * one corrective commit turn and the deterministic `git add -A && git commit`
 * was refused. It is not emitted for a merely-dirty worktree.
 */
export const coderUncommittedFailure = (args: {
  taskId: string
  worktreePath: string
  branch: string
  integrationBranch: string
  dirtyFiles: string[]
  commitsAhead: number
  autoCommitReason: string
}): string =>
  [
    coderUncommittedSummary(args.taskId, args.dirtyFiles.length),
    '',
    `The coder committed ${args.commitsAhead} commit(s) onto ${args.branch} and left these path(s) uncommitted:`,
    ...args.dirtyFiles.map((f) => `  ${f}`),
    '',
    `A corrective coder turn ran first and did not commit them; the orchestrator's deterministic auto-commit was then refused: ${args.autoCommitReason}`,
    '',
    `Worktree: ${args.worktreePath}`,
    `Branch: ${args.branch} (integration branch: ${args.integrationBranch})`,
    '',
    'An uncommitted path never reaches verify and blocks the rebase at merge, so',
    'the blocker has to be cleared and the work landed before this task retries.',
  ].join('\n')

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

  // Dirtiness is classified FIRST: a tree with uncommitted paths is dirty
  // whether or not the coder also produced commits. Reading `commitsAhead`
  // first (the pre-2026-07 shape) collapsed "committed some work, left the
  // rest uncommitted" into `clean-with-commits`, which passed the code step,
  // passed verify's has-diff gate, and only blew up at the rebase as
  // `merge/unclassified` (task fix-30ac0aaa).
  if (dirtyFiles.length > 0) {
    return commitsAhead > 0
      ? { kind: 'dirty-with-commits', dirtyFiles, commitsAhead }
      : { kind: 'dirty-no-commits', dirtyFiles }
  }
  if (commitsAhead > 0) {
    return { kind: 'clean-with-commits', commitsAhead }
  }
  return { kind: 'clean-no-work' }
}
