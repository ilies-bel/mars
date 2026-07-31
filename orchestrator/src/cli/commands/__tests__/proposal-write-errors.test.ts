/**
 * Proposal write commands must make database failures observable to shell
 * callers.  The failure case starts the actual CLI against a refused
 * PostgreSQL endpoint, rather than mocking the command or its error path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-write-errors-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(join(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const { initProposals } = await import('../../../core/proposals')
  await initProposals()
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

describe('proposal write commands', () => {
  it('dismisses a draft proposal and reports the dismissed status through the CLI', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const { createProposal } = await import('../../../core/proposals')
    const { makeFakeDaemon } = await import('../../test-adapter')
    const proposal = await createProposal('Dismiss through the CLI')
    const opts = { store, ctx, daemon: makeFakeDaemon() }

    const dismissed = await run(['proposal', 'dismiss', proposal.id], opts)
    const shown = await run(['proposal', 'show', proposal.id], opts)

    expect(dismissed.code).toBe(0)
    expect(dismissed.out).toEqual([`dismissed ${proposal.id}`])
    expect(dismissed.err).toEqual([
      expect.stringContaining(`proposal ${proposal.id} dismissed;`),
    ])
    expect(shown.code).toBe(0)
    expect(shown.out).toContain('status:     dismissed')
  })

  it('refuses to write the retired rejected proposal status', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const { createProposal } = await import('../../../core/proposals')
    const { makeFakeDaemon } = await import('../../test-adapter')
    const proposal = await createProposal('Reject status is retired')

    const result = await run(
      ['proposal', 'set', proposal.id, 'status', 'rejected'],
      { store, ctx, daemon: makeFakeDaemon() },
    )

    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err.join('\n')).toMatch(/invalid proposal status.*rejected/i)
  })

  it('does not keep proposal reject as an alias for dismiss', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const { makeFakeDaemon } = await import('../../test-adapter')

    const result = await run(
      ['proposal', 'reject', 'any-id'],
      { store, ctx, daemon: makeFakeDaemon() },
    )

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toMatch(/Lifecycle:.*dismiss/i)
    expect(result.err.join('\n')).not.toMatch(/\breject\b/i)
  })

  it('reports a successful field update to stdout with exit code 0', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const { createProposal } = await import('../../../core/proposals')
    const { makeFakeDaemon } = await import('../../test-adapter')
    const proposal = await createProposal('Write error regression')

    const result = await run(
      ['proposal', 'set', proposal.id, 'notes', 'saved'],
      { store, ctx, daemon: makeFakeDaemon() },
    )

    expect(result.code).toBe(0)
    expect(result.out).toEqual([`updated ${proposal.id}`])
    expect(result.err).toEqual([])
  })

  it.each([
    ['proposal set', ['proposal', 'set', 'draft-id', 'notes', 'x']],
    ['proposal add-user-story', ['proposal', 'add-user-story', 'draft-id', 'As a user I can save']],
  ])('%s exits non-zero and sends a database error to stderr', (_name, args) => {
    // The production CLI must use the real database boundary here. Port 1 is
    // deliberately refused, which deterministically makes schema bootstrap
    // fail before either write can report success.
    writeFileSync(join(repo, '.mars', 'pg.dsn'), 'postgres://127.0.0.1:1/mars')
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: resolve(import.meta.dirname, '../../../..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        MARS_REPO: repo,
        MARS_DB_BACKEND: 'embedded',
        MARS_REFLECT_DISABLED: '1',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/ECONNREFUSED|connect/i)
  })
})
