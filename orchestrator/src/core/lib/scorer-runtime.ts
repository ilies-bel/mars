/**
 * Scorer runtime (PRD 6cf85bc9) — the record-only post-instance quality hook.
 *
 * When a Workflow instance reaches `done` via merge, the daemon's scoring
 * pool calls {@link runScorersForTask}. Every ACCEPTED Scorer whose target
 * workflow kind matches the instance grades the instance's PERSISTED
 * artifacts (composed dispatch prompt + merged diff + verify output) via the
 * pinned read-only Haiku-class Scorer Worker, and the normalized 0..1 score
 * plus one-line rationale lands in `scorer_results`.
 *
 * Non-negotiable contract (ADR "Scorers are record-only quality signal, not
 * a merge gate"):
 *   - runs strictly AFTER the merge landed — the instance is already done;
 *   - a low score never blocks a merge, never fails the task, never spawns
 *     recovery — verify remains the sole correctness gate;
 *   - a failed scoring run records an `error` row and stops (level-triggered,
 *     no retry, no fix-task);
 *   - a scoring run is NOT a Task: no queue row, no blocker edges, no KPI or
 *     action-queue distortion. Its trace events and judge usage attach to the
 *     ORIGIN instance's ids so the spend governor sees the overhead.
 *
 * Kill-switches: `mars operator set scoring off` (sets
 * MARS_SCORING_DISABLED=1 in the daemon process, persistently) and
 * MARS_REFLECT_DISABLED=1 (scoring is signal capture; that env var stays the
 * single comprehensive disable).
 */

import { z } from 'zod'
import { getTask, type Task } from '../queue'
import { listScorers, type Scorer } from '../scorers'
import {
  ScorerVerdictSchema,
  type ScorerVerdict,
  recordScorerResult,
  getScorerResult,
  initScorerResults,
  type ScorerResult,
} from '../scorer-results'
import {
  getTrialWorkflowConfig,
  getActiveWorkflowConfig,
  initWorkflowConfigs,
} from '../workflow-configs'
import { resolveStateClient } from '../store/state-client'
import { isReflectDisabled } from './reflect-signals'
import { getDefaultTaskStore } from '../store/task-store'
import type { TraceEventStore } from './trace-events-store'
import type { ClaudeEvent } from './claude-stream'

/**
 * True when scoring must not run: the operator flipped the in-memory
 * `scoring` daemon flag off, or reflection (signal capture as a whole) is
 * disabled via MARS_REFLECT_DISABLED=1.
 */
export const isScoringDisabled = (): boolean =>
  process.env.MARS_SCORING_DISABLED === '1' || isReflectDisabled()

/**
 * The effective workflow kind of an instance — the same resolution the
 * dispatcher applies: an explicit user-owned pipeline selection
 * (`task.workflow`) wins; `null` means default-by-kind. Scorers target this
 * value, so an approved self-authored workflow is scored exactly like a
 * bundled pipeline.
 */
export const effectiveWorkflowKind = (
  task: Pick<Task, 'workflow' | 'kind'>,
): string => task.workflow ?? task.kind ?? 'task'

/** Byte caps for the judge's assembled input — no repo exploration, ever. */
const PROMPT_CAP_BYTES = 24 * 1024
const DIFF_CAP_BYTES = 48 * 1024
const VERIFY_CAP_BYTES = 16 * 1024

const capText = (text: string, cap: number): string =>
  text.length <= cap
    ? text
    : `${text.slice(0, cap)}\n…[truncated at ${cap} bytes]`

/** The persisted artifacts one scoring run grades. */
export interface ScorerRunArtifacts {
  /** The composed dispatch prompt the Coder received (capped). */
  prompt: string
  /** `git diff <mergePreSha> <mergePostSha>` of the landed work; null when the SHAs were not persisted. */
  mergedDiff: string | null
  /** The verify step's recorded output; null when none was persisted. */
  verifyOutput: string | null
}

/** One judge invocation: grade `artifacts` against `scorer.rubric`. */
export type ScorerJudge = (args: {
  scorer: Scorer
  task: Task
  artifacts: ScorerRunArtifacts
}) => Promise<ScorerVerdict>

export interface RunScorersOptions {
  /** Injectable judge (tests). Defaults to the pinned Scorer Worker dispatch. */
  judge?: ScorerJudge
  /** Trace store for `scorer_result` events + judge Session spans. */
  traceStore?: TraceEventStore
}

