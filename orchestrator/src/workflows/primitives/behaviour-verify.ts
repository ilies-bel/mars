/**
 * `behaviourVerify` — the fifth domain primitive (Behaviour verification).
 *
 * Sits between `verify` (static: typecheck/tests/lint) and `merge` in the
 * bundled implement pipeline. Static verify proves the code compiles and its
 * tests pass; this step proves the task's **Definition of Done** (the
 * `task_done_criteria` the operator authored with `mars task add --done`) is
 * observable on a *running* surface.
 *
 * This step dispatches the role-pinned BehaviourVerifier Worker (read-only
 * tool surface, using whatever browser/UI-driving MCP tools are wired into
 * the operator's environment), and folds the Worker's per-criterion verdict
 * JSON into exactly one of THREE outcomes:
 *
 *  - **PASS** — every exercised criterion positively verified (≥1 verified,
 *    0 contradicted). The step returns; merge runs.
 *  - **behavioural FAIL** — at least one criterion where the Worker REACHED
 *    the relevant surface state and observed behaviour CONTRADICTING the
 *    criterion, backed by screenshot evidence. Mirrors static verify's
 *    failure shape: stamp the task failed, spawn exactly ONE recovery Chore
 *    on the origin worktree under the registered signature
 *    `behaviour-verify:dod-unmet` (ADR-0002 recipe registered in
 *    fix-recipes.ts), then THROW — merge never runs on behaviourally-broken
 *    work.
 *  - **CAN'T-VERIFY** — everything else (no runnable surface, empty DoD,
 *    dev server won't boot or health-check, no UI-driving tool available in
 *    the environment, verdict JSON missing/unparseable, no criterion
 *    exercisable). Files a fingerprint-deduped draft proposal
 *    (`behaviour-verify:<originId>`) and raises a level-triggered
 *    `behaviour-unverified` action-queue row, then RETURNS — the merge
 *    proceeds. Never silent, never a hard fail.
 *
 * THE BOUNDARY IN ONE LINE: FAIL requires positive evidence of contradiction
 * on a reached live surface; absence, ambiguity, or infrastructure error is
 * always CAN'T-VERIFY.
 *
 * Artifacts (per-criterion screenshots under
 * `.mars/behaviour-verify/<taskId>/`, the verdicts array, the dev-server log
 * path) attach to the `step_ended` trace payload via the existing
 * `getExtraPayload` seam so Studio renders the visual evidence off the span
 * with zero schema migration.
 */
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { extname, isAbsolute, join, resolve } from 'node:path'

import { discoverAppBoot, type BootPlan } from './app-boot-discovery'

const execFileAsync = promisify(execFile)

import type { WorktreeRef } from '../../core/lib/git/worktree'
import { getTask, type Task } from '../../core/queue'
import { createProposal, findOpenDraftByKpiTag } from '../../core/proposals'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import type { ClaudeEvent } from '../../core/lib/claude-stream'
import {
  runNonLlmStepWithSpan,
} from '../../core/lib/run-worker-with-span'
import { resolveContext } from '../../core/context'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import {
  resolveTaskId,
  resolveTrace,
  resolveWorktree,
  readWorkflowInput,
  spanStore,
  type MarsCtx,
} from './index'

// ---------------------------------------------------------------------------
// Stable, load-bearing names
// ---------------------------------------------------------------------------

/** The durable step name — keys checkpoint-resume and the trace node label. */
export const BEHAVIOUR_VERIFY_STEP_NAME = 'behaviour-verify'

/**
 * The failing-step key handed to `handleTaskFailureWithFixTask` on a
 * behavioural FAIL. `computeFailureSignature` appends the `dod-unmet` error
 * class (registered in failure-signature.ts) yielding the full signature
 * {@link BEHAVIOUR_DOD_UNMET_SIGNATURE}, whose ADR-0002 recovery recipe is
 * registered in fix-recipes.ts in the same change (ship-blocker).
 */
