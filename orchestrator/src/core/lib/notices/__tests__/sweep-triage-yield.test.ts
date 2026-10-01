/**
 * The `trend.triage-yield` wiring in the sweep: the lever gates whether the
 * detector even runs, and a real collapse speaks exactly one Notice with the
 * rendered copy naming the rate, the volume, and the flooding source.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../db.js'

const DAY = 24 * 60 * 60 * 1000
// The detector reads real wall-clock time through the sweep (no `now`
// override is threaded through `runNoticeSweep`), so proposals are seeded
// relative to the actual current time rather than a fixed epoch.
const NOW = Date.now()

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-sweep-triage-yield-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const load = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const chat = await import('../../chat-store.js')
  await chat.initChatStore()
  const { resolveStateClient } = await import('../../../store/state-client.js')
  const { runNoticeSweep } = await import('../sweep.js')
  const { renderConversationNotice } = await import('../../conversation-copy.js')
  return { db: resolveStateClient() as DbClient, runNoticeSweep, renderConversationNotice }
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

/** Seed the July-shaped collapse: a healthy prior window, a flooded recent one. */
const seedCollapse = async (db: DbClient) => {
  await seed(db, 45, 50, 24) // prior: 48%
  await seed(db, 10, 100, 3, 'reflection') // recent: 3%
  await seed(db, 12, 5, 0, 'human')
}

describe('runNoticeSweep — trend.triage-yield', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const base = (db: DbClient, post: ReturnType<typeof vi.fn>, level = 'tell') => ({
    client: db,
    repoRoot: repo,
    integrationBranch: 'main',
    listCommits: async () => [],
    post: post as never,
    readAutonomyLevel: () => level,
  })

  it('stays silent and never consults the detector when the lever is off', async () => {
    const { db, runNoticeSweep } = await load(repo)
    // Seed data that would otherwise be a textbook collapse — if the
    // detector ran against it, it would return a drop and the sweep would
    // speak. Lever 'off' must prevent both.
    await seedCollapse(db)
    const post = vi.fn().mockResolvedValue({ id: 'n1', delivered: true })

    const result = await runNoticeSweep(base(db, post, 'off'))

    expect(result.posted).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('speaks exactly one trend.triage-yield notice with the rendered copy on a real collapse', async () => {
    const { db, runNoticeSweep, renderConversationNotice } = await load(repo)
    await seedCollapse(db)
    const post = vi.fn().mockResolvedValue({ id: 'n1', delivered: true })

    const result = await runNoticeSweep(base(db, post))

    // Other detectors may also fire on this seed (e.g. an idle-proposal
    // offer, since the seed leaves draft proposals behind) — what matters
    // here is that exactly one `trend.triage-yield` notice is among them.
    expect(result.posted).toBeGreaterThanOrEqual(1)
    const triageCalls = post.mock.calls.filter(([input]) => input.kind === 'trend.triage-yield')
    expect(triageCalls).toHaveLength(1)

    const [input] = triageCalls[0]!
    expect(input).toMatchObject({
      kind: 'trend.triage-yield',
      priority: 'routine',
      payload: {
        priorRatePct: 48,
        recentCreated: 105,
        windowDays: 30,
        topSource: 'reflection',
      },
    })

    const body = renderConversationNotice(input.kind, input.payload)
    expect(body).toContain('105')
    expect(body).toContain('30')
    expect(body).toContain('reflection')
    expect(body).toContain(`${input.payload.recentRatePct}%`)
  })
})
