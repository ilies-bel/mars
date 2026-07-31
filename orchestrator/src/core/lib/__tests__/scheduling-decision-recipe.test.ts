import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startDeferralWakeSweeper } from '../../daemon/deferral-wake-sweeper.js'

let repo: string

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-scheduling-decision-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  process.env.MARS_REPO = repo
  process.env.MARS_DB_BACKEND = 'pglite'

  const queue = await import('../../queue.js')
  await queue.migrateQueueSchema()
})

afterAll(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  rmSync(repo, { recursive: true, force: true })
})

describe('scheduling decisions in the action queue', () => {
  it('shows one deferred and one woken decision with their scheduling context', async () => {
    const queue = await import('../../queue.js')
    const deferrals = await import('../deferral-store.js')
    const snapshots = await import('../usage-snapshot-store.js')
    const actionQueue = await import('../action-queue.js')
    const client = queue.resolveQueueClient()
    const targetWindowEnd = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    const task = await queue.enqueueTask('deferred maintenance task', undefined, {
      priority: 0,
      deferrable: true,
      skipTriage: true,
    })

    await deferrals.upsertDeferral({
      taskId: task.id,
      reason: 'usage pressure is critical',
      targetWindowEnd,
      pressure: 'critical',
    }, client)
    await deferrals.upsertDeferral({
      taskId: task.id,
      reason: 'usage pressure is critical',
      targetWindowEnd,
      pressure: 'critical',
    }, client)

    expect(await actionQueue.listActionQueueItems('open', {
      kind: 'scheduling-decision',
    })).toMatchObject([
      {
        payload: {
          taskId: task.id,
          decision: 'deferred',
          reason: 'usage pressure is critical',
          pressure: 'critical',
          targetWindowEnd,
          canRunNow: false,
        },
      },
    ])

    await snapshots.insertUsageSnapshot({
      capturedAt: new Date().toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      windowKind: 'rolling',
      rawJson: { usedPct: 10, nextResetAt: targetWindowEnd },
    }, client)
    const pendingImplement = new Set<string>()
    const sweeper = startDeferralWakeSweeper({
      interval: 60_000,
      drain: vi.fn().mockResolvedValue(undefined),
      pendingImplement,
      getLatestSnapshot: () => snapshots.getLatestUsageSnapshot(client),
      getTask: queue.getTask,
    })

    await sweeper.tick()
    await sweeper.tick()
    sweeper.stop()

    const decisions = await actionQueue.listActionQueueItems('open', {
      kind: 'scheduling-decision',
    })
    expect(pendingImplement).toEqual(new Set([task.id]))
    expect(decisions).toHaveLength(2)
    expect(decisions.map((item) => item.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: task.id,
        decision: 'deferred',
        reason: 'usage pressure is critical',
        pressure: 'critical',
        targetWindowEnd,
        canRunNow: false,
      }),
      expect.objectContaining({
        taskId: task.id,
        decision: 'woken',
        reason: 'usage pressure is critical',
        pressure: 'critical',
        targetWindowEnd,
        canRunNow: true,
      }),
    ]))
  })
})
