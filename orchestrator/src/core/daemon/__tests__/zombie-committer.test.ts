/**
 * Regression coverage for the 2026-07-30 zombie-committer deadlock.
 *
 * WHAT HAPPENED. A `main-commiter` recovery task was dispatched, then the
 * daemon was restarted 47 seconds later. The restart killed the committer's
 * worker process, but its row kept saying `status='running'`. Every subsequent
 * task that hit dirty-main then parked behind the corpse, logging
 * `attached to existing committer in status=running`. 23 tasks ended up blocked
 * on a task that could never reach `done`; the queue went to 0 queued /
 * 43 blocked and stayed there across restarts, and 21 blocker edges had to be
 * cleared by hand.
 *
 * THE DEFECT is the attach path, not the reap. Parking every dirty-main task
 * behind ONE committer is correct and deliberate — but only while that
 * committer can still finish. Attaching to a dead one converts a transient
 * condition into a permanent, queue-wide deadlock, and because every later task
 * attaches too, it is self-amplifying.
 *
 * The tests below pin the fix, plus the two properties it must not break:
 *  - "does not park behind a committer whose worker is gone" — before the fix
 *    the second source attached to the zombie (`spawned: false`).
 *  - "still attaches to a genuinely alive committer" — serialising behind one
 *    live committer must survive the fix, including for a committer that has
 *    legitimately been running for 45 minutes.
 *  - "attaches when liveness is unknown" — a process that does not own the
 *    workers must not declare one dead.
 *  - "requeue-stale-running has no main-commiter carve-out" — pins that the
 *    general stale-`running` boot reap treats a committer like any other task.
 *    Recorded because the incident was initially read as a reap carve-out; it
 *    is not one, and this test is the evidence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const makeDeps = (log: (l: string) => void = () => {}) => ({
  log,
  bus: new EventEmitter(),
  traceStore: null,
  handleProposalSlice: null,
})

/**
 * A clean git repo whose `.gitignore` swallows every `.mars*` path, so
 * `git status --porcelain` stays empty. Several helpers on the committer path
 * consult git working-tree state; a repo that reports itself dirty for
 * incidental test scaffolding would change their behaviour.
 */
const setupCleanRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-zombie-committer-'))
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
  const liveness = await import('../../lib/worker-liveness')
  const { nullTraceStore } = await import('../../lib/run-tool')
  return { queue, mainDirty, liveness, nullTraceStore }
}

/** Detection payload every call site passes once the branch is known dirty. */
const DIRTY = { dirty: true as const, statusOutput: ' M src/thing.ts\n' }

