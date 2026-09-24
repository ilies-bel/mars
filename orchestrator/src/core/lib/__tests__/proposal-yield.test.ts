/**
 * Proposal yield metrics against a real embedded Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../db.js'

const NOW = Date.UTC(2026, 4, 15) // 2026-05-15
const at = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d, 12)

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposal-yield-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const load = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const chat = await import('../chat-store.js')
  await chat.initChatStore()
  const { resolveStateClient } = await import('../../store/state-client.js')
  return {
    db: resolveStateClient() as DbClient,
    y: await import('../proposal-yield.js'),
  }
}

let seq = 0
const add = async (db: DbClient, source: string, status: string, createdAt: number) => {
  await db.execute({
    sql: `INSERT INTO proposals (id, title, status, source, created_at, updated_at)
          VALUES (?, 't', ?, ?, ?, ?)`,
    args: [`p${seq++}`, status, source, createdAt, createdAt],
  })
}

describe('proposal yield', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const seed = async (db: DbClient) => {
    // March: slicer 4 (2 sliced, 1 prd-ready, 1 draft)
    await add(db, 'slicer', 'sliced', at(2026, 3, 2))
    await add(db, 'slicer', 'sliced', at(2026, 3, 3))
    await add(db, 'slicer', 'prd-ready', at(2026, 3, 4))
    await add(db, 'slicer', 'draft', at(2026, 3, 5))
    // April: intentionally empty
    // May: reflection 3 (1 taken, 2 dismissed)
    await add(db, 'reflection', 'taken', at(2026, 5, 1))
    await add(db, 'reflection', 'dismissed', at(2026, 5, 2))
    await add(db, 'reflection', 'dismissed', at(2026, 5, 3))
  }

  it('computeYieldBySource reports every source, including empty ones', async () => {
    const { db, y } = await load(repo)
    await seed(db)
    const rows = await y.computeYieldBySource(db)
    expect(rows.map((r) => r.source)).toHaveLength(8)
    expect(rows.find((r) => r.source === 'slicer')).toEqual({
      source: 'slicer', total: 4, sliced: 2, prdReady: 1, actionedPct: 75,
    })
    expect(rows.find((r) => r.source === 'reflection')).toEqual({
      source: 'reflection', total: 3, sliced: 0, prdReady: 0, actionedPct: 33,
    })
    expect(rows.find((r) => r.source === 'growth')).toEqual({
      source: 'growth', total: 0, sliced: 0, prdReady: 0, actionedPct: 0,
    })
  })

  it('computeVolumeByMonth is oldest-first and includes the zero month', async () => {
    const { db, y } = await load(repo)
    await seed(db)
    const rows = await y.computeVolumeByMonth(db, { monthsBack: 3, now: () => NOW })
    expect(rows).toEqual([
      { month: '2026-03', created: 4, actioned: 3, ratePct: 75 },
      { month: '2026-04', created: 0, actioned: 0, ratePct: 0 },
      { month: '2026-05', created: 3, actioned: 1, ratePct: 33 },
    ])
  })

  it('computeActionRate handles arbitrary windows and empty ones', async () => {
    const { db, y } = await load(repo)
    await seed(db)
    expect(await y.computeActionRate(db, { fromMs: at(2026, 3, 1), toMs: at(2026, 6, 1) }))
      .toEqual({ created: 7, actioned: 4, ratePct: 57 })
    expect(await y.computeActionRate(db, { fromMs: at(2026, 4, 1), toMs: at(2026, 4, 30) }))
      .toEqual({ created: 0, actioned: 0, ratePct: 0 })
  })
})
