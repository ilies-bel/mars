/**
 * Behavioural tests for `mars action-queue reconcile`.
 *
 * Verifies the command:
 *   (a) routes without falling through to the list usage path,
 *   (b) closes open items whose origin task is terminal (done/dropped),
 *   (c) leaves open items for non-terminal tasks (failed, queued) untouched.
 *
 * Uses the same in-process Command seam (ADR-0023) as command-seam.test.ts,
 * backed by a real temp-file DB so the underlying reconcile SQL is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-aq-reconcile-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/** Fresh module set pointed at the current `repo`. */
const loadModules = async () => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store')
  const contextModule = await import('../../core/context')
  const aqModule = await import('../../core/lib/action-queue')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
    queue: queueModule,
    aq: aqModule,
  }
}

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('action-queue reconcile', () => {
  it('returns code 0 and reports nothing when the queue is already consistent', async () => {
    const { store, ctx } = await loadModules()
    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }

    const r = await runCommandInProcess(['action-queue', 'reconcile'], opts)

    expect(r.code).toBe(0)
    expect(r.unknown).toBeUndefined()
    expect(r.out.join('\n')).toContain('nothing to reconcile')
  })

  it('closes open items for done tasks and prints the count', async () => {
    const { store, ctx, queue, aq } = await loadModules()

    const task = await queue.enqueueTask('finish me', undefined)
    await queue.updateTask(task.id, { status: 'done' })

    await aq.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Some item',
      body: 'Body',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: 'sig-done',
      originTaskId: task.id,
    })

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'reconcile'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/closed 1 action queue item/)
    // Confirm the item is no longer open.
    const open = await aq.listActionQueueItems('open')
    expect(open).toHaveLength(0)
  })

  it('closes open items for dropped tasks', async () => {
    const { store, ctx, queue, aq } = await loadModules()

    const task = await queue.enqueueTask('dropped task', undefined)
    await queue.updateTask(task.id, { status: 'dropped' })

    await aq.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Dropped item',
      body: 'Body',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: 'sig-dropped',
      originTaskId: task.id,
    })

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'reconcile'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/closed 1 action queue item/)
  })

  it('leaves open items for failed tasks untouched', async () => {
    const { store, ctx, queue, aq } = await loadModules()

    const task = await queue.enqueueTask('stuck task', undefined)
    await queue.updateTask(task.id, { status: 'failed' })

    await aq.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Failed item',
      body: 'Body',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: 'sig-failed',
      originTaskId: task.id,
    })

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'reconcile'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('nothing to reconcile')

    // Item must still be open.
    const open = await aq.listActionQueueItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].state).toBe('open')
  })

  it('does not fall through to the list usage text', async () => {
    const { store, ctx } = await loadModules()
    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }

    const r = await runCommandInProcess(['action-queue', 'reconcile'], opts)

    // Must not print the list usage/error text.
    expect(r.err.join('\n')).not.toContain('usage: mars action-queue list')
    expect(r.unknown).toBeUndefined()
  })
})
