import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  addBlockers: typeof import('../../queue').addBlockers
  addPendingReviewBlockers: typeof import('../../queue').addPendingReviewBlockers
}

interface InvariantModule {
  countBlockerEdges: typeof import('../blocker-invariant').countBlockerEdges
  hasBlockerEdge: typeof import('../blocker-invariant').hasBlockerEdge
  assertHasBlockerEdge: typeof import('../blocker-invariant').assertHasBlockerEdge
  assertNotRecoveryEdge: typeof import('../blocker-invariant').assertNotRecoveryEdge
  isRecoveryTask: typeof import('../blocker-invariant').isRecoveryTask
  scanRecoveryBlockerEdges: typeof import('../blocker-invariant').scanRecoveryBlockerEdges
  BlockerInvariantViolation: typeof import('../blocker-invariant').BlockerInvariantViolation
  RecoveryTaskBlockerError: typeof import('../blocker-invariant').RecoveryTaskBlockerError
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-blocker-invariant-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; inv: InvariantModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const inv = (await import(
    '../blocker-invariant'
  )) as unknown as InvariantModule
  return { q, inv }
}

describe('blocker-invariant', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('countBlockerEdges returns 0 for a task with no blockers', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('lonely', undefined, { skipTriage: true })
    expect(await inv.countBlockerEdges(t.id)).toBe(0)
    expect(await inv.hasBlockerEdge(t.id)).toBe(false)
  })

  it('countBlockerEdges returns the count once edges exist', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const b1 = await q.enqueueTask('blocker1', undefined, { skipTriage: true })
    const b2 = await q.enqueueTask('blocker2', undefined, { skipTriage: true })
    await q.addBlockers(t.id, [b1.id, b2.id])
    expect(await inv.countBlockerEdges(t.id)).toBe(2)
    expect(await inv.hasBlockerEdge(t.id)).toBe(true)
  })

  it('assertHasBlockerEdge throws BlockerInvariantViolation when zero edges', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('edgeless', undefined, { skipTriage: true })
    await expect(inv.assertHasBlockerEdge(t.id)).rejects.toBeInstanceOf(
      inv.BlockerInvariantViolation,
    )
  })

  it('assertHasBlockerEdge resolves quietly when at least one edge exists', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const b = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await q.addBlockers(t.id, [b.id])
    await expect(inv.assertHasBlockerEdge(t.id)).resolves.toBeUndefined()
  })

  it('BlockerInvariantViolation carries the taskId for callers to route to failed', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('edgeless', undefined, { skipTriage: true })
    try {
      await inv.assertHasBlockerEdge(t.id)
      throw new Error('expected throw')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(inv.BlockerInvariantViolation)
      if (err instanceof inv.BlockerInvariantViolation) {
        expect(err.taskId).toBe(t.id)
      }
    }
  })
})

/**
 * Test-only helper: hand-craft a recovery (fix) task row by directly
 * INSERTing into `tasks`. The real recovery-spawn path lives in
 * `upsertFixTask` and pulls in recipes, signatures, and store wiring we
 * don't need here — the leaf-node guard only cares about the row shape
 * (`kind='fix'` + non-null `fix_for_task_id`), so a raw INSERT keeps the
 * test focused.
 */
