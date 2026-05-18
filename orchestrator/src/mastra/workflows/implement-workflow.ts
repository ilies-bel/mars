import { createWorkflow, createStep } from '@mastra/core/workflows'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

const execFileAsync = promisify(execFile)
import {
  checkSetupPreflight,
  cleanWorktreeIfNoCommitsAhead,
  createWorktree,
  removeWorktree,
  verifyChanges,
  loadVerifyScopes,
  selectVerifySteps,
  getChangedFiles,
  mergeBranch,
  checkMergeTargetStatus,
  detectTemplatePaths,
} from '../lib/git'
import { getWorkerForTag } from '../workers'
import {
  TASK_TAGS,
  isTaskTag,
  TASK_TYPES,
  type TaskTag,
  type TaskSpec,
} from '../queue'
import { resolveContext } from '../context'
import {
  installWorktreeDeps,
  WorktreeInstallError,
} from '../lib/worktree-install'
import type { ClaudeEvent } from '../lib/claude-stream'
import {
  getTask,
  hasIncompleteBlockers,
  updateTask,
  upsertTranscript,
} from '../queue'
import { raiseInboxItem } from '../lib/inbox'
import { handleTaskFailureWithFixTask } from '../queue-fix-tasks'
import { resolveOriginIdForTask } from '../lib/origin'

export const BLOCKERS_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} has incomplete blockers; aborting dispatch (task remains queued)`

// Mastra's workflow runner wraps a step-thrown error before it surfaces on
// `run.start()`'s result (e.g. `new Error("Step <id> failed: <original>")`
// with the original on `.cause`). Matching only `err.message` therefore
// misses the sentinel once it's wrapped. Flatten the message + the entire
// `cause` chain (depth-bounded against cycles) into one haystack so a
// wrapped sentinel is still recognised.
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

// Thrown by setupStep when the merge target (integration branch) has
// uncommitted tracked changes at the moment the worktree would be created.
// The task is parked as `blocked` and an inbox item is raised so the
// operator can clean up. The sentinel keeps the dispatcher from routing
// this through the generic failure-handler (which would spawn a fix-task
// and stamp `failed`, masking the blocked state).
export const DIRTY_MAIN_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} setup aborted: merge target has uncommitted changes; task parked blocked`

export const isDirtyMainAbortError = (err: unknown): boolean =>
  errorHaystack(err).includes('setup aborted: merge target has uncommitted changes')

import { verifyPassedScorer } from '../scorers/verify-passed'
import { mergeCleanScorer } from '../scorers/merge-clean'
import { summarizeUsage } from '../lib/claude-usage'
import { recordSignals, isReflectDisabled } from '../lib/reflect-signals'
import { resolveVerifyCwd, type RanVerifyStep } from '../lib/derive-repro-command'
import { resolveTaskCwd } from '../lib/resolve-task-cwd'
import { relative } from 'node:path'
import {
  createReadSpanWatcher,
  resolveReadSpanLimit,
} from '../lib/read-span-watch'
import { TDD_WORKER_BRIEF } from './tdd-brief'

const planSchema = z
  .object({
    functional: z.string(),
    technical: z.string(),
  })
  .nullable()

// Worker-routing tag, mirroring {@link TaskTag}. Defaults to 'coder' when
// the dispatcher omits it (legacy/tagless rows) so the workflow keeps
// running on Coder unless a tag is explicitly threaded through.
const tagSchema: z.ZodType<TaskTag> = z.enum(TASK_TAGS as readonly [TaskTag, ...TaskTag[]])
  .default('coder')

// Phases that the workflow can be resumed from. Mirrors {@link FailedPhase}
// in queue.ts but the workflow only ever resumes from a verify-or-later
// failure: 'code' failures (setup:install) are non-resumable.
const resumeFromSchema = z.enum(['verify', 'merge']).nullable().default(null)

// Structured-task contract. Mirrors {@link TaskSpec} in queue.ts. Optional so
// legacy free-prose rows still flow through composePrompt unchanged.
const specSchema = z
  .object({
    files: z.array(z.string()),
    verifyCmd: z.string().nullable(),
    doneCriteria: z.array(z.string()),
    taskType: z.enum(TASK_TYPES as readonly ['auto', 'checkpoint']),
  })
  .nullable()
  .default(null)

const STEP_ORDER = ['setup-worktree', 'run-claude-code', 'verify', 'merge'] as const

