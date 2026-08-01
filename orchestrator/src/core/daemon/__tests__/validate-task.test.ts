/**
 * Tests for the preview-gate verdict mechanics (`coreValidateTask` /
 * `coreRejectTask`) — the human-in-the-loop half of the awaiting-validation
 * flow.
 *
 * Validate: kills the dev server, marks the task validated, re-queues it.
 * Reject:   kills the dev server, fails the task (worktree preserved), and
 *           supersedes the awaiting-validation action-queue row.
 *
 * The dev-server module is mocked so no real process is spawned; we assert the
 * recorded pid is passed to killDevServer and the task-state transitions land.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// PGlite cold start can take longer than the default 5 s timeout per-test;
// raise both timeouts so each dynamically-loaded PGlite instance gets 30 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// Capture pids passed to killDevServer; spawn is never reached in these tests.
const killed: Array<number | null> = []
vi.mock('../../lib/dev-server', () => ({
  killDevServer: async (pid: number | null) => {
    killed.push(pid)
  },
  startDevServer: async () => ({ pid: 4242, url: 'http://127.0.0.1:4242', logPath: '/tmp/x.log', port: 4242 }),
  isDevServerAlive: () => false,
  allocatePort: async () => 4242,
}))

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-validate-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let repo: string
let resetTestDbs: (() => Promise<void>) | undefined

beforeAll(() => {
  repo = setupRepo()
})

afterAll(async () => {
  await resetTestDbs?.()
  resetTestDbs = undefined
  delete process.env.MARS_REPO
  vi.resetModules()
  rmSync(repo, { recursive: true, force: true })
})

const load = async (repo: string) => {
  killed.length = 0
  process.env.MARS_REPO = repo
  const q = await import('../../queue')
  const { __resetDbRegistryForTests } = await import('../../lib/db')
  resetTestDbs = __resetDbRegistryForTests
  await q.migrateQueueSchema()
  const validate = await import('../validate-task')
  const actionQueue = await import('../../lib/action-queue')
  return { q, validate, actionQueue }
}

/** Enqueue a task and drive it into the awaiting-validation parked state. */
const parkAtGate = async (
  q: typeof import('../../queue'),
  prompt = 'preview me',
): Promise<string> => {
  const task = await q.enqueueTask(prompt, undefined, {
    spec: {
      files: [],
      verifyCmd: null,
      doneCriteria: [],
      mergeMode: 'auto',
    },
  })
  await q.updateTask(task.id, {
    status: 'awaiting-validation',
    devServerUrl: 'http://127.0.0.1:4242',
    devServerPid: 4242,
  })
  return task.id
}

describe('coreValidateTask', () => {
  it('kills the dev server, marks validated, clears coordinates, and re-queues', async () => {
    const { q, validate } = await load(repo)
    const id = await parkAtGate(q)

    await validate.coreValidateTask(id)

    expect(killed).toEqual([4242])
    const after = await q.getTask(id)
    expect(after?.status).toBe('queued')
    expect(after?.previewValidated).toBe(true)
    expect(after?.devServerUrl).toBeNull()
    expect(after?.devServerPid).toBeNull()
  })

  it('refuses a task that is not awaiting validation', async () => {
    const { q, validate } = await load(repo)
    const task = await q.enqueueTask('not parked')
    await expect(validate.coreValidateTask(task.id)).rejects.toThrow(/awaiting validation/)
  })

  it('throws NOT_FOUND for an unknown task', async () => {
    const { validate } = await load(repo)
    await expect(validate.coreValidateTask('nope')).rejects.toThrow(/not found/)
  })
})

describe('coreRejectTask', () => {
  it('kills the dev server, fails the task (worktree preserved), and closes the row', async () => {
    const { q, validate, actionQueue } = await load(repo)
    const id = await parkAtGate(q)
    // Raise the row the merge gate would have raised.
    await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-validation',
      category: 'user',
      priority: 'high',
      title: 'Validate',
      body: 'preview running',
      payload: { taskId: id, devServerUrl: 'http://127.0.0.1:4242' },
      context: {},
      raisedBy: 'merge:preview-gate',
      signature: `${id}:awaiting-validation`,
      originTaskId: id,
    })

    await validate.coreRejectTask(id)

    expect(killed).toEqual([4242])
    const after = await q.getTask(id)
    expect(after?.status).toBe('failed')
    expect(after?.failedPhase).toBe('merge')
    expect(after?.devServerUrl).toBeNull()
    expect(after?.devServerPid).toBeNull()

    const open = await actionQueue.listActionQueueItems('open')
    const stillOpen = open.find((i) => i.payload['taskId'] === id)
    expect(stillOpen, 'awaiting-validation row must be superseded on reject').toBeUndefined()
  })

  it('refuses a task that is not awaiting validation', async () => {
    const { q, validate } = await load(repo)
    const task = await q.enqueueTask('not parked')
    await expect(validate.coreRejectTask(task.id)).rejects.toThrow(/awaiting validation/)
  })
})
