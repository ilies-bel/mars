/**
 * The 'scorer-suggested' action-queue projection (PRD 6988ed3b, ADR-0048):
 * a row exists iff a scorers row sits in status='suggested'.
 *
 * End-to-end through the real seams: the scorers entity module emits
 * scorer.suggested / scorer.accepted / scorer.dismissed into the outbox, and
 * the action-queue-repopulator drain projects those events into
 * raise/evict on action_queue_items.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface RepopulatorModule {
  ACTION_QUEUE_REPOPULATOR_SUBSCRIBER: typeof import('../action-queue-repopulator').ACTION_QUEUE_REPOPULATOR_SUBSCRIBER
  ensureActionQueueRepopulator: typeof import('../action-queue-repopulator').ensureActionQueueRepopulator
  drainActionQueueRepopulations: typeof import('../action-queue-repopulator').drainActionQueueRepopulations
}

interface ScorersModule {
  initScorers: typeof import('../../scorers').initScorers
  suggestScorer: typeof import('../../scorers').suggestScorer
  acceptScorer: typeof import('../../scorers').acceptScorer
  dismissScorer: typeof import('../../scorers').dismissScorer
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
  rep: RepopulatorModule
  scorers: ScorersModule
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-scorer-action-queue-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import(
    '../../lib/action-queue'
  )) as unknown as ActionQueueModule
  const rep = (await import(
    '../action-queue-repopulator'
  )) as unknown as RepopulatorModule
  const scorers = (await import('../../scorers')) as unknown as ScorersModule
  await scorers.initScorers()
  return { q, actionQueue, rep, scorers }
}

const suggestInput = {
  workflow: 'task',
  title: 'Diff minimality',
  rubric:
    'Grade how tightly the instance diff is scoped to the stated goal, from 0 (dominated by unrelated churn) to 1 (every hunk serves the goal).',
  originArcId: 'arc-scorer-aq-001',
  reportPath: null,
  evidence: ['task mars-xyz event 3: verify passed with 0 tests run'],
  confidence: 0.7,
} as const

describe('scorer-suggested action-queue projection', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises one scorer-suggested row when a scorer lands in status=suggested', async () => {
    const { q, actionQueue, rep, scorers } = await loadModules(repo)
    const client = q.resolveQueueClient()
    await rep.ensureActionQueueRepopulator(client)

    const { scorer } = await scorers.suggestScorer({ ...suggestInput })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const open = await actionQueue.listActionQueueItems('open', {
      kind: 'scorer-suggested',
    })
    expect(open).toHaveLength(1)
    expect(open[0].payload['scorerId']).toBe(scorer.id)
    expect(open[0].payload['workflow']).toBe('task')
    expect(open[0].originTaskId).toBe(scorer.id)
    expect(open[0].title).toContain('Diff minimality')
  })

  it('evicts the row on scorer.accepted (net zero open rows)', async () => {
    const { q, actionQueue, rep, scorers } = await loadModules(repo)
    const client = q.resolveQueueClient()
    await rep.ensureActionQueueRepopulator(client)

    const { scorer } = await scorers.suggestScorer({ ...suggestInput })
    await rep.drainActionQueueRepopulations(client)
    expect(
      await actionQueue.listActionQueueItems('open', { kind: 'scorer-suggested' }),
    ).toHaveLength(1)

    await scorers.acceptScorer(scorer.id)
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const open = await actionQueue.listActionQueueItems('open', {
      kind: 'scorer-suggested',
    })
    expect(open).toHaveLength(0)

    // The row was resolved (projection closed), not deleted.
    const all = await actionQueue.listActionQueueItems('all', {
      kind: 'scorer-suggested',
    })
    expect(all).toHaveLength(1)
    expect(all[0].state).toBe('resolved')
  })

  it('evicts the row on scorer.dismissed', async () => {
    const { q, actionQueue, rep, scorers } = await loadModules(repo)
    const client = q.resolveQueueClient()
    await rep.ensureActionQueueRepopulator(client)

    const { scorer } = await scorers.suggestScorer({ ...suggestInput })
    await rep.drainActionQueueRepopulations(client)

    await scorers.dismissScorer(scorer.id)
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    expect(
      await actionQueue.listActionQueueItems('open', { kind: 'scorer-suggested' }),
    ).toHaveLength(0)
  })

  it('a re-derived (absorbed) suggestion does not raise a second row', async () => {
    const { q, actionQueue, rep, scorers } = await loadModules(repo)
    const client = q.resolveQueueClient()
    await rep.ensureActionQueueRepopulator(client)

    await scorers.suggestScorer({ ...suggestInput })
    // Fingerprint match (case/punctuation-insensitive) → absorbed; no second
    // scorer.suggested event lands in the outbox.
    const second = await scorers.suggestScorer({
      ...suggestInput,
      title: 'diff-Minimality',
      evidence: ['task mars-second event 8: another vacuous pass'],
    })
    expect(second.outcome).toBe('absorbed')

    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1) // exactly one raise event was ever emitted

    const open = await actionQueue.listActionQueueItems('open', {
      kind: 'scorer-suggested',
    })
    expect(open).toHaveLength(1)
  })

  it('row appears iff status=suggested: nothing raised for a scorer that was accepted before the drain', async () => {
    const { q, actionQueue, rep, scorers } = await loadModules(repo)
    const client = q.resolveQueueClient()
    await rep.ensureActionQueueRepopulator(client)

    // Suggest + accept BEFORE any drain: both events sit in the outbox.
    const { scorer } = await scorers.suggestScorer({ ...suggestInput })
    await scorers.acceptScorer(scorer.id)

    // The drain processes scorer.suggested (raise) then scorer.accepted
    // (evict) in order — the projection converges on zero open rows.
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(2)

    expect(
      await actionQueue.listActionQueueItems('open', { kind: 'scorer-suggested' }),
    ).toHaveLength(0)
  })
})