// Map a resume hint to the rank of the first step that should actually
// execute. Steps with a lower rank pass through, reusing the persisted
// branch + worktree from the previous run.
const resumeRank = (resumeFrom: 'verify' | 'merge' | null): number => {
  if (resumeFrom === 'verify') return STEP_ORDER.indexOf('verify')
  if (resumeFrom === 'merge') return STEP_ORDER.indexOf('merge')
  return 0
}

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

// Footer for Writer tasks. The Writer lands its work via `mars glossary
// set/remove` and `mars adr add`, both of which route through the daemon's
// structured-write path and commit on the integration branch directly —
// there is no worktree commit to make. Telling the Writer to run
// `git add -A && git commit` (the Coder footer) would be a no-op at best
// and confuse the agent into thinking it failed at worst. Instead, the
// Writer footer names the canonical verbs and reminds it that the
// daemon, not the worktree, owns the commit.
export const WRITER_FOOTER = [
  '## Save your work',
  '',
  'You are a Writer worker. You cannot edit files in this worktree directly. Land every change through the canonical daemon verbs:',
  '',
  '- `mars glossary set "<term>" "<definition>"` to add or update a glossary term.',
  '- `mars glossary remove "<term>"` to retire a glossary term.',
  '- `mars adr add --title "<title>" --body "<body>"` to record an ADR.',
  '',
  'Each call routes through the structured-write daemon, which performs the file edit on its own internal worktree and merges into the integration branch. You do not run `git add` or `git commit` yourself — the daemon owns the commit.',
  '',
  'After every call succeeds, verify the change took effect (e.g. `mars glossary show "<term>"` or `mars adr show <NNNN>`) before moving to the next acceptance criterion. When every criterion is satisfied, exit.',
].join('\n')

// System prompt injected on top of the worker's default for Writer Sessions.
// Pins the agent's mental model to the structured-write verbs so it does not
// reach for Edit/Write (which are denied at the wrapper layer anyway) when
// asked to update CONTEXT.md or docs/adr/**.
export const WRITER_SYSTEM_PROMPT = [
  'You are the Writer worker.',
  '',
  'You land documentation changes (glossary terms, ADRs) by calling the Mars CLI verbs that route through the structured-write daemon, NOT by editing files in this worktree.',
  '',
  'The only mutation verbs available to you are:',
  '  - mars glossary set "<term>" "<definition>" [--aliases "<alias1>,<alias2>"]',
  '  - mars glossary remove "<term>"',
  '  - mars adr add --title "<title>" --body "<body>"',
  '',
  'You may read freely (Read, Grep, Glob, Bash for read-only commands). Edit, Write, and NotebookEdit are disabled — attempting to edit CONTEXT.md or docs/adr/** in the worktree will fail.',
  '',
  'When every acceptance criterion is satisfied via the verbs above, exit cleanly. The daemon commits each verb on the integration branch on your behalf.',
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
  '  3. For deferred refactors / observed cleanups that should NOT block this slice, run `mars idea add "<observation>"` so the loose end is captured but parked in the idea backlog.',
  '  4. Commit whatever in-scope work is already complete, then exit. The orchestrator will re-dispatch this task once the new blocker resolves.',
  '',
  '**Scope boundary.** Only fix issues your changes touch. Pre-existing warnings, linting errors, or failures in unrelated files are out of scope — file them with `mars idea add "<observation>"` if interesting; do NOT fix them inline.',
  '',
  '**Fix-attempt cap.** If you have run the verify command 3 times on this task and it still fails for reasons you cannot explain, STOP. File a follow-up task via `mars task add --blocked-by $TASK_ID` describing the failing verify and what you tried, then exit. Do not loop.',
  '',
  '`$TASK_ID` is the id of the task you are executing right now; the orchestrator passes it to you in the brief below.',
].join('\n')

// Standing Session instructions for the Coder Worker. The test-driven-
// development operating philosophy and the deviation rules are both passed
// once, as the Worker's Session-level system prompt, so they are present for
// the whole Session and never re-sent inside the per-Task prompt. This means
// the Coder does not re-absorb ~150+ lines of boilerplate at the top of every
// Task and a retry does not replay it verbatim — keeping the per-task
// prompt focused on the actual work.
export const CODER_SYSTEM_PROMPT = [TDD_WORKER_BRIEF, DEVIATION_RULES].join('\n\n')

