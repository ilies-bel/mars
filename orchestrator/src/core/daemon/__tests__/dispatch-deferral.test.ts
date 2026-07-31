import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// The daemon's control socket is transport-only for this test. Stub it so the
// dispatch path can boot in the Vitest sandbox, which forbids Unix sockets.
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  const { EventEmitter } = await import('node:events')
  class StubServer extends EventEmitter {
    listen(_path: string, callback: () => void): this {
      callback()
      return this
    }

    close(callback: () => void): this {
      callback()
      return this
    }
  }
  return { ...actual, createServer: () => new StubServer() }
})

vi.mock('../http-server', () => ({
  startHttpServer: async () => ({ port: 0, close: async () => {} }),
}))

let repo: string
let taskId: string
let stop: (() => Promise<void>) | null = null
let exitSpy: { mockRestore: () => void }

const eventually = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition was not reached before timeout')
}

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-dispatch-deferral-test-'))
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
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  mkdirSync(resolve(repo, '.mars', 'workflows'), { recursive: true })
  writeFileSync(
    resolve(repo, '.mars', 'workflows', 'report-workflow.js'),
    "export default { id: 'report', fn: async () => null }\n",
  )

  process.env.MARS_REPO = repo
  process.env.MARS_DB_BACKEND = 'pglite'
  process.env.MARS_DISABLE_DUCKDB = '1'
  process.env.MARS_DRAIN_POLL_MS = '10'
  process.env.MARS_USAGE_SAMPLE_SEC = '3600'
  process.env.MARS_WORKER_PROVIDER = 'codex'
  process.env.MARS_CODEX_BIN = '/usr/bin/true'

  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

  const queue = await import('../../queue.js')
  const snapshots = await import('../../lib/usage-snapshot-store.js')
  await queue.migrateQueueSchema()
  const client = queue.resolveQueueClient()
  const now = new Date()
  await snapshots.insertUsageSnapshot(
    {
      capturedAt: now.toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      windowKind: 'rolling',
      rawJson: {
        usedPct: 95,
        nextResetAt: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      },
    },
    client,
  )
  const task = await queue.enqueueTask('defer this maintenance task', undefined, {
    priority: 0,
    deferrable: true,
    skipTriage: true,
    workflow: 'report',
  })
  taskId = task.id

  const server = await import('../server.js')
  const daemon = await server.startDaemon()
  stop = async () => { await daemon.stop(true) }
})

afterAll(async () => {
  await stop?.()
  exitSpy.mockRestore()
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  delete process.env.MARS_DISABLE_DUCKDB
  delete process.env.MARS_DRAIN_POLL_MS
  delete process.env.MARS_USAGE_SAMPLE_SEC
  delete process.env.MARS_WORKER_PROVIDER
  delete process.env.MARS_CODEX_BIN
  rmSync(repo, { recursive: true, force: true })
})

describe('dispatch deferral', () => {
  it('records critical-pressure deferrals and dispatches after the pressure clears', async () => {
    const queue = await import('../../queue.js')
    const snapshots = await import('../../lib/usage-snapshot-store.js')
    const deferrals = await import('../../lib/deferral-store.js')
    const client = queue.resolveQueueClient()

    await eventually(async () => (await deferrals.listDeferrals(client)).length === 1)
    expect((await queue.getTask(taskId))?.status).toBe('queued')

    const now = new Date()
    await snapshots.insertUsageSnapshot(
      {
        capturedAt: new Date(now.getTime() + 1_000).toISOString(),
        inputTokens: 0,
        outputTokens: 0,
        windowKind: 'rolling',
        rawJson: {
          usedPct: 10,
          nextResetAt: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
        },
      },
      client,
    )

    try {
      await eventually(async () => (await queue.getTask(taskId))?.status === 'running')
    } catch (error) {
      throw new Error(`${(error as Error).message}; status=${(await queue.getTask(taskId))?.status}`)
    }
    expect((await deferrals.listDeferrals(client))[0]).toMatchObject({
      reason: 'usage pressure is critical',
      pressure: 'critical',
    })
  })
})
