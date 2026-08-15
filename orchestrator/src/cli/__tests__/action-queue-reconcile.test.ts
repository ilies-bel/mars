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
      kind: 'awaiting-human',
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
      kind: 'awaiting-human',
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
      kind: 'awaiting-human',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Stuck task item',
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
    expect(open[0].status).toBe('open')
  })

  it('closes open items with null origin_task_id whose payload.originTaskId is absent from tasks', async () => {
    const { store, ctx, queue, aq } = await loadModules()

    // Simulate an item raised before origin_task_id was populated — NULL column,
    // but originTaskId is in the payload JSON. The underlying task has since been
    // purged from the DB entirely.
    const purgedTaskId = 'mars-purged-orphan'
    await aq.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Orphaned item',
      body: 'Body',
      payload: { originTaskId: purgedTaskId },
      context: {},
      raisedBy: 'test',
      signature: 'sig-orphan',
      // No originTaskId — simulates the NULL column case.
    })

    // Verify the item exists with origin_task_id = NULL.
    const openBefore = await aq.listActionQueueItems('open')
    expect(openBefore).toHaveLength(1)

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'reconcile'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/closed 1 action queue item/)

    const openAfter = await aq.listActionQueueItems('open')
    expect(openAfter).toHaveLength(0)
  })

  it('leaves open items with null origin_task_id whose payload.originTaskId task still exists', async () => {
    const { store, ctx, queue, aq } = await loadModules()

    // Task is still in the DB (failed, not purged).
    const task = await queue.enqueueTask('live task', undefined)
    await queue.updateTask(task.id, { status: 'failed' })

    await aq.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Item for live task',
      body: 'Body',
      payload: { originTaskId: task.id },
      context: {},
      raisedBy: 'test',
      signature: 'sig-live',
    })

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'reconcile'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('nothing to reconcile')

    const open = await aq.listActionQueueItems('open')
    expect(open).toHaveLength(1)
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

describe('action-queue resolve', () => {
  it('resolves an open item by id, prints confirmation, and records history', async () => {
    const { store, ctx, aq } = await loadModules()

    const itemId = await aq.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Waiting for human',
      body: 'some body',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: 'sig-resolve-test',
    })

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(
      ['action-queue', 'resolve', itemId, '--reason', 'stale row, closing manually'],
      opts,
    )

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(`resolved ${itemId}`)

    // The item must now be resolved.
    const item = await aq.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.status).toBe('resolved')
    expect(item!.resolution).toBe('manual')
    expect(item!.resolutionNote).toBe('stale row, closing manually')
    // History must record the transition.
    const history = item!.history
    expect(history.length).toBeGreaterThanOrEqual(2)
    const closeEntry = history[history.length - 1]!
    expect(closeEntry.fromState).toBe('open')
    expect(closeEntry.toState).toBe('resolved')
    expect(closeEntry.by).toBe('operator:cli')
  })

  it('returns code 1 when the id does not match any item', async () => {
    const { store, ctx } = await loadModules()

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'resolve', 'nonexistent'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no action queue item matching nonexistent')
  })

  it('returns code 1 when the item is already resolved', async () => {
    const { store, ctx, aq } = await loadModules()

    const itemId = await aq.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Already resolved',
      body: 'already done',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: 'sig-already-resolved',
    })
    await aq.setActionQueueState(itemId, 'resolved', { resolution: 'manual', by: 'test' })

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'resolve', itemId], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('already resolved')
  })

  it('returns code 2 when no id is given', async () => {
    const { store, ctx } = await loadModules()

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'resolve'], opts)

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage:')
  })
})
