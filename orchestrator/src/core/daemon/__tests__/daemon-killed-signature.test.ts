/**
 * Tests that rows killed by the daemon carry the structured
 * `failureSignature = 'daemon-killed'` so downstream code can query for them
 * without fragile substring matching on the freeform `error` field.
 *
 * Acceptance criteria:
 *   - DAEMON_KILLED_SIGNATURE exported from retry-budget equals 'daemon-killed'
 *   - An updateTask call that matches the kill path stamps failureSignature
 *     and reads back through getTask
 *   - A task updated without failureSignature has failureSignature === null
 *     (baseline: column is not poisoned by a stray default)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  initQueue: typeof import('../../queue').initQueue
  updateTask: typeof import('../../queue').updateTask
}

interface RetryBudgetModule {
  DAEMON_KILLED_SIGNATURE: typeof import('../../lib/retry-budget').DAEMON_KILLED_SIGNATURE
}

/** Spin up a minimal git repo so the queue initialises cleanly. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-killed-sig-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  return repo
}

describe('daemon-killed failure signature', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('DAEMON_KILLED_SIGNATURE constant equals the literal string daemon-killed', async () => {
    const { DAEMON_KILLED_SIGNATURE } = (await import(
      '../../lib/retry-budget'
    )) as RetryBudgetModule

    expect(DAEMON_KILLED_SIGNATURE).toBe('daemon-killed')
  })

  it('killed rows carry failureSignature === DAEMON_KILLED_SIGNATURE when updated via the kill path arguments', async () => {
    process.env.MARS_REPO = repo

    const { DAEMON_KILLED_SIGNATURE } = (await import(
      '../../lib/retry-budget'
    )) as RetryBudgetModule

    const q = (await import('../../queue')) as unknown as QueueModule
    await q.initQueue()

    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
    // Simulate exactly what the server.ts kill loop now does.
    await q.updateTask(task.id, {
      status: 'failed',
      error: 'killed by `mars daemon kill`',
      failureSignature: DAEMON_KILLED_SIGNATURE,
    })

    const row = await q.getTask(task.id)
    expect(row).not.toBeNull()
    expect(row!.failureSignature).toBe('daemon-killed')
    expect(row!.status).toBe('failed')
    expect(row!.error).toBe('killed by `mars daemon kill`')
  })

  it('a task failed without a failureSignature has failureSignature === null', async () => {
    process.env.MARS_REPO = repo

    const q = (await import('../../queue')) as unknown as QueueModule
    await q.initQueue()

    const task = await q.enqueueTask('another task', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'failed',
      error: 'some other error',
    })

    const row = await q.getTask(task.id)
    expect(row).not.toBeNull()
    expect(row!.failureSignature).toBeNull()
  })
})
