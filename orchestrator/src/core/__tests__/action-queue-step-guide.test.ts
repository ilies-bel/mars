/**
 * Integration test: the action-queue row raised by Arc.parkForHuman uses the
 * step guide as the row's actionable body (slice mars-9d53a245).
 *
 * Acceptance criterion:
 *   The action-queue row raised by a manual park uses the Step guide as the
 *   row's actionable text (not a generic "awaiting human" string).
 *
 * Covers:
 *   1. `stepGuide` provided → raised row body equals the guide string.
 *   2. `stepGuide` absent → raised row body is a non-empty generic fallback
 *      (does not equal null or an empty string).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-aq-step-guide-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('Arc.parkForHuman — action-queue row body equals guide', () => {
  it('sets row body to the step guide when guide is provided', async () => {
    const { migrateQueueSchema, enqueueTask } = await import('../queue')
    const { initActionQueue, listActionQueueItems } = await import('../lib/action-queue')
    const { Arc } = await import('../arc')
    await migrateQueueSchema()
    await initActionQueue()

    const task = await enqueueTask('test guide task', undefined, { skipTriage: true })
    const guide = 'Review the diff carefully, then approve if all checks pass.'

    await Arc.load(task.id).parkForHuman(task.id, {
      leaseOwner: 'test-operator',
      stepName: 'review-diff',
      stepGuide: guide,
    })

    const items = await listActionQueueItems('open', { kind: 'awaiting-human' })
    const row = items.find((item) => item.originTaskId === task.id)
    expect(row).toBeDefined()
    expect(row?.body).toBe(guide)
  })

  it('uses a generic fallback body when no guide is provided', async () => {
    const { migrateQueueSchema, enqueueTask } = await import('../queue')
    const { initActionQueue, listActionQueueItems } = await import('../lib/action-queue')
    const { Arc } = await import('../arc')
    await migrateQueueSchema()
    await initActionQueue()

    const task = await enqueueTask('test no-guide task', undefined, { skipTriage: true })

    await Arc.load(task.id).parkForHuman(task.id, {
      leaseOwner: 'test-operator',
    })

    const items = await listActionQueueItems('open', { kind: 'awaiting-human' })
    const row = items.find((item) => item.originTaskId === task.id)
    expect(row).toBeDefined()
    // Body is a non-empty generic string referencing the task, not the (null) guide
    expect(row?.body).toBeTruthy()
    expect(row?.body).toContain(task.id)
  })
})
