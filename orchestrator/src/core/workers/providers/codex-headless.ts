// Codex headless adapter — normalises the `codex exec --json` JSONL stream
// into the orchestrator's legacy ClaudeEvent shape so downstream readers work
// unchanged. Authentication is deliberately delegated to Codex CLI: a local
// `codex login` ChatGPT OAuth session (or another CLI-supported auth method) is
// reused automatically and MARS never reads or copies credential material.
//
// Usage semantics are 'cumulative': the ONLY usage-bearing event is the
// terminal `turn.completed`, and its `usage` block is total spend for the
// whole turn — not context occupancy. Reading it as occupancy is what
// produced fabricated readouts like `289216/50000` and ctx% above 300%.

import { runSubprocessStreaming, buildWorkerEnv, type RunClaudeResult } from '../../lib/git/claude'
import type { ClaudeEvent } from '../../lib/claude-stream'
import type { HeadlessAdapter, HeadlessRunOpts } from '../providers'
import { providerBinPath } from '../provider-bin'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isReadOnlyRun = (opts: HeadlessRunOpts): boolean => {
  const denied = new Set(opts.disallowedTools ?? [])
  return denied.has('Edit') && denied.has('Write')
}

// `codex exec --help` exposes no system-instruction argument. Keep the
// unavoidable inlining explicit at this call site: Codex receives these as
// ordinary user text, so the user prompt must put non-negotiable exit
// conditions first rather than relying on system-role precedence.
export const composeCodexPrompt = (prompt: string, systemPrompt?: string): string =>
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
 *
 * NOTHING usage-bearing is dropped here. Verified against codex-cli 0.145.0 by
 * capturing a full `codex exec --json` run (one prompt, one shell tool call):
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution",…}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution",…}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}
 *   {"type":"turn.completed","usage":{"input_tokens":31864,"cached_input_tokens":25088,
 *                                     "cache_write_input_tokens":0,"output_tokens":118,
 *                                     "reasoning_output_tokens":0}}
 *
 * No token/usage field appears on any item event, and `codex exec --help` on
 * this version exposes no incremental-usage or raw-protocol-event flag. The
 * terminal `turn.completed` really is the ONLY usage signal, which is why the
 * adapter declares 'cumulative' semantics and why no mid-run ceiling can exist
 * on this provider — see ContextGuardMode in ../../lib/claude-usage.
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
    usageSemantics: 'cumulative',
    quotaRejected: false,
    sessionId: false,
  },
  readOutput: readCodexOutput,

  run: async (prompt: string, opts: HeadlessRunOpts): Promise<RunClaudeResult> => {
    const conversation: ClaudeEvent[] = []
    const abort = new AbortController()
    let externalAborted = false

    if (opts.externalAbort) {
      if (opts.externalAbort.aborted) {
        externalAborted = true
        abort.abort()
      } else {
        opts.externalAbort.addEventListener('abort', () => {
          externalAborted = true
          abort.abort()
        }, { once: true })
      }
    }

    // Resolved once per process (see provider-bin.ts) and reused, so a
    // mid-session PATH change cannot silently break every subsequent run.
    const result = await runSubprocessStreaming(
      providerBinPath('codex'),
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
        composeCodexPrompt(prompt, opts.systemPrompt),
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

    if (externalAborted) {
      return {
        exitCode: 138,
        stdout: result.stdout,
        stderr: 'codex exec aborted by caller (read/grep span watcher)',
        sessionId: null,
        conversation,
        quotaRejected: null,
      }
    }

    return {
      ...result,
      sessionId: null,
      conversation,
      quotaRejected: null,
    }
  },
}