// Resolve the standing Session instructions a dispatched Worker is launched
// with, by routing tag. Coder carries the TDD operating philosophy and
// deviation rules; Writer keeps its structured-write mental model (unchanged).
// Centralised here so codeStep does not assemble the system prompt inline and
// the per-tag surface is a single auditable seam.
export const resolveWorkerSystemPrompt = (
  tag: TaskTag,
): string | undefined =>
  tag === 'writer' ? WRITER_SYSTEM_PROMPT : CODER_SYSTEM_PROMPT

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
// codeStep below). We *disclose* the project subdirectory here rather
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
): string => {
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
  // Both tags get their footer. Deviation rules are NOT included here — they
  // are part of CODER_SYSTEM_PROMPT (standing Session instructions) and must
  // not appear in the per-Task prompt.
  sections.push(tag === 'writer' ? WRITER_FOOTER : COMMIT_FOOTER)
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
// Logging lives at the call site (codeStep below) so the same classifier
// is reusable from tests without spying on console.
export interface PostCoderStateArgs {
  worktreePath: string
  integrationBranch: string
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
  let commitsAhead: number
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', `${args.integrationBranch}..HEAD`],
      { cwd: args.worktreePath },
    )
    const parsed = Number.parseInt(stdout.trim(), 10)
    if (!Number.isInteger(parsed)) {
      return { kind: 'error', error: `rev-list emitted non-integer: ${stdout.trim()}` }
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
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: args.worktreePath },
    )
    dirtyFiles = parsePorcelainPaths(stdout)
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

