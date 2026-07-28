/**
 * codex-api — credential loading.
 *
 * Covers the `account_id` recovery path: `auth.json` does not always carry a
 * top-level `tokens.account_id`, but the id is always present in the access
 * token's own claims. A missing field is not a broken login and must not force
 * the user back through `codex login`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCodexAuth, CodexApiError } from '../codex-api'

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
