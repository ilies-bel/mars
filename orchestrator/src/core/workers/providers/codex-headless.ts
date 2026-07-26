// Codex headless adapter — normalises the `codex exec --json` JSONL stream
// into the orchestrator's ClaudeEvent shape so downstream readers work
// unchanged. The adapter is deliberately minimal: context-token metering,
// quota-rejection detection, and session-id extraction are all false/null
// because the codex CLI does not expose those signals.

import { runSubprocessStreaming, buildWorkerEnv, type RunClaudeResult } from '../../lib/git/claude'
import type { ClaudeEvent } from '../../lib/claude-stream'
import type { HeadlessAdapter, HeadlessRunOpts } from '../providers'

// Resolve the codex binary path. Reuses MARS_CODEX_BIN (the same env var
// consumed by the chat-runner's codex-api path) so operators configure one
// binary location for both call sites.
const resolveCodexBin = (): string => process.env.MARS_CODEX_BIN?.trim() || 'codex'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Parse a single JSONL line from the `codex exec --json` stream into a
 * ClaudeEvent-shaped record, or `null` when the line should be discarded.
 *
 * Recognised mappings:
 *   item.completed(agent_message) → assistant event with text content block
 *   item.completed(reasoning)     → null (dropped; opaque to downstream readers)
 *   turn.completed                → result event; is_error reflects the codex error field
 *   everything else               → null
 */
export const parseCodexEventLine = (line: string): ClaudeEvent | null => {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null

  if (parsed.type === 'item.completed' && isObject(parsed.item)) {
    const item = parsed.item
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: item.text }],
        },
      }
    }
    // reasoning items and all other item subtypes are dropped.
    return null
  }

  if (parsed.type === 'turn.completed') {
    // Treat the presence of a non-null `error` field as an error condition.
    const hasError = parsed.error !== undefined && parsed.error !== null
    return {
      type: 'result',
      is_error: hasError,
      ...(isObject(parsed.usage) ? { usage: parsed.usage } : {}),
    }
  }

  return null
}

export const codexHeadless: HeadlessAdapter = {
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
      resolveCodexBin(),
      [
        'exec',
        '--json',
        '--model',
        opts.model ?? 'gpt-5.5',
        '-c',
        `model_reasoning_effort="${opts.effort ?? 'high'}"`,
        '--sandbox',
        'workspace-write',
        prompt,
      ],
      opts.cwd,
      async ({ stream, line }) => {
        if (stream !== 'stdout') return
        const ev = parseCodexEventLine(line)
        if (!ev) return
        conversation.push(ev)
        if (opts.onEvent) await opts.onEvent(ev)
      },
      abort.signal,
      buildWorkerEnv(),
      opts.onPid,
    )

    return {
      ...result,
      sessionId: null,
      conversation,
      quotaRejected: null,
    }
  },
}
