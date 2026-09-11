/**
 * Tests for `coreApproveStep` and `coreAbortRelease` from approve-step-action.ts.
 *
 * coreApproveStep:
 *   - Re-queues an awaiting-human task (closes the AQ row, transitions to queued)
 *   - Refuses tasks not in awaiting-human status
 *   - Refuses tasks with no active lease
 *
 * coreAbortRelease:
 *   - Fails a task without merging (closes the AQ row, transitions to failed)
 *   - Refuses tasks not in awaiting-human status
 *   - Refuses tasks with no active lease
 *
 * Both verify that the awaiting-human action-queue row is resolved (superseded)
 * after the call — the ADR-0094 atomicity rule.
 *
 * Pattern follows validate-task.test.ts: real PGlite DB, no bus mock
 * (standalone functions do not emit bus events).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// PGlite cold start can take longer than the default 5 s timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-approve-step-test-'))
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
  process.env.MARS_REPO = repo
  const q = await import('../../queue')
  const { __resetDbRegistryForTests } = await import('../../lib/db')
  resetTestDbs = __resetDbRegistryForTests
  await q.migrateQueueSchema()
  const approveStepMod = await import('../approve-step-action')
  const actionQueue = await import('../../lib/action-queue')
  return { q, approveStepMod, actionQueue }
}

/**
 * Enqueue a task and park it at awaiting-human with an active lease and a
 * merge-gate step name. Also raises an awaiting-human AQ row so we can verify
 * it gets closed.
 */
const parkAtMergeGate = async (
  q: typeof import('../../queue'),
  actionQueue: typeof import('../../lib/action-queue'),
  _taskId?: string,
): Promise<string> => {
  const task = await q.enqueueTask('gated merge task', undefined, {
    spec: {
      files: [],
      verifyCmd: null,
      doneCriteria: [],
      mergeMode: 'gated',
    },
  })
  const id = task.id
  await q.updateTask(id, {
    status: 'awaiting-human',
    leaseOwner: 'test-session',
    leasedAt: new Date().toISOString(),
    leaseNote: 'implementing',
    currentStepName: 'merge-gate',
  })
  // Raise the awaiting-human AQ row (signature = taskId, per park-for-human.ts convention).
  await actionQueue.raiseActionQueueItem({
    kind: 'awaiting-human',
    category: 'user',
    priority: 'high',
    title: `Step 'merge-gate' parked`,
    body: 'Waiting for operator approval',
    payload: {
      situation: 'lease-park',
      taskId: id,
      leaseOwner: 'test-session',
      leasedAt: new Date().toISOString(),
      leaseNote: 'implementing',
      stepName: 'merge-gate',
    },
    context: {},
    raisedBy: 'park-for-human',
    signature: id,
    originTaskId: id,
  })
  return id
}

// ── coreApproveStep ──────────────────────────────────────────────────────────

describe('coreApproveStep', () => {
  it('re-queues the task and closes the awaiting-human AQ row', async () => {
    const { q, approveStepMod, actionQueue } = await load(repo)
    const id = await parkAtMergeGate(q, actionQueue)

    await approveStepMod.coreApproveStep(id)

    const after = await q.getTask(id)
    expect(after?.status).toBe('queued')

    const open = await actionQueue.listActionQueueItems('open')
    const stillOpen = open.find((i) => i.signature === id && i.kind === 'awaiting-human')
    expect(stillOpen, 'awaiting-human row must be superseded on approve-step').toBeUndefined()
  })

  it('refuses a task that is not awaiting-human', async () => {
    const { q, approveStepMod } = await load(repo)
    const task = await q.enqueueTask('not parked')
    await expect(approveStepMod.coreApproveStep(task.id)).rejects.toThrow(/awaiting-human/)
  })

  it('refuses a task with no active lease', async () => {
    const { q, approveStepMod } = await load(repo)
    const task = await q.enqueueTask('no lease')
    await q.updateTask(task.id, { status: 'awaiting-human' })
    // leaseOwner is null — no lease attached
    await expect(approveStepMod.coreApproveStep(task.id)).rejects.toThrow(/no active lease/)
  })

  it('throws NOT_FOUND for an unknown task id', async () => {
    const { approveStepMod } = await load(repo)
    await expect(approveStepMod.coreApproveStep('nonexistent-id')).rejects.toThrow(/not found/)
  })
})

// ── coreAbortRelease ─────────────────────────────────────────────────────────

describe('coreAbortRelease', () => {
  it('fails the task without merging and closes the awaiting-human AQ row', async () => {
    const { q, approveStepMod, actionQueue } = await load(repo)
    const id = await parkAtMergeGate(q, actionQueue)

    await approveStepMod.coreAbortRelease(id)

    const after = await q.getTask(id)
    expect(after?.status).toBe('failed')
    expect(after?.failureReason).toBe('operator aborted human work')
    // Worktree / branch are NOT cleaned up — the task is preserved for inspection.
    expect(after?.error).toBeTruthy()

    const open = await actionQueue.listActionQueueItems('open')
    const stillOpen = open.find((i) => i.signature === id && i.kind === 'awaiting-human')
    expect(stillOpen, 'awaiting-human row must be superseded on abort-release').toBeUndefined()
  })

  it('refuses a task that is not awaiting-human', async () => {
    const { q, approveStepMod } = await load(repo)
    const task = await q.enqueueTask('not parked')
    await expect(approveStepMod.coreAbortRelease(task.id)).rejects.toThrow(/awaiting-human/)
  })

  it('refuses a task with no active lease', async () => {
    const { q, approveStepMod } = await load(repo)
    const task = await q.enqueueTask('no lease')
    await q.updateTask(task.id, { status: 'awaiting-human' })
    await expect(approveStepMod.coreAbortRelease(task.id)).rejects.toThrow(/no active lease/)
  })

  it('throws NOT_FOUND for an unknown task id', async () => {
    const { approveStepMod } = await load(repo)
    await expect(approveStepMod.coreAbortRelease('nonexistent-id')).rejects.toThrow(/not found/)
  })
})
