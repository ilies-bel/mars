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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isReadOnlyRun = (opts: HeadlessRunOpts): boolean => {
  const denied = new Set(opts.disallowedTools ?? [])
  return denied.has('Edit') && denied.has('Write')
}

/**
 * Pull the human-readable message out of a codex `error` / `turn.failed`
 * envelope. `error` carries `message` at the top level; `turn.failed` nests it
 * under `error`.
 */
const codexErrorMessage = (parsed: Record<string, unknown>): string | null => {
  if (typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim()
  }
  const nested = parsed.error
  if (isObject(nested) && typeof nested.message === 'string' && nested.message.trim()) {
    return nested.message.trim()
  }
  return null
}

/**
 * Codex's wording for a rate/spend rejection. Verified against codex-cli
 * 0.145.0, which emits:
 *
 *   "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
 *    to purchase more credits or try again at Aug 6th, 2026 11:58 PM."
 *
 * This is an ENVIRONMENTAL condition, not a code failure: the coder never ran
 * and the worktree is untouched. Recognising it routes the run into the
 * existing quota branch in the code step (re-queue + pause dispatch + one
 * action-queue row) instead of burning the task's single recovery slot on a
 * rejection that would reproduce instantly.
 */
const CODEX_QUOTA_REJECTION_RE =
  /usage limit|rate limit|quota exceeded|too many requests|429/i

/**
 * Codex reports the reset point as English prose inside the same sentence
 * ("… try again at Aug 6th, 2026 11:58 PM."), not as a machine field. Parse it
 * best-effort and fall back to 0, which the daemon already understands as
 * "unknown" and answers with a fixed 30-minute pause. An unparsed date must
 * never suppress the rejection itself.
 */
const parseCodexResetsAt = (message: string): number => {
  const match = /try again (?:at|after|on)\s+([^.]+)/i.exec(message)
  if (!match) return 0
  // Strip ordinal suffixes ("Aug 6th" → "Aug 6") so Date.parse can read it.
  const cleaned = match[1].trim().replace(/(\d+)(st|nd|rd|th)\b/gi, '$1')
  const parsed = Date.parse(cleaned)
  if (!Number.isFinite(parsed)) return 0
  const seconds = Math.floor(parsed / 1000)
  return seconds > 0 ? seconds : 0
}

/**
 * Scan a normalised codex conversation for a provider quota rejection.
 * Returns the daemon's `{ resetsAt }` sentinel, or null when the run failed
 * for any other reason.
 */
export const extractCodexQuotaRejected = (
  conversation: readonly ClaudeEvent[],
): { resetsAt: number } | null => {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const event = conversation[i]
    if (event.type !== 'result' || event.is_error !== true) continue
    const text = typeof event.result === 'string' ? event.result : ''
    if (text && CODEX_QUOTA_REJECTION_RE.test(text)) {
      return { resetsAt: parseCodexResetsAt(text) }
    }
  }
  return null
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
 *   error / turn.failed           → result event with is_error:true and the message
 *   everything else               → null
 *
 * `error` and `turn.failed` are NOT optional to handle. When codex refuses a
 * run outright (usage limit, auth failure, bad model) it writes those two
 * lines to STDOUT and nothing whatsoever to stderr except the benign
 * "Reading additional input from stdin..." notice it prints on every run
 * whose stdin is not a TTY. Dropping them left `conversation` empty, so the
 * code step's diagnostic fallback (extractLastStreamText) had nothing to
 * report and the task failed as `code/unclassified` with a stdin notice as
 * its only evidence — a real incident that churned two tasks in a 30-second
 * requeue loop with no way to see the cause.
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

  // Terminal provider-side refusal. Two shapes, both observed on codex-cli
  // 0.145.0 within a single failed run:
  //   {"type":"error","message":"…"}
  //   {"type":"turn.failed","error":{"message":"…"}}
  if (parsed.type === 'error' || parsed.type === 'turn.failed') {
    const message = codexErrorMessage(parsed)
    if (!message) return null
    return { type: 'result', is_error: true, result: message }
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
    // Codex DOES surface rate/spend rejections — as an `error` / `turn.failed`
    // pair on stdout rather than a dedicated field. extractCodexQuotaRejected
    // recovers them, so this adapter populates RunClaudeResult.quotaRejected.
    quotaRejected: true,
    sessionId: false,
  },
  readOutput: readCodexOutput,

  run: async (prompt: string, opts: HeadlessRunOpts): Promise<RunClaudeResult> => {
    // Refuse before spawning: `codex exec` with no prompt argument falls back
    // to reading stdin, which is /dev/null for dispatched workers, so it reads
    // EOF and exits 1 with no usable diagnostic. See EMPTY_PROMPT_REFUSAL.
    const composedPrompt = composeCodexPrompt(prompt, opts.systemPrompt)
    if (isBlankPrompt(composedPrompt)) return emptyPromptResult('codex')

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
        composedPrompt,
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
      quotaRejected: extractCodexQuotaRejected(conversation),
    }
  },
}