export interface RunScorersOutcome {
  taskId: string
  outcome: 'disabled' | 'no-task' | 'not-done' | 'no-scorers' | 'ran'
  workflow: string | null
  /** Fresh `scored` rows recorded. */
  scored: number
  /** Fresh `error` rows recorded (judge failure / unparseable verdict). */
  errored: number
  /** Scorers skipped because a result for this instance already exists. */
  skipped: number
  results: ScorerResult[]
}

const stepEndedPayload = async (
  taskId: string,
  phase: 'verify' | 'merge',
): Promise<Record<string, unknown> | null> => {
  const store = await getDefaultTaskStore()
  const r = await store.query({
    sql: `SELECT payload FROM trace_events
           WHERE kind = 'step_ended' AND task_id = ? AND phase = ?
           ORDER BY timestamp DESC
           LIMIT 1`,
    args: [taskId, phase],
  })
  if (r.rows.length === 0) return null
  try {
    return JSON.parse(
      (r.rows[0] as unknown as { payload: string }).payload,
    ) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Reconstruct the merged diff from the SHAs the merge step persisted into its
 * step_ended payload (`mergePreSha` / `mergePostSha`). Both are permanent git
 * objects, so the diff is reproducible after the worktree is removed and
 * after the integration branch advances. Returns null when the SHAs are
 * missing (legacy instances) or git fails.
 */
const loadMergedDiff = async (taskId: string): Promise<string | null> => {
  const payload = await stepEndedPayload(taskId, 'merge')
  const pre = payload?.mergePreSha
  const post = payload?.mergePostSha
  if (typeof pre !== 'string' || typeof post !== 'string' || !pre || !post) {
    return null
  }
  try {
    const { resolveContext } = await import('../context')
    const { exec, resolveGitBin } = await import('./git/internal')
    const { stdout } = await exec(
      resolveGitBin(),
      ['diff', '--no-color', pre, post],
      { cwd: resolveContext().repoRoot, timeout: 30_000 },
    )
    return stdout.length > 0 ? stdout : null
  } catch {
    return null
  }
}

/**
 * The verify step's persisted output. Primary source: the verify-phase
 * step_ended payload's `commandOutput` (written by the verify primitive).
 * Fallback: any step_ended payload carrying `verifyOutput` (the
 * upsertTranscript path used by legacy rows).
 */
const loadVerifyOutput = async (taskId: string): Promise<string | null> => {
  const payload = await stepEndedPayload(taskId, 'verify')
  const fromVerify = payload?.commandOutput
  if (typeof fromVerify === 'string' && fromVerify.length > 0) return fromVerify
  const store = await getDefaultTaskStore()
  const r = await store.query({
    sql: `SELECT payload FROM trace_events
           WHERE kind = 'step_ended' AND task_id = ?
             AND payload::jsonb ->> 'verifyOutput' IS NOT NULL
           ORDER BY timestamp DESC
           LIMIT 1`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  try {
    const p = JSON.parse(
      (r.rows[0] as unknown as { payload: string }).payload,
    ) as Record<string, unknown>
    return typeof p.verifyOutput === 'string' ? p.verifyOutput : null
  } catch {
    return null
  }
}

/**
 * Assemble the judge's input from persisted artifacts only. The composed
 * dispatch prompt is re-rendered via the same `composePrompt` the dispatcher
 * used (dynamic import — core must not statically depend on workflows).
 */
export const assembleScorerArtifacts = async (
  task: Task,
): Promise<ScorerRunArtifacts> => {
  let prompt = task.prompt
  try {
    const { composePrompt } = await import('../../workflows/primitives/shared')
    prompt = composePrompt(
      task.prompt,
      task.plan,
      task.tags[0] ?? 'coder',
      task.spec,
      task.id,
    )
  } catch {
    // Fall back to the raw prompt — grading proceeds on what we have.
  }
  const [mergedDiff, verifyOutput] = await Promise.all([
    loadMergedDiff(task.id),
    loadVerifyOutput(task.id),
  ])
  return {
    prompt: capText(prompt, PROMPT_CAP_BYTES),
    mergedDiff: mergedDiff === null ? null : capText(mergedDiff, DIFF_CAP_BYTES),
    verifyOutput:
      verifyOutput === null ? null : capText(verifyOutput, VERIFY_CAP_BYTES),
  }
}

// ---------------------------------------------------------------------------
// Judge dispatch (default judge = pinned Scorer Worker)
// ---------------------------------------------------------------------------

export const SCORER_VERDICT_OPEN_TAG = '<scorer_verdict>'
export const SCORER_VERDICT_CLOSE_TAG = '</scorer_verdict>'

export const buildScorerPrompt = (
  scorer: Scorer,
  task: Task,
  artifacts: ScorerRunArtifacts,
): string =>
  [
    `You are the Scorer — a record-only quality judge for the Mars orchestrator.`,
    `Grade ONE completed workflow instance against the rubric below. The instance already merged; your score changes nothing about it. Be a calibrated measurement instrument, not a cheerleader: use the full 0..1 range.`,
    ``,
    `Do NOT explore the repository. Grade ONLY from the artifacts embedded in this prompt.`,
    ``,
    `## Rubric (quality dimension: ${scorer.title})`,
    scorer.rubric,
    ``,
    `## Instance`,
    `task id: ${task.id}`,
    `workflow kind: ${effectiveWorkflowKind(task)}`,
    ``,
    `## Artifact 1 — dispatch prompt the implementor received`,
    '```',
    artifacts.prompt,
    '```',
    ``,
    `## Artifact 2 — merged diff`,
    artifacts.mergedDiff !== null
      ? '```diff\n' + artifacts.mergedDiff + '\n```'
      : '(merged diff unavailable for this instance)',
    ``,
    `## Artifact 3 — verify output`,
    artifacts.verifyOutput !== null
      ? '```\n' + artifacts.verifyOutput + '\n```'
      : '(no verify output recorded)',
    ``,
    `## Output contract`,
    `Reply with EXACTLY one line containing the verdict wrapped in sentinel tags:`,
    `${SCORER_VERDICT_OPEN_TAG}{"score": <number in 0..1>, "rationale": "<one line>"}${SCORER_VERDICT_CLOSE_TAG}`,
    `The score is continuous (0.0–1.0). The rationale is a single sentence naming the decisive evidence.`,
  ].join('\n')

const collectCandidateTexts = (events: readonly ClaudeEvent[]): string[] => {
  const texts: string[] = []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i] as unknown as Record<string, unknown>
    if (ev.type === 'result' && typeof ev.result === 'string') {
      texts.push(ev.result)
    }
    if (ev.type === 'assistant' && ev.message !== null && typeof ev.message === 'object') {
      const content = (ev.message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block !== null &&
            typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'text' &&
            typeof (block as Record<string, unknown>).text === 'string'
          ) {
            texts.push((block as Record<string, unknown>).text as string)
          }
        }
      }
    }
  }
  return texts
}

