// Thin wrapper that records a step_started event before a Worker run and a
// step_ended event after — on success or failure. Every LLM-backed Worker
// (Coder, Fixer, Planner, Slicer, Triager) calls this wrapper so any session
// shows up in the unified trace surface.
//
// Only the transcript is gated behind isReflectDisabled() (it can be large).
// Session id and usage signals are always recorded so lightweight queries
// remain accurate even when reflection is globally disabled.

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
        outcome: 'failure',
        failureReason: msg.slice(0, 200),
        durationMs: Date.now() - startedAt,
      },
    })
    throw err
  }

  const usage = summarizeUsage(result.conversation)
  const outcome = result.exitCode === 0 ? 'success' : 'failure'
  const failureReason =
    result.exitCode === 0 ? undefined : `exit-${result.exitCode}`
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