export const BEHAVIOUR_VERIFY_FAILING_STEP = 'behaviour-verify:dod-unmet'

/** The full `<failingStep>/<error-class>` signature a behavioural FAIL produces. */
export const BEHAVIOUR_DOD_UNMET_SIGNATURE = 'behaviour-verify:dod-unmet/dod-unmet'

/** Fingerprint carrier for the CAN'T-VERIFY draft proposal (kpi_tag column). */
export const behaviourUnverifiedFingerprint = (originId: string): string =>
  `behaviour-verify:${originId}`

// ---------------------------------------------------------------------------
// Verdict contract (Zod)
// ---------------------------------------------------------------------------

export const criterionVerdictSchema = z.object({
  /** Zero-based index into the task's doneCriteria list. */
  criterionIndex: z.number().int().nonnegative(),
  /**
   * 'fail' is reserved for a REACHED surface state whose observed behaviour
   * CONTRADICTS the criterion, with screenshot evidence. Anything the Worker
   * could not reach or exercise is 'unverifiable', never an inferred pass.
   */
  verdict: z.enum(['pass', 'fail', 'unverifiable']),
  /** Screenshot path (or filename inside the artifact dir); null when none. */
  evidence: z.string().nullable().default(null),
  /** Free-text observation backing the verdict. */
  note: z.string().default(''),
})

export type CriterionVerdict = z.infer<typeof criterionVerdictSchema>

export const behaviourVerdictReportSchema = z.object({
  verdicts: z.array(criterionVerdictSchema),
})

export type BehaviourVerdictReport = z.infer<typeof behaviourVerdictReportSchema>

/** Sentinel tags the Worker MUST wrap its verdict JSON in. */
export const VERDICT_OPEN_TAG = '<behaviour_verdicts>'
export const VERDICT_CLOSE_TAG = '</behaviour_verdicts>'

// ---------------------------------------------------------------------------
// Pure helpers: verdict extraction + the three-outcome fold
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Pull every candidate text that might carry the verdict block, newest first. */
const collectCandidateTexts = (events: readonly ClaudeEvent[]): string[] => {
  const texts: string[] = []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev.type === 'result' && typeof ev.result === 'string') {
      texts.push(ev.result)
    }
    if (ev.type === 'assistant' && isRecord(ev.message)) {
      const content = ev.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text)
          }
        }
      }
    }
  }
  return texts
}

const tryParseReport = (raw: string): BehaviourVerdictReport | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const r = behaviourVerdictReportSchema.safeParse(parsed)
  return r.success ? r.data : null
}

/**
 * Extract the Worker's verdict report from its conversation. Tries, in order:
 * the sentinel-tagged block (the instructed contract), then the last fenced
 * ```json block mentioning "verdicts". Returns null when nothing parses —
 * the caller resolves that to CAN'T-VERIFY (`verdict-unparseable`), never an
 * inferred pass: the parser is the guard against LLM optimism.
 */
export const extractVerdictReport = (
  events: readonly ClaudeEvent[],
): BehaviourVerdictReport | null => {
  for (const text of collectCandidateTexts(events)) {
    const openIdx = text.lastIndexOf(VERDICT_OPEN_TAG)
    if (openIdx !== -1) {
      const closeIdx = text.indexOf(VERDICT_CLOSE_TAG, openIdx)
      if (closeIdx !== -1) {
        const inner = text.slice(openIdx + VERDICT_OPEN_TAG.length, closeIdx).trim()
        const report = tryParseReport(inner)
        if (report) return report
      }
    }
    // Fallback: last fenced code block that carries a "verdicts" key.
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g
    let match: RegExpExecArray | null
    let lastFenced: string | null = null
    while ((match = fenceRe.exec(text)) !== null) {
      if (match[1].includes('"verdicts"')) lastFenced = match[1].trim()
    }
    if (lastFenced !== null) {
      const report = tryParseReport(lastFenced)
      if (report) return report
    }
  }
  return null
}

