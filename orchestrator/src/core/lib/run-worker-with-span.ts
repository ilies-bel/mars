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

import { summarizeUsage, getLatestContextSize } from './claude-usage'
import { resolveUsage } from './usage-sources'
import { isReflectDisabled } from './reflect-signals'
import { evaluateStep } from './step-evaluators'
import { TRANSCRIPT_CHUNK_BATCH } from './trace-events-store'
import type { TraceEventStore, TraceEventPhase } from './trace-events-store'
import type { Worker, RunOptions } from '../workers'
import type { RunClaudeResult } from './git/claude'
import type { ClaudeEvent } from './claude-stream'

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
  /**
   * The owning task id stamped on every span emitted by this call. Pass the
   * concrete child task id for implement-arc steps (`run-claude-code`, etc.) and
   * `null` for slicer-level steps (`generate-slices`, `auto-linker-direction`,
   * `action-quality-reprompt`) that have no direct task owner.
   */
  taskId: string | null
  /** Optional phase tag (`code`, `verify`, …) attached to both events. */
  phase?: TraceEventPhase
  /**
   * Optional. Called after the worker succeeds to supply extra key/value
   * pairs that are merged into the `step_ended` payload before
   * `evaluateStep` runs. Spread before `evalResults` so evaluators can
   * read the caller-supplied fields. Returning an empty object is a no-op.
   */
  getExtraPayload?: () => Record<string, unknown>
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
    taskId,
    phase,
    getExtraPayload,
  } = options

  const startedAt = Date.now()
  await safeRecord(traceStore, {
    kind: 'step_started',
    taskId,
    originId,
    phase: phase ?? null,
    payload: {
      stepName,
      workflowInstanceId,
      workerName: worker.config.name,
    },
  })

  // Accumulate streaming events so partial usage is available if the worker
  // throws before returning. For PTY workers onEvent is never called — they
  // emit nothing to this path — so accumulatedEvents will be empty and the
  // failure payload carries zeros, which is the same as the prior behaviour.
  const accumulatedEvents: ClaudeEvent[] = []

  // Incremental transcript streaming: flush every TRANSCRIPT_CHUNK_BATCH events
  // to task_transcripts so a watchdog-killed session's partial transcript is
  // readable before step_ended is written. Best-effort — a DB hiccup must never
  // fail the task.
  const pendingChunkEvents: ClaudeEvent[] = []
  let chunkSeq = 0
  const sessionIdForChunks = runOptions.sessionId ?? null
  const chunkTaskId = taskId

  const safeFlushChunk = async (): Promise<void> => {
    if (
      pendingChunkEvents.length === 0 ||
      !sessionIdForChunks ||
      !chunkTaskId ||
      !traceStore?.appendTranscriptChunk
    ) {
      pendingChunkEvents.length = 0
      return
    }
    const batch = pendingChunkEvents.splice(0)
    await traceStore.appendTranscriptChunk(chunkTaskId, sessionIdForChunks, chunkSeq++, batch).catch(() => {})
  }

  const runOptionsWithAccum: RunOptions = {
    ...runOptions,
    onEvent: async (event) => {
      accumulatedEvents.push(event)
      pendingChunkEvents.push(event)
      if (pendingChunkEvents.length >= TRANSCRIPT_CHUNK_BATCH) {
        await safeFlushChunk()
      }
      // Spawn-time model guard: the claude CLI emits a system/init event at
      // the start of every run containing the model it actually selected.
      // Compare against the Worker's pinned model; a mismatch means the
      // subprocess is using a different (possibly more expensive) model than
      // intended — emit a warn trace event so the drift is visible in reflect.
      // This converts silent budget drift (e.g. opus running where sonnet was
      // pinned) into a queryable signal without blocking the run.
      if (
        event.type === 'system' &&
        (event.subtype as string | undefined) === 'init' &&
        typeof event.model === 'string' &&
        event.model !== worker.config.model
      ) {
        await safeRecord(traceStore, {
          kind: 'worker-model-mismatch',
          taskId,
          originId,
          phase: phase ?? null,
          payload: {
            expected: worker.config.model,
            actual: event.model as string,
            worker: worker.config.name,
            taskId,
          },
        })
      }
      return runOptions.onEvent?.(event)
    },
  }

  let result: RunClaudeResult
  try {
    result = await worker.run(prompt, runOptionsWithAccum)
  } catch (err) {
    // Flush any remaining buffered events so a killed/crashed session's
    // partial transcript is durable even without a step_ended row.
    await safeFlushChunk()
    const msg = err instanceof Error ? err.message : String(err)
    const partialUsage = summarizeUsage(accumulatedEvents)
    const partialContextTokens = getLatestContextSize(accumulatedEvents)
    const failurePayload = {
      stepName,
      workflowInstanceId,
      workerName: worker.config.name,
      outcome: 'failed' as const,
      failureReason: msg.slice(0, 200),
      durationMs: Date.now() - startedAt,
      usageSignals: {
        inputTokens: partialUsage.inputTokens,
        outputTokens: partialUsage.outputTokens,
        cacheCreateTokens: partialUsage.cacheCreateTokens,
        cacheReadTokens: partialUsage.cacheReadTokens,
        messageCount: partialUsage.messageCount,
        contextTokens: partialContextTokens,
      },
    }
    const failureEvalResults = evaluateStep(stepName, failurePayload)
    await safeRecord(traceStore, {
      kind: 'step_ended',
      taskId,
      originId,
      phase: phase ?? null,
      payload: {
        ...failurePayload,
        ...(failureEvalResults.length > 0 ? { evalResults: failureEvalResults } : {}),
      },
    })
    throw err
  }

  // Flush any remaining buffered events from the successful run.
  await safeFlushChunk()

  const usage = await resolveUsage({
    conversation: result.conversation,
    sessionId: result.sessionId,
    cwd: runOptions.cwd,
    provider: worker.config.provider,
  })
  const contextTokens = getLatestContextSize(result.conversation)
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

  // Persist the full conversation as a gzip-compressed BLOB in
  // task_durable_transcripts — not inline in the step_ended payload.
  // step_ended payloads are scanned by hot aggregate queries and must remain
  // small; the dedicated table avoids multi-megabyte blobs in trace_events.
  if (!isReflectDisabled() && taskId && traceStore?.appendDurableTranscript) {
    await traceStore
      .appendDurableTranscript(
        taskId,
        result.sessionId ?? '',
        stepName,
        JSON.stringify(result.conversation),
      )
      .catch(() => {})
  }

  const successPayload = {
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
      contextTokens,
    },
    ...(getExtraPayload !== undefined ? getExtraPayload() : {}),
  }
  const evalResults = evaluateStep(stepName, successPayload)
  await safeRecord(traceStore, {
    kind: 'step_ended',
    taskId,
    originId,
    phase: phase ?? null,
    payload: {
      ...successPayload,
      ...(evalResults.length > 0 ? { evalResults } : {}),
    },
  })

  return result
}

