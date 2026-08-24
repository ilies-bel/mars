import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('./queue').enqueueTask
  addBlockers: typeof import('./queue').addBlockers
  getTask: typeof import('./queue').getTask
  resolveQueueClient: typeof import('./queue').resolveQueueClient
  ensureQueueSchema: typeof import('./queue').ensureQueueSchema
}

interface ArcModule {
  Arc: typeof import('./arc').Arc
}

interface BlockerResolutionModule {
  ORPHANED_ORIGIN_FAILURE_REASON: typeof import('./lib/blocker-resolution-primitives').ORPHANED_ORIGIN_FAILURE_REASON
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-reparent-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; arc: ArcModule; br: BlockerResolutionModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('./queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const arc = (await import('./arc')) as unknown as ArcModule
  const br = (await import('./lib/blocker-resolution-primitives')) as unknown as BlockerResolutionModule
  return { q, arc, br }
}

/** Raw `origin_id` column value — `getTask` coalesces NULL to the row's own id. */
const rawOriginId = async (q: QueueModule, id: string): Promise<string | null> => {
  const res = await q.resolveQueueClient().execute({
    sql: `SELECT origin_id FROM tasks WHERE id = ?`,
    args: [id],
  })
  if (res.rows.length === 0) return null
  return (res.rows[0] as unknown as { origin_id: string | null }).origin_id
}

const blockOn = async (
  q: QueueModule,
  taskId: string,
  blockerTaskId: string,
): Promise<void> => {
  await q.addBlockers(taskId, [blockerTaskId])
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
    args: [taskId],
  })
}

/**
 * PGlite boots from disk on the first query of a freshly-imported module graph,
 * and the vitest config documents that cold start as 5-25 s (longer when several
 * task worktrees run their suites at once). Paying it per test — `beforeEach` +
 * `vi.resetModules()` — put all three cases at or past the 30 s `testTimeout`
 * and wedged one mid-transaction, which then poisoned the next test with
 * `atomic() cannot be nested`. One shared repo + module graph for the whole file
 * pays that cost once. The cases stay independent because every fixture id comes
 * from `enqueueTask`, so no two of them can collide on a row.
 */
const COLD_START_TIMEOUT_MS = 120_000

describe('Arc.drop — dangling origin_id reparenting', () => {
  let repo: string
  let q: QueueModule
  let arc: ArcModule
  let br: BlockerResolutionModule

  beforeAll(async () => {
    repo = setupRepo()
    ;({ q, arc, br } = await loadModules(repo))
  }, COLD_START_TIMEOUT_MS)

  afterAll(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reparents a blocked row that names the dropped task as origin_id, reports it, and does not fail it later when its unrelated blocker settles', async () => {
    // Reproduces the mars-eb5eab63 report end to end:
    //   P — arc root, dropped after its work landed elsewhere
    //   D — origin_id = P.id, blocked on B (an UNRELATED blocker; D is not a
    //       task_blockers dependent of P at all, so the drop's orphan pre-pass
    //       never sees it)
    //   B — the unrelated blocker that settles later
    //
    // Before the fix: drop(P) reported edges=0in/0out and said nothing; half an
    // hour later B completed and the unblock path failed D with
    // `orphaned_origin_at_unblock`.
    const P = await q.enqueueTask('origin task, work landed elsewhere', undefined, {
      skipTriage: true,
    })
    const B = await q.enqueueTask('unrelated blocker', undefined, { skipTriage: true })
    const D = await q.enqueueTask('dependent carrying P as origin', undefined, {
      skipTriage: true,
      originId: P.id,
    })
    await blockOn(q, D.id, B.id)

    // Precondition: D names P as its origin and is blocked only on B.
    expect(await rawOriginId(q, D.id)).toBe(P.id)
    expect((await q.getTask(D.id))?.status).toBe('blocked')

    // ── drop P ───────────────────────────────────────────────────────────────
    const result = await arc.Arc.load(P.id).drop()

    // The drop must REPORT what it did to the origin references — silence is
    // what made this expensive.
    expect(result.originsReparented).toEqual([D.id])
    // No task_blockers edge ever existed between D and P, so the edge counters
    // stay at zero: origin references are a separate accounting line.
    expect(result.edgesRemoved).toEqual({ incoming: 0, outgoing: 0 })

    // P is gone, and D no longer points at it. P was an arc root, so D becomes
    // its own arc root.
    expect(await q.getTask(P.id)).toBeNull()
    expect(await rawOriginId(q, D.id)).toBe(D.id)

    // D is untouched otherwise — still blocked on B.
    expect((await q.getTask(D.id))?.status).toBe('blocked')

    // ── B settles 30 minutes later ───────────────────────────────────────────
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [B.id],
    })
    await arc.Arc.unblockByCompletion(B.id)

    // D must be released, NOT failed with orphaned_origin_at_unblock.
    const afterUnblock = await q.getTask(D.id)
    expect(afterUnblock?.status).toBe('queued')
    expect(afterUnblock?.failureReason).not.toBe(br.ORPHANED_ORIGIN_FAILURE_REASON)
    // Its blocker edges survived (the orphan guard clears them on the way out).
    const edges = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [D.id],
    })
    expect(Number((edges.rows[0] as unknown as { n: number | bigint }).n)).toBe(1)
  })

  it('chains dependents up to the dropped task’s own origin when it was not an arc root', async () => {
    // G ← P ← D: dropping the middle member must not orphan D. It inherits P's
    // origin (G) so arc membership is preserved rather than reset.
    const G = await q.enqueueTask('grandparent arc root', undefined, { skipTriage: true })
    const P = await q.enqueueTask('arc member to drop', undefined, {
      skipTriage: true,
      originId: G.id,
    })
    const B = await q.enqueueTask('unrelated blocker', undefined, { skipTriage: true })
    const D = await q.enqueueTask('dependent carrying P as origin', undefined, {
      skipTriage: true,
      originId: P.id,
    })
    await blockOn(q, D.id, B.id)

    const result = await arc.Arc.load(P.id).drop()

    expect(result.originsReparented).toEqual([D.id])
    expect(await rawOriginId(q, D.id)).toBe(G.id)
  })

  it('leaves terminal rows that name the dropped task as origin alone', async () => {
    // A done/failed row cannot be dispatched again, so its stale origin_id is
    // inert — reparenting it would rewrite history for no benefit.
    const P = await q.enqueueTask('task to drop', undefined, { skipTriage: true })
    const T = await q.enqueueTask('already-done arc member', undefined, {
      skipTriage: true,
      originId: P.id,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [T.id],
    })

    const result = await arc.Arc.load(P.id).drop()

    expect(result.originsReparented).toEqual([])
    expect(await rawOriginId(q, T.id)).toBe(P.id)
  })
})
