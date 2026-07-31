// Codex headless adapter — normalises the `codex exec --json` JSONL stream
// into the orchestrator's legacy ClaudeEvent shape so downstream readers work
// unchanged. Authentication is deliberately delegated to Codex CLI: a local
// `codex login` ChatGPT OAuth session (or another CLI-supported auth method) is
// reused automatically and MARS never reads or copies credential material.

import { runSubprocessStreaming, buildWorkerEnv, type RunClaudeResult } from '../../lib/git/claude'
import type { ClaudeEvent } from '../../lib/claude-stream'
import type { HeadlessAdapter, HeadlessRunOpts } from '../providers'

// Resolve the codex binary path. Reuses MARS_CODEX_BIN (the same env var
// consumed by the chat-runner's codex-api path) so operators configure one
// binary location for both call sites.
const resolveCodexBin = (): string => process.env.MARS_CODEX_BIN?.trim() || 'codex'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isReadOnlyRun = (opts: HeadlessRunOpts): boolean => {
  const denied = new Set(opts.disallowedTools ?? [])
  return denied.has('Edit') && denied.has('Write')
}

const composePrompt = (prompt: string, systemPrompt?: string): string =>
  systemPrompt?.trim()
    ? `<mars_system_instructions>\n${systemPrompt.trim()}\n</mars_system_instructions>\n\n${prompt}`
    : prompt

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

/** Read Codex's NDJSON stdout, ignoring blank and incomplete trailing lines. */
export const readCodexOutput = (stdout: string): ClaudeEvent[] =>
  stdout
    .split(/\r?\n/)
    .map((line) => parseCodexEventLine(line))
    .filter((event): event is ClaudeEvent => event !== null)

export const codexHeadless: HeadlessAdapter = {
  capabilities: {
    contextTokenMetering: false,
    quotaRejected: false,
    sessionId: false,
  },
  readOutput: readCodexOutput,

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
        '--ephemeral',
        '--json',
        '--model',
        opts.model ?? 'gpt-5.6-sol',
        '-c',
        `model_reasoning_effort="${opts.effort ?? 'high'}"`,
        '--sandbox',
        isReadOnlyRun(opts) ? 'read-only' : 'workspace-write',
        composePrompt(prompt, opts.systemPrompt),
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
