/**
 * Regression coverage for the `queued-committer-reseed` reconciler
 * (reconcilers.ts). It re-seeds `main-commiter` fix tasks stuck in `queued`
 * with blocked dependents whose `updated_at` exceeds the 15-minute stale
 * threshold. Mirrors the setup used by `failed-committer-reconcile.test.ts`.
 *
 * Incident context (2026-07-25 → 07-26): a fresh main-committer was spawned
 * during `dispatchImplement` but its `task.queued` bus event was never emitted,
 * so it sat in `queued` for 14 hours with 91 blocked dependents. The primary
 * fix is in `dispatchImplement` (now emits `task.queued` on spawn). This
 * reconciler is the periodic/boot-time safety net for any remaining gap.
 *
 * Test cases:
 * - A stale queued main-commiter with blocked dependents emits task.queued.
 * - A fresh queued committer (under threshold) is left alone.
 * - A non-committer fix task in queued is ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const noopLog = (): void => {}

const makeDeps = () => ({
  log: noopLog,
  bus: new EventEmitter(),
  traceStore: null,
  handleProposalSlice: null,
})

const setupCleanRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-queued-committer-reconcile-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, '.gitignore'), '.mars*\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = await import('../../queue')
  await queue.migrateQueueSchema()
  const mainDirty = await import('../../lib/main-dirty')
  const { nullTraceStore } = await import('../../lib/run-tool')
  const { RECONCILERS } = await import('../reconcilers')
  const reconciler = RECONCILERS.find((r) => r.name === 'queued-committer-reseed')
  return { queue, mainDirty, nullTraceStore, reconciler }
}

describe('queued-committer-reseed reconciler', () => {
  let repo: string

  beforeEach(() => {
    repo = setupCleanRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('is registered in the RECONCILERS array', async () => {
    const { reconciler } = await loadModules(repo)
    expect(reconciler).toBeDefined()
  })

  it('emits task.queued for a stale queued main-commiter with blocked dependents', async () => {
    const { queue, mainDirty, nullTraceStore, reconciler } = await loadModules(repo)

    const src1 = await queue.enqueueTask('stale-src-one', undefined, { skipTriage: true })
    const src2 = await queue.enqueueTask('stale-src-two', undefined, { skipTriage: true })
    const detection = { dirty: true as const, statusOutput: '' }

    const res = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })

    // Committer is still queued — the dispatch loop never picked it up.
    expect((await queue.getTask(res.fixTaskId))?.status).toBe('queued')

    // Back-date updated_at to simulate a 20-minute stale committer (> threshold).
    const staleTime = new Date(Date.now() - 20 * 60_000).toISOString()
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [staleTime, res.fixTaskId],
    })

    const deps = makeDeps()
    const emitted: string[] = []
    deps.bus.on('task.queued', (e: { taskId: string }) => emitted.push(e.taskId))

    await reconciler!.run(deps)

    // The stale committer was re-seeded via task.queued.
    expect(emitted).toContain(res.fixTaskId)
    // The dependents remain blocked (the reconciler only re-seeds; dispatch unblocks them).
    expect((await queue.getTask(src1.id))?.status).toBe('blocked')
    expect((await queue.getTask(src2.id))?.status).toBe('blocked')
  })

  it('does NOT emit task.queued for a fresh queued committer (under threshold)', async () => {
    const { queue, mainDirty, nullTraceStore, reconciler } = await loadModules(repo)

    const src = await queue.enqueueTask('fresh-src', undefined, { skipTriage: true })
    const res = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })

    // Leave updated_at at the default (just now) — under the 15-min threshold.
    expect((await queue.getTask(res.fixTaskId))?.status).toBe('queued')

    const deps = makeDeps()
    const emitted: string[] = []
    deps.bus.on('task.queued', (e: { taskId: string }) => emitted.push(e.taskId))

    await reconciler!.run(deps)

    // Fresh committer must be left alone — it's within the threshold window.
    expect(emitted).not.toContain(res.fixTaskId)
  })

  it('ignores a non-committer fix task in queued status', async () => {
    const { queue, reconciler } = await loadModules(repo)

    // A plain queued fix task with a blocked dependent but no recovery_payload.
    const origin = await queue.enqueueTask('plain-origin', undefined, { skipTriage: true })
    const staleTime = new Date(Date.now() - 20 * 60_000).toISOString()
    const fixId = `fix-plain-${Math.random().toString(36).slice(2, 8)}`
    await queue.resolveQueueClient().execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, origin_id, priority, created_at, updated_at) VALUES (?, ?, 'queued', 'fix', ?, ?, 0, ?, ?)`,
      args: [fixId, 'plain fix', origin.id, origin.id, staleTime, staleTime],
    })
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [origin.id],
    })
    await queue.resolveQueueClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [origin.id, fixId, staleTime],
    })

    const deps = makeDeps()
    const emitted: string[] = []
    deps.bus.on('task.queued', (e: { taskId: string }) => emitted.push(e.taskId))

    await reconciler!.run(deps)

    // Plain fix tasks without a main-commiter payload must be ignored.
    expect(emitted).not.toContain(fixId)
    expect((await queue.getTask(origin.id))?.status).toBe('blocked')
  })
})
