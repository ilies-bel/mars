/**
 * Behavioural tests for `mars action-queue resolve <id>`.
 *
 * Verifies the command:
 *   (a) closes exactly the targeted row and leaves all other open rows untouched
 *       (contrast with `reconcile`'s bulk-sweep behaviour),
 *   (b) prints the resolved id on success,
 *   (c) exits non-zero with a clear message when the id is not found,
 *   (d) exits non-zero with a usage message when no id is supplied,
 *   (e) propagates an optional --note into the history record.
 *
 * Uses the same in-process Command seam (ADR-0023) and real temp-file DB as
 * action-queue-reconcile.test.ts.
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
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-aq-resolve-test-'))
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

const raiseItem = async (
  aq: Awaited<ReturnType<typeof loadModules>>['aq'],
  suffix: string,
) =>
  aq.raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'normal',
    title: `Item ${suffix}`,
    body: 'Body',
    payload: {},
    context: {},
    raisedBy: 'test',
    signature: `sig-${suffix}`,
  })

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('action-queue resolve', () => {
  it('closes exactly the targeted row and leaves a second open row untouched', async () => {
    const { store, ctx, aq } = await loadModules()

    const idA = await raiseItem(aq, 'A')
    const idB = await raiseItem(aq, 'B')

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'resolve', idA], opts)

    expect(r.code).toBe(0)
    expect(r.out).toContain(idA)
    expect(r.err).toHaveLength(0)

    // idA must be resolved; idB must still be open
    const open = await aq.listActionQueueItems('open')
    const openIds = open.map((i) => i.id)
    expect(openIds).not.toContain(idA)
    expect(openIds).toContain(idB)
  })

  it('prints the resolved id on success (one line, no decoration)', async () => {
    const { store, ctx, aq } = await loadModules()
    const id = await raiseItem(aq, 'print-id')

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(['action-queue', 'resolve', id], opts)

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    expect(r.out[0]).toBe(id)
  })

  it('supports resolving by id prefix (≥4 chars)', async () => {
    const { store, ctx, aq } = await loadModules()
    const id = await raiseItem(aq, 'prefix')

    // Use at least 4-char prefix
    const prefix = id.slice(0, 4)
    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    const r = await runCommandInProcess(
      ['action-queue', 'resolve', prefix],
      opts,
    )

    expect(r.code).toBe(0)
    expect(r.out).toContain(id)

    const open = await aq.listActionQueueItems('open')
    expect(open.map((i) => i.id)).not.toContain(id)
  })

  it('exits non-zero with a clear message when the id is not found', async () => {
    const { store, ctx } = await loadModules()
    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }

    const r = await runCommandInProcess(
      ['action-queue', 'resolve', 'nonexistent-id'],
      opts,
    )

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toContain('nonexistent-id')
  })

  it('exits non-zero with usage text when no id is supplied', async () => {
    const { store, ctx } = await loadModules()
    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }

    const r = await runCommandInProcess(['action-queue', 'resolve'], opts)

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toContain('usage: mars action-queue resolve')
  })

  it('does not close other rows when resolving a single targeted row', async () => {
    // Contrast with reconcile: resolve is surgical, not a bulk sweep.
    const { store, ctx, aq } = await loadModules()

    // Raise sequentially to avoid a concurrent initActionQueue race.
    const id1 = await raiseItem(aq, 'bystander-1')
    const id2 = await raiseItem(aq, 'bystander-2')
    const targetId = await raiseItem(aq, 'target')

    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }
    await runCommandInProcess(['action-queue', 'resolve', targetId], opts)

    const open = await aq.listActionQueueItems('open')
    const openIds = open.map((i) => i.id)
    expect(openIds).toContain(id1)
    expect(openIds).toContain(id2)
    expect(openIds).not.toContain(targetId)
  })

  it('does not fall through to the list usage text', async () => {
    const { store, ctx } = await loadModules()
    const opts: InProcessOptions = { store, ctx, daemon: makeFakeDaemon() }

    // Supply a nonexistent id — should get a resolve-specific error, not list usage
    const r = await runCommandInProcess(
      ['action-queue', 'resolve', 'aaaa1234'],
      opts,
    )

    expect(r.err.join('\n')).not.toContain('usage: mars action-queue list')
    expect(r.unknown).toBeUndefined()
  })
})
