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

import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── Endpoint + OAuth constants ────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** OAuth client id of the Codex CLI's ChatGPT app — required for token refresh. */
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

// ── Env-driven config ─────────────────────────────────────────────────────────

const _env = (key: string): string | undefined => {
  const raw = process.env[key]
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined
}

const _numericEnv = (key: string, fallback: number): number => {
  const raw = _env(key)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Resolved chat-connector tunables. Env-driven so operators can tune without a rebuild. */
export interface CodexOAuthConfig {
  /** Base URL for Codex API requests (the `/responses` suffix is appended internally). */
  baseUrl: string
  /** Model identifier forwarded to the Responses API. */
  model: string
  /** Reasoning effort passed to the API (`'high'` by default — the current hardcoded value). */
  effort: string
  /** Upper bound on model↔tool round-trips within one chat turn. */
  maxToolTurns: number
  /** Per-run wall-clock timeout in milliseconds. */
  requestTimeoutMs: number
}

/**
 * Resolve chat-connector tunables from env, falling back to the current
 * hardcoded defaults so behaviour is unchanged when no vars are set.
 *
 * | Env var                       | Default                             |
 * |-------------------------------|-------------------------------------|
 * | MARS_CODEX_BASE_URL           | https://chatgpt.com/backend-api/codex |
 * | MARS_CHAT_MODEL               | gpt-5.5                             |
 * | MARS_CHAT_EFFORT              | high                                |
 * | MARS_CHAT_MAX_TOOL_TURNS      | 40                                  |
 * | MARS_CHAT_REQUEST_TIMEOUT_MS  | 600_000 (10 min)                    |
 */
export const resolveCodexOAuthConfig = (): CodexOAuthConfig => ({
  baseUrl: (_env('MARS_CODEX_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
  model: _env('MARS_CHAT_MODEL') ?? 'gpt-5.5',
  effort: _env('MARS_CHAT_EFFORT') ?? 'high',
  maxToolTurns: _numericEnv('MARS_CHAT_MAX_TOOL_TURNS', 40),
  requestTimeoutMs: _numericEnv('MARS_CHAT_REQUEST_TIMEOUT_MS', 10 * 60 * 1000),
})

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
  /** Stable request identity lets the provider reuse the Main-session prefix. */
  requestIdentity?: string
  signal: AbortSignal
  /** Invoked once per parsed SSE event, in stream order. */
  onEvent: (event: unknown) => void
}

// ── Auth file ─────────────────────────────────────────────────────────────────

export const resolveCodexAuthFilePath = (
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string => {
  const codexHome = env.CODEX_HOME
  return join(
    typeof codexHome === 'string' && codexHome.length > 0
      ? codexHome
      : join(homeDir, '.codex'),
    'auth.json',
  )
}

/**
 * Recover `chatgpt_account_id` from the access token's own claims.
 *
 * `auth.json` does not always carry a top-level `tokens.account_id` — the id is
 * always present in the JWT payload, so a missing field is not a broken login
 * and must not force the user through `codex login` again.
 */
const decodeAccountId = (token: string): string | null => {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const payload = JSON.parse(json) as unknown
    if (typeof payload !== 'object' || payload === null) return null
    const auth = (payload as Record<string, unknown>)['https://api.openai.com/auth']
    if (typeof auth !== 'object' || auth === null) return null
    const id = (auth as Record<string, unknown>).chatgpt_account_id
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null
  } catch {
    return null
  }
}

/**
 * Load the OAuth credentials the Codex CLI persisted via `codex login`.
 * Throws `CodexApiError('auth')` when the file is missing or incomplete so
 * callers route straight to the re-authenticate path.
 */
export const loadCodexAuth = async (): Promise<CodexAuth> => {
  let raw: string
  try {
    raw = await readFile(resolveCodexAuthFilePath(), 'utf8')
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
  if (!accessToken) {
    throw new CodexApiError('auth', 'Codex credentials are incomplete — run `codex login`.')
  }
  const accountId =
    (typeof tokens?.account_id === 'string' ? tokens.account_id : null) ?? decodeAccountId(accessToken)
  if (!accountId) {
    throw new CodexApiError('auth', 'Codex credentials are incomplete — run `codex login`.')
  }
  return {
    accessToken,
    accountId,
    refreshToken: typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : null,
  }
}

/**
 * Exchange the stored refresh token for a fresh access token, persist the
 * rotated credentials back to `auth.json` atomically, and return the refreshed
 * `CodexAuth` for the current process.
 *
 * Persistence rules (ADR-0088, operator decision — option a):
 *
 *   1. **Atomic write**: credentials are written to a temp file in the same
 *      directory, then `rename()`d over `auth.json` so a crash or concurrent
 *      `codex` CLI refresh can never observe a half-written file.
 *   2. **Only server-issued refresh tokens are persisted**: when the OAuth
 *      response omits `refresh_token`, the in-memory fallback (`auth.refreshToken`)
 *      is still used for this process, but the on-disk `refresh_token` is left
 *      exactly as it was.
 *   3. **Best-effort**: a failed write (unwritable path, full disk, …) is
 *      silently swallowed — the in-memory tokens remain valid for the run.
 *
 * Throws `CodexApiError('auth')` when the token exchange itself fails — the
 * user must run `codex login` again.
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
  const body = (await res.json()) as { access_token?: string; refresh_token?: string }
  if (typeof body.access_token !== 'string') {
    throw new CodexApiError('auth', 'Codex token refresh returned no access token — run `codex login`.')
  }

  // The server-issued refresh token, or null if the server did not return one.
  const serverRefreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null

  const refreshed: CodexAuth = {
    accessToken: body.access_token,
    accountId: auth.accountId,
    // In-memory: fall back to the existing token so the process stays authenticated.
    refreshToken: serverRefreshToken ?? auth.refreshToken,
  }

  // Best-effort atomic persistence — an unwritable auth.json only costs a refresh next run.
  try {
    const path = resolveCodexAuthFilePath()
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { tokens?: Record<string, unknown> }
    onDisk.tokens = {
      ...onDisk.tokens,
      access_token: refreshed.accessToken,
      // Only update refresh_token when the server explicitly issued a new one.
      ...(serverRefreshToken !== null ? { refresh_token: serverRefreshToken } : {}),
    }
    ;(onDisk as Record<string, unknown>).last_refresh = new Date().toISOString()
    const tmp = join(dirname(path), `.auth-tmp-${randomUUID()}.json`)
    await writeFile(tmp, JSON.stringify(onDisk, null, 2))
    await rename(tmp, path)
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
  const { baseUrl, effort } = resolveCodexOAuthConfig()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.auth.accessToken}`,
        'chatgpt-account-id': opts.auth.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        session_id: opts.requestIdentity ?? randomUUID(),
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
        reasoning: { effort, summary: 'auto' },
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