/** Reason classes for the CAN'T-VERIFY outcome. */
export type UnverifiableReason =
  | 'no-preview-command'
  | 'no-done-criteria'
  | 'dev-server-unhealthy'
  | 'worker-error'
  | 'verdict-unparseable'
  | 'no-exercisable-criteria'

export type VerdictFold =
  | { decision: 'pass'; passed: CriterionVerdict[] }
  | { decision: 'fail'; failed: CriterionVerdict[] }
  | { decision: 'unverifiable'; reason: UnverifiableReason }

/**
 * Fold per-criterion verdicts into the tri-state outcome. FAIL dominates:
 * a single evidenced contradiction blocks the merge regardless of how many
 * siblings passed. With zero fails, PASS requires at least one positive
 * verification; a report of only 'unverifiable' rows degrades to
 * CAN'T-VERIFY (`no-exercisable-criteria`).
 */
export const foldVerdicts = (
  verdicts: readonly CriterionVerdict[],
): VerdictFold => {
  const failed = verdicts.filter((v) => v.verdict === 'fail')
  if (failed.length > 0) return { decision: 'fail', failed }
  const passed = verdicts.filter((v) => v.verdict === 'pass')
  if (passed.length > 0) return { decision: 'pass', passed }
  return { decision: 'unverifiable', reason: 'no-exercisable-criteria' }
}

// ---------------------------------------------------------------------------
// Worker construction + prompt
// ---------------------------------------------------------------------------

export interface BehaviourVerifyPromptArgs {
  url: string
  criteria: readonly string[]
  artifactsDir: string
}

/** Build the BehaviourVerifier Worker prompt (exported for tests). */
export const buildBehaviourVerifyPrompt = (
  args: BehaviourVerifyPromptArgs,
): string => {
  const criteriaLines = args.criteria
    .map((c, i) => `  [${i}] ${c}`)
    .join('\n')
  return [
    '# Behaviour verification',
    '',
    `A live dev server for this task is running at: ${args.url}`,
    '',
    "Your job: verify each Definition-of-Done criterion below against that RUNNING surface using whatever browser/UI-driving MCP tools are available in your environment (common examples: browser_navigate, browser_snapshot, browser_click, browser_type, browser_take_screenshot). You are an observer with a read-only file surface — you cannot and must not change any code; you only exercise the surface and report what you saw. If no browser or UI-driving tool is available, mark each criterion 'unverifiable' with a note explaining you lacked the tool.",
    '',
    '## Definition-of-Done criteria',
    '',
    criteriaLines,
    '',
    '## Rules',
    '',
    "- Navigate to the URL first and take an accessibility snapshot to orient yourself.",
    `- For every criterion you exercise, capture a screenshot as evidence (e.g. using browser_take_screenshot if available) using filename \`criterion-<index>.png\` (screenshots are saved under ${args.artifactsDir}).`,
    "- Verdict per criterion, exactly one of:",
    "  - 'pass'         — you REACHED the relevant surface state and positively OBSERVED the criterion satisfied.",
    "  - 'fail'         — you REACHED the relevant surface state and the observed behaviour CONTRADICTS the criterion. A 'fail' MUST carry a screenshot in `evidence`.",
    "  - 'unverifiable' — everything else: the criterion is not exercisable through this web surface (backend-only work), you could not reach the relevant state, or tooling failed. When in doubt, 'unverifiable' — NEVER guess a pass and NEVER stretch a hunch into a fail.",
    '',
    '## Output contract (mandatory)',
    '',
    `Your FINAL message must contain exactly one block of the following form (raw JSON between the tags, one verdict object per criterion, criterionIndex matching the [index] above):`,
    '',
    VERDICT_OPEN_TAG,
    '{"verdicts": [{"criterionIndex": 0, "verdict": "pass", "evidence": "criterion-0.png", "note": "what you observed"}]}',
    VERDICT_CLOSE_TAG,
    '',
    'A missing or malformed block is treated as CAN\'T-VERIFY for the whole run — your observations are lost unless they are in that block.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Options / result / deps
// ---------------------------------------------------------------------------

/** Artifact reference attached to the step_ended payload (Studio renders these). */
export interface BehaviourVerifyArtifact {
  type: 'screenshot'
  path: string
  criterionIndex: number
  verdict: CriterionVerdict['verdict']
}

export type BehaviourVerifyOutcome = 'pass' | 'unverifiable' | 'skipped'

export interface BehaviourVerifyResult {
  outcome: BehaviourVerifyOutcome
  /** Skip cause or {@link UnverifiableReason}; null on 'pass'. */
  reason: string | null
  /** Per-criterion verdicts when the Worker produced a parseable report. */
  verdicts: CriterionVerdict[] | null
  /** Screenshot references (absolute paths). */
  artifacts: BehaviourVerifyArtifact[]
  /** Dev-server log path when a server was booted. */
  devServerLogPath: string | null
  /**
   * Boot plan discovered by {@link discoverAppBoot} when the task's diff
   * touched UI files. Null when the diff carries no UI changes, no boot
   * command was discoverable, or the step was skipped.
   */
  bootPlan: BootPlan | null
}

/**
 * Side-effect seams, injectable for tests. Every field defaults to the real
 * implementation.
 */
export interface BehaviourVerifyDeps {
  getTask: typeof getTask
  createProposal: typeof createProposal
  findOpenDraftByKpiTag: typeof findOpenDraftByKpiTag
  raiseActionQueueItem: typeof raiseActionQueueItem
  /**
   * Return the `git diff --name-only` output for the worktree branch vs the
   * integration branch. Defaults to the real `git` invocation; injectable for
   * tests so no subprocess is spawned during unit tests.
   */
  getDiff: (worktreePath: string, integrationBranch: string) => Promise<string>
}

const defaultGetDiff = async (worktreePath: string, integrationBranch: string): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'diff', `${integrationBranch}...HEAD`, '--name-only'],
      { maxBuffer: 1_048_576 },
    )
    return stdout
  } catch {
    // Not a git repo, or git not available — treat as no UI files touched.
    return ''
  }
}

