// Gemini headless adapter — normalises the gemini CLI line-buffered stdout
// into the orchestrator's ClaudeEvent shape so downstream readers work
// unchanged. The adapter is deliberately minimal: context-token metering,
// quota-rejection detection, and session-id extraction are all false/null
// because the gemini CLI does not expose those signals.

import { runSubprocessStreaming, buildWorkerEnv, type RunClaudeResult } from '../../lib/git/claude'
import type { ClaudeEvent } from '../../lib/claude-stream'
import type { HeadlessAdapter, HeadlessRunOpts } from '../providers'

// Resolve the gemini binary path. Reads MARS_GEMINI_BIN so operators can
// configure a specific binary location; falls back to the bare name 'gemini'
// and lets spawn surface ENOENT cleanly if it is not on PATH.
export const resolveGeminiBin = (): string => process.env.MARS_GEMINI_BIN?.trim() || 'gemini'

/**
 * Parse a single stdout line from the gemini CLI into a ClaudeEvent-shaped
 * record, or `null` when the line should be discarded.
 *
 * Recognised mappings:
 *   non-empty text line → assistant event with a single text content block
 *   empty / whitespace-only line → null (discarded)
 *
 * The gemini CLI emits plain text rather than structured JSONL, so every
 * non-empty stdout line is treated as assistant text.
 */
export const parseGeminiEventLine = (line: string): ClaudeEvent | null => {
  if (!line.trim()) return null
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: line }],
    },
  }
}

export const geminiHeadless: HeadlessAdapter = {
  capabilities: {
    contextTokenMetering: false,
    quotaRejected: false,
    sessionId: false,
  },

  run: async (prompt: string, opts: HeadlessRunOpts): Promise<RunClaudeResult> => {
    const conversation: ClaudeEvent[] = []
    const abort = new AbortController()

    if (opts.externalAbort) {
      if (opts.externalAbort.aborted) {
        abort.abort()
      } else {
        opts.externalAbort.addEventListener('abort', () => abort.abort(), { once: true })
      }
    }

    const result = await runSubprocessStreaming(
      resolveGeminiBin(),
      ['-p', prompt, '--model', opts.model ?? 'gemini-2.5-pro'],
      opts.cwd,
      async ({ stream, line }) => {
        if (stream !== 'stdout') return
        const ev = parseGeminiEventLine(line)
        if (!ev) return
        conversation.push(ev)
        if (opts.onEvent) await opts.onEvent(ev)
      },
      abort.signal,
      buildWorkerEnv(),
      opts.onPid,
    )

    // Synthesise a result event. On nonzero exit, mark it as an error and
    // include the captured stderr so callers can surface the failure message.
    const resultEvent: ClaudeEvent =
      result.exitCode !== 0
        ? { type: 'result', is_error: true, result: result.stderr }
        : { type: 'result', is_error: false }
    conversation.push(resultEvent)
    if (opts.onEvent) await opts.onEvent(resultEvent)

    return {
      ...result,
      sessionId: null,
      conversation,
      quotaRejected: null,
    }
  },
}
