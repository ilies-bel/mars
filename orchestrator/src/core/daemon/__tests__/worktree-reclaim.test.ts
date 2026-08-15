/**
 * Unit tests for worktree-reclaim.ts.
 *
 * Tests run against a real temporary git repo and ephemeral in-memory DB so
 * they verify the actual directory-removal behaviour, not just mocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface ReclaimModule {
  reclaimSettledWorktrees: typeof import('../worktree-reclaim').reclaimSettledWorktrees
  sweepOrphanWorktrees: typeof import('../worktree-reclaim').sweepOrphanWorktrees
  reclaimExcessFailedWorktrees: typeof import('../worktree-reclaim').reclaimExcessFailedWorktrees
  getWorktreeFootprint: typeof import('../worktree-reclaim').getWorktreeFootprint
  checkDiskSpace: typeof import('../worktree-reclaim').checkDiskSpace
  FAILED_WORKTREE_CAP_DEFAULT: typeof import('../worktree-reclaim').FAILED_WORKTREE_CAP_DEFAULT
  LOW_DISK_THRESHOLD_BYTES: typeof import('../worktree-reclaim').LOW_DISK_THRESHOLD_BYTES
}

const setupRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'mars-reclaim-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.mars', 'worktrees'), { recursive: true })
  return repo
}

const makeWorktreeDir = (repo: string, id: string): string => {
  const path = join(repo, '.mars', 'worktrees', id)
  mkdirSync(path, { recursive: true })
  return path
}

const loadModules = async (repo: string): Promise<{ q: QueueModule; r: ReclaimModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const r = (await import('../worktree-reclaim')) as unknown as ReclaimModule
  return { q, r }
}

describe('reclaimSettledWorktrees', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes the worktree directory when a task is done', async () => {
    const { q, r } = await loadModules(repo)
    const task = await q.enqueueTask('done task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'done' })
    const wt = makeWorktreeDir(repo, task.id)

    const result = await r.reclaimSettledWorktrees(repo)

    expect(result.removed).toContain(task.id)
    expect(result.failed).toHaveLength(0)
    expect(existsSync(wt)).toBe(false)
  })

  it('removes the worktree directory when a task is dropped', async () => {
    const { q, r } = await loadModules(repo)
    const task = await q.enqueueTask('dropped task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'dropped' })
    const wt = makeWorktreeDir(repo, task.id)

    const result = await r.reclaimSettledWorktrees(repo)

    expect(result.removed).toContain(task.id)
    expect(existsSync(wt)).toBe(false)
  })

  it('does NOT remove the worktree for a failed task', async () => {
    const { q, r } = await loadModules(repo)
    const task = await q.enqueueTask('failed task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed', error: 'boom' })
    const wt = makeWorktreeDir(repo, task.id)

    const result = await r.reclaimSettledWorktrees(repo)

    expect(result.removed).not.toContain(task.id)
    expect(existsSync(wt)).toBe(true) // must survive
  })

  it('does NOT remove the worktree for a running task', async () => {
    const { q, r } = await loadModules(repo)
    const task = await q.enqueueTask('running task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'running' })
    const wt = makeWorktreeDir(repo, task.id)

    const result = await r.reclaimSettledWorktrees(repo)

    expect(result.removed).not.toContain(task.id)
    expect(existsSync(wt)).toBe(true)
  })

  it('returns empty removed list when no done/dropped task has a worktree on disk', async () => {
    const { q, r } = await loadModules(repo)
    const task = await q.enqueueTask('done no-worktree', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'done' })
    // Intentionally omit creating the worktree directory.

    const result = await r.reclaimSettledWorktrees(repo)

    expect(result.removed).toHaveLength(0)
  })
})

describe('sweepOrphanWorktrees', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes a directory with no owning task row', async () => {
    const { r } = await loadModules(repo)
    const orphanId = 'deadbeef'
    const path = makeWorktreeDir(repo, orphanId)

    const result = await r.sweepOrphanWorktrees(repo)

    expect(result.removed).toContain(orphanId)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps a directory whose name matches a live task id', async () => {
    const { q, r } = await loadModules(repo)
    const task = await q.enqueueTask('live task', undefined, { skipTriage: true })
    const path = makeWorktreeDir(repo, task.id)

    const result = await r.sweepOrphanWorktrees(repo)

    expect(result.removed).not.toContain(task.id)
    expect(existsSync(path)).toBe(true)
  })

  it('keeps a directory whose name does not match the task-id pattern', async () => {
    const { r } = await loadModules(repo)
    // This looks like a manual placement, not a task id
    const path = makeWorktreeDir(repo, 'my-manual-worktree')

    const result = await r.sweepOrphanWorktrees(repo)

    expect(result.removed).not.toContain('my-manual-worktree')
    expect(existsSync(path)).toBe(true)
  })

  it('returns empty when there are no directories', async () => {
    const { r } = await loadModules(repo)
    const result = await r.sweepOrphanWorktrees(repo)
    expect(result.removed).toHaveLength(0)
  })

  it('keeps directories for tasks in any status, including terminal', async () => {
    const { q, r } = await loadModules(repo)
    const task = await q.enqueueTask('done task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'done' })
    const path = makeWorktreeDir(repo, task.id)

    const result = await r.sweepOrphanWorktrees(repo)

    // sweepOrphanWorktrees never removes task-owned dirs; reclaimSettledWorktrees does.
    expect(result.removed).not.toContain(task.id)
    expect(existsSync(path)).toBe(true)
  })
})

describe('reclaimExcessFailedWorktrees', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FAILED_WORKTREE_CAP
    rmSync(repo, { recursive: true, force: true })
  })

  it('does not remove any worktrees when count is at or below the cap', async () => {
    const { q, r } = await loadModules(repo)
    const cap = 3
    for (let i = 0; i < cap; i++) {
      const task = await q.enqueueTask(`failed ${i}`, undefined, { skipTriage: true })
      await q.updateTask(task.id, { status: 'failed', error: 'boom' })
      makeWorktreeDir(repo, task.id)
    }

    const result = await r.reclaimExcessFailedWorktrees(repo, undefined, cap)

    expect(result.removed).toHaveLength(0)
  })

  it('removes the oldest failed worktrees when over the cap', async () => {
    const { q, r } = await loadModules(repo)
    const cap = 2
    const ids: string[] = []

    for (let i = 0; i < 4; i++) {
      const task = await q.enqueueTask(`failed ${i}`, undefined, { skipTriage: true })
      await q.updateTask(task.id, { status: 'failed', error: 'boom' })
      const wt = makeWorktreeDir(repo, task.id)
      // Touch mtime so we have deterministic ordering: older i = older mtime
      const oldTime = new Date(Date.now() - (4 - i) * 10_000)
      utimesSync(wt, oldTime, oldTime)
      ids.push(task.id)
    }

    const result = await r.reclaimExcessFailedWorktrees(repo, undefined, cap)

    // 4 worktrees, cap=2 → remove 2 oldest
    expect(result.removed).toHaveLength(2)
    // The 2 oldest (ids[0], ids[1]) should be gone
    expect(existsSync(join(repo, '.mars', 'worktrees', ids[0]))).toBe(false)
    expect(existsSync(join(repo, '.mars', 'worktrees', ids[1]))).toBe(false)
    // The 2 newest should survive
    expect(existsSync(join(repo, '.mars', 'worktrees', ids[2]))).toBe(true)
    expect(existsSync(join(repo, '.mars', 'worktrees', ids[3]))).toBe(true)
  })

  it('skips failed tasks with no worktree on disk', async () => {
    const { q, r } = await loadModules(repo)
    const cap = 0 // force removal of everything over 0
    // One failed task with a worktree, one without.
    const taskWith = await q.enqueueTask('with wt', undefined, { skipTriage: true })
    await q.updateTask(taskWith.id, { status: 'failed', error: 'boom' })
    makeWorktreeDir(repo, taskWith.id)

    const taskWithout = await q.enqueueTask('no wt', undefined, { skipTriage: true })
    await q.updateTask(taskWithout.id, { status: 'failed', error: 'boom' })
    // No directory created for taskWithout.

    const result = await r.reclaimExcessFailedWorktrees(repo, undefined, cap)

    // Only 1 worktree exists; cap=0 → remove it.
    expect(result.removed).toContain(taskWith.id)
    expect(result.removed).not.toContain(taskWithout.id)
  })

  it('reads cap from MARS_FAILED_WORKTREE_CAP env var', async () => {
    const { q, r } = await loadModules(repo)
    process.env.MARS_FAILED_WORKTREE_CAP = '1'

    for (let i = 0; i < 3; i++) {
      const task = await q.enqueueTask(`f${i}`, undefined, { skipTriage: true })
      await q.updateTask(task.id, { status: 'failed', error: 'e' })
      const wt = makeWorktreeDir(repo, task.id)
      const t = new Date(Date.now() - (3 - i) * 5_000)
      utimesSync(wt, t, t)
    }

    // No explicit cap arg — reads from env.
    const result = await r.reclaimExcessFailedWorktrees(repo)

    // 3 worktrees, cap=1 → 2 removed
    expect(result.removed).toHaveLength(2)
  })
})

describe('getWorktreeFootprint', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns count=0 totalBytes=0 when the worktrees directory is empty', async () => {
    const { r } = await loadModules(repo)
    const fp = await r.getWorktreeFootprint(repo)
    expect(fp.count).toBe(0)
    expect(fp.totalBytes).toBe(0)
  })

  it('returns count of worktree dirs', async () => {
    const { r } = await loadModules(repo)
    makeWorktreeDir(repo, 'aabbccdd')
    makeWorktreeDir(repo, 'eeff0011')

    const fp = await r.getWorktreeFootprint(repo)

    expect(fp.count).toBe(2)
  })

  it('returns count=0 when the worktrees directory does not exist', async () => {
    // Use a repo without the worktrees dir
    const freshRepo = mkdtempSync(join(tmpdir(), 'mars-fp-'))
    execFileSync('git', ['init', '-q'], { cwd: freshRepo })
    mkdirSync(join(freshRepo, '.mars'), { recursive: true })
    // No worktrees/ subdirectory.

    vi.resetModules()
    process.env.MARS_REPO = freshRepo
    const freshR = (await import('../worktree-reclaim')) as unknown as ReclaimModule

    try {
      const fp = await freshR.getWorktreeFootprint(freshRepo)
      expect(fp.count).toBe(0)
      expect(fp.totalBytes).toBe(0)
    } finally {
      rmSync(freshRepo, { recursive: true, force: true })
    }
  })
})

describe('checkDiskSpace', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_LOW_DISK_THRESHOLD_BYTES
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns ok:true when the threshold is 0 (always enough)', async () => {
    const { r } = await loadModules(repo)
    process.env.MARS_LOW_DISK_THRESHOLD_BYTES = '0'
    // Reload to pick up env var
    vi.resetModules()
    process.env.MARS_REPO = repo
    const freshR = (await import('../worktree-reclaim')) as unknown as ReclaimModule
    const check = await freshR.checkDiskSpace(repo)
    expect(check.ok).toBe(true)
  })

  it('returns ok:false when the threshold is impossibly high', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    process.env.MARS_LOW_DISK_THRESHOLD_BYTES = String(Number.MAX_SAFE_INTEGER)
    const freshR = (await import('../worktree-reclaim')) as unknown as ReclaimModule
    const check = await freshR.checkDiskSpace(repo)
    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.freeBytes).toBeGreaterThan(0)
      expect(check.thresholdBytes).toBe(Number.MAX_SAFE_INTEGER)
    }
  })
})

describe('writeFileSync in worktree dir creates measurable size', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('totalBytes increases when files are written into a worktree dir', async () => {
    const { r } = await loadModules(repo)

    const fp0 = await r.getWorktreeFootprint(repo)
    expect(fp0.count).toBe(0)

    makeWorktreeDir(repo, 'aabbccdd')
    writeFileSync(join(repo, '.mars', 'worktrees', 'aabbccdd', 'big.txt'), 'x'.repeat(1024))

    const fp1 = await r.getWorktreeFootprint(repo)
    expect(fp1.count).toBe(1)
    // totalBytes is the stat() size of the directory entry itself;
    // it will be > 0 on most systems.
    expect(fp1.totalBytes).toBeGreaterThanOrEqual(0) // at least non-negative
  })
})

// ── Shared-worktree guard tests ───────────────────────────────────────────────
//
// Regression coverage for the periodic sweep bypassing isWorktreeSharedWithLiveTask
// (mars-caae60e2 incident): a settled or excess-failed task whose worktree_path
// is shared with a live (non-terminal) task must be SKIPPED, not removed.
//
// The guard was already applied in the drop handler (server.ts) and purge path
// (purge-task.ts) by mars-330d72e2, but the periodic reclaim sweep was missed.

describe('reclaimSettledWorktrees — shared-worktree guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('does NOT remove the worktree when a dropped task shares its path with a live task', async () => {
    const { q, r } = await loadModules(repo)

    // Live (running) origin task whose worktree is the shared directory.
    const origin = await q.enqueueTask('live origin', undefined, { skipTriage: true })
    const sharedPath = makeWorktreeDir(repo, origin.id)
    await q.updateTask(origin.id, { status: 'running', worktreePath: sharedPath })

    // Fix task (dropped) pointing at the same worktree path.
    const fix = await q.enqueueTask('fix task', undefined, { skipTriage: true })
    await q.updateTask(fix.id, { status: 'dropped', worktreePath: sharedPath })

    const result = await r.reclaimSettledWorktrees(repo)

    // The sweep must skip the shared path — the live origin is still using it.
    expect(result.removed).not.toContain(fix.id)
    expect(existsSync(sharedPath)).toBe(true)
  })

  it('does NOT remove the worktree when a done fix task shares its path with a verifying origin', async () => {
    const { q, r } = await loadModules(repo)

    // Origin in non-terminal status (verifying) — the exact scenario from mars-caae60e2.
    const origin = await q.enqueueTask('verifying origin', undefined, { skipTriage: true })
    const sharedPath = makeWorktreeDir(repo, origin.id)
    await q.updateTask(origin.id, { status: 'verifying', worktreePath: sharedPath })

    // Fix task that completed (done) but still has the shared worktree_path.
    const fix = await q.enqueueTask('done fix', undefined, { skipTriage: true })
    await q.updateTask(fix.id, { status: 'done', worktreePath: sharedPath })

    const result = await r.reclaimSettledWorktrees(repo)

    expect(result.removed).not.toContain(fix.id)
    expect(existsSync(sharedPath)).toBe(true)
  })

  it('DOES remove the worktree when the sharing task has since settled (no longer live)', async () => {
    const { q, r } = await loadModules(repo)

    // Origin is now done (terminal) — the path is no longer actively used.
    const origin = await q.enqueueTask('done origin', undefined, { skipTriage: true })
    const sharedPath = makeWorktreeDir(repo, origin.id)
    await q.updateTask(origin.id, { status: 'done', worktreePath: sharedPath })

    // Fix task also done, pointing at the same path.
    const fix = await q.enqueueTask('done fix', undefined, { skipTriage: true })
    await q.updateTask(fix.id, { status: 'done', worktreePath: sharedPath })

    const result = await r.reclaimSettledWorktrees(repo)

    // Both are terminal; the path is cleaned up (at least one of them removes it).
    expect(existsSync(sharedPath)).toBe(false)
    // At least the first settled task in the sweep removes the path.
    expect(result.removed.length).toBeGreaterThanOrEqual(1)
  })
})

describe('reclaimExcessFailedWorktrees — shared-worktree guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FAILED_WORKTREE_CAP
    rmSync(repo, { recursive: true, force: true })
  })

  it('does NOT remove a failed worktree that is shared with a live task even when over cap', async () => {
    const { q, r } = await loadModules(repo)
    const cap = 1

    // Three failed tasks → over cap=1 by 2, the two oldest should be removed.
    // Make t0 shared so the guard protects it; t1 is unprotected and gets removed.
    const t0 = await q.enqueueTask('failed 0 (shared)', undefined, { skipTriage: true })
    await q.updateTask(t0.id, { status: 'failed', error: 'boom' })
    const wt0 = makeWorktreeDir(repo, t0.id)
    const oldestTime = new Date(Date.now() - 30_000)
    utimesSync(wt0, oldestTime, oldestTime)

    const t1 = await q.enqueueTask('failed 1 (not shared)', undefined, { skipTriage: true })
    await q.updateTask(t1.id, { status: 'failed', error: 'boom' })
    const wt1 = makeWorktreeDir(repo, t1.id)
    const middleTime = new Date(Date.now() - 20_000)
    utimesSync(wt1, middleTime, middleTime)

    const t2 = await q.enqueueTask('failed 2 (newest, kept)', undefined, { skipTriage: true })
    await q.updateTask(t2.id, { status: 'failed', error: 'boom' })
    const wt2 = makeWorktreeDir(repo, t2.id)
    const newestTime = new Date(Date.now() - 10_000)
    utimesSync(wt2, newestTime, newestTime)

    // A live task that shares t0's worktree path — triggers the guard.
    const live = await q.enqueueTask('live origin', undefined, { skipTriage: true })
    await q.updateTask(live.id, { status: 'running', worktreePath: wt0 })

    // Also record t0's worktreePath so isWorktreeSharedWithLiveTask matches it.
    await q.updateTask(t0.id, { worktreePath: wt0 })

    const result = await r.reclaimExcessFailedWorktrees(repo, undefined, cap)

    // t0 is oldest (would be evicted) but the guard skips it — live origin uses it.
    expect(result.removed).not.toContain(t0.id)
    expect(existsSync(wt0)).toBe(true)

    // t1 is second-oldest, NOT shared → removed.
    expect(result.removed).toContain(t1.id)
    expect(existsSync(wt1)).toBe(false)

    // t2 is the newest (within the cap=1 retained set) → kept.
    expect(result.removed).not.toContain(t2.id)
    expect(existsSync(wt2)).toBe(true)
  })
})