const defaultDeps: BehaviourVerifyDeps = {
  getTask,
  createProposal,
  findOpenDraftByKpiTag,
  raiseActionQueueItem,
  getDiff: defaultGetDiff,
}

/** Per-call domain options for {@link behaviourVerify}. All fields default. */
export interface BehaviourVerifyOpts {
  /** Pipeline kind. Default `'task'`. `'diagnose'` short-circuits as skipped. */
  kind?: 'task' | 'fix' | 'diagnose'
  /** Merge target. Default `'main'`. */
  integrationBranch?: string
  /** Serialised recovery payload; only on `kind:'fix'`. Default null. */
  recoveryPayload?: string | null
  /** Override the task id (defaults to `ctx.runId`). */
  taskId?: string
  /** Override the worktree (defaults to the one stashed by setupWorktree). */
  worktree?: WorktreeRef
  /** Test seams — every side effect is overridable. */
  deps?: Partial<BehaviourVerifyDeps>
}

// ---------------------------------------------------------------------------
// Internal composition helpers
// ---------------------------------------------------------------------------

const resolveEvidencePath = (
  evidence: string | null,
  artifactsDir: string,
): string | null => {
  if (evidence === null || evidence.trim().length === 0) return null
  const trimmed = evidence.trim()
  return isAbsolute(trimmed) ? trimmed : resolve(artifactsDir, trimmed)
}

export const buildArtifacts = (
  verdicts: readonly CriterionVerdict[],
  artifactsDir: string,
): BehaviourVerifyArtifact[] => {
  const out: BehaviourVerifyArtifact[] = []
  for (const v of verdicts) {
    const path = resolveEvidencePath(v.evidence, artifactsDir)
    if (path === null) continue
    out.push({ type: 'screenshot', path, criterionIndex: v.criterionIndex, verdict: v.verdict })
  }
  return out
}

