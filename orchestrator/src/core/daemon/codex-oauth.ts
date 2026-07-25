/**
 * codex-oauth — the chat surface's provider: a direct HTTPS call to the
 * ChatGPT/Codex backend, replacing the `codex exec` subprocess.
 *
 * WHY
 *
 * Spawning the Codex CLI per chat turn paid a fixed startup cost (process spawn,
 * CODEX_HOME resolution, auth load, rollout state db, MCP boot) before the model
 * saw a single token — and then made this exact HTTPS request anyway. Calling the
 * backend directly removes that, and lets us control the two things that actually
 * govern chat latency and quota burn: reasoning effort and history size.
 *
 * WHAT THE BACKEND CONSTRAINS (all verified against the live endpoint)
 *
 *  - `store: true` is rejected: `{"detail":"Store must be set to false"}`. So
 *    `previous_response_id` chaining is unavailable and every turn replays its
 *    own history — see chat-history.ts.
 *  - Automatic prefix caching exists but does NOT currently help this surface,
 *    and it is worth knowing why before anyone "optimises" for it. The cacheable
 *    unit is the stable request prefix — `instructions` plus `tools` — because
 *    history is appended after it and differs every turn. Caching has a
 *    ~1024-token minimum, and Mars's system prompt plus the shell tool schema is
 *    only ~450 tokens, so requests here report `cached_input_tokens: 0`. A
 *    ~2000-token prefix does get hits (1536 of 2026 measured), and those hits are
 *    content-keyed rather than session-keyed — a request with a fresh
 *    `session_id` still hit — but population is opportunistic: three identical
 *    calls were needed before the first hit, and a later one missed again.
 *    Practical upshot: the wins on this lane come from `effort: none` and bounded
 *    history, not from caching. Caching only becomes worth designing around if
 *    durable context (command reference, glossary) is moved into `instructions`
 *    and pushes the prefix past ~1024 tokens. Either way, nothing volatile
 *    (run ids, timestamps, thread state) belongs in `instructions`.
 *  - `reasoning.effort` accepts `none | low | medium | high | xhigh` on gpt-5.5
 *    (NOT `minimal`). `none` yields zero reasoning tokens, which is the right
 *    default for a chat surface; the CLI path used `high` on every turn.
 *  - The tool loop works under `store: false` at `effort: none` WITHOUT
 *    `include: ['reasoning.encrypted_content']`. That include is only needed to
 *    keep multi-turn tool calls coherent once reasoning is switched on, so it is
 *    added conditionally rather than always.
 *
 * SANDBOXING — READ THIS, IT IS A REGRESSION
 *
 * The CLI ran tools under `--sandbox workspace-write`: OS-level confinement
 * (Seatbelt on macOS) that kept writes inside the workspace. Calling the backend
 * directly means WE own tool execution, and this module runs commands as a plain
 * child process with NO OS sandbox. The chat agent can now write anywhere the
 * daemon user can.
 *
 * `MARS_CHAT_SHELL_ALLOWLIST=1` enables an opt-in prefix check, but it is not a
 * replacement and is off by default for two reasons. It cannot contain
 * `cat x && rm -rf y`, because the whole string goes to `zsh -lc` and only the
 * first token is inspected. And it fails unpredictably in practice: a list built
 * around the agent's documented job still refused `git rev-list --count HEAD` on
 * the first live run, so a default-on list would break real work while
 * delivering no real safety property.
 *
 * Restoring genuine confinement means running each command under a
 * `sandbox-exec` profile; that is tracked as separate work.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatSegment } from './chat-runner'
import type { ProviderInputItem } from './chat-history'

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const DEFAULT_MODEL = 'gpt-5.5'
/** Chat wants an answer, not a deliberation. `none` ⇒ zero reasoning tokens. */
const DEFAULT_EFFORT = 'none'
const DEFAULT_MAX_TOOL_TURNS = 12
/** Per-request ceiling. The runner also enforces a 10-minute wall clock per run. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
/** Tool output beyond this is truncated — it would otherwise land in history. */
const MAX_TOOL_OUTPUT_CHARS = 16_384

/**
 * Backoff for retrying a 5xx or a dropped connection, in ms.
 *
 * This endpoint returns intermittent `500 server_error` responses at a
 * meaningful rate — bisecting one such failure showed the *same* request body
 * succeeding and failing minutes apart, so it is server-side flakiness rather
 * than anything about the request. The Codex CLI absorbed these internally;
 * now that we call the backend ourselves, a single blip would otherwise become
 * a user-visible "Codex could not complete this response".
 *
 * Sized against a measured failure rate: sampling the endpoint with a fixed
 * request body returned 500 on roughly 2 attempts in 5. Three retries (four
 * attempts) puts the compound failure rate near 2.5%; two retries left it around
 * 6%, which showed up as consecutive user-visible failures during testing.
 * Backoff stays short because someone is waiting on a chat reply — the whole
 * budget adds under 4 s before giving up.
 */
