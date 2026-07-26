/**
 * CLI tests for `mars credentials set/list/remove` (slice 11).
 *
 * Covers:
 *   1. `credentials` group → exit 2 with usage
 *   2. `credentials list` with no credentials → "(no credentials configured)"
 *   3. `credentials set <name> <env-var>` → stores credential, prints confirmation
 *   4. `credentials set` missing name → exit 2
 *   5. `credentials set` missing env-var → exit 2
 *   6. `credentials list` shows name, env_var, description, set? columns
 *   7. `credentials list` shows yes/no for set? based on env var presence
 *   8. `credentials set` with --description stores description
 *   9. `credentials set` upsert — updating an existing credential works
 *  10. `credentials remove <name>` removes the credential
 *  11. `credentials remove` with no args → exit 2
 *  12. `credentials remove` unknown name → silent exit 0 (idempotent)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-creds-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadDeps = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const { ensureSchema } = await import('../../../core/lib/pg-schema')
  const { resolveStateClient } = await import('../../../core/store/state-client')
  const client = resolveStateClient()
  await ensureSchema(client)
  const { ensureCredentialSchema } = await import('../../../core/lib/credential-store')
  await ensureCredentialSchema(client)

  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')

  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, opts)
}

const makeFake = async () => {
  const { makeFakeDaemon } = await import('../../test-adapter')
  return makeFakeDaemon()
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Group command — exits 2
// ---------------------------------------------------------------------------

describe('mars credentials — group command', () => {
  it('exits 2 and mentions subcommands on stderr', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['credentials'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    const errText = r.err.join('\n')
    expect(errText).toContain('set')
    expect(errText).toContain('list')
    expect(errText).toContain('remove')
  })
})

// ---------------------------------------------------------------------------
// 2. credentials list — empty table
// ---------------------------------------------------------------------------

describe('mars credentials list — empty table', () => {
  it('prints "(no credentials configured)"', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['credentials', 'list'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('no credentials configured')
  })
})

// ---------------------------------------------------------------------------
// 3. credentials set — happy path
// ---------------------------------------------------------------------------

describe('mars credentials set — happy path', () => {
  it('stores the credential and prints confirmation', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['credentials', 'set', 'github-token', 'GITHUB_TOKEN'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('github-token')
    expect(r.out.join('\n')).toContain('GITHUB_TOKEN')
  })
})

// ---------------------------------------------------------------------------
// 4. credentials set — missing name
// ---------------------------------------------------------------------------

describe('mars credentials set — missing name', () => {
  it('exits 2 with usage error', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['credentials', 'set'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    expect(r.err.join('\n').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 5. credentials set — missing env-var
// ---------------------------------------------------------------------------

describe('mars credentials set — missing env-var', () => {
  it('exits 2 with usage error', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['credentials', 'set', 'github-token'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    expect(r.err.join('\n').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 6. credentials list — shows expected columns
// ---------------------------------------------------------------------------

describe('mars credentials list — header columns', () => {
  it('prints header with name, env_var, description, set? columns', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['credentials', 'set', 'github-token', 'GITHUB_TOKEN'],
      { store, ctx, daemon },
    )

    const r = await run(['credentials', 'list'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('name')
    expect(out).toContain('env_var')
    expect(out).toContain('description')
    expect(out).toContain('set?')
    expect(out).toContain('github-token')
    expect(out).toContain('GITHUB_TOKEN')
  })
})

// ---------------------------------------------------------------------------
// 7. credentials list — set? column reflects env var presence
// ---------------------------------------------------------------------------

describe('mars credentials list — set? column', () => {
  it('shows "yes" when the env var is set and "no" when it is not', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['credentials', 'set', 'token-set', 'TEST_CRED_SET_VAR'],
      { store, ctx, daemon },
    )
    await run(
      ['credentials', 'set', 'token-unset', 'TEST_CRED_UNSET_VAR'],
      { store, ctx, daemon },
    )

    // Set the env var for one credential
    process.env.TEST_CRED_SET_VAR = 'secret-value'
    delete process.env.TEST_CRED_UNSET_VAR

    const r = await run(['credentials', 'list'], { store, ctx, daemon })

    delete process.env.TEST_CRED_SET_VAR

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('yes')
    expect(out).toContain('no')
  })
})

// ---------------------------------------------------------------------------
// 8. credentials set — with --description
// ---------------------------------------------------------------------------

describe('mars credentials set — with --description', () => {
  it('stores the description and shows it in the list', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['credentials', 'set', 'github-token', 'GITHUB_TOKEN', '--description', 'GitHub API token'],
      { store, ctx, daemon },
    )

    const r = await run(['credentials', 'list'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('GitHub API token')
  })
})

// ---------------------------------------------------------------------------
// 9. credentials set — upsert overwrites existing
// ---------------------------------------------------------------------------

describe('mars credentials set — upsert', () => {
  it('updates the env var when set again with the same name', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['credentials', 'set', 'github-token', 'OLD_ENV_VAR'],
      { store, ctx, daemon },
    )

    const r2 = await run(
      ['credentials', 'set', 'github-token', 'NEW_ENV_VAR'],
      { store, ctx, daemon },
    )
    expect(r2.code).toBe(0)

    const listR = await run(['credentials', 'list'], { store, ctx, daemon })
    const out = listR.out.join('\n')
    expect(out).toContain('NEW_ENV_VAR')
    expect(out).not.toContain('OLD_ENV_VAR')
  })
})

// ---------------------------------------------------------------------------
// 10. credentials remove — removes the credential
// ---------------------------------------------------------------------------

describe('mars credentials remove — happy path', () => {
  it('removes the credential and exits 0', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['credentials', 'set', 'github-token', 'GITHUB_TOKEN'],
      { store, ctx, daemon },
    )

    const removeR = await run(['credentials', 'remove', 'github-token'], { store, ctx, daemon })
    expect(removeR.code).toBe(0)

    const listR = await run(['credentials', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('no credentials configured')
  })
})

// ---------------------------------------------------------------------------
// 11. credentials remove — no args
// ---------------------------------------------------------------------------

describe('mars credentials remove — no args', () => {
  it('exits 2 with usage error', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['credentials', 'remove'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    expect(r.err.join('\n').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 12. credentials remove — unknown name (idempotent)
// ---------------------------------------------------------------------------

describe('mars credentials remove — unknown name', () => {
  it('exits 0 silently when the name does not exist', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['credentials', 'remove', 'nonexistent'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    expect(r.err).toHaveLength(0)
  })
})
