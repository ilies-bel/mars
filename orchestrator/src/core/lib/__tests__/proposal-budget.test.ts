import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { DbClient } from '../db.js'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

describe('checkSourceBudget', () => {
  let repo: string
  let client: DbClient
  let checkSourceBudget: typeof import('../proposal-budget.js').checkSourceBudget

  const seed = async (source: string, n: number, createdAt = NOW - DAY): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await client.execute({
        sql: `INSERT INTO proposals (id, source, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        args: [`${source}-${createdAt}-${i}`, source, createdAt, createdAt],
      })
    }
  }

  beforeEach(async () => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-budget-test-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    vi.resetModules()
    process.env.MARS_REPO = repo
    const proposals = await import('../../proposals.js')
    await proposals.initProposals()
    client = (await import('../../store/state-client.js')).resolveStateClient()
    ;({ checkSourceBudget } = await import('../proposal-budget.js'))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const now = (): number => NOW

  it('never flags an unlimited source', async () => {
    await seed('human', 200)
    expect(await checkSourceBudget(client, 'human', { now })).toEqual({
      overBudget: false,
      used: 200,
      ceiling: null,
    })
  })

  it('is under budget below the ceiling', async () => {
    await seed('failure-reflector', 29)
    expect(await checkSourceBudget(client, 'failure-reflector', { now })).toEqual({
      overBudget: false,
      used: 29,
      ceiling: 30,
    })
  })

  it('is not over budget exactly at the ceiling', async () => {
    await seed('failure-reflector', 30)
    expect((await checkSourceBudget(client, 'failure-reflector', { now })).overBudget).toBe(false)
  })

  it('is over budget above the ceiling and ignores rows outside the window', async () => {
    await seed('failure-reflector', 31)
    await seed('failure-reflector', 10, NOW - 45 * DAY)
    const v = await checkSourceBudget(client, 'failure-reflector', { now })
    expect(v).toEqual({ overBudget: true, used: 31, ceiling: 30 })
  })

  it('honours a daemon.json proposalBudgets override, including 0 and null', async () => {
    await seed('arc-verifier', 1)
    await seed('reflection', 100)
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ proposalBudgets: { 'arc-verifier': 0, reflection: null } }),
    )
    expect(await checkSourceBudget(client, 'arc-verifier', { now })).toEqual({
      overBudget: true,
      used: 1,
      ceiling: 0,
    })
    expect((await checkSourceBudget(client, 'reflection', { now })).ceiling).toBeNull()
  })

  it('falls back to defaults on an unreadable daemon.json', async () => {
    writeFileSync(resolve(repo, '.mars', 'daemon.json'), '{not json')
    expect((await checkSourceBudget(client, 'reflection', { now })).ceiling).toBe(60)
  })

  it('lets opts.ceilings override the defaults', async () => {
    await seed('planner', 3)
    const v = await checkSourceBudget(client, 'planner', { now, ceilings: { planner: 2 } })
    expect(v).toEqual({ overBudget: true, used: 3, ceiling: 2 })
  })
})