const tryParseVerdict = (raw: string): ScorerVerdict | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const r = ScorerVerdictSchema.safeParse(parsed)
  return r.success ? r.data : null
}

/**
 * Extract the verdict from the judge's conversation: the sentinel-tagged
 * block first (the instructed contract), then any bare JSON object carrying a
 * numeric `score`. Returns null when nothing parses — the caller records an
 * `error` row, never an inferred score: the parser guards against optimism.
 */
export const extractScorerVerdict = (
  events: readonly ClaudeEvent[],
): ScorerVerdict | null => {
  for (const text of collectCandidateTexts(events)) {
    const openIdx = text.lastIndexOf(SCORER_VERDICT_OPEN_TAG)
    if (openIdx !== -1) {
      const closeIdx = text.indexOf(SCORER_VERDICT_CLOSE_TAG, openIdx)
      const raw =
        closeIdx !== -1
          ? text.slice(openIdx + SCORER_VERDICT_OPEN_TAG.length, closeIdx)
          : text.slice(openIdx + SCORER_VERDICT_OPEN_TAG.length)
      const verdict = tryParseVerdict(raw.trim())
      if (verdict !== null) return verdict
    }
    // Fallback: a bare JSON object on its own line.
    const match = text.match(/\{[^{}]*"score"[^{}]*\}/)
    if (match) {
      const verdict = tryParseVerdict(match[0])
      if (verdict !== null) return verdict
    }
  }
  return null
}

/**
 * Default judge: one `claude -p` run on the pinned read-only Haiku-class
 * Scorer Worker, bracketed with step spans (stepName 'scorer') attributed to
 * the SCORED instance's task/origin ids — the judge's token usage lands in
 * the origin Arc's step_ended usage signals, so the spend governor sees the
 * scoring overhead exactly where it belongs.
 */
const defaultJudge =
  (traceStore: TraceEventStore | undefined): ScorerJudge =>
  async ({ scorer, task, artifacts }) => {
    const { Workers } = await import('../workers')
    const { runWorkerWithSpan } = await import('./run-worker-with-span')
    const { resolveContext } = await import('../context')
    const prompt = buildScorerPrompt(scorer, task, artifacts)
    const result = await runWorkerWithSpan({
      worker: Workers.Scorer,
      prompt,
      runOptions: { cwd: resolveContext().repoRoot },
      traceStore,
      stepName: 'scorer',
      workflowInstanceId: `scorer-${scorer.id}-${task.id}`,
      originId: task.originId,
      taskId: task.id,
    })
    if (result.exitCode !== 0) {
      throw new Error(`scorer worker exited ${result.exitCode}`)
    }
    const verdict = extractScorerVerdict(result.conversation)
    if (verdict === null) {
      throw new Error('scorer verdict unparseable (no valid sentinel JSON)')
    }
    return verdict
  }

