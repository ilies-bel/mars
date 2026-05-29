// Thin wrappers that bracket step execution with step_started / step_ended
// trace events.
//
// `runWorkerWithSpan` covers LLM-backed Workers (Coder, Fixer, Planner,
// Slicer, Triager). It records the worker name and Claude session id so every
// claude -p execution shows up as a Session in the unified trace surface.
//
// `runNonLlmStepWithSpan` covers non-LLM workflow steps (setup, verify,
// fast-forward merge). It records start time, end time, and outcome but carries
// no worker name and no session id — the invariant "a Step span is a Session iff
// worker IS NOT NULL" means these are Step spans, not Sessions.
//
// Only the transcript in `runWorkerWithSpan` is gated behind isReflectDisabled()
// (it can be large). Session id and usage signals are always recorded so
// lightweight queries remain accurate even when reflection is globally disabled.

import { summarizeUsage } from './claude-usage'
import { isReflectDisabled } from './reflect-signals'
import type { TraceEventStore, TraceEventPhase } from './trace-events-store'
import type { Worker, RunOptions } from '../workers'
import type { RunClaudeResult } from './git'

export interface RunWorkerWithSpanOptions {
  worker: Worker
  prompt: string
  runOptions: RunOptions
  /**
   * Optional — when absent (or when `record` fails) no trace events are
   * written and the worker still runs normally. Callers pass `undefined`
   * when the store could not be opened so they do not need a separate code
   * path for the "store unavailable" case.
   */
  traceStore?: TraceEventStore
  stepName: string
  workflowInstanceId: string
  originId: string
  /** Optional phase tag (`code`, `verify`, …) attached to both events. */
  phase?: TraceEventPhase
}

const safeRecord = async (
  store: TraceEventStore | undefined,
  event: Parameters<TraceEventStore['record']>[0],
): Promise<void> => {
  if (!store) return
  try {
    await store.record(event)
  } catch {
    // trace capture is best-effort — a DB hiccup must never fail the task
  }
}

/**
 * Run a Worker and bracket its execution with `step_started` / `step_ended`
 * trace events.
 *
 * The step_ended payload records the worker name, Claude session id, the
 * outcome (`success` | `failure`), the run duration, token usage signals,
 * and — when reflection is enabled — the full conversation transcript.
 * The span is always closed, even when the worker throws.
 *
 * Trace capture is best-effort: errors from `record` are swallowed so a
 * DB hiccup can never fail the task.
 *
 * Returns the raw {@link RunClaudeResult} unchanged so callers can use
 * `r.exitCode`, `r.stdout`, `r.sessionId`, and `r.conversation` exactly as
 * they would after a direct {@link Worker.run} call.
 */
export const runWorkerWithSpan = async (
  options: RunWorkerWithSpanOptions,
): Promise<RunClaudeResult> => {
  const {
    worker,
    prompt,
    runOptions,
    traceStore,
    stepName,
    workflowInstanceId,
    originId,
    phase,
  } = options

  const startedAt = Date.now()
  await safeRecord(traceStore, {
    kind: 'step_started',
    taskId: originId,
    originId,
    phase: phase ?? null,
    payload: {
      stepName,
      workflowInstanceId,
      workerName: worker.config.name,
    },
  })

  let result: RunClaudeResult
  try {
    result = await worker.run(prompt, runOptions)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await safeRecord(traceStore, {
      kind: 'step_ended',
      taskId: originId,
      originId,
      phase: phase ?? null,
      payload: {
        stepName,
        workflowInstanceId,
        workerName: worker.config.name,
        outcome: 'failed',
        failureReason: msg.slice(0, 200),
        durationMs: Date.now() - startedAt,
      },
    })
    throw err
  }

  const usage = summarizeUsage(result.conversation)
  // Exit code 138 means the run was terminated by an external abort signal
  // (read/grep span watchdog). This is a distinct outcome from a genuine
  // task failure — the worker was killed, not broken.
  const outcome =
    result.exitCode === 0
      ? 'completed'
      : result.exitCode === 138
        ? 'killed'
        : 'failed'
  const failureReason =
    result.exitCode === 0 || result.exitCode === 138
      ? undefined
      : `exit-${result.exitCode}`
  const transcript = isReflectDisabled()
    ? undefined
    : JSON.stringify(result.conversation)

  await safeRecord(traceStore, {
    kind: 'step_ended',
    taskId: originId,
    originId,
    phase: phase ?? null,
    payload: {
      stepName,
      workflowInstanceId,
      workerName: worker.config.name,
      outcome,
      ...(failureReason !== undefined ? { failureReason } : {}),
      sessionId: result.sessionId ?? null,
      durationMs: Date.now() - startedAt,
      usageSignals: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreateTokens: usage.cacheCreateTokens,
        cacheReadTokens: usage.cacheReadTokens,
        messageCount: usage.messageCount,
      },
      ...(transcript !== undefined ? { transcript } : {}),
    },
  })

  return result
}