/**
 * The FAIL evidence block. Its FIRST LINE is load-bearing: the `dod-unmet`
 * error-class rule in failure-signature.ts matches it, binding the failure to
 * the registered `behaviour-verify:dod-unmet/dod-unmet` recipe.
 */
export const buildFailEvidenceBlock = (args: {
  failed: readonly CriterionVerdict[]
  criteria: readonly string[]
  url: string
  artifactsDir: string
  devServerLogPath: string
  logTail: string
}): string => {
  const n = args.failed.length
  const lines: string[] = [
    `behaviour verification: ${n} Definition-of-Done ${n === 1 ? 'criterion' : 'criteria'} unmet on live surface`,
    '',
    `Surface: ${args.url}`,
    '',
    'Failed criteria:',
  ]
  for (const v of args.failed) {
    const text = args.criteria[v.criterionIndex] ?? '(criterion text unavailable)'
    lines.push(`  [${v.criterionIndex}] ${text}`)
    lines.push(`      verdict: fail`)
    lines.push(
      `      evidence: ${resolveEvidencePath(v.evidence, args.artifactsDir) ?? '(none captured)'}`,
    )
    if (v.note.trim().length > 0) lines.push(`      note: ${v.note.trim()}`)
  }
  lines.push('')
  lines.push(`Dev-server log tail (${args.devServerLogPath}):`)
  lines.push(args.logTail)
  return lines.join('\n')
}

const unblockHint = (reason: UnverifiableReason): string => {
  switch (reason) {
    case 'no-preview-command':
      return 'No runnable preview surface is configured for this task — wire a dev server through the workflow or the task\'s environment so the step has a live URL to exercise.'
    case 'no-done-criteria':
      return 'Author Definition-of-Done criteria (`mars task add ... --done "<observable>"`) phrased as user-observable behaviours.'
    case 'dev-server-unhealthy':
      return 'The dev server spawned but never answered its health check — fix the command or its boot (it must serve HTTP on the injected $PORT).'
    case 'worker-error':
      return 'The behaviour-verify Worker run failed before producing verdicts — check the step transcript and ensure any browser/UI-driving MCP tools required by the operator environment are configured.'
    case 'verdict-unparseable':
      return 'The Worker produced no parseable verdict JSON — check the step transcript; the worker may lack browser/UI-driving tools needed to exercise the surface.'
    case 'no-exercisable-criteria':
      return 'No Definition-of-Done criterion maps to an exercisable web interaction — reshape the criteria into surface-observable statements, or accept that this task class is not behaviour-verifiable.'
  }
}

// ---------------------------------------------------------------------------
// UI-file detection
// ---------------------------------------------------------------------------

/**
 * File extensions that indicate UI/frontend work. Used to decide whether to
 * attempt dev-server discovery for a given task diff.
 */
const UI_EXTENSIONS = new Set([
  '.tsx', '.jsx', '.css', '.scss', '.sass', '.less',
  '.html', '.svg', '.vue', '.svelte',
])

/**
 * Path segments that indicate UI/frontend work regardless of extension. A file
 * is considered a UI file when any of these segments appear in its path.
 */
const UI_PATH_SEGMENTS = ['ui/', '/ui/', 'components/', 'pages/', 'app/', 'frontend/', 'views/']

/**
 * Return true when the `--name-only` git diff output contains at least one
 * file that looks like a UI/frontend file (by extension or path convention).
 * A false negative is safe — the caller degrades to CAN'T-VERIFY, which is
 * always a soft outcome.
 */