const safeTrace = async (
  traceStore: TraceEventStore | undefined,
  payload: Record<string, unknown>,
  taskId: string,
  originId: string | null,
): Promise<void> => {
  if (!traceStore) return
  try {
    await traceStore.record({
      kind: 'scorer_result',
      taskId,
      originId,
      payload,
    })
  } catch {
    // trace capture is best-effort — a DB hiccup must never surface here
  }
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/**
 * Grade one completed instance with every accepted Scorer targeting its
 * workflow kind. Record-only: this function never mutates the tasks table and
 * never enqueues anything. Idempotent per (Scorer, instance) via the
 * scorer_results unique index.
 */
export const runScorersForTask = async (
  taskId: string,
  opts: RunScorersOptions = {},
): Promise<RunScorersOutcome> => {
  const base: RunScorersOutcome = {
    taskId,
    outcome: 'ran',
    workflow: null,
    scored: 0,
    errored: 0,
    skipped: 0,
    results: [],
  }
  if (isScoringDisabled()) return { ...base, outcome: 'disabled' }
  const task = await getTask(taskId)
  if (!task) return { ...base, outcome: 'no-task' }
  if (task.status !== 'done') return { ...base, outcome: 'not-done' }
  const workflow = effectiveWorkflowKind(task)
  const scorers = await listScorers({ status: 'accepted', workflow })
  if (scorers.length === 0) return { ...base, outcome: 'no-scorers', workflow }

  await initScorerResults()
  const judge = opts.judge ?? defaultJudge(opts.traceStore)
  // Assembled once per instance — shared across all scorers for this kind.
  const artifacts = await assembleScorerArtifacts(task)

  // Resolve the active workflow-config version for this workflow kind.
  // Trial takes precedence over promoted/baseline (ADR-0034 scoring seam).
  // Null when no config rows exist yet (legacy calls remain compatible).
  const stateC = resolveStateClient()
  await initWorkflowConfigs()
  const trialConfig = await getTrialWorkflowConfig(stateC, workflow)
  const activeConfig = trialConfig ?? (await getActiveWorkflowConfig(stateC, workflow))
  const workflowConfigVersionId = activeConfig?.id ?? null

  const outcome: RunScorersOutcome = { ...base, workflow }

  for (const scorer of scorers) {
    // Historical-backfill guard + duplicate-delivery guard: one run per
    // (Scorer, instance).
    if ((await getScorerResult(scorer.id, taskId)) !== null) {
      outcome.skipped += 1
      continue
    }
    try {
      const verdict = ScorerVerdictSchema.parse(
        await judge({ scorer, task, artifacts }),
      )
      const { result } = await recordScorerResult({
        scorerId: scorer.id,
        taskId,
        workflow,
        score: verdict.score,
        rationale: verdict.rationale,
        status: 'scored',
        workflowConfigVersionId,
      })
      outcome.scored += 1
      outcome.results.push(result)
      await safeTrace(
        opts.traceStore,
        {
          scorerId: scorer.id,
          resultId: result.id,
          workflow,
          score: verdict.score,
          status: 'scored',
        },
        taskId,
        task.originId ?? null,
      )
    } catch (err) {
      // Level-triggered failure handling: one error row, no retry, no
      // fix-task, and the instance's own status is untouched.
      const message = errorMessage(err).slice(0, 500)
      const { result } = await recordScorerResult({
        scorerId: scorer.id,
        taskId,
        workflow,
        score: null,
        rationale: message,
        status: 'error',
        workflowConfigVersionId,
      })
      outcome.errored += 1
      outcome.results.push(result)
      await safeTrace(
        opts.traceStore,
        {
          scorerId: scorer.id,
          resultId: result.id,
          workflow,
          status: 'error',
          error: message,
        },
        taskId,
        task.originId ?? null,
      )
    }
  }
  return outcome
}

/** Zod schema export for callers that validate external verdict input. */
export const ScorerRunOutcomeSchema = z.object({
  taskId: z.string(),
  outcome: z.enum(['disabled', 'no-task', 'not-done', 'no-scorers', 'ran']),
  workflow: z.string().nullable(),
  scored: z.number().int().min(0),
  errored: z.number().int().min(0),
  skipped: z.number().int().min(0),
})