const insertFixTaskRow = async (
  q: QueueModule,
  fixForTaskId: string,
  id: string = `fix-${Math.random().toString(36).slice(2, 10)}`,
): Promise<string> => {
  const now = new Date().toISOString()
  await q.resolveQueueClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, origin_id, priority, created_at, updated_at) VALUES (?, ?, 'queued', 'fix', ?, ?, 0, ?, ?)`,
    args: [id, 'recovery prompt', fixForTaskId, fixForTaskId, now, now],
  })
  return id
}

describe('ADR-0040 recovery-leaf guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('isRecoveryTask matches kind=fix', async () => {
    const { inv } = await loadModules(repo)
    expect(inv.isRecoveryTask({ kind: 'fix', fixForTaskId: 'parent' })).toBe(true)
    expect(inv.isRecoveryTask({ kind: 'task', fixForTaskId: null })).toBe(false)
    expect(inv.isRecoveryTask({ kind: 'diagnose', fixForTaskId: null })).toBe(false)
  })

  it('isRecoveryTask falls back to non-null fixForTaskId when kind is absent', async () => {
    const { inv } = await loadModules(repo)
    expect(inv.isRecoveryTask({ kind: null, fixForTaskId: 'parent' })).toBe(true)
    expect(inv.isRecoveryTask({ fixForTaskId: 'parent' })).toBe(true)
    expect(inv.isRecoveryTask({})).toBe(false)
  })

  it('addBlockers rejects an edge whose task is a recovery', async () => {
    const { q, inv } = await loadModules(repo)
    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
    const fixId = await insertFixTaskRow(q, origin.id)
    const other = await q.enqueueTask('other', undefined, { skipTriage: true })
    await expect(q.addBlockers(fixId, [other.id])).rejects.toBeInstanceOf(
      inv.RecoveryTaskBlockerError,
    )
    try {
      await q.addBlockers(fixId, [other.id])
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(inv.RecoveryTaskBlockerError)
      if (err instanceof inv.RecoveryTaskBlockerError) {
        expect(err.role).toBe('task')
        expect(err.taskId).toBe(fixId)
      }
    }
  })

  it('addBlockers rejects an edge whose blocker is a recovery', async () => {
    const { q, inv } = await loadModules(repo)
    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
    const fixId = await insertFixTaskRow(q, origin.id)
    const other = await q.enqueueTask('other', undefined, { skipTriage: true })
    try {
      await q.addBlockers(other.id, [fixId])
      throw new Error('expected throw')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(inv.RecoveryTaskBlockerError)
      if (err instanceof inv.RecoveryTaskBlockerError) {
        expect(err.role).toBe('blocker')
        expect(err.taskId).toBe(fixId)
      }
    }
  })

  it('addBlockers writes a clean origin → origin edge', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const b = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await q.addBlockers(t.id, [b.id])
    expect(await inv.countBlockerEdges(t.id)).toBe(1)
  })

  it('addPendingReviewBlockers rejects recovery endpoints', async () => {
    const { q, inv } = await loadModules(repo)
    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
    const fixId = await insertFixTaskRow(q, origin.id)
    const candidate = await q.enqueueTask('candidate', undefined, {
      skipTriage: true,
    })
    await expect(
      q.addPendingReviewBlockers(candidate.id, [fixId]),
    ).rejects.toBeInstanceOf(inv.RecoveryTaskBlockerError)
  })

  it('cascade does not walk further when a recovery completes (none can exist)', async () => {
    // ADR-0040's cascade-no-recurse rule is structurally bounded: because no
    // recovery can be the task_id of any task_blockers row (guarded above),
    // a recovery completing has no dependents-of-dependents to walk. This
    // test pins that exact invariant: even after spawning a recovery,
    // querying for any task_blockers row pointing AWAY from it returns 0.
    const { q } = await loadModules(repo)
    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
    const fixId = await insertFixTaskRow(q, origin.id)
    // The legitimate origin → fix edge is what `upsertFixTask` would write;
    // we simulate it via a raw INSERT bypassing the guard so the assertion
    // below tests the leaf-side (no edges OUT of the recovery), not the
    // guard at the user-facing writers.
    const now = new Date().toISOString()
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [origin.id, fixId, now],
    })
    // No row where the recovery is itself the dependent (task_id).
    const r = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [fixId],
    })
    const n = (r.rows[0] as unknown as { n: number | bigint }).n
    expect(Number(n)).toBe(0)
  })

  it('scanRecoveryBlockerEdges reports nothing on a clean queue', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const b = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await q.addBlockers(t.id, [b.id])
    const violations = await inv.scanRecoveryBlockerEdges()
    expect(violations).toEqual([])
  })

  it('scanRecoveryBlockerEdges flags pre-existing illegal edges (backfill)', async () => {
    const { q, inv } = await loadModules(repo)
    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
    const fixId = await insertFixTaskRow(q, origin.id)
    const other = await q.enqueueTask('other', undefined, { skipTriage: true })
    // Bypass the user-facing guard to simulate a row inserted before the
    // ADR-0040 enforcement landed: raw INSERT both directions.
    const now = new Date().toISOString()
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [fixId, other.id, now],
    })
    const violations = await inv.scanRecoveryBlockerEdges()
    expect(violations).toHaveLength(1)
    expect(violations[0].taskId).toBe(fixId)
    expect(violations[0].taskIsRecovery).toBe(true)
    expect(violations[0].blockerIsRecovery).toBe(false)
  })
})
