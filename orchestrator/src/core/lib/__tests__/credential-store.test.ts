/**
 * Tests for credential-store.ts — the env-var-based credential registry.
 *
 * Covers:
 * - ensureCredentialSchema: creates the table idempotently
 * - setCredential: inserts a new credential and upserts an existing one
 * - removeCredential: deletes by name; silently ignores missing names
 * - listCredentials: returns all rows ordered by name
 * - resolveCredentialEnv: maps credential names to live env-var values
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../db.js'

let repo: string
let client: DbClient
let dbModule: typeof import('../db.js')

beforeEach(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-cred-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo

  dbModule = await import('../db.js')
  client = dbModule.openDb(resolve(repo, '.mars'))
})

afterEach(async () => {
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('ensureCredentialSchema', () => {
  it('creates the credentials table idempotently', async () => {
    const { ensureCredentialSchema } = await import('../credential-store.js')
    await ensureCredentialSchema(client)
    // Second call must not throw (IF NOT EXISTS)
    await expect(ensureCredentialSchema(client)).resolves.toBeUndefined()
    // Table is queryable
    const r = await client.execute(`SELECT COUNT(*) AS cnt FROM credentials`)
    expect(r.rows[0]).toMatchObject({ cnt: 0 })
  })
})

describe('setCredential', () => {
  it('inserts a credential with all fields', async () => {
    const { ensureCredentialSchema, setCredential, listCredentials } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await setCredential('SSO_TOKEN', 'MY_SSO_TOKEN_ENV', 'SSO login token')

    const creds = await listCredentials()
    expect(creds).toHaveLength(1)
    expect(creds[0]).toMatchObject({
      name: 'SSO_TOKEN',
      envVar: 'MY_SSO_TOKEN_ENV',
      description: 'SSO login token',
    })
    expect(typeof creds[0].createdAt).toBe('string')
    expect(creds[0].createdAt.length).toBeGreaterThan(0)
  })

  it('defaults description to empty string when omitted', async () => {
    const { ensureCredentialSchema, setCredential, listCredentials } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await setCredential('API_KEY', 'MY_API_KEY')

    const creds = await listCredentials()
    expect(creds[0].description).toBe('')
  })

  it('upserts: updates an existing credential with the same name', async () => {
    const { ensureCredentialSchema, setCredential, listCredentials } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await setCredential('TOKEN', 'OLD_VAR', 'old description')
    await setCredential('TOKEN', 'NEW_VAR', 'new description')

    const creds = await listCredentials()
    expect(creds).toHaveLength(1)
    expect(creds[0]).toMatchObject({
      name: 'TOKEN',
      envVar: 'NEW_VAR',
      description: 'new description',
    })
  })
})

describe('removeCredential', () => {
  it('deletes a credential by name', async () => {
    const { ensureCredentialSchema, setCredential, removeCredential, listCredentials } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await setCredential('SSO_TOKEN', 'MY_SSO_TOKEN_ENV')
    await removeCredential('SSO_TOKEN')

    const creds = await listCredentials()
    expect(creds).toHaveLength(0)
  })

  it('silently does nothing when the credential does not exist', async () => {
    const { ensureCredentialSchema, removeCredential, listCredentials } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await expect(removeCredential('NON_EXISTENT')).resolves.toBeUndefined()
    expect(await listCredentials()).toHaveLength(0)
  })
})

describe('listCredentials', () => {
  it('returns an empty array when no credentials exist', async () => {
    const { ensureCredentialSchema, listCredentials } = await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await expect(listCredentials()).resolves.toEqual([])
  })

  it('returns credentials ordered by name', async () => {
    const { ensureCredentialSchema, setCredential, listCredentials } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await setCredential('ZEBRA_TOKEN', 'ZEBRA_ENV')
    await setCredential('ALPHA_TOKEN', 'ALPHA_ENV')
    await setCredential('MIKE_TOKEN', 'MIKE_ENV')

    const creds = await listCredentials()
    expect(creds).toHaveLength(3)
    expect(creds[0].name).toBe('ALPHA_TOKEN')
    expect(creds[1].name).toBe('MIKE_TOKEN')
    expect(creds[2].name).toBe('ZEBRA_TOKEN')
  })
})

describe('resolveCredentialEnv', () => {
  it('returns an empty map when no credentials are stored', async () => {
    const { ensureCredentialSchema, resolveCredentialEnv } = await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await expect(resolveCredentialEnv()).resolves.toEqual({})
  })

  it('maps credential name to env-var value for set variables', async () => {
    const { ensureCredentialSchema, setCredential, resolveCredentialEnv } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await setCredential('SSO_TOKEN', 'MY_SSO_TOKEN_ENV')
    process.env.MY_SSO_TOKEN_ENV = 'secret-value-123'
    try {
      const env = await resolveCredentialEnv()
      expect(env).toEqual({ SSO_TOKEN: 'secret-value-123' })
    } finally {
      delete process.env.MY_SSO_TOKEN_ENV
    }
  })

  it('skips credentials whose env var is not set', async () => {
    const { ensureCredentialSchema, setCredential, resolveCredentialEnv } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await setCredential('PRESENT', 'MY_PRESENT_VAR')
    await setCredential('ABSENT', 'MY_ABSENT_VAR')
    process.env.MY_PRESENT_VAR = 'present-value'
    // MY_ABSENT_VAR is intentionally not set
    try {
      const env = await resolveCredentialEnv()
      expect(env).toEqual({ PRESENT: 'present-value' })
      expect('ABSENT' in env).toBe(false)
    } finally {
      delete process.env.MY_PRESENT_VAR
    }
  })

  it('returns all credentials when all env vars are set', async () => {
    const { ensureCredentialSchema, setCredential, resolveCredentialEnv } =
      await import('../credential-store.js')
    await ensureCredentialSchema(client)

    await setCredential('CRED_A', 'MY_VAR_A')
    await setCredential('CRED_B', 'MY_VAR_B')
    process.env.MY_VAR_A = 'value-a'
    process.env.MY_VAR_B = 'value-b'
    try {
      const env = await resolveCredentialEnv()
      expect(env).toEqual({ CRED_A: 'value-a', CRED_B: 'value-b' })
    } finally {
      delete process.env.MY_VAR_A
      delete process.env.MY_VAR_B
    }
  })
})
