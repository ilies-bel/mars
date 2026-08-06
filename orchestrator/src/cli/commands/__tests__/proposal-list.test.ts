/**
 * Tests for `mars proposal list` robustness with legacy DB statuses.
 *
 * The writer/reader split: the DB may contain rows with status values that the
 * current TypeScript enum doesn't recognise ('promoted', 'superseded', 'done').
 * An unknown status must not crash the whole listing — it degrades to rendering
 * the raw string value rather than throwing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-list-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadEnv = async () => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const proposals = await import('../../../core/proposals')
  await proposals.initProposals()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  const stateClientModule = await import('../../../core/store/state-client')
  const { runCommandInProcess, makeFakeDaemon } = await import('../../test-adapter')
  return {
    proposals,
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
    db: stateClientModule.resolveStateClient(),
    run: async (argv: readonly string[]) => {
      const opts: InProcessOptions = {
        store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
        ctx: contextModule.resolveContext(repo),
        daemon: makeFakeDaemon(),
      }
      return runCommandInProcess(argv, opts)
    },
  }
}

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('mars proposal list with legacy statuses', () => {
  it('returns a listing that includes a row with an unrecognised status', async () => {
    const { proposals, db, run } = await loadEnv()

    const known = await proposals.createProposal('Known draft')
    const legacy = await proposals.createProposal('Legacy proposal')

    // Bypass the validated write path to simulate a legacy status in the DB.
    await db.execute({
      sql: `UPDATE proposals SET status = 'promoted' WHERE id = ?`,
      args: [legacy.id],
    })

    const result = await run(['proposal', 'list'])

    expect(result.code).toBe(0)
    // Both proposals must be present — the listing must not throw.
    const knownLine = result.out.find((l) => l.includes(known.id.slice(0, 8)))
    const legacyLine = result.out.find((l) => l.includes(legacy.id.slice(0, 8)))
    expect(knownLine).toBeDefined()
    expect(legacyLine).toBeDefined()
    // The legacy row renders its raw status, not a blank or an error.
    expect(legacyLine).toContain('promoted')
  })

  it('unknown status in one row does not prevent the other rows from listing', async () => {
    const { proposals, db, run } = await loadEnv()

    const first = await proposals.createProposal('First')
    const second = await proposals.createProposal('Second')
    const third = await proposals.createProposal('Third')

    // Set the middle row to a completely unknown status.
    await db.execute({
      sql: `UPDATE proposals SET status = 'superseded' WHERE id = ?`,
      args: [second.id],
    })

    const result = await run(['proposal', 'list'])

    expect(result.code).toBe(0)
    // All three rows must appear.
    expect(result.out.some((l) => l.includes(first.id.slice(0, 8)))).toBe(true)
    expect(result.out.some((l) => l.includes(second.id.slice(0, 8)))).toBe(true)
    expect(result.out.some((l) => l.includes(third.id.slice(0, 8)))).toBe(true)
  })

  it('--status filter works for a status value that exists in the DB', async () => {
    const { proposals, db, run } = await loadEnv()

    const draft = await proposals.createProposal('Draft proposal')
    const legacy = await proposals.createProposal('Legacy proposal')

    await db.execute({
      sql: `UPDATE proposals SET status = 'done' WHERE id = ?`,
      args: [legacy.id],
    })

    // Filtering by 'done' must return exactly the one row.
    const done = await run(['proposal', 'list', '--status', 'done'])
    expect(done.code).toBe(0)
    expect(done.out.some((l) => l.includes(legacy.id.slice(0, 8)))).toBe(true)
    expect(done.out.some((l) => l.includes(draft.id.slice(0, 8)))).toBe(false)

    // Filtering by 'draft' must return exactly the other row.
    const drafts = await run(['proposal', 'list', '--status', 'draft'])
    expect(drafts.code).toBe(0)
    expect(drafts.out.some((l) => l.includes(draft.id.slice(0, 8)))).toBe(true)
    expect(drafts.out.some((l) => l.includes(legacy.id.slice(0, 8)))).toBe(false)
  })
})
