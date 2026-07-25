/**
 * codex-api — direct client for the ChatGPT-backend Codex Responses endpoint.
 *
 * Replaces the `codex exec` CLI subprocess for chat: the daemon authenticates
 * with the OAuth token the Codex CLI stores in `${CODEX_HOME:-~/.codex}/auth.json`
 * (written by `codex login`), sends Responses-API-shaped requests with its own
 * `instructions` and function tools, and parses the SSE stream. Nothing of the
 * Codex CLI harness (base prompt, AGENTS.md discovery, sandbox shell) reaches
 * the context window — the caller owns every input item.
 *
 * The endpoint is unofficial (it is what the Codex CLI itself calls), so all
 * request framing lives here behind one seam: headers, SSE parsing, error
 * classification, and token refresh. Callers see typed events and
 * `CodexApiError` kinds, never HTTP details.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── Endpoint + OAuth constants ────────────────────────────────────────────────

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** OAuth client id of the Codex CLI's ChatGPT app — required for token refresh. */
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CodexAuth {
  accessToken: string
  accountId: string
  refreshToken: string | null
}

export type CodexApiErrorKind = 'auth' | 'rate-limit' | 'http' | 'network'

/** Typed failure from the Codex endpoint. `message` is safe to log (no tokens). */
export class CodexApiError extends Error {
  constructor(
    readonly kind: CodexApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CodexApiError'
  }
}

/** One item of Responses-API conversation input, replayed verbatim each turn. */
export type ResponseInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: Array<{ type: 'input_text' | 'output_text'; text: string }> }
  | { type: 'function_call'; name: string; arguments: string; call_id: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export interface FunctionToolDef {
  type: 'function'
  name: string
  description: string
  strict: boolean
  parameters: Record<string, unknown>
}

export interface StreamCodexResponseOpts {
  auth: CodexAuth
  model: string
  instructions: string
  input: readonly ResponseInputItem[]
  tools: readonly FunctionToolDef[]
  signal: AbortSignal
  /** Invoked once per parsed SSE event, in stream order. */
  onEvent: (event: unknown) => void
}

// ── Auth file ─────────────────────────────────────────────────────────────────

const authFilePath = (): string =>
  join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')

/**
 * Load the OAuth credentials the Codex CLI persisted via `codex login`.
 * Throws `CodexApiError('auth')` when the file is missing or incomplete so
 * callers route straight to the re-authenticate path.
 */
export const loadCodexAuth = async (): Promise<CodexAuth> => {
  let raw: string
  try {
    raw = await readFile(authFilePath(), 'utf8')
  } catch {
    throw new CodexApiError('auth', 'Codex credentials not found — run `codex login`.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CodexApiError('auth', 'Codex credentials are unreadable — run `codex login`.')
  }
  const tokens = (parsed as { tokens?: Record<string, unknown> }).tokens
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : null
  const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : null
  if (!accessToken || !accountId) {
    throw new CodexApiError('auth', 'Codex credentials are incomplete — run `codex login`.')
  }
  return {
    accessToken,
    accountId,
    refreshToken: typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : null,
  }
}

/**
 * Exchange the stored refresh token for a fresh access token and persist the
 * rotated credentials back to `auth.json` (so the Codex CLI and future daemon
 * runs both see them). Throws `CodexApiError('auth')` when refresh fails —
 * the user must `codex login` again.
 */
export const refreshCodexAuth = async (auth: CodexAuth): Promise<CodexAuth> => {
  if (!auth.refreshToken) {
    throw new CodexApiError('auth', 'No Codex refresh token available — run `codex login`.')
  }
  let res: Response
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
        scope: 'openid profile email',
      }),
    })
  } catch {
    throw new CodexApiError('network', 'Could not reach the OpenAI auth service.')
  }
  if (!res.ok) {
    throw new CodexApiError('auth', 'Codex token refresh was rejected — run `codex login`.', res.status)
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string }
  if (typeof body.access_token !== 'string') {
    throw new CodexApiError('auth', 'Codex token refresh returned no access token — run `codex login`.')
  }
  const refreshed: CodexAuth = {
    accessToken: body.access_token,
    accountId: auth.accountId,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : auth.refreshToken,
  }
  // Best-effort persistence — an unwritable auth.json only costs a refresh next run.
  try {
    const path = authFilePath()
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { tokens?: Record<string, unknown> }
    onDisk.tokens = {
      ...onDisk.tokens,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      ...(typeof body.id_token === 'string' ? { id_token: body.id_token } : {}),
    }
    ;(onDisk as Record<string, unknown>).last_refresh = new Date().toISOString()
    await writeFile(path, JSON.stringify(onDisk, null, 2))
  } catch {
    // ignore — the in-memory tokens are still valid for this run
  }
  return refreshed
}

// ── Streaming request ─────────────────────────────────────────────────────────

/** Patterns in a `response.failed` error that indicate a quota/rate condition. */
const RATE_LIMIT_RE = /(rate.?limit|usage.?limit|quota|too many requests)/i

/**
 * POST one Responses request and feed every parsed SSE event to `onEvent`.
 * Resolves when the stream ends; throws `CodexApiError` on HTTP or in-stream
 * failure. Abort surfaces as the fetch AbortError (not a CodexApiError) so
 * callers can distinguish user stops from provider failures.
 */
export const streamCodexResponse = async (opts: StreamCodexResponseOpts): Promise<void> => {
  let res: Response
  try {
    res = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.auth.accessToken}`,
        'chatgpt-account-id': opts.auth.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        session_id: randomUUID(),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: opts.model,
        instructions: opts.instructions,
        input: opts.input,
        tools: opts.tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'high', summary: 'auto' },
        store: false,
        stream: true,
        include: [],
      }),
      signal: opts.signal,
    })
  } catch (err) {
    if (opts.signal.aborted) throw err
    throw new CodexApiError('network', 'Could not reach the Codex service.')
  }

  if (!res.ok) {
    // Drain the error body for classification but never surface it verbatim —
    // it can echo request details. Classify by status first, body second.
    const bodyText = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new CodexApiError('auth', 'Codex rejected the stored credentials.', res.status)
    }
    if (res.status === 429 || RATE_LIMIT_RE.test(bodyText)) {
      throw new CodexApiError('rate-limit', 'Codex rate/usage limit reached.', res.status)
    }
    throw new CodexApiError('http', `Codex request failed (HTTP ${res.status}).`, res.status)
  }
  if (!res.body) {
    throw new CodexApiError('http', 'Codex returned no response stream.', res.status)
  }

  let failure: CodexApiError | null = null
  const decoder = new TextDecoder()
  let buf = ''
  const handleLine = (line: string): void => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') return
    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }
    const type = (event as { type?: unknown }).type
    if (type === 'response.failed' || type === 'error') {
      const detail = JSON.stringify(event)
      failure = RATE_LIMIT_RE.test(detail)
        ? new CodexApiError('rate-limit', 'Codex rate/usage limit reached.')
        : new CodexApiError('http', 'Codex reported a response failure.')
      return
    }
    opts.onEvent(event)
  }

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, idx).trim())
      buf = buf.slice(idx + 1)
    }
  }
  handleLine(buf.trim())

  if (failure) throw failure
}