const setupStep = createStep({
  id: 'setup-worktree',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema.default(null),
    tag: tagSchema,
    integrationBranch: z.string().default('main'),
    resumeFrom: resumeFromSchema,
    spec: specSchema,
  }),
  outputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema,
    tag: tagSchema,
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    resumeFrom: resumeFromSchema,
    spec: specSchema,
  }),
  execute: async ({ inputData, tracingContext }) => {
    const originId = await resolveOriginIdForTask(inputData.taskId)
    tracingContext?.currentSpan?.update({
      metadata: { originId, taskId: inputData.taskId },
    })
    // `hasIncompleteBlockers` checks the task-dependency junction
    // (`task_blockers`), NOT the removed question/answer feature. The
    // orchestrator does not read, wait on, or branch based on question rows —
    // the planner emits ideas, not questions, and a task progresses through
    // draft → queued → running purely on plan completeness (PRD eb6f8cc6).
    // Do not reintroduce question-gating here.
    if (await hasIncompleteBlockers(inputData.taskId)) {
      throw new Error(BLOCKERS_ABORT_MESSAGE(inputData.taskId))
    }

    // Resume short-circuit: 'mars continue' restarted this task on the
    // existing branch+worktree. Skip worktree creation and dep install;
    // re-use whatever the previous run committed.
    if (resumeRank(inputData.resumeFrom) > STEP_ORDER.indexOf('setup-worktree')) {
      const persisted = await getTask(inputData.taskId)
      if (!persisted?.branch || !persisted?.worktreePath) {
        throw new Error(
          `task ${inputData.taskId} has resumeFrom=${inputData.resumeFrom} but no branch/worktree on the row; refusing to resume`,
        )
      }
      return {
        ...inputData,
        path: persisted.worktreePath,
        branch: persisted.branch,
      }
    }

    // Setup-time pre-flight: abort before creating the worktree or dispatching
    // the coding agent when the merge target already has uncommitted changes on
    // tracked paths. This is the same condition that checkMergeTargetStatus
    // catches at merge time — detecting it here prevents the full coding cost
    // (historically ~$1–2 per occurrence). Only tracked files matter:
    // untracked/ignored files cannot block `git merge --ff-only`.
    try {
      const { repoRoot: preflightRoot } = resolveContext()
      const preflight = await checkSetupPreflight(preflightRoot)
      if (preflight.dirty) {
        const dirtyFiles = preflight.dirtyLines
        const errorMsg = `setup:preflight/dirty-main: ${inputData.integrationBranch} has uncommitted changes; task parked blocked`
        await updateTask(inputData.taskId, { status: 'blocked', error: errorMsg })
        await raiseInboxItem({
          kind: 'dirty-main-at-setup',
          category: 'orchestrator',
          priority: 'high',
          title: `Task ${inputData.taskId} blocked: merge target has uncommitted changes before coding`,
          body: [
            `The merge target (\`${inputData.integrationBranch}\`) has uncommitted changes. The coding agent was NOT dispatched — no compute cost was incurred.`,
            '',
            '## Dirty files',
            '',
            dirtyFiles.join('\n'),
            '',
            `Resolve the uncommitted changes on \`${inputData.integrationBranch}\`, then restart with:`,
            '```',
            `mars restart ${inputData.taskId}`,
            '```',
          ].join('\n'),
          payload: {
            taskId: inputData.taskId,
            dirtyFiles,
            integrationBranch: inputData.integrationBranch,
          },
          context: {},
          raisedBy: 'implement-workflow',
          signature: `dirty-main-at-setup:${inputData.taskId}`,
        }).catch((err) => {
          console.error(
            `[setup:preflight] task ${inputData.taskId} failed to raise inbox item:`,
            err,
          )
        })
        throw new Error(DIRTY_MAIN_ABORT_MESSAGE(inputData.taskId))
      }
    } catch (gitErr) {
      // Re-throw only our own dirty-main sentinel. Git/IO failures are swallowed:
      // the pre-flight is best-effort — if we cannot determine the target's state
      // we proceed and let the merge-time check catch it.
      if (gitErr instanceof Error && isDirtyMainAbortError(gitErr)) throw gitErr
      console.warn(
        `[setup:preflight] task ${inputData.taskId} dirty-main pre-flight threw, continuing:`,
        gitErr,
      )
    }

    await updateTask(inputData.taskId, { status: 'running' })
    const ref = await createWorktree({
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch,
    })
    await updateTask(inputData.taskId, {
      branch: ref.branch,
      worktreePath: ref.path,
    })

    // Capture the integration HEAD SHA at setup time so the task row records
    // which commit the worktree branched from. Non-fatal: a missed capture
    // (e.g. the branch does not exist yet in a fresh repo) is better than a
    // failed setup. The column is nullable for exactly this case.
    try {
      const { repoRoot } = resolveContext()
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', inputData.integrationBranch],
        { cwd: repoRoot },
      )
      await updateTask(inputData.taskId, { integrationHeadSha: stdout.trim() })
    } catch {
      // Non-fatal: leave integration_head_sha as null.
    }

    try {
      const summary = await installWorktreeDeps({
        worktreeRoot: ref.path,
        log: (line) => console.log(line),
      })
      if (summary.sites.length > 0) {
        console.log(
          `[setup] task ${inputData.taskId} install completed in ${(
            summary.totalDurationMs / 1000
          ).toFixed(1)}s (${summary.sites.length} manifest${summary.sites.length === 1 ? '' : 's'})`,
        )
      }
    } catch (error: unknown) {
      const isInstallErr = error instanceof WorktreeInstallError
      const errorOutput = isInstallErr ? error.message : String(error)
      const summary = errorOutput.slice(0, 1000)
      await updateTask(inputData.taskId, {
        status: 'failed',
        error: summary,
        failedPhase: 'code',
      })
      await handleTaskFailureWithFixTask({
        taskId: inputData.taskId,
        failingStep: 'setup:install',
        // Lead with a classifier-friendly summary; the recipe gets the
        // raw error via recipeContext.statusOutput.
        errorOutput: `frozen-lockfile install failed\n${errorOutput}`,
        branch: ref.branch,
        recipeContext: {
          targetPath: isInstallErr ? error.site.dir : ref.path,
          statusOutput: errorOutput,
          targetBranch: ref.branch,
          // Handler backfills from task.prompt when '' is passed.
          originalPrompt: '',
        },
      }).catch((err) => {
        console.error(
          `[failure-handler] task ${inputData.taskId} setup:install handling errored:`,
          err,
        )
      })
      throw error instanceof Error ? error : new Error(errorOutput)
    }

    return { ...inputData, ...ref }
  },
})

