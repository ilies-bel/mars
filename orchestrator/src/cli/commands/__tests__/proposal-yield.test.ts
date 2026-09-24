/** Tests for `mars proposal yield`. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-yield-test-'))
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

describe('mars proposal yield', () => {
  it('renders both tables with a seeded source row', async () => {
    const { proposals, db, run } = await loadEnv()
    const p = await proposals.createProposal('Sliced one')
    await db.execute({ sql: `UPDATE proposals SET status = 'sliced' WHERE id = ?`, args: [p.id] })

    const result = await run(['proposal', 'yield'])

    expect(result.code).toBe(0)
    expect(result.out.some((l) => l.startsWith('source') && l.includes('actioned%'))).toBe(true)
    expect(result.out.some((l) => l.startsWith('month') && l.includes('rate'))).toBe(true)
    expect(result.out.some((l) => /^\S+\s+1\s+1\s+0\s+100%/.test(l))).toBe(true)
  })

  it('--json prints one object with bySource and byMonth; --months sizes the window', async () => {
    const { run } = await loadEnv()

    const result = await run(['proposal', 'yield', '--json', '--months', '3'])

    expect(result.code).toBe(0)
    expect(result.out).toHaveLength(1)
    const parsed = JSON.parse(result.out[0])
    expect(Array.isArray(parsed.bySource)).toBe(true)
    expect(parsed.byMonth).toHaveLength(3)
  })
})
