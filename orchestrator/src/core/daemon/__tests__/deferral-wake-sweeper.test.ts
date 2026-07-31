import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startDeferralWakeSweeper } from '../deferral-wake-sweeper.js'

let repo: string

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-deferral-wake-sweeper-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(resolve(repo, '.gitignore'), '.mars/\n')
  execFileSync(
    'git',
    ['-c', 'user.name=Mars Test', '-c', 'user.email=mars@example.test', 'add', '.gitignore'],
    { cwd: repo },
  )
  execFileSync(
    'git',
    ['-c', 'user.name=Mars Test', '-c', 'user.email=mars@example.test', 'commit', '-qm', 'init'],
    { cwd: repo },
  )
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

describe('startDeferralWakeSweeper', () => {
  it('releases a deferred task and drains it when the latest snapshot pressure is ok', async () => {
    const queue = await import('../../queue.js')
    const deferrals = await import('../../lib/deferral-store.js')
    const snapshots = await import('../../lib/usage-snapshot-store.js')
    const client = queue.resolveQueueClient()
    const task = await queue.enqueueTask('deferred maintenance task', undefined, {
      priority: 0,
      deferrable: true,
      skipTriage: true,
    })
    await deferrals.upsertDeferral({
      taskId: task.id,
      reason: 'usage pressure is critical',
      targetWindowEnd: null,
      pressure: 'critical',
    }, client)
    await snapshots.insertUsageSnapshot({
      capturedAt: new Date().toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      windowKind: 'rolling',
      rawJson: { usedPct: 10 },
    }, client)

    const pendingImplement = new Set<string>()
    const drain = vi.fn().mockResolvedValue(undefined)
    const sweeper = startDeferralWakeSweeper({
      interval: 60_000,
      drain,
      pendingImplement,
      getLatestSnapshot: () => snapshots.getLatestUsageSnapshot(client),
      getTask: queue.getTask,
    })

    await sweeper.tick()

    expect(await deferrals.listDeferrals(client)).toEqual([])
    expect(pendingImplement).toEqual(new Set([task.id]))
    expect(drain).toHaveBeenCalledTimes(1)
    sweeper.stop()
  })
})
