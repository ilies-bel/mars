import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

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

const eventually = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition was not reached before timeout')
}

describe('recovery dispatch', () => {
  let repo: string | undefined
  let stop: (() => Promise<void>) | undefined
  let exitSpy: { mockRestore: () => void } | undefined

  afterEach(async () => {
    await stop?.()
    exitSpy?.mockRestore()
    if (repo) rmSync(repo, { recursive: true, force: true })
    repo = undefined
    stop = undefined
    exitSpy = undefined
    delete process.env.MARS_REPO
    delete process.env.MARS_DB_BACKEND
    delete process.env.MARS_DISABLE_DUCKDB
    delete process.env.MARS_DRAIN_POLL_MS
    delete process.env.MARS_QUEUED_DISPATCH_SWEEP_MS
    delete process.env.MARS_USAGE_SAMPLE_SEC
    delete process.env.MARS_WORKER_PROVIDER
    delete process.env.MARS_CODEX_BIN
    vi.resetModules()
  })

  it('dispatches a recovery spawned for a verify failure without restarting the daemon', async () => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-recovery-dispatch-test-'))
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
    mkdirSync(resolve(repo, '.mars', 'workflows'), { recursive: true })
    writeFileSync(
      resolve(repo, '.mars', 'workflows', 'fix-workflow.js'),
      "export default { id: 'fix', fn: async () => new Promise((resolve) => setTimeout(resolve, 2_000)) }\n",
    )

    process.env.MARS_REPO = repo
    process.env.MARS_DB_BACKEND = 'pglite'
    process.env.MARS_DISABLE_DUCKDB = '1'
    process.env.MARS_DRAIN_POLL_MS = '60000'
    process.env.MARS_USAGE_SAMPLE_SEC = '3600'
    process.env.MARS_WORKER_PROVIDER = 'codex'
    process.env.MARS_CODEX_BIN = '/usr/bin/true'
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const queue = await import('../../queue.js')
    const fixTasks = await import('../../queue-fix-tasks.js')
    await queue.migrateQueueSchema()
    const server = await import('../server.js')
    const daemon = await server.startDaemon()
    stop = async () => { await daemon.stop(true) }

    const source = await queue.enqueueTask('repair this typecheck failure', undefined, {
      skipTriage: true,
    })
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ?, worktree_path = ? WHERE id = ?`,
      args: ['main', repo, source.id],
    })
    await queue.updateTask(source.id, { status: 'failed' })
    const recovery = await fixTasks.handleTaskFailureWithFixTask({
      taskId: source.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2339: Property "missing" does not exist on type "Task".',
    })

    expect(recovery.outcome).toBe('blocked')
    if (recovery.fixTaskId === undefined) throw new Error('recovery did not create a fix task')
    let recoveryStatus: string | undefined
    try {
      await eventually(async () => {
        recoveryStatus = (await queue.getTask(recovery.fixTaskId!))?.status
        return recoveryStatus === 'running'
      })
    } catch (error) {
      throw new Error(`${(error as Error).message}; recovery status=${recoveryStatus}`)
    }
    expect((await queue.getTask(recovery.fixTaskId))?.status).toBe('running')
  })

  it('periodically dispatches a queued task that bypassed the dispatch hint', async () => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-queued-dispatch-sweep-test-'))
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
    mkdirSync(resolve(repo, '.mars', 'workflows'), { recursive: true })
    writeFileSync(
      resolve(repo, '.mars', 'workflows', 'report-workflow.js'),
      "export default { id: 'report', fn: async () => new Promise((resolve) => setTimeout(resolve, 1_000)) }\n",
    )

    process.env.MARS_REPO = repo
    process.env.MARS_DB_BACKEND = 'pglite'
    process.env.MARS_DISABLE_DUCKDB = '1'
    // A direct DB write produces no bus event. Keep the idle-only poll fallback
    // well outside this assertion window so the periodic sweep is the path under test.
    process.env.MARS_DRAIN_POLL_MS = '60000'
    process.env.MARS_QUEUED_DISPATCH_SWEEP_MS = '25'
    process.env.MARS_USAGE_SAMPLE_SEC = '3600'
    process.env.MARS_WORKER_PROVIDER = 'codex'
    process.env.MARS_CODEX_BIN = '/usr/bin/true'
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const queue = await import('../../queue.js')
    await queue.migrateQueueSchema()
    const server = await import('../server.js')
    const daemon = await server.startDaemon()
    stop = async () => { await daemon.stop(true) }

    const missedTask = await queue.enqueueTask('a queued task with no hint', undefined, {
      skipTriage: true,
      workflow: 'report',
    })

    await eventually(async () => (await queue.getTask(missedTask.id))?.status === 'running')
    expect((await queue.getTask(missedTask.id))?.status).toBe('running')
  })
})
