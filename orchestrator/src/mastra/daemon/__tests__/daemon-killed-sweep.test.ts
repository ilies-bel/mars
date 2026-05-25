import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  initQueue: typeof import('../../queue').initQueue
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
}

interface InboxModule {
  listInboxItems: typeof import('../../lib/inbox').listInboxItems
}

interface SweepModule {
  detectAndRaiseDaemonKilled: typeof import('../daemon-killed-sweep').detectAndRaiseDaemonKilled
  buildDaemonKilledBody: typeof import('../daemon-killed-sweep').buildDaemonKilledBody
  DAEMON_KILLED_INBOX_KIND: typeof import('../daemon-killed-sweep').DAEMON_KILLED_INBOX_KIND
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-daemon-killed-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; inbox: InboxModule; sweep: SweepModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const inbox = (await import('../../lib/inbox')) as unknown as InboxModule
  const sweep = (await import('../daemon-killed-sweep')) as unknown as SweepModule
  return { q, inbox, sweep }
}

describe('detectAndRaiseDaemonKilled', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises exactly one alert per daemon-killed task and does NOT requeue it', async () => {
    const { q, inbox, sweep } = await loadModules(repo)

    const task = await q.enqueueTask('killed work', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'failed',
      error: 'killed by `mars daemon kill`',
      failureSignature: 'daemon-killed',
    })

    const raised = await sweep.detectAndRaiseDaemonKilled()
    expect(raised).toHaveLength(1)

    // Alert-only: status must remain 'failed', never auto-flipped to queued.
    const after = await q.getTask(task.id)
    expect(after?.status).toBe('failed')

    const items = await inbox.listInboxItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_KILLED_INBOX_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.title).toContain(task.id)
  })

  it('ignores failed tasks without the daemon-killed signature', async () => {
    const { q, sweep } = await loadModules(repo)

    const task = await q.enqueueTask('ordinary failure', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'failed', error: 'verify failed' })

    const raised = await sweep.detectAndRaiseDaemonKilled()
    expect(raised).toHaveLength(0)
  })

  it('dedupes on re-detection (one row, bumped) rather than inserting siblings', async () => {
    const { q, inbox, sweep } = await loadModules(repo)

    const task = await q.enqueueTask('killed work', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'failed',
      failureSignature: 'daemon-killed',
    })

    await sweep.detectAndRaiseDaemonKilled()
    await sweep.detectAndRaiseDaemonKilled()

    const items = await inbox.listInboxItems()
    const ours = items.filter((i) => i.kind === sweep.DAEMON_KILLED_INBOX_KIND)
    expect(ours).toHaveLength(1)
    expect(ours[0]?.seenCount).toBeGreaterThanOrEqual(2)
  })

  it('body lists the registry recovery action labels', async () => {
    const { sweep } = await loadModules(repo)
    const body = sweep.buildDaemonKilledBody('mars-abc')
    expect(body).toContain('mars-abc')
    expect(body).toContain('Requeue now')
    expect(body).toContain('Restart daemon')
  })
})
