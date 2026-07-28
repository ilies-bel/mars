/**
 * codex-api — credential loading and refresh behaviour.
 *
 * Covers:
 *  1. The `account_id` recovery path: `auth.json` does not always carry a
 *     top-level `tokens.account_id`, but the id is always present in the
 *     access token's own claims. A missing field is not a broken login and
 *     must not force the user back through `codex login`.
 *  2. That `refreshCodexAuth` never writes back to `auth.json` (ADR-0087).
 *     The daemon refreshes in-memory for the process lifetime only, leaving
 *     the file the user's own `codex` CLI owns untouched to avoid a race that
 *     would corrupt their login.
 *  3. That `resolveCodexOAuthConfig` reads the chat connector tunables from
 *     the environment, falling back to the documented defaults when unset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadCodexAuth,
  refreshCodexAuth,
  resolveCodexOAuthConfig,
  CodexApiError,
} from '../codex-api'

/** Build a JWT whose payload carries the OpenAI auth claim. */
const tokenWithAccountId = (accountId: string): string => {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codex-auth-'))
  vi.stubEnv('CODEX_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

const writeAuth = (tokens: Record<string, unknown>): Promise<void> =>
  writeFile(join(home, 'auth.json'), JSON.stringify({ tokens }))

describe('resolveCodexOAuthConfig', () => {
  it('returns defaults when no relevant env vars are set', () => {
    const cfg = resolveCodexOAuthConfig()
    expect(cfg.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
    expect(cfg.model).toBe('gpt-5.5')
    expect(cfg.effort).toBe('high')
    expect(cfg.maxToolTurns).toBe(40)
    expect(cfg.requestTimeoutMs).toBe(10 * 60 * 1000)
  })

  it('uses MARS_CHAT_MODEL when set', () => {
    vi.stubEnv('MARS_CHAT_MODEL', 'gpt-6')
    expect(resolveCodexOAuthConfig().model).toBe('gpt-6')
  })

  it('uses MARS_CHAT_EFFORT when set', () => {
    vi.stubEnv('MARS_CHAT_EFFORT', 'low')
    expect(resolveCodexOAuthConfig().effort).toBe('low')
  })

  it('uses MARS_CODEX_BASE_URL when set, stripping a trailing slash', () => {
    vi.stubEnv('MARS_CODEX_BASE_URL', 'https://custom.example.com/api/')
    expect(resolveCodexOAuthConfig().baseUrl).toBe('https://custom.example.com/api')
  })

  it('uses MARS_CHAT_MAX_TOOL_TURNS when set to a positive integer', () => {
    vi.stubEnv('MARS_CHAT_MAX_TOOL_TURNS', '20')
    expect(resolveCodexOAuthConfig().maxToolTurns).toBe(20)
  })

  it('uses MARS_CHAT_REQUEST_TIMEOUT_MS when set to a positive integer', () => {
    vi.stubEnv('MARS_CHAT_REQUEST_TIMEOUT_MS', '30000')
    expect(resolveCodexOAuthConfig().requestTimeoutMs).toBe(30000)
  })

  it('falls back to the default when MARS_CHAT_MAX_TOOL_TURNS is not a number', () => {
    vi.stubEnv('MARS_CHAT_MAX_TOOL_TURNS', 'not-a-number')
    expect(resolveCodexOAuthConfig().maxToolTurns).toBe(40)
  })

  it('falls back to the default when MARS_CHAT_REQUEST_TIMEOUT_MS is zero or negative', () => {
    vi.stubEnv('MARS_CHAT_REQUEST_TIMEOUT_MS', '0')
    expect(resolveCodexOAuthConfig().requestTimeoutMs).toBe(10 * 60 * 1000)
  })
})

describe('loadCodexAuth', () => {
  it('uses the explicit account_id when auth.json provides one', async () => {
    await writeAuth({ access_token: tokenWithAccountId('from-jwt'), account_id: 'explicit' })

    const auth = await loadCodexAuth()

    expect(auth.accountId).toBe('explicit')
    expect(auth.accessToken).toContain('header.')
  })

  it('recovers account_id from the token claims when auth.json omits it', async () => {
    await writeAuth({ access_token: tokenWithAccountId('acct-from-claims') })

    const auth = await loadCodexAuth()

    expect(auth.accountId).toBe('acct-from-claims')
  })

  it('carries the refresh token through when present', async () => {
    await writeAuth({ access_token: tokenWithAccountId('a'), refresh_token: 'refresh-me' })

    const auth = await loadCodexAuth()

    expect(auth.refreshToken).toBe('refresh-me')
  })

  it('reports null refreshToken when auth.json has no refresh token', async () => {
    await writeAuth({ access_token: tokenWithAccountId('a') })

    const auth = await loadCodexAuth()

    expect(auth.refreshToken).toBeNull()
  })

  it('throws an auth error when the access token is missing', async () => {
    await writeAuth({ account_id: 'acct' })

    await expect(loadCodexAuth()).rejects.toThrow(CodexApiError)
  })

  it('throws an auth error when no account id can be recovered', async () => {
    // A well-formed token whose claims carry no chatgpt_account_id.
    const opaque = `header.${Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')}.sig`
    await writeAuth({ access_token: opaque })

    await expect(loadCodexAuth()).rejects.toThrow(/credentials are incomplete/i)
  })

  it('throws an auth error when auth.json is absent', async () => {
    await expect(loadCodexAuth()).rejects.toThrow(/credentials not found/i)
  })
})

describe('refreshCodexAuth', () => {
  it('returns refreshed credentials from the OAuth response without modifying auth.json', async () => {
    // Arrange: write initial auth.json with a refresh token
    const originalTokens = {
      access_token: tokenWithAccountId('acct-original'),
      account_id: 'acct-original',
      refresh_token: 'rt-original',
    }
    await writeAuth(originalTokens)
    const originalOnDisk = await readFile(join(home, 'auth.json'), 'utf8')

    // Simulate the OAuth token endpoint returning a new access token
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: tokenWithAccountId('acct-original'),
          refresh_token: 'rt-rotated',
          id_token: 'id-new',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const staleAuth = await loadCodexAuth()

    // Act
    const refreshed = await refreshCodexAuth(staleAuth)

    // Assert: in-memory result is the new token
    expect(refreshed.accessToken).toBe(tokenWithAccountId('acct-original'))
    expect(refreshed.refreshToken).toBe('rt-rotated')
    expect(refreshed.accountId).toBe('acct-original')

    // Assert: auth.json on disk is UNCHANGED (the daemon must not touch it)
    const afterOnDisk = await readFile(join(home, 'auth.json'), 'utf8')
    expect(afterOnDisk).toBe(originalOnDisk)

    fetchSpy.mockRestore()
  })

  it('throws an auth error when no refresh token is available', async () => {
    await writeAuth({ access_token: tokenWithAccountId('a'), account_id: 'a' })
    const auth = await loadCodexAuth()

    await expect(refreshCodexAuth(auth)).rejects.toThrow(/no codex refresh token/i)
  })

  it('throws an auth error when the OAuth server rejects the refresh', async () => {
    await writeAuth({ access_token: tokenWithAccountId('a'), account_id: 'a', refresh_token: 'rt-bad' })
    const auth = await loadCodexAuth()

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    )

    await expect(refreshCodexAuth(auth)).rejects.toThrow(/codex token refresh was rejected/i)
    vi.restoreAllMocks()
  })
})
