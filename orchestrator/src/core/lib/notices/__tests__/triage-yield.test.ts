/**
 * detectTriageYieldDrop against a real embedded Postgres. The cases that
 * matter most are the ones where Mars must stay silent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../db.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const load = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const chat = await import('../../chat-store.js')
  await chat.initChatStore()
  const { resolveStateClient } = await import('../../../store/state-client.js')
  return {
    db: resolveStateClient() as DbClient,
    triage: await import('../triage-yield.js'),
  }
}

let seq = 0
/** Seed `total` proposals in a window, `actioned` of them sliced. */
const seed = async (
  db: DbClient,
  daysAgo: number,
  total: number,
  actioned: number,
  source = 'human',
) => {
  const createdAt = NOW - daysAgo * DAY
  for (let i = 0; i < total; i++) {
    await db.execute({
      sql: `INSERT INTO proposals (id, title, status, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [`p-${seq++}`, 't', i < actioned ? 'sliced' : 'draft', source, createdAt, createdAt],
    })
  }
}

describe('detectTriageYieldDrop', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-triage-yield-test-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('fires on the July-shaped collapse and names the flooding source', async () => {
    const { db, triage } = await load(repo)
    await seed(db, 45, 50, 24) // prior: 48%
    await seed(db, 10, 100, 3, 'reflection') // recent: 3%
    await seed(db, 12, 5, 0, 'human')

    const finding = await triage.detectTriageYieldDrop(db, { now: () => NOW })
    expect(finding).toMatchObject({
      priorRatePct: 48,
      windowDays: 30,
      priorCreated: 50,
      recentCreated: 105,
      topSource: 'reflection',
    })
    expect(finding!.dropPct).toBe(finding!.priorRatePct - finding!.recentRatePct)
    expect(finding!.dropPct).toBeGreaterThanOrEqual(20)
  })

  it('stays silent on a quiet month with a low rate', async () => {
    const { db, triage } = await load(repo)
    await seed(db, 45, 50, 24)
    await seed(db, 10, 10, 0)
    expect(await triage.detectTriageYieldDrop(db, { now: () => NOW })).toBeNull()
  })

  it('stays silent when the rate recovered', async () => {
    const { db, triage } = await load(repo)
    await seed(db, 45, 100, 3)
    await seed(db, 10, 100, 48)
    expect(await triage.detectTriageYieldDrop(db, { now: () => NOW })).toBeNull()
  })
})
