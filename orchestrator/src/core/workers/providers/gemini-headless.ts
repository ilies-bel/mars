// Gemini headless adapter — normalises the gemini CLI line-buffered stdout
// into the orchestrator's ClaudeEvent shape so downstream readers work
// unchanged. The adapter is deliberately minimal: token usage,
// quota-rejection detection, and session-id extraction are all absent/null
// because the gemini CLI does not expose those signals — usage semantics are
// therefore 'none' and no token signal is reported for a gemini run.

import {
  runSubprocessStreaming,
  buildWorkerEnv,
  emptyPromptResult,
  isBlankPrompt,
  type RunClaudeResult,
} from '../../lib/git/claude'
import type { ClaudeEvent } from '../../lib/claude-stream'
import type { HeadlessAdapter, HeadlessRunOpts } from '../providers'
import { providerBinPath } from '../provider-bin'

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

/** Read Gemini's line-buffered text output into normalized assistant events. */
export const readGeminiOutput = (stdout: string): ClaudeEvent[] =>
  stdout
    .split(/\r?\n/)
    .map((line) => parseGeminiEventLine(line))
    .filter((event): event is ClaudeEvent => event !== null)

export const geminiHeadless: HeadlessAdapter = {
  capabilities: {
    usageSemantics: 'none',
    quotaRejected: false,
    sessionId: false,
  },
  readOutput: readGeminiOutput,

  run: async (prompt: string, opts: HeadlessRunOpts): Promise<RunClaudeResult> => {
    // Refuse before spawning: `gemini -p ''` falls back to reading the prompt
    // from stdin, which is /dev/null for dispatched workers. See
    // EMPTY_PROMPT_REFUSAL.
    if (isBlankPrompt(prompt)) return emptyPromptResult('gemini')

    const conversation: ClaudeEvent[] = []
    const abort = new AbortController()

    if (opts.externalAbort) {
      if (opts.externalAbort.aborted) {
        abort.abort()
      } else {
        opts.externalAbort.addEventListener('abort', () => abort.abort(), { once: true })
      }
    }

    // Resolved once per process (see provider-bin.ts) and reused, so a
    // mid-session PATH change cannot silently break every subsequent run.
    const result = await runSubprocessStreaming(
      providerBinPath('gemini'),
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