const touchesUi = (nameOnlyDiff: string): boolean => {
  const lines = nameOnlyDiff.split('\n').filter((l) => l.trim().length > 0)
  return lines.some((file) => {
    const lower = file.toLowerCase()
    if (UI_EXTENSIONS.has(extname(lower))) return true
    return UI_PATH_SEGMENTS.some((seg) => lower.startsWith(seg) || lower.includes(seg))
  })
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * Behaviour verification of the worktree's committed changes against the
 * task's Definition of Done, on a live surface. See the module doc for the
 * tri-state contract. Returns on PASS / CAN'T-VERIFY / skip; THROWS on
 * behavioural FAIL (so reaching the caller's merge step always means the
 * behaviour gate did not observe a contradiction).
 *
 * Usage from a scaffolded workflow:
 * ```js
 * await ctx.step('behaviour-verify', () => behaviourVerify(ctx))
 * ```
 */
export const behaviourVerify = async (
  ctx: MarsCtx,
  opts: BehaviourVerifyOpts = {},
): Promise<BehaviourVerifyResult> => {
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const kind = opts.kind ?? readWorkflowInput(ctx).kind ?? 'task'
  const integrationBranch =
    opts.integrationBranch ?? readWorkflowInput(ctx).integrationBranch ?? 'main'
  const recoveryPayload =
    opts.recoveryPayload ?? readWorkflowInput(ctx).recoveryPayload ?? null
  const fixForTaskId = readWorkflowInput(ctx).fixForTaskId ?? null
  const store: TaskStore = ctx.services.store
  const deps: BehaviourVerifyDeps = { ...defaultDeps, ...opts.deps }

  const skipped = (reason: string): BehaviourVerifyResult => ({
    outcome: 'skipped',
    reason,
    verdicts: null,
    artifacts: [],
    devServerLogPath: null,
    bootPlan: null,
  })

  // Skips mirror static verify's scope logic: a diagnose Chore has no
  // runnable artefact, and a main-commiter recovery works on the integration
  // branch itself (no task surface of its own). No span for a skip.
  if (kind === 'diagnose') return skipped('diagnose')
  if (kind === 'fix' && recoveryPayload != null) {
    const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
      '../../core/lib/main-dirty'
    )
    if (parseMainCommiterPayload(recoveryPayload)?.recipe === MAIN_COMMITER_RECIPE) {
      return skipped('main-commiter')
    }
  }

  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)

  const task = await deps.getTask(taskId, store)
  // A recovery Chore carries no spec of its own — the Definition of Done
  // lives on the ORIGIN task it is recovering.
  const specTask: Task | null =
    kind === 'fix' && fixForTaskId !== null
      ? await deps.getTask(fixForTaskId, store)
      : task
  const criteria: readonly string[] = specTask?.spec?.doneCriteria ?? []

  const ctxResolved = resolveContext()
  const artifactsDir = join(ctxResolved.stateDir, 'behaviour-verify', taskId)

  /**
   * The CAN'T-VERIFY exit: exactly one visible pair — a fingerprint-deduped
   * draft proposal plus a level-triggered `behaviour-unverified` action-queue
   * row — then the step RETURNS so the merge proceeds. Never silent, never a
   * hard fail; a raise/create hiccup is logged, not thrown.
   */
  const cantVerify = async (
    reason: UnverifiableReason,
    detail: {
      devServerLogPath?: string | null
      verdicts?: CriterionVerdict[] | null
      artifacts?: BehaviourVerifyArtifact[]
      bootPlan?: BootPlan | null
    } = {},
  ): Promise<BehaviourVerifyResult> => {
    const fingerprint = behaviourUnverifiedFingerprint(trace.originId)
    let proposalId: string | null = null
    try {
      const existing = await deps.findOpenDraftByKpiTag(fingerprint)
      if (existing !== null) {
        proposalId = existing.id
      } else {
        const created = await deps.createProposal(
          `Make task ${taskId} behaviourally verifiable`,
          {
            author: { kind: 'agent', name: 'behaviour-verifier' },
            source: 'planner',
            problem: [
              `Task ${taskId} merged without behaviour verification: the behaviour-verify step classified it CAN'T-VERIFY (reason: ${reason}).`,
              '',
              criteria.length > 0
                ? `Definition-of-Done criteria that went unexercised:\n${criteria.map((c, i) => `  [${i}] ${c}`).join('\n')}`
                : 'The task carries no Definition-of-Done criteria.',
            ].join('\n'),
            solution: unblockHint(reason),
            notes: [
              `Reason class: ${reason}`,
              detail.devServerLogPath ? `Dev-server log: ${detail.devServerLogPath}` : null,
              `Origin: ${trace.originId}`,
            ]
              .filter((l): l is string => l !== null)
              .join('\n'),
            kpiTag: fingerprint,
          },
        )
        proposalId = created.id
      }
    } catch (err) {
      console.error(
        `[behaviour-verify] task ${taskId} fallback-draft creation errored:`,
        err,
      )
    }

    await deps
      .raiseActionQueueItem({
        kind: 'behaviour-unverified',
        category: 'orchestrator',
        priority: 'normal',
        title: `Task ${taskId} merged unverified: behaviour could not be checked (${reason})`,
        body: [
          `Task \`${taskId}\` passed static verify and merged, but the behaviour-verify step could not exercise its Definition of Done against a live surface.`,
          '',
          `Reason: **${reason}**`,
          '',
          unblockHint(reason),
          '',
          proposalId !== null
            ? `Draft proposal \`${proposalId}\` carries the concrete unblock — promote it to make this task class verifiable.`
            : 'The fallback draft proposal could not be created; see the daemon log.',
        ].join('\n'),
        payload: {
          taskId,
          originTaskId: trace.originId,
          proposalId,
          reason,
          criteria: [...criteria],
          devServerLogPath: detail.devServerLogPath ?? null,
          artifactsDir,
        },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'agent:behaviour-verifier',
        signature: `${taskId}:behaviour-unverified`,
        originTaskId: taskId,
        occurrence: { at: new Date().toISOString(), reason },
      })
      .catch((err) => {
        console.error(
          `[behaviour-verify] task ${taskId} behaviour-unverified raise errored:`,
          err,
        )
      })

    return {
      outcome: 'unverifiable',
      reason,
      verdicts: detail.verdicts ?? null,
      artifacts: detail.artifacts ?? [],
      devServerLogPath: detail.devServerLogPath ?? null,
      bootPlan: detail.bootPlan ?? null,
    }
  }

  // ── CAN'T-VERIFY: no runnable surface wired to this task ─────────────────
  // Without a live surface the step cannot exercise the Definition of Done.
  // Attempt to discover a boot command from repo signals when the diff touches
  // UI files; record the result on the run regardless of whether a plan was
  // found. The merge proceeds in all cases (CAN'T-VERIFY is always soft).

  if (criteria.length === 0) {
    return await runNonLlmStepWithSpan({
      stepName: BEHAVIOUR_VERIFY_STEP_NAME,
      workflowInstanceId: trace.workflowInstanceId,
      originId: trace.originId,
      taskId,
      phase: 'verify',
      traceStore: spanStore(trace),
      getExtraPayload: () => ({
        behaviourVerifyOutcome: 'unverifiable:no-done-criteria',
        bootPlan: null,
        verdicts: null,
        artifacts: [],
        devServerLogPath: null,
      }),
      fn: async (): Promise<BehaviourVerifyResult> => cantVerify('no-done-criteria'),
    })
  }

  // Has criteria — inspect the diff to decide whether to attempt boot discovery.
  const diff = await deps.getDiff(worktree.path, integrationBranch)
  const boot = touchesUi(diff) ? discoverAppBoot(worktree.path) : null

  return await runNonLlmStepWithSpan({
    stepName: BEHAVIOUR_VERIFY_STEP_NAME,
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    taskId,
    phase: 'verify',
    traceStore: spanStore(trace),
    getExtraPayload: () => ({
      behaviourVerifyOutcome: boot !== null
        ? `boot-discovered:no-preview-command`
        : 'unverifiable:no-preview-command',
      bootPlan: boot,
      verdicts: null,
      artifacts: [],
      devServerLogPath: null,
    }),
    fn: async (): Promise<BehaviourVerifyResult> =>
      cantVerify('no-preview-command', { bootPlan: boot }),
  })

}