describe('zombie main-commiter', () => {
  let repo: string

  beforeEach(() => {
    repo = setupCleanRepo()
  })

  afterEach(async () => {
    // Drop the liveness probe so it never leaks into a neighbouring suite.
    const liveness = await import('../../lib/worker-liveness')
    liveness.setWorkerLivenessProbe(null)
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── the boot reap has no committer carve-out ─────────────────────────────

  it('requeue-stale-running reaps a running main-commiter like any other task', async () => {
    const { queue, mainDirty, nullTraceStore } = await loadModules(repo)
    const { RECONCILERS } = await import('../reconcilers')

    const src = await queue.enqueueTask('carve-out-src', undefined, { skipTriage: true })
    const { fixTaskId } = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(fixTaskId, { status: 'running' })

    const reap = RECONCILERS.find((r) => r.name === 'requeue-stale-running')
    expect(reap).toBeDefined()
    const summary = await reap!.run(makeDeps() as never)

    // No exclusion for kind='fix' or for the main-commiter recovery_payload:
    // a daemon that has just started owns every worker it spawned and has
    // spawned none, so a `running` committer at boot is stale like anything
    // else and is re-queued from setup.
    expect(summary.runningRequeued).toBe(1)
    expect((await queue.getTask(fixTaskId))?.status).toBe('queued')
    // The dependent stays parked — the committer is coming back, not dying.
    expect((await queue.getTask(src.id))?.status).toBe('blocked')
  })

  // ── the attach path ──────────────────────────────────────────────────────

  it('does not park behind a committer whose worker is gone; reaps and replaces it', async () => {
    const { queue, mainDirty, liveness, nullTraceStore } = await loadModules(repo)

    // First source spawns the committer and parks behind it.
    const src1 = await queue.enqueueTask('zombie-src-one', undefined, { skipTriage: true })
    const first = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    expect(first.spawned).toBe(true)
    expect((await queue.getTask(src1.id))?.status).toBe('blocked')

    // The committer is dispatched (row says running) and then its daemon is
    // restarted: the worker process dies, the row does not change.
    await queue.updateTask(first.fixTaskId, { status: 'running' })
    // Age the row past the race-suppressing grace window. This is not a work
    // timeout — a live committer is classified alive by the probe regardless of
    // row age; the grace only covers dispatcher write/commit races.
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = ?`,
      args: [first.fixTaskId],
    })

    // The daemon is up and positively reports that it holds no worker for it.
    liveness.setWorkerLivenessProbe(() => false)

    const src2 = await queue.enqueueTask('zombie-src-two', undefined, { skipTriage: true })
    const second = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })

    // A fresh committer took over instead of a second corpse-attachment.
    expect(second.spawned).toBe(true)
    expect(second.fixTaskId).not.toBe(first.fixTaskId)
    expect(second.reapedZombieCommitterId).toBe(first.fixTaskId)

    // The zombie was reaped through the audited seam — failed, not deleted, so
    // no dependent is left holding a dangling blocker edge.
    const zombie = await queue.getTask(first.fixTaskId)
    expect(zombie?.status).toBe('failed')
    expect(zombie?.failureReasonCode).toBe(mainDirty.COMMITTER_WORKER_VANISHED_CODE)

    // The first source did not stay stranded on the corpse: it was reparented
    // onto the replacement committer, which can still reach `done`.
    const edges = await queue.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id AS b FROM task_blockers WHERE task_id = ?`,
      args: [src1.id],
    })
    const blockers = (edges.rows as unknown as Array<{ b: string }>).map((r) => r.b)
    expect(blockers).toContain(second.fixTaskId)
    expect(blockers).not.toContain(first.fixTaskId)
  })

  it('still attaches to a genuinely alive committer and keeps serialising dependents', async () => {
    const { queue, mainDirty, liveness, nullTraceStore } = await loadModules(repo)

    const src1 = await queue.enqueueTask('alive-src-one', undefined, { skipTriage: true })
    const first = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(first.fixTaskId, { status: 'running' })

    // Age the row well past the grace window so the ONLY thing keeping this
    // committer attachable is the liveness signal — a legitimately long
    // main-committer run must never be reaped for being slow.
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = NOW() - INTERVAL '45 minutes' WHERE id = ?`,
      args: [first.fixTaskId],
    })

    // The daemon reports a live worker for the committer.
    liveness.setWorkerLivenessProbe((taskId) => taskId === first.fixTaskId)

    const src2 = await queue.enqueueTask('alive-src-two', undefined, { skipTriage: true })
    const second = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })

    // Attached, not replaced: one committer per dirty branch is the point.
    expect(second.spawned).toBe(false)
    expect(second.fixTaskId).toBe(first.fixTaskId)
    expect(second.attachedToStatus).toBe('running')
    expect(second.reapedZombieCommitterId).toBeNull()

    // Both dependents are serialised behind that one live committer.
    expect((await queue.getTask(first.fixTaskId))?.status).toBe('running')
    expect((await queue.getTask(src1.id))?.status).toBe('blocked')
    expect((await queue.getTask(src2.id))?.status).toBe('blocked')
  })

  it('attaches when liveness is unknown (no daemon installed the probe)', async () => {
    const { queue, mainDirty, nullTraceStore } = await loadModules(repo)

    const src1 = await queue.enqueueTask('unknown-src-one', undefined, { skipTriage: true })
    const first = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(first.fixTaskId, { status: 'running' })
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = ?`,
      args: [first.fixTaskId],
    })

    // No probe installed: this process does not own the workers, so it has no
    // standing to declare one dead. Behaviour must be unchanged (attach).
    const src2 = await queue.enqueueTask('unknown-src-two', undefined, { skipTriage: true })
    const second = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    expect(second.spawned).toBe(false)
    expect(second.fixTaskId).toBe(first.fixTaskId)
  })
})