const TRANSIENT_RETRY_BACKOFF_MS = [400, 1_000, 2_500]

/**
 * Prefix allowlist used only when `MARS_CHAT_SHELL_ALLOWLIST=1`.
 *
 * Covers the chat agent's documented job — `mars` commands plus repo and
 * database inspection — and deliberately omits interpreters and package
 * managers, which would make the check meaningless. Off by default: it is not a
 * security boundary, and see the header note for why default-on is worse than
 * either alternative.
 */
const OPT_IN_SHELL_ALLOWLIST = [
  'mars', 'git', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'jq',
  'sqlite3', 'psql', 'pwd', 'date', 'stat', 'du', 'df', 'which', 'echo', 'printf',
]

const env = (key: string): string | undefined => {
  const raw = process.env[key]
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined
}

const numericEnv = (key: string, fallback: number): number => {
  const raw = env(key)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Resolved provider settings for one turn. Env-driven so operators can tune without a rebuild. */
export interface CodexOAuthConfig {
  baseUrl: string
  model: string
  effort: string
  maxToolTurns: number
  requestTimeoutMs: number
  shellAllowlist: readonly string[] | null
}

export const resolveCodexOAuthConfig = (): CodexOAuthConfig => ({
  baseUrl: (env('MARS_CODEX_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
  model: env('MARS_CHAT_MODEL') ?? DEFAULT_MODEL,
  effort: env('MARS_CHAT_EFFORT') ?? DEFAULT_EFFORT,
  maxToolTurns: numericEnv('MARS_CHAT_MAX_TOOL_TURNS', DEFAULT_MAX_TOOL_TURNS),
  requestTimeoutMs: numericEnv('MARS_CHAT_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
  shellAllowlist: env('MARS_CHAT_SHELL_ALLOWLIST') === '1' ? OPT_IN_SHELL_ALLOWLIST : null,
})

// ── Credentials ───────────────────────────────────────────────────────────────

export interface CodexCredentials {
  accessToken: string
  accountId: string | null
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const nonEmpty = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

/** `chatgpt_account_id` from the access token's own claims, when auth.json omits it. */
const decodeAccountId = (token: string): string | null => {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const payload = JSON.parse(json) as unknown
    if (!isObject(payload)) return null
    const auth = payload['https://api.openai.com/auth']
    return isObject(auth) ? nonEmpty(auth.chatgpt_account_id) : null
  } catch {
    return null
  }
}

/**
 * Read the Codex CLI's own credentials from `$CODEX_HOME/auth.json`.
 *
 * Read fresh on every turn rather than cached, so a `codex login` (or the CLI's
 * own refresh) is picked up without restarting the daemon. This module never
 * writes the file and never performs a refresh itself: rotating the refresh
 * token incorrectly would break the user's CLI login, and these access tokens
 * are long-lived (~8 days). An expired token surfaces as a 401, which maps to
 * the runner's existing `auth` failure path and its re-auth banner.
 */
export const loadCodexCredentials = async (): Promise<CodexCredentials | null> => {
  const codexHome = env('CODEX_HOME') ?? join(homedir(), '.codex')
  try {
    const raw = await readFile(join(codexHome, 'auth.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isObject(parsed)) return null
    const tokens = isObject(parsed.tokens) ? parsed.tokens : {}
    const accessToken = nonEmpty(tokens.access_token)
    if (!accessToken) return null
    return { accessToken, accountId: nonEmpty(tokens.account_id) ?? decodeAccountId(accessToken) }
  } catch {
    return null
  }
}

// ── Shell tool ────────────────────────────────────────────────────────────────

/**
 * Short display name for a shell command, matching what the UI's shell-tool
 * renderer groups on.
 * - `mars <verb> ...` → `mars <verb>`
 * - anything else      → first token
 */
export const deriveCommandName = (command: string): string => {
  const tokens = command.trim().split(/\s+/)
  if (tokens[0] === 'mars' && tokens[1]) return `mars ${tokens[1]}`
  return tokens[0] ?? 'shell'
}

const truncate = (output: string): string =>
  output.length <= MAX_TOOL_OUTPUT_CHARS
    ? output
    : `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated at ${MAX_TOOL_OUTPUT_CHARS} characters]`

const SHELL_TOOL_DEFINITION = {
  type: 'function' as const,
  name: 'shell',
  description:
    'Run a command in the repository root and return its stdout, stderr and exit code. Use this to run `mars` commands and to inspect the repo and its database.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The shell command to run.' } },
    required: ['command'],
    additionalProperties: false,
  },
}

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run one command via `zsh -lc` in `cwd`. Never rejects: a spawn failure or a
 * non-zero exit is reported through `exitCode`/`stderr` so the model can react
 * to it the same way it reacted to CLI tool failures.
 */
export const runShellCommand = (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ShellResult> =>
  new Promise((resolve) => {
    execFile(
      '/bin/zsh',
      ['-lc', command],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0
        resolve({
          stdout: truncate(stdout),
          stderr: truncate(error && stderr.length === 0 ? error.message : stderr),
          exitCode: code,
        })
      },
    )
  })

const isAllowed = (command: string, allowlist: readonly string[] | null): boolean =>
  allowlist === null || allowlist.some((prefix) => command.trim().startsWith(prefix))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ── SSE parsing ───────────────────────────────────────────────────────────────

/**
 * Yield parsed `data:` payloads from an SSE body as they arrive.
 *
 * Incremental by design: the old CLI path streamed JSONL line-by-line into the
 * UI, and buffering the whole response here would have turned a visibly typing
 * assistant into a spinner that produces everything at once.
 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  // Decoded incrementally rather than via TextDecoderStream: `stream: true`
  // holds partial multi-byte sequences across chunk boundaries, and it avoids
  // the DOM `BufferSource` typing mismatch on pipeThrough.
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data) as unknown
          if (isObject(parsed)) yield parsed
        } catch {
          // Ignore malformed SSE payloads rather than failing the whole turn.
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Releasing an already-errored reader throws; nothing to do.
    }
  }
}

// ── Turn execution ────────────────────────────────────────────────────────────

export interface CodexOAuthUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

/**
 * Failure kinds, chosen to map onto the branches the runner's state machine
 * already had for CLI exit codes.
 */
export type CodexOAuthFailureKind = 'no-token' | 'auth' | 'rate-limit' | 'generic'

export type CodexOAuthResult =
  | { ok: true; usage: CodexOAuthUsage }
  | { ok: false; kind: CodexOAuthFailureKind; message: string }

export interface CodexOAuthTurnOptions {
  /** Stable cache prefix — must not contain per-run volatile values. */
  systemPrompt: string
  /** Prior turns, already bounded by `buildProviderHistory`. */
  history: readonly ProviderInputItem[]
  /** The new user message, including any attachment guidance. */
  prompt: string
  /** Working directory for shell tool calls (the repo root). */
  cwd: string
  signal: AbortSignal
  /** Called for every segment as it streams. */
  onSegment: (segment: ChatSegment) => void
  config?: CodexOAuthConfig
  credentials?: CodexCredentials
}

const addUsage = (total: CodexOAuthUsage, raw: unknown): CodexOAuthUsage => {
  if (!isObject(raw)) return total
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const details = isObject(raw.input_tokens_details) ? raw.input_tokens_details : {}
  return {
    inputTokens: total.inputTokens + num(raw.input_tokens),
    outputTokens: total.outputTokens + num(raw.output_tokens),
    cachedInputTokens:
      total.cachedInputTokens + (num(raw.cached_input_tokens) || num(details.cached_tokens)),
  }
}

/**
 * Pull a human-readable message out of an error body.
 *
 * The backend wraps upstream failures twice: the outer body is
 * `{"detail": "<a JSON string>"}` whose payload is itself
 * `{"error":{"message":...}}`. Unwrapping one level would surface a blob of
 * escaped JSON to the logs, so `detail` is re-parsed when it looks like JSON.
 * Its own validation errors (e.g. `{"detail":"Store must be set to false"}`)
 * are plain strings and pass straight through.
 */
const errorMessageFrom = (raw: string, status: number): string => {
  const unwrap = (value: string, depth: number): string | null => {
    try {
      const parsed = JSON.parse(value) as unknown
      if (!isObject(parsed)) return null
      const error = isObject(parsed.error) ? parsed.error : {}
      const direct = nonEmpty(error.message) ?? nonEmpty(parsed.message)
      if (direct) return direct
      const detail = nonEmpty(parsed.detail)
      if (detail === null) return null
      return (depth > 0 ? unwrap(detail, depth - 1) : null) ?? detail
    } catch {
      return null
    }
  }
  return unwrap(raw, 2) ?? `provider request failed with HTTP ${status}`
}

/**
 * Run one chat turn to completion, including any tool round-trips.
 *
 * Segments are emitted through `onSegment` as they stream; the returned value
 * only reports the outcome and accumulated usage. The caller owns persistence
 * and the `result`/`error` terminal segments.
 */
export const runCodexOAuthTurn = async (
  options: CodexOAuthTurnOptions,
): Promise<CodexOAuthResult> => {
  const config = options.config ?? resolveCodexOAuthConfig()
  const credentials = options.credentials ?? (await loadCodexCredentials())
  if (!credentials) {
    return {
      ok: false,
      kind: 'no-token',
      message: 'No Codex credentials found. Run `codex login`, then try again.',
    }
  }

  // One session id for the whole turn, including tool round-trips.
  const sessionId = crypto.randomUUID()
  const input: unknown[] = [
    ...options.history,
    { role: 'user', content: [{ type: 'input_text', text: options.prompt }] },
  ]
  let usage: CodexOAuthUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }

  for (let turn = 0; turn < config.maxToolTurns; turn += 1) {
    if (options.signal.aborted) return { ok: true, usage }

    const body: Record<string, unknown> = {
      model: config.model,
      // Stable prefix → prefix cache hit. Never interpolate volatile data here.
      instructions: options.systemPrompt,
      input,
      stream: true,
      // Mandatory: the backend rejects `store: true` outright.
      store: false,
      tools: [SHELL_TOOL_DEFINITION],
      reasoning: { effort: config.effort },
    }
    // Only needed to keep multi-turn tool calls coherent when reasoning is on;
    // at `effort: none` it would be pure replayed weight.
    if (config.effort !== 'none') body.include = ['reasoning.encrypted_content']

    // Send the turn, retrying transient failures that happen BEFORE any bytes
    // are streamed. A failure mid-stream is deliberately NOT retried: segments
    // have already reached the UI by then, and re-running the turn would emit
    // them twice.
    let stream: ReadableStream<Uint8Array> | null = null
    for (let attempt = 0; stream === null; attempt += 1) {
      if (options.signal.aborted) return { ok: true, usage }
      const canRetry = attempt < TRANSIENT_RETRY_BACKOFF_MS.length
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(config.requestTimeoutMs)])

      let candidate: Response
      try {
        candidate = await fetch(`${config.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'responses=experimental',
            session_id: sessionId,
            ...(credentials.accountId ? { 'chatgpt-account-id': credentials.accountId } : {}),
            Origin: 'https://chatgpt.com',
            Referer: 'https://chatgpt.com/codex',
            'User-Agent': 'Mars chat',
          },
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        // A caller-driven abort (stop button, wall-clock timeout) is not a
        // failure the runner should report as a provider error.
        if (options.signal.aborted) return { ok: true, usage }
        if (canRetry) {
          await sleep(TRANSIENT_RETRY_BACKOFF_MS[attempt] ?? 0)
          continue
        }
        return {
          ok: false,
          kind: 'generic',
          message: error instanceof Error ? error.message : String(error),
        }
      }

      if (candidate.ok) {
        if (!candidate.body) {
          return { ok: false, kind: 'generic', message: 'provider returned an empty response body' }
        }
        stream = candidate.body
        break
      }

      const raw = await candidate.text().catch(() => '')
      const message = errorMessageFrom(raw, candidate.status)
      if (candidate.status === 401 || candidate.status === 403) {
        return { ok: false, kind: 'auth', message }
      }
      if (candidate.status === 429) {
        return { ok: false, kind: 'rate-limit', message }
      }
      if (candidate.status >= 500 && canRetry) {
        await sleep(TRANSIENT_RETRY_BACKOFF_MS[attempt] ?? 0)
        continue
      }
      return { ok: false, kind: 'generic', message }
    }

    // Per-turn stream state.
    const outputItems: Record<string, unknown>[] = []
    let sawTextDelta = false
    let sawCompleted = false
    let reasoningBuffer = ''
    let failureMessage: string | null = null

    try {
      for await (const event of sseEvents(stream)) {
        const type = nonEmpty(event.type)

        if (type === 'response.output_text.delta') {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            sawTextDelta = true
            options.onSegment({ type: 'text', text: event.delta })
          }
        } else if (type === 'response.reasoning_summary_text.delta') {
          if (typeof event.delta === 'string') reasoningBuffer += event.delta
        } else if (type === 'response.output_item.done') {
          if (isObject(event.item)) {
            outputItems.push(event.item)
            // Flush accumulated reasoning as one block per reasoning item, so the
            // UI renders a single collapsible panel rather than one per token.
            if (event.item.type === 'reasoning' && reasoningBuffer.trim().length > 0) {
              options.onSegment({ type: 'thinking', thinking: reasoningBuffer.trim() })
              reasoningBuffer = ''
            }
          }
        } else if (type === 'response.completed') {
          sawCompleted = true
          const completed = isObject(event.response) ? event.response : {}
          usage = addUsage(usage, completed.usage)
        } else if (type === 'response.failed' || type === 'error') {
          const failed = isObject(event.response) ? event.response : event
          const nested = isObject(failed.error) ? failed.error : {}
          failureMessage = nonEmpty(nested.message) ?? nonEmpty(failed.message) ?? 'provider reported a stream failure'
        }
      }
    } catch (error) {
      if (options.signal.aborted) return { ok: true, usage }
      return {
        ok: false,
        kind: 'generic',
        message: error instanceof Error ? error.message : String(error),
      }
    }

    if (failureMessage) {
      const kind: CodexOAuthFailureKind = /rate limit|usage limit|quota/i.test(failureMessage)
        ? 'rate-limit'
        : 'generic'
      return { ok: false, kind, message: failureMessage }
    }
    if (options.signal.aborted) return { ok: true, usage }

    // A stream that ends with nothing usable is a failure, not an empty answer.
    // Reporting it as success would surface the runner's generic "no chat
    // response" error and hide that the turn never actually ran.
    if (!sawCompleted && outputItems.length === 0 && !sawTextDelta) {
      return {
        ok: false,
        kind: 'generic',
        message: 'provider stream ended without producing a response',
      }
    }

    const calls = outputItems.filter((item) => item.type === 'function_call')

    if (calls.length === 0) {
      // No tools requested — this turn produced the final answer. Fall back to
      // message-item text when the delta channel stayed silent.
      if (!sawTextDelta) {
        const text = outputItems
          .filter((item) => item.type === 'message')
          .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
          .map((part) => (isObject(part) ? nonEmpty(part.text) : null))
          .filter((t): t is string => t !== null)
          .join('\n')
        if (text.length > 0) options.onSegment({ type: 'text', text })
      }
      return { ok: true, usage }
    }

    // Replay this turn's items verbatim, then append one output per call.
    input.push(...outputItems)

    for (const call of calls) {
      const callId = nonEmpty(call.call_id) ?? nonEmpty(call.id) ?? ''
      let command = ''
      try {
        const args = JSON.parse(typeof call.arguments === 'string' ? call.arguments : '{}') as unknown
        if (isObject(args)) command = nonEmpty(args.command) ?? ''
      } catch {
        // Unparseable arguments → reported to the model as a tool error below.
      }

      if (command.length === 0) {
        options.onSegment({
          type: 'tool_result',
          tool_use_id: callId,
          content: { stdout: '', stderr: 'shell tool called without a command', exitCode: 1 },
          isError: true,
        })
        input.push({ type: 'function_call_output', call_id: callId, output: 'error: no command provided' })
        continue
      }

      // Emitted with the same shape the CLI parser produced, so the UI's
      // shell-tool rendering and command grouping keep working unchanged.
      options.onSegment({
        type: 'tool_use',
        id: callId,
        name: deriveCommandName(command),
        input: { command, cwd: options.cwd },
      })

      if (!isAllowed(command, config.shellAllowlist)) {
        const refusal = `command not permitted by the MARS_CHAT_SHELL_ALLOWLIST prefix list: ${deriveCommandName(command)}`
        options.onSegment({
          type: 'tool_result',
          tool_use_id: callId,
          content: { stdout: '', stderr: refusal, exitCode: 126 },
          isError: true,
        })
        input.push({ type: 'function_call_output', call_id: callId, output: `error: ${refusal}` })
        continue
      }

      const result = await runShellCommand(command, options.cwd, config.requestTimeoutMs, options.signal)
      options.onSegment({
        type: 'tool_result',
        tool_use_id: callId,
        content: result,
        isError: result.exitCode !== 0,
      })
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: truncate(
          [result.stdout, result.stderr].filter((part) => part.length > 0).join('\n') ||
            `(no output, exit ${result.exitCode})`,
        ),
      })
    }
  }

  return {
    ok: false,
    kind: 'generic',
    message: `stopped after ${config.maxToolTurns} tool turns without a final answer`,
  }
}
