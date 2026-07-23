/**
 * Regression coverage for the `failed-committer-dependent-release` reconciler
 * (reconcilers.ts). It replays the interrupted on-failure fan-out for a shared
 * `main-commiter` recovery: when the in-line handler in `updateTaskWithEvents`
 * never released the committer's dependents (a crash, or — the 2026-07-23
 * incident — a DB deadlock whose error was swallowed), the dependents are left
 * `blocked` on a dead committer forever once main goes clean, because the
 * on-spawn `reparentStrandedDependentsOntoNewCommitter` rescue only fires when a
 * NEW committer spawns (which never happens on a clean branch). This reconciler
 * is the startup self-heal for that gap.
 *
 * Uses the `vi.resetModules()` + fresh-import isolation pattern from
 * startup-reconcile.test.ts so `resolveContext`/getRepoRoot (which the
 * reconciler consults for the git-clean guard) resolve against THIS test's
 * MARS_REPO rather than a leaked process-wide cache.
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

// A clean git repo: an initial commit plus a `.gitignore` that ignores every
// `.mars*` path so `git status --porcelain` stays empty. The release guard
// inside `releaseMainCommitterDependents` only re-queues dependents when main is
// clean — and the PGlite test backend materialises a `.mars.pglite/` data dir
// alongside `.mars/`, so both must be ignored.
const setupCleanRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-failed-committer-reconcile-'))
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
  const reconciler = RECONCILERS.find(
    (r) => r.name === 'failed-committer-dependent-release',
  )
  return { queue, mainDirty, nullTraceStore, reconciler }
}

describe('failed-committer-dependent-release reconciler', () => {
  let repo: string

  beforeEach(() => {
    repo = setupCleanRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('is registered', async () => {
    const { reconciler } = await loadModules(repo)
    expect(reconciler).toBeDefined()
  })

  it('releases every dependent of a failed main-commiter when main is clean', async () => {
    const { queue, mainDirty, nullTraceStore, reconciler } = await loadModules(repo)

    const src1 = await queue.enqueueTask('recon-one', undefined, { skipTriage: true })
    const src2 = await queue.enqueueTask('recon-two', undefined, { skipTriage: true })
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

    // Committer fails. We do NOT invoke the on-failure release — the dependents
    // stay stranded exactly as they were after the deadlock storm.
    await queue.updateTask(res.fixTaskId, { status: 'failed', error: 'verify failed' })
    expect((await queue.getTask(src1.id))?.status).toBe('blocked')
    expect((await queue.getTask(src2.id))?.status).toBe('blocked')

    await reconciler!.run(makeDeps())

    // Both cohort members re-queued; the dead committer's edges are gone.
    expect((await queue.getTask(src1.id))?.status).toBe('queued')
    expect((await queue.getTask(src2.id))?.status).toBe('queued')
    const edges = await queue.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ?`,
      args: [res.fixTaskId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('keeps dependents blocked while main is still dirty', async () => {
    const { queue, mainDirty, nullTraceStore, reconciler } = await loadModules(repo)

    const src = await queue.enqueueTask('dirty-recon', undefined, { skipTriage: true })
    const res = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(res.fixTaskId, { status: 'failed', error: 'verify failed' })

    // Make main dirty (a tracked, staged change git status reports).
    writeFileSync(resolve(repo, 'leftover.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', 'leftover.ts'], { cwd: repo })

    await reconciler!.run(makeDeps())

    // Guard keeps the dependent blocked so re-queuing does not churn behind a
    // fresh committer while main is still dirty.
    expect((await queue.getTask(src.id))?.status).toBe('blocked')
  })

  it('is a no-op when a failed fix task is not a main-commiter', async () => {
    const { queue, reconciler } = await loadModules(repo)

    // A plain (non-committer) failed fix task with a blocked dependent: the
    // reconciler must skip it (no recovery_payload → not a main-commiter).
    const origin = await queue.enqueueTask('origin', undefined, { skipTriage: true })
    const now = new Date().toISOString()
    const fixId = `fix-plain-${Math.random().toString(36).slice(2, 8)}`
    await queue.resolveQueueClient().execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, origin_id, priority, created_at, updated_at) VALUES (?, ?, 'failed', 'fix', ?, ?, 0, ?, ?)`,
      args: [fixId, 'plain fix', origin.id, origin.id, now, now],
    })
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [origin.id],
    })
    await queue.resolveQueueClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [origin.id, fixId, now],
    })

    await reconciler!.run(makeDeps())

    // Untouched — plain recovery failures are handled by the escalation path,
    // not the committer fan-out.
    expect((await queue.getTask(origin.id))?.status).toBe('blocked')
  })
})