const codeStep = createStep({
  id: 'run-claude-code',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema,
    tag: tagSchema,
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    resumeFrom: resumeFromSchema,
    spec: specSchema,
  }),
  outputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    tag: tagSchema,
    claudeExitCode: z.number(),
    resumeFrom: resumeFromSchema,
  }),
  execute: async ({ inputData, writer, tracingContext }) => {
    // Resume short-circuit: the worker already ran in a previous attempt
    // and committed its work. Skip the claude-code invocation entirely;
    // pass-through with a synthetic exit code 0.
    if (resumeRank(inputData.resumeFrom) > STEP_ORDER.indexOf('run-claude-code')) {
      return {
        taskId: inputData.taskId,
        integrationBranch: inputData.integrationBranch,
        path: inputData.path,
        branch: inputData.branch,
        tag: inputData.tag,
        claudeExitCode: 0,
        resumeFrom: inputData.resumeFrom,
      }
    }

    // Sweep stray untracked files from a previous failed attempt on this
    // branch BEFORE invoking the agent. Without this, a re-dispatch of a
    // source task that the orchestrator unblocked after a recovery
    // inherits the prior Coder's debris (e.g. files written under a
    // wrongly-nested path that the previous run never staged) and burns
    // turns inspecting them before getting to the actual work. The clean
    // is gated on `rev-list --count <integration>..HEAD == 0`, so any
    // commits the agent already produced are preserved.
    try {
      const cleanResult = await cleanWorktreeIfNoCommitsAhead({
        worktreePath: inputData.path,
        integrationBranch: inputData.integrationBranch,
      })
      if (cleanResult.cleaned && cleanResult.output.trim().length > 0) {
        console.log(
          `[clean] task ${inputData.taskId} ${cleanResult.reason}\n${cleanResult.output.trim()}`,
        )
      } else if (!cleanResult.cleaned) {
        console.log(
          `[clean] task ${inputData.taskId} skipped: ${cleanResult.reason}`,
        )
      }
    } catch (err) {
      // Clean is a best-effort hygiene step; never fail the dispatch on it.
      console.error(
        `[clean] task ${inputData.taskId} threw, continuing without clean:`,
        err,
      )
    }

    const originId = await resolveOriginIdForTask(inputData.taskId)
    const tag = isTaskTag(inputData.tag) ? inputData.tag : 'coder'
    const fullPrompt = composePrompt(
      inputData.prompt,
      inputData.plan,
      tag,
      inputData.spec ?? null,
      inputData.taskId,
      inputData.path,
    )
    const conversation: ClaudeEvent[] = []
    const worker = getWorkerForTag(tag)
    // Read/Grep span watcher (gsd-style analysis-paralysis signal). Only
    // applied to Coder runs — Writer's surface is too narrow to stall on
    // reads. Log-only: when the streak first crosses the limit we emit
    // one diagnostic line and otherwise let the run proceed.
    const watcher =
      tag === 'coder'
        ? createReadSpanWatcher({
            limit: resolveReadSpanLimit(),
            onThreshold: (info) => {
              console.log(
                `[span] task ${inputData.taskId}: ${info.limit} consecutive Read/Grep/Glob calls without action (trace=${info.trace.map((t) => t.tool).join('+')}).`,
              )
            },
          })
        : null
    const r = await worker.run(fullPrompt, {
      cwd: inputData.path,
      systemPrompt: resolveWorkerSystemPrompt(tag),
      onEvent: async (event) => {
        conversation.push(event)
        watcher?.observe(event)
        await writer?.write({ type: 'claude-event', event })
      },
    })
    // Classify the worktree end-state. Only the 'dirty-no-commits' case is
    // worth a log line — it's the new failure mode the post-test commit
    // guard is being built to detect. Clean-success and clean-no-work are
    // already covered by verify's existing signal. Errors are logged at
    // warn level so a flaky git invocation doesn't pollute the success
    // path. Best-effort: never fails the dispatch.
    try {
      const postState = await detectPostCoderState({
        worktreePath: inputData.path,
        integrationBranch: inputData.integrationBranch,
      })
      if (postState.kind === 'dirty-no-commits') {
        console.log(
          `[post-coder] task ${inputData.taskId}: dirty tree with 0 commits ahead of ${inputData.integrationBranch} — ${postState.dirtyFiles.length} uncommitted path(s):\n  ${postState.dirtyFiles.join('\n  ')}`,
        )
      } else if (postState.kind === 'error') {
        console.warn(
          `[post-coder] task ${inputData.taskId}: classifier error: ${postState.error}`,
        )
      }
    } catch (err) {
      console.warn(
        `[post-coder] task ${inputData.taskId}: classifier threw, continuing:`,
        err,
      )
    }

    const usage = summarizeUsage(conversation)
    tracingContext?.currentSpan?.update({
      metadata: {
        originId,
        taskId: inputData.taskId,
        claudeSessionId: r.sessionId,
        usage,
      },
    })
    if (r.sessionId) {
      await updateTask(inputData.taskId, { claudeSessionId: r.sessionId })
    }
    await recordSignals(inputData.taskId, 'run-claude-code', usage).catch(() => {
      // signal capture must never fail the task
    })
    if (!isReflectDisabled()) {
      await upsertTranscript({
        taskId: inputData.taskId,
        conversationJson: JSON.stringify(conversation),
      }).catch(() => {
        // transcript capture must never fail the task
      })
    }
    return {
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch,
      path: inputData.path,
      branch: inputData.branch,
      tag,
      claudeExitCode: r.exitCode,
      resumeFrom: inputData.resumeFrom,
    }
  },
})