export interface RunNonLlmStepOptions<T> {
  stepName: string
  workflowInstanceId: string
  originId: string
  phase: TraceEventPhase
  /**
   * Optional — when absent (or when `record` fails) no trace events are
   * written and the step fn still runs normally.
   */
  traceStore?: TraceEventStore
  fn: () => Promise<T>
  /**
   * Optional. Called after fn() succeeds to check whether the step upgraded
   * to a Worker Session (e.g. the merge step that routed to Vega for conflict
   * resolution). When it returns non-null, the step_ended event carries
   * `workerName` and `sessionId`, satisfying the invariant
   * "a Step span is a Session iff worker IS NOT NULL".
   * Returning null / undefined keeps the span a plain non-LLM Step span.
   */
  getVegaInfo?: () => { workerName: string; sessionId: string | null } | null | undefined
}

/**
 * Run an async function representing a non-LLM workflow step (setup, verify,
 * merge) and bracket its execution with `step_started` / `step_ended` trace
 * events.
 *
 * By default these events carry no `workerName` and no `sessionId` — making
 * this a Step span that is NOT a Session. The optional `getVegaInfo` callback
 * upgrades the step_ended event to a Session when the step routed to a Worker
 * (e.g. the merge step invoking Vega for conflict resolution). The invariant
 * "a Step span is a Session iff worker IS NOT NULL" holds across both paths.
 *
 * Outcome vocabulary: `completed` on success, `failed` on any throw.
 * A live in-flight step is represented by a `step_started` event with no
 * corresponding `step_ended` — query by (kind=step_started, stepName,
 * workflowInstanceId) to detect running state.
 *
 * Trace capture is best-effort: errors from `record` are swallowed so a
 * DB hiccup can never fail the step.
 *
 * Re-throws the original error unchanged so callers preserve their own
 * error-handling invariants.
 */
export const runNonLlmStepWithSpan = async <T>(
  options: RunNonLlmStepOptions<T>,
): Promise<T> => {
  const { stepName, workflowInstanceId, originId, phase, traceStore, fn, getVegaInfo } = options

  const startedAt = Date.now()
  await safeRecord(traceStore, {
    kind: 'step_started',
    taskId: originId,
    originId,
    phase,
    payload: { stepName, workflowInstanceId },
  })

  try {
    const result = await fn()
    const vegaInfo = getVegaInfo?.() ?? null
    await safeRecord(traceStore, {
      kind: 'step_ended',
      taskId: originId,
      originId,
      phase,
      payload: {
        stepName,
        workflowInstanceId,
        outcome: 'completed',
        durationMs: Date.now() - startedAt,
        ...(vegaInfo !== null
          ? { workerName: vegaInfo.workerName, sessionId: vegaInfo.sessionId }
          : {}),
      },
    })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await safeRecord(traceStore, {
      kind: 'step_ended',
      taskId: originId,
      originId,
      phase,
      payload: {
        stepName,
        workflowInstanceId,
        outcome: 'failed',
        failureReason: msg.slice(0, 200),
        durationMs: Date.now() - startedAt,
      },
    })
    throw err
  }
}
