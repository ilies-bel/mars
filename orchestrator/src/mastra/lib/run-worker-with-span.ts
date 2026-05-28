// Thin wrapper that opens a step_spans row before a Worker run and closes it
// once the run completes — on success or failure. Every LLM-backed Worker
// (Coder, Fixer, Planner, Slicer, Triager) calls this wrapper so any session
// can be deep-reflected from raw span data, not just implement-workflow tasks.
//
// Only the transcript is gated behind isReflectDisabled() (it can be large).
// Session id and usage signals are always recorded so lightweight queries
// remain accurate even when reflection is globally disabled.

import { summarizeUsage } from './claude-usage'
import { isReflectDisabled } from './reflect-signals'
import type { StepSpanStore } from './step-span-store'
import type { Worker, RunOptions } from '../workers'
import type { RunClaudeResult } from './git'

export interface RunWorkerWithSpanOptions {
  worker: Worker
  prompt: string
  runOptions: RunOptions
  /**
   * Optional — when absent (or when `openSpan` fails) no span row is written
   * and the worker still runs normally. Callers pass `undefined` when the
   * span store could not be opened so they do not need a separate code path
   * for the "store unavailable" case.
   */
  spanStore?: StepSpanStore
  stepName: string
  workflowInstanceId: string
  originId: string
}

/**
 * Run a Worker and capture a step span around its execution.
 *
 * Opens a span row before calling {@link Worker.run} and closes it after
 * — recording the worker name, Claude session id, conversation transcript,
 * and token-level usage signals.  The span is always closed even when the
 * worker throws; in that case `outcome` reflects the failure so the data is
 * still available for retrospective analysis.
 *
 * Span capture is best-effort: errors from `openSpan` / `closeSpan` are
 * swallowed so a DB hiccup can never fail the task.
 *
 * Returns the raw {@link RunClaudeResult} unchanged so callers can use
 * `r.exitCode`, `r.stdout`, `r.sessionId`, and `r.conversation` exactly
 * as they would after a direct {@link Worker.run} call.
 */
export const runWorkerWithSpan = async (
  options: RunWorkerWithSpanOptions,
): Promise<RunClaudeResult> => {
  const { worker, prompt, runOptions, spanStore, stepName, workflowInstanceId, originId } = options

  let spanId: string | null = null
  if (spanStore !== undefined) {
    try {
      spanId = await spanStore.openSpan({
        stepName,
        workflowInstanceId,
        originId,
        workerName: worker.config.name,
      })
    } catch {
      // span capture is best-effort — proceed without a span rather than
      // failing the task
    }
  }

  let result: RunClaudeResult
  try {
    result = await worker.run(prompt, runOptions)
  } catch (err) {
    if (spanId !== null && spanStore !== undefined) {
      const msg = err instanceof Error ? err.message : String(err)
      await spanStore
        .closeSpan(spanId, {
          outcome: `failed:${msg.slice(0, 200)}`,
        })
        .catch(() => {})
    }
    throw err
  }

  if (spanId !== null && spanStore !== undefined) {
    const usage = summarizeUsage(result.conversation)
    await spanStore
      .closeSpan(spanId, {
        outcome: result.exitCode === 0 ? 'success' : `failed:exit-${result.exitCode}`,
        sessionId: result.sessionId ?? undefined,
        transcript: isReflectDisabled() ? undefined : JSON.stringify(result.conversation),
        usageSignals: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreateTokens: usage.cacheCreateTokens,
          cacheReadTokens: usage.cacheReadTokens,
          messageCount: usage.messageCount,
        },
      })
      .catch(() => {})
  }

  return result
}