const verifyStep = createStep({
  id: 'verify',
  inputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    tag: tagSchema,
    claudeExitCode: z.number(),
    resumeFrom: resumeFromSchema,
  }),
  outputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    tag: tagSchema,
    verified: z.boolean(),
  }),
  scorers: {
    verifyPassed: {
      scorer: verifyPassedScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
  execute: async ({ inputData, tracingContext }) => {
    const originId = await resolveOriginIdForTask(inputData.taskId)
    tracingContext?.currentSpan?.update({
      metadata: { originId, taskId: inputData.taskId },
    })

    // Resume short-circuit: 'mars continue' is jumping straight to merge.
    // Verify already passed in the previous run; trust it and pass through.
    if (resumeRank(inputData.resumeFrom) > STEP_ORDER.indexOf('verify')) {
      return {
        taskId: inputData.taskId,
        integrationBranch: inputData.integrationBranch,
        path: inputData.path,
        branch: inputData.branch,
        tag: inputData.tag,
        verified: true,
      }
    }

    // Entering verify for real: clear both the previous failure stamp and
    // the resume hint so a subsequent failure records this run's phase.
    await updateTask(inputData.taskId, {
      status: 'verifying',
      failedPhase: null,
      resumeFrom: null,
    })
    const verifyCwd = resolveVerifyCwd(inputData.path)
    const ctx = resolveContext()
    // Scope-aware verify-step selection: look at the files the task
    // actually changed between its branch and integration, then run the
    // root scope's steps (the repo-wide floor) plus every narrower scope
    // whose subtree a changed file falls in — each in its own directory.
    const scopes = await loadVerifyScopes(ctx.supervisorsManifest)
    const changedFiles = await getChangedFiles(
      inputData.path,
      inputData.integrationBranch,
      inputData.branch,
    )
    const steps = selectVerifySteps(scopes, changedFiles)
    // Writer tasks land their changes on the integration branch via the
    // daemon's structured-write path, not on the task branch — so the
    // task branch is correctly 0 commits ahead of integration and the
    // has-diff check would reject a perfectly successful Writer run.
    // Skip has-diff for writer; the typecheck/test/lint gates still apply.
    const r = await verifyChanges({
      cwd: verifyCwd,
      steps,
      branch: inputData.branch,
      integrationBranch: inputData.integrationBranch,
      skipDiffCheck: inputData.tag === 'writer',
    })

    if (!isReflectDisabled()) {
      const verifyOutput = r.steps
        .map((s) => `=== ${s.name} (${s.passed ? 'pass' : 'fail'}) ===\n${s.output}`)
        .join('\n\n')
      await upsertTranscript({
        taskId: inputData.taskId,
        verifyOutput,
      }).catch(() => {
        // transcript capture must never fail the task
      })
    }

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
      await updateTask(inputData.taskId, {
        status: 'failed',
        error: summary,
        failedPhase: 'verify',
      })
      await handleTaskFailureWithFixTask({
        taskId: inputData.taskId,
        failingStep: `verify:${firstFailedName}`,
        errorOutput: firstFailedOutput,
        branch: inputData.branch,
        ranVerifySteps,
        recipeContext: {
          targetPath: inputData.path,
          statusOutput: firstFailedOutput,
          targetBranch: inputData.branch,
          integrationBranch: inputData.integrationBranch,
          // Handler backfills from task.prompt when '' is passed.
          originalPrompt: '',
        },
      }).catch((err) => {
        console.error(
          `[failure-handler] task ${inputData.taskId} verify failure handling errored:`,
          err,
        )
      })
    }

    return {
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch,
      path: inputData.path,
      branch: inputData.branch,
      tag: inputData.tag,
      verified: r.passed,
    }
  },
})