export interface RunNonLlmStepOptions<T> {
  stepName: string
  workflowInstanceId: string
  originId: string
  /**
   * The owning task id stamped on every span emitted by this call. Pass the
   * concrete child task id for implement-arc steps and `null` for slicer-level
   * steps that have no direct task owner.
   */
  taskId: string | null
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
  /**
   * Optional. Called after fn() completes (successfully or with a throw) to
   * capture the step's command output (e.g. the concatenated verify step
   * stdout/stderr). When it returns a non-undefined string the value is
   * included in the step_ended payload as `commandOutput`. Returning
   * undefined (or omitting this callback) omits the field.
   */
  getCommandOutput?: () => string | undefined
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
  const {
    stepName,
    workflowInstanceId,
    originId,
    taskId,
    phase,
    traceStore,
    fn,
    getVegaInfo,
    getCommandOutput,
  } = options

  const startedAt = Date.now()
  await safeRecord(traceStore, {
    kind: 'step_started',
    taskId,
    originId,
    phase,
    payload: { stepName, workflowInstanceId },
  })

  try {
    const result = await fn()
    const vegaInfo = getVegaInfo?.() ?? null
    const commandOutput = getCommandOutput?.()
    const nonLlmSuccessPayload = {
      stepName,
      workflowInstanceId,
      outcome: 'completed' as const,
      durationMs: Date.now() - startedAt,
      ...(vegaInfo !== null
        ? { workerName: vegaInfo.workerName, sessionId: vegaInfo.sessionId }
        : {}),
      ...(commandOutput !== undefined ? { commandOutput } : {}),
    }
    const nonLlmSuccessEvalResults = evaluateStep(stepName, nonLlmSuccessPayload)
    await safeRecord(traceStore, {
      kind: 'step_ended',
      taskId,
      originId,
      phase,
      payload: {
        ...nonLlmSuccessPayload,
        ...(nonLlmSuccessEvalResults.length > 0 ? { evalResults: nonLlmSuccessEvalResults } : {}),
      },
    })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const commandOutput = getCommandOutput?.()
    const nonLlmFailurePayload = {
      stepName,
      workflowInstanceId,
      outcome: 'failed' as const,
      failureReason: msg.slice(0, 200),
      durationMs: Date.now() - startedAt,
      ...(commandOutput !== undefined ? { commandOutput } : {}),
    }
    const nonLlmFailureEvalResults = evaluateStep(stepName, nonLlmFailurePayload)
    await safeRecord(traceStore, {
      kind: 'step_ended',
      taskId,
      originId,
      phase,
      payload: {
        ...nonLlmFailurePayload,
        ...(nonLlmFailureEvalResults.length > 0 ? { evalResults: nonLlmFailureEvalResults } : {}),
      },
    })
    throw err
  }
}
