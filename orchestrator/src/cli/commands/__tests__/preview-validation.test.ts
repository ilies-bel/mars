/**
 * CLI behaviour for approving or rejecting preview-gated tasks.
 *
 * The daemon remains the single writer: these commands only look up the
 * daemon's published HTTP port and POST to its existing action routes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { makeFakeDaemon, runCommandInProcess } from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

const FAKE_PORT = 19999
let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-preview-validation-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  writeFileSync(resolve(dir, '.mars', 'http.port'), String(FAKE_PORT))
  return dir
}

const loadStoreAndCtx = async (): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
}> => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const createTask = async (status: string): Promise<string> => {
  const { enqueueTask, updateTask } = await import('../../../core/queue')
  const task = await enqueueTask('preview-gated task', undefined, { skipTriage: true })
  await updateTask(task.id, {
    status: status as Parameters<typeof updateTask>[1]['status'],
  })
  return task.id
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('mars validate', () => {
  it('approves every preview-gated task through the daemon action route', async () => {
    const first = await createTask('awaiting-validation')
    const second = await createTask('awaiting-validation')
    const { store, ctx } = await loadStoreAndCtx()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await runCommandInProcess(['validate', first, second], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })

    expect(result.code).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:${FAKE_PORT}/actions/validate/${first}`,
      { method: 'POST' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:${FAKE_PORT}/actions/validate/${second}`,
      { method: 'POST' },
    )
    expect(result.out.join('\n')).toContain(`validated ${first}; re-queued for merge`)
    expect(result.out.join('\n')).toContain(`validated ${second}; re-queued for merge`)
  })

  it('refuses a task outside the preview gate and names its actual status', async () => {
    const taskId = await createTask('queued')
    const { store, ctx } = await loadStoreAndCtx()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await runCommandInProcess(['validate', taskId], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain(`task ${taskId} is queued`)
    expect(result.err.join('\n')).toContain("only applies to an 'awaiting-validation' task")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a task status before requiring a running daemon', async () => {
    const taskId = await createTask('queued')
    const { store, ctx } = await loadStoreAndCtx()
    rmSync(resolve(repo, '.mars', 'http.port'))

    const result = await runCommandInProcess(['validate', taskId], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain(`task ${taskId} is queued`)
    expect(result.err.join('\n')).not.toContain('daemon not running')
  })

  it('routes an awaiting-human task to the manual-step command', async () => {
    const taskId = await createTask('awaiting-human')
    const { store, ctx } = await loadStoreAndCtx()

    const result = await runCommandInProcess(['validate', taskId], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })

    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain(`task ${taskId} is awaiting-human`)
    expect(result.err.join('\n')).toContain(`mars step done ${taskId}`)
  })
})

describe('mars reject', () => {
  it('rejects a preview-gated task through the daemon action route', async () => {
    const taskId = await createTask('awaiting-validation')
    const { store, ctx } = await loadStoreAndCtx()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await runCommandInProcess(['reject', taskId], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })

    expect(result.code).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:${FAKE_PORT}/actions/reject/${taskId}`,
      { method: 'POST' },
    )
    expect(result.out.join('\n')).toContain(`rejected ${taskId}; task failed`)
  })
})