const mergeStep = createStep({
  id: 'merge',
  inputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    tag: tagSchema,
    verified: z.boolean(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    success: z.boolean(),
    message: z.string(),
  }),
  scorers: {
    mergeClean: {
      scorer: mergeCleanScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
  execute: async ({ inputData, writer, tracingContext }) => {
    const originId = await resolveOriginIdForTask(inputData.taskId)
    tracingContext?.currentSpan?.update({
      metadata: { originId, taskId: inputData.taskId },
    })
    if (!inputData.verified) {
      return {
        taskId: inputData.taskId,
        success: false,
        message: 'verification failed; worktree retained for inspection',
      }
    }

    // Writer short-circuit: the daemon's structured-write path already
    // committed every change on the integration branch, so the task
    // branch is identical to integration and there is nothing to merge.
    // Clean up the worktree and mark the task done; the merge primitive
    // would otherwise contend for the merge lock for a guaranteed no-op.
    if (inputData.tag === 'writer') {
      await removeWorktree({ path: inputData.path, branch: inputData.branch }, true)
      await updateTask(inputData.taskId, { status: 'done', failedPhase: null })
      return {
        taskId: inputData.taskId,
        success: true,
        message: 'writer task: changes landed on integration via structured-write daemon',
      }
    }

    // Any unhandled throw from mergeBranch (e.g. an unexpected git failure)
    // must transition the task to a terminal status. Otherwise the queue row
    // stays at 'merging' forever and `mars list` hides the failure.
    try {
      // Entering merge for real: clear any previous failure stamp + the
      // resume hint so a subsequent failure records this run's phase.
      await updateTask(inputData.taskId, {
        status: 'merging',
        failedPhase: null,
        resumeFrom: null,
      })

      const targetStatus = await checkMergeTargetStatus({
        integrationBranch: inputData.integrationBranch,
        taskBranch: inputData.branch,
      })
      if (targetStatus.kind === 'needs-rebase') {
        // Diverged / behind integration — recoverable, NOT a failure.
        // mergeBranch Step 1 rebases the task branch onto integration
        // (escalating to the vcs-supervisor on conflict) before the
        // --ff-only merge. Parking here is the bug that dead-looped every
        // lapped branch through the retry budget. Fall through to merge.
        console.log(
          `[merge:preflight] task ${inputData.taskId} ${targetStatus.statusOutput}; proceeding to rebase-before-ff`,
        )
      }
      if (targetStatus.kind === 'dirty') {
        const errorMsg = `merge target has uncommitted changes; cannot fast-forward into ${inputData.integrationBranch}`
        await updateTask(inputData.taskId, {
          status: 'failed',
          error: errorMsg,
          failedPhase: 'merge',
        })
        await handleTaskFailureWithFixTask({
          taskId: inputData.taskId,
          failingStep: 'merge:preflight',
          // Classifier-friendly lead line; raw porcelain via recipeContext.
          errorOutput: `merge target ${targetStatus.targetPath} has uncommitted changes blocking fast-forward\n${targetStatus.statusOutput}`,
          branch: inputData.branch,
          recipeContext: {
            targetPath: targetStatus.targetPath,
            statusOutput: targetStatus.statusOutput,
            targetBranch: inputData.integrationBranch,
            // Handler backfills from task.prompt when '' is passed.
            originalPrompt: '',
          },
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${inputData.taskId} dirty-merge-target handling errored:`,
            err,
          )
        })
        return {
          taskId: inputData.taskId,
          success: false,
          message: `merge pre-flight detected dirty target ${inputData.integrationBranch}; worktree retained`,
        }
      }
      if (targetStatus.kind === 'error') {
        await updateTask(inputData.taskId, {
          status: 'failed',
          error: `merge pre-flight git status failed: ${targetStatus.error.message}`.slice(0, 1000),
          failedPhase: 'merge',
        })
        return {
          taskId: inputData.taskId,
          success: false,
          message: `merge pre-flight failed: ${targetStatus.error.message}`,
        }
      }

      // Merge preflight: reject any branch that touches orchestrator/src/init/templates/**.
      // Template files are init-only archetypes edited by humans on main, never by an
      // orchestrator task. Any diff to those paths is leakage — most commonly caused by
      // composePrompt inlining the project-root CLAUDE.md into the coder brief and a
      // bypassPermissions coder "reconciling" the embedded text back to the template file.
      // (Systematic: two independent worktrees showed byte-identical leaked diffs.)
      // Strict default: ALL tasks are rejected. No current task legitimately edits the
      // bundled archetype via the orchestrator; humans edit it directly on main.
      const branchChangedFiles = await getChangedFiles(
        inputData.path,
        inputData.integrationBranch,
        inputData.branch,
      )
      const leakingTemplatePaths = detectTemplatePaths(branchChangedFiles)
      if (leakingTemplatePaths.length > 0) {
        const leakMsg =
          `merge:preflight/template-leakage: task branch touches ${leakingTemplatePaths.length} init template path(s) ` +
          `that must only be edited by humans on main:\n  ${leakingTemplatePaths.join('\n  ')}`
        await updateTask(inputData.taskId, {
          status: 'failed',
          error: leakMsg.slice(0, 1000),
          failedPhase: 'merge',
        })
        await handleTaskFailureWithFixTask({
          taskId: inputData.taskId,
          failingStep: 'merge:preflight/template-leakage',
          errorOutput: leakMsg,
          branch: inputData.branch,
          recipeContext: {
            targetPath: inputData.path,
            statusOutput: leakingTemplatePaths.join('\n'),
            targetBranch: inputData.integrationBranch,
            originalPrompt: '',
          },
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${inputData.taskId} template-leakage handling errored:`,
            err,
          )
        })
        return {
          taskId: inputData.taskId,
          success: false,
          message: `merge:preflight/template-leakage: branch touches ${leakingTemplatePaths.length} init template path(s); worktree retained`,
        }
      }

      const supervisorConversation: ClaudeEvent[] = []
      const m = await mergeBranch({
        branch: inputData.branch,
        worktreePath: inputData.path,
        integrationBranch: inputData.integrationBranch,
        lockTimeoutMs: 5 * 60 * 1000,
        onSupervisorEvent: async (event) => {
          supervisorConversation.push(event)
          await writer?.write({ type: 'vcs-supervisor-event', event })
        },
      })

      if (supervisorConversation.length > 0) {
        const supervisorUsage = summarizeUsage(supervisorConversation)
        tracingContext?.currentSpan?.update({
          metadata: {
            originId,
            taskId: inputData.taskId,
            supervisorConversation,
            supervisorConversationBytes: JSON.stringify(supervisorConversation).length,
            supervisorUsage,
          },
        })
        await recordSignals(inputData.taskId, 'vcs-supervisor', supervisorUsage).catch(() => {
          // signal capture must never fail the task
        })
      }

      if (m.aborted) {
        const errorMsg = `merge aborted by vcs-supervisor; worktree retained at ${inputData.path}\n${m.output.slice(0, 1000)}`
        await updateTask(inputData.taskId, {
          status: 'failed',
          error: errorMsg,
          failedPhase: 'merge',
        })
        await handleTaskFailureWithFixTask({
          taskId: inputData.taskId,
          failingStep: 'merge:vcs-supervisor-aborted',
          errorOutput: m.output,
          branch: inputData.branch,
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${inputData.taskId} merge abort handling errored:`,
            err,
          )
        })
        return {
          taskId: inputData.taskId,
          success: false,
          message: 'merge aborted; vcs-supervisor could not reconcile, worktree retained',
        }
      }

      await removeWorktree({ path: inputData.path, branch: inputData.branch }, true)
      await updateTask(inputData.taskId, { status: 'done', failedPhase: null })

      return {
        taskId: inputData.taskId,
        success: true,
        message: m.conflictResolved
          ? 'merged with vcs-supervisor conflict resolution'
          : 'merged cleanly',
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[merge] task ${inputData.taskId} crashed:`, error)
      await updateTask(inputData.taskId, {
        status: 'failed',
        error: `merge step crashed: ${message}`.slice(0, 1000),
        failedPhase: 'merge',
      })
      await handleTaskFailureWithFixTask({
        taskId: inputData.taskId,
        failingStep: 'merge:crashed',
        errorOutput: message,
        branch: inputData.branch,
      }).catch((err) => {
        console.error(
          `[failure-handler] task ${inputData.taskId} merge crash handling errored:`,
          err,
        )
      })
      return {
        taskId: inputData.taskId,
        success: false,
        message: 'merge step crashed; worktree retained',
      }
    }
  },
})

export const implementWorkflow = createWorkflow({
  id: 'implement',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema.default(null),
    tag: tagSchema,
    integrationBranch: z.string().default('main'),
    resumeFrom: resumeFromSchema,
    spec: specSchema,
  }),
  outputSchema: z.object({
    taskId: z.string(),
    success: z.boolean(),
    message: z.string(),
  }),
})
  .then(setupStep)
  .then(codeStep)
  .then(verifyStep)
  .then(mergeStep)
  .commit()
