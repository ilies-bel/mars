/**
 * Slice F.2 tests: dirty-main detection + main-commiter dedup/spawn.
 *
 * The tests live close to the helpers they exercise (the detection module
 * and the spawn-or-attach orchestration). Dispatch- and verify-time
 * integration are exercised by the focused unit shape: we drive the
 * helpers directly with a freshly-seeded queue + git repo, and assert the
 * recorded state — same pattern as the existing F.1 blocker-invariant
 * tests in this folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { nullTraceStore } from '../run-tool'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-main-dirty-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  // One initial commit so HEAD exists.
  writeFileSync(resolve(repo, 'README.md'), 'hi\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync(
    'git',
    ['commit', '-q', '-m', 'init', '--allow-empty'],
    { cwd: repo },
  )
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const dirtyRepo = (repo: string, content = 'dirty\n'): void => {
  writeFileSync(resolve(repo, 'README.md'), content)
}

describe('checkIntegrationBranchDirty', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns dirty:false on a clean repo', async () => {
    // 15 s: the first dynamic import of main-dirty (which pulls in arc.ts and
    // all its transitive modules) can take 3–5 s on a loaded CI host; add
    // two git commands on top and the default 5 s timeout is too tight.
    const { checkIntegrationBranchDirty } = await import('../main-dirty')
    const r = await checkIntegrationBranchDirty({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(r.dirty).toBe(false)
    expect(r.statusOutput).toBe('')
  }, 15000)

  it('returns dirty:true with statusOutput on a dirty repo', async () => {
    const { checkIntegrationBranchDirty } = await import('../main-dirty')
    dirtyRepo(repo)
    const r = await checkIntegrationBranchDirty({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(r.dirty).toBe(true)
    expect(r.statusOutput).toContain('README.md')
  })

  it('returns dirty:false and emits a warning when repoRoot is on a non-integration branch', async () => {
    // Regression guard: a crashed merge step can leave the primary repo
    // checked out on a task branch. Without this guard, git status on the
    // task branch reads as "dirty main" and drives a committer respawn loop.
    const { checkIntegrationBranchDirty } = await import('../main-dirty')
    // Create and switch to a task branch.
    execFileSync('git', ['checkout', '-b', 'task/some-work'], { cwd: repo })
    // Make the repo dirty so it would report dirty:true without the guard.
    dirtyRepo(repo)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await checkIntegrationBranchDirty({
        repoRoot: repo,
        integrationBranch: 'main',
        traceCtx: { store: nullTraceStore, phase: 'setup' },
      })
      expect(r.dirty).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('task/some-work'),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping dirty-main probe'),
      )
      // With branch-keyed dedup, no hash is computed — only dirty/statusOutput.
      expect(r.statusOutput).toBe('')
    } finally {
      warnSpy.mockRestore()
      // Return to main so teardown can clean up.
      execFileSync('git', ['checkout', 'main'], { cwd: repo })
    }
  })
})

// ---------------------------------------------------------------------------
// Spawn / attach orchestration. These tests reach into the queue/store
// directly to seed source tasks and committer rows, mirroring the
// blocker-invariant tests in this folder.
// ---------------------------------------------------------------------------

describe('spawnOrAttachMainCommitter', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('spawns a fresh committer when no active one exists for the branch', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src = await queue.enqueueTask('source', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(src.id, {
      failureReason: 'stale failure reason',
      failureReasonCode: 'stale-failure-code',
      failureSignature: 'stale-failure-signature',
    })

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: {
        dirty: true,
        statusOutput: ' M README.md\n',
      },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'fake prompt body',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    expect(resolution.spawned).toBe(true)
    expect(resolution.fixTaskId).toMatch(/^fix-[0-9a-f]{8}$/)

    const after = await queue.getTask(src.id)
    expect(after?.status).toBe('blocked')
    expect(after?.error).toBe(
      'dirty integration branch (main) detected at dispatch; parked behind main-commiter recovery',
    )
    expect(after?.failureReason).toBeNull()
    expect(after?.failureReasonCode).toBeNull()
    expect(after?.failureSignature).toBeNull()

    const committer = await queue.getTask(resolution.fixTaskId)
    expect(committer?.kind).toBe('fix')
    expect(committer?.fixForTaskId).toBe(src.id)
    expect(committer?.failureSignature).toBe('verify:main-dirty')
    expect(committer?.recoveryPayload).toBeTruthy()
    expect(committer?.prompt).toBe('fake prompt body')

    const { parseMainCommiterPayload } = await import('../main-dirty')
    const payload = parseMainCommiterPayload(committer!.recoveryPayload)
    expect(payload?.recipe).toBe('main-commiter')
    expect(payload?.integrationBranch).toBe('main')

    // The edge is in place: source is blocked-by the committer.
    const c = queue.resolveQueueClient()
    const edges = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [src.id, resolution.fixTaskId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(1)
  })

  it('attaches a second source to the existing committer on the same branch', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })
    await queue.updateTask(src2.id, {
      failureReason: 'stale failure reason',
      failureReasonCode: 'stale-failure-code',
      failureSignature: 'stale-failure-signature',
    })
    const detection = {
      dirty: true as const,
      statusOutput: '',
    }

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    expect(first.spawned).toBe(true)

    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'verify',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    expect(second.spawned).toBe(false)
    expect(second.fixTaskId).toBe(first.fixTaskId)

    const src2After = await queue.getTask(src2.id)
    expect(src2After?.status).toBe('blocked')
    expect(src2After?.error).toBe(
      'dirty integration branch (main) detected at verify; parked behind main-commiter recovery',
    )
    expect(src2After?.failureReason).toBeNull()
    expect(src2After?.failureReasonCode).toBeNull()
    expect(src2After?.failureSignature).toBeNull()

    const c = queue.resolveQueueClient()
    const edges = await c.execute({
      sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ? ORDER BY task_id`,
      args: [first.fixTaskId],
    })
    const ids = (edges.rows as unknown as Array<{ task_id: string }>)
      .map((r) => r.task_id)
      .sort()
    expect(ids).toEqual([src1.id, src2.id].sort())

    await queue.updateTask(first.fixTaskId, { status: 'done' })
    const { Arc } = await import('../../arc')
    await Arc.unblockByCompletion(first.fixTaskId)
    expect((await queue.getTask(src1.id))?.status).toBe('queued')
    expect((await queue.getTask(src2.id))?.status).toBe('queued')
  })

  it('spawns independent committers for parallel integration branches', async () => {
    // Branch-keyed dedup: each integration branch gets its own committer.
    // A committer for 'main' does not satisfy dedup for 'release/v2'.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    expect(first.spawned).toBe(true)

    // Different branch → always spawns a fresh, independent committer.
    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'release/v2',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    expect(second.spawned).toBe(true)
    expect(second.fixTaskId).not.toBe(first.fixTaskId)
  })

  it('respawns when the existing committer for the same branch FAILED (never attach to a dead committer)', async () => {
    // A failed committer must never become a new blocker. 'failed' is not in
    // ACTIVE_COMMITTER_STATUSES so a dead task is invisible to
    // resolveActiveMainCommitter and a fresh one is always spawned. This prevents
    // the deadlock where tasks are permanently blocked on a committer that can
    // never succeed.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })
    const detection = {
      dirty: true as const,
      statusOutput: '',
    }

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(first.fixTaskId, {
      status: 'failed',
      error: 'simulated commit failure',
    })

    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'verify',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    // Must spawn fresh — never block behind a failed (dead) committer.
    expect(second.spawned).toBe(true)
    expect(second.fixTaskId).not.toBe(first.fixTaskId)
  })

  it('respawns a fresh committer when the existing committer for the same branch reached DONE', async () => {
    // A done committer never absorbs new dirty-main detections. The verify gate
    // enforces that a committer only reaches `done` when the integration checkout
    // was actually clean; if main is re-dirty after the committer completes, that
    // is a genuinely new dirty episode requiring a fresh committer.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })
    const detection = {
      dirty: true as const,
      statusOutput: '',
    }

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(first.fixTaskId, { status: 'done' })

    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    // Done committer does NOT satisfy dedup → fresh committer spawned.
    expect(second.spawned).toBe(true)
    expect(second.fixTaskId).not.toBe(first.fixTaskId)

    // src2 is blocked on the FRESH committer, not the done one.
    const src2After = await queue.getTask(src2.id)
    expect(src2After?.status).toBe('blocked')
    const c = queue.resolveQueueClient()
    const poisonEdge = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [src2.id, first.fixTaskId],
    })
    expect(Number((poisonEdge.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('allows a fresh committer when HEAD advances (done committer never reused)', async () => {
    // Done committers never satisfy dedup — so after HEAD advances and the same
    // files are still dirty on the same branch, a fresh committer is always
    // spawned rather than suppressed.
    //
    // Scenario: dirty.txt is present before AND after HEAD advances. The first
    // committer (done) handled the old episode. The new dirty episode on the
    // same branch must get a fresh committer.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })

    const { checkIntegrationBranchDirty, spawnOrAttachMainCommitter } = await import('../main-dirty')

    // Dirty the repo with an untracked file.
    writeFileSync(resolve(repo, 'dirty.txt'), 'initial\n')

    const detection1 = await checkIntegrationBranchDirty({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(detection1.dirty).toBe(true)

    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: detection1,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    expect(first.spawned).toBe(true)
    await queue.updateTask(first.fixTaskId, { status: 'done' })

    // Advance HEAD: commit another file while dirty.txt remains untracked.
    writeFileSync(resolve(repo, 'advance.txt'), 'advance\n')
    execFileSync('git', ['add', 'advance.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'advance HEAD'], { cwd: repo })

    // Get detection for the new HEAD.
    const detection2 = await checkIntegrationBranchDirty({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(detection2.dirty).toBe(true)
    expect(detection2.statusOutput).toContain('dirty.txt')

    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })
    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: detection2,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    // Done committer never satisfies dedup → fresh spawn regardless of HEAD.
    expect(second.spawned).toBe(true)
    expect(second.fixTaskId).not.toBe(first.fixTaskId)
  })

  it('reparents stranded dependents from prior failed committer onto fresh committer', async () => {
    // Scenario: committer-1 has 3 blocked dependents after failure. src2 arrives → committer-2
    // spawns → reparenting re-parents all 3 stranded deps. When committer-2
    // completes, unblockByCompletion re-queues all 3.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()

    const c = queue.resolveQueueClient()
    const now = new Date().toISOString()
    const blockerCreatedAt = Date.now()
    const { parseMainCommiterPayload, serialiseMainCommiterPayload } = await import('../main-dirty')

    // Seed a phantom origin task (needed for FK on fix_for_task_id).
    const origin1 = await queue.enqueueTask('origin-1', undefined, { skipTriage: true })

    // Seed committer-1 directly: a failed main-committer for 'main'.
    const committer1 = 'fix-00000001'
    const payload1 = { recipe: 'main-commiter' as const, integrationBranch: 'main' }
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, author_kind, author_name, origin_id, priority, recovery_payload, created_at, updated_at)
            VALUES (?, 'committer-1', 'failed', 'fix', ?, 'agent', 'seed', ?, 3, ?, ?, ?)`,
      args: [committer1, origin1.id, origin1.id, serialiseMainCommiterPayload(payload1), now, now],
    })

    // Seed 3 dependent tasks blocked on committer-1.
    const dep1 = await queue.enqueueTask('dep-1', undefined, { skipTriage: true })
    const dep2 = await queue.enqueueTask('dep-2', undefined, { skipTriage: true })
    const dep3 = await queue.enqueueTask('dep-3', undefined, { skipTriage: true })
    for (const dep of [dep1, dep2, dep3]) {
      await c.execute({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
        args: [dep.id, committer1, blockerCreatedAt],
      })
      await c.execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [dep.id],
      })
    }

    // src2 arrives → committer-2 spawns → reparenting runs.
    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const src2 = await queue.enqueueTask('source-2', undefined, { skipTriage: true })
    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: {
        dirty: true as const,
        statusOutput: '',
      },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    expect(second.spawned).toBe(true)
    const committer2 = second.fixTaskId

    // All 3 stranded dependents + new source must be blocked on committer-2.
    const edgeRows = await c.execute({
      sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ? ORDER BY task_id`,
      args: [committer2],
    })
    const blockedIds = (edgeRows.rows as unknown as Array<{ task_id: string }>)
      .map((r) => r.task_id)
      .sort()
    expect(blockedIds).toEqual([src2.id, dep1.id, dep2.id, dep3.id].sort())

    // Old committer-1 edges must have been removed so unblockByCompletion can release them.
    const oldEdgesRow = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ? AND task_id IN (?, ?, ?)`,
      args: [committer1, dep1.id, dep2.id, dep3.id],
    })
    expect(Number((oldEdgesRow.rows[0] as unknown as { n: number }).n)).toBe(0)

    // Integration: when committer-2 completes, unblockByCompletion re-queues all stranded deps.
    await queue.updateTask(committer2, { status: 'done' })
    const { Arc } = await import('../../arc')
    await Arc.unblockByCompletion(committer2)

    for (const dep of [dep1, dep2, dep3]) {
      const t = await queue.getTask(dep.id)
      expect(t?.status).toBe('queued')
    }
  })

  it('attaches a second source to the SAME ACTIVE committer on the same branch even after HEAD advances', async () => {
    // Branch-keyed dedup: an active committer for branch 'main' is always
    // found regardless of HEAD position. A second task hitting dirty-main on
    // the same branch while the committer is still running attaches to it
    // rather than spawning a fresh one.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src1 = await queue.enqueueTask('source-1', undefined, { skipTriage: true })

    const { checkIntegrationBranchDirty, spawnOrAttachMainCommitter } = await import('../main-dirty')

    // Dirty the repo with an untracked file.
    writeFileSync(resolve(repo, 'dirty.txt'), 'some dirty content\n')

    const detection1 = await checkIntegrationBranchDirty({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(detection1.dirty).toBe(true)

    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: detection1,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    expect(first.spawned).toBe(true)
    // The committer is still ACTIVE (not done, not failed) — it's running.

    // Advance HEAD: another task merged into main while this committer is still running.
    writeFileSync(resolve(repo, 'advance.txt'), 'advance\n')
    execFileSync('git', ['add', 'advance.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'advance HEAD while committer runs'], { cwd: repo })

    // dirty.txt is still present (the committer hasn't cleaned up yet).
    const detection2 = await checkIntegrationBranchDirty({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(detection2.dirty).toBe(true)
    expect(detection2.statusOutput).toContain('dirty.txt')

    const src2 = await queue.enqueueTask('source-2', undefined, { skipTriage: true })
    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: detection2,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    // MUST attach to the still-active committer — NOT spawn a fresh one.
    expect(second.spawned).toBe(false)
    expect(second.fixTaskId).toBe(first.fixTaskId)

    // src2 is blocked on the existing committer.
    const src2After = await queue.getTask(src2.id)
    expect(src2After?.status).toBe('blocked')

    // Both sources are blocked on the same committer.
    const c = queue.resolveQueueClient()
    const edges = await c.execute({
      sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ? ORDER BY task_id`,
      args: [first.fixTaskId],
    })
    const ids = (edges.rows as unknown as Array<{ task_id: string }>)
      .map((r) => r.task_id)
      .sort()
    expect(ids).toEqual([src1.id, src2.id].sort())
  })
})

describe('spawnOrAttachMainCommitter with dispatchPhase merge', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('spawns a committer with dispatchPhase=merge and parks source blocked (not failed)', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src = await queue.enqueueTask('source-merge', undefined, {
      skipTriage: true,
    })

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: {
        dirty: true,
        statusOutput: ' M README.md\n',
      },
      integrationBranch: 'main',
      dispatchPhase: 'merge',
      recipePrompt: 'merge-phase committer prompt',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })

    expect(resolution.spawned).toBe(true)
    expect(resolution.fixTaskId).toMatch(/^fix-[0-9a-f]{8}$/)

    // Source must be blocked, NOT failed.
    const after = await queue.getTask(src.id)
    expect(after?.status).toBe('blocked')
    expect(after?.status).not.toBe('failed')

    // Committer row is in place.
    const committer = await queue.getTask(resolution.fixTaskId)
    expect(committer?.kind).toBe('fix')
    expect(committer?.fixForTaskId).toBe(src.id)

    // Blocker edge is present.
    const c = queue.resolveQueueClient()
    const edges = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [src.id, resolution.fixTaskId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(1)
  })

  it('attaches a merge-phase source to an existing dispatch-phase committer on the same branch', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src1 = await queue.enqueueTask('source-dispatch', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-merge', undefined, {
      skipTriage: true,
    })
    const detection = {
      dirty: true as const,
      statusOutput: ' M file.ts\n',
    }

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    expect(first.spawned).toBe(true)

    // src2 hits dirty on the same branch at merge time — must attach, not spawn fresh.
    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'merge',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    expect(second.spawned).toBe(false)
    expect(second.fixTaskId).toBe(first.fixTaskId)

    const src2After = await queue.getTask(src2.id)
    expect(src2After?.status).toBe('blocked')
  })
})

describe('attachToExistingFixTask preserves the ADR-0040 leaf invariant', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('addBlockers still rejects a recovery endpoint (F.1 enforcement intact)', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const src = await queue.enqueueTask('source', undefined, {
      skipTriage: true,
    })
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    // Add another source to act as a would-be edge target.
    const other = await queue.enqueueTask('other', undefined, {
      skipTriage: true,
    })
    // Routing the recovery through the user-facing `addBlockers` MUST still
    // fail per F.1; the F.2 attach path bypasses via the exemption.
    const { RecoveryTaskBlockerError } = await import('../blocker-invariant')
    await expect(
      queue.addBlockers(other.id, [resolution.fixTaskId]),
    ).rejects.toBeInstanceOf(RecoveryTaskBlockerError)
  })
})

// ---------------------------------------------------------------------------
// Integration-clean verify check (invariant 1)
// These tests exercise the `checkIntegrationBranchDirty` call that the verify
// primitive makes on the integration checkout (repoRoot) for main-committer tasks.
// A non-empty result means verify FAILS the committer task; an empty result means
// verify passes.
// ---------------------------------------------------------------------------

describe('main-committer verify: integration-clean check', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('committer-done-but-dirty: returns dirty when the integration checkout is still dirty after committer ran', async () => {
    // Simulates the verify-time check the primitives/verify step runs for a
    // main-committer task. If the integration checkout is non-empty at this
    // point, the verify step must fail the committer task (non-recoverable).
    //
    // Scenario: main-committer ran but the integration branch working tree
    // still has uncommitted files (e.g. ignored files a checkpoint cannot hold).
    const { checkIntegrationBranchDirty } = await import('../main-dirty')

    // Simulate integration checkout still dirty.
    writeFileSync(resolve(repo, 'leftover.ts'), 'uncommitted\n')

    const result = await checkIntegrationBranchDirty({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx: { store: nullTraceStore, phase: 'verify' },
    })

    // dirty:true means the verify step would fail the committer task.
    expect(result.dirty).toBe(true)
    expect(result.statusOutput).toContain('leftover.ts')
  })

  it('committer cleaned successfully: returns clean when integration checkout is empty after committer ran', async () => {
    // Simulates the verify-time check after the committer successfully committed
    // or parked all dirty files. The integration checkout is clean →
    // checkIntegrationBranchDirty returns dirty:false → verify passes.
    const { checkIntegrationBranchDirty } = await import('../main-dirty')

    // No uncommitted files — the committer cleaned everything.
    const result = await checkIntegrationBranchDirty({
      repoRoot: repo,
      integrationBranch: 'main',
      traceCtx: { store: nullTraceStore, phase: 'verify' },
    })

    expect(result.dirty).toBe(false)
    expect(result.statusOutput).toBe('')
  })

  it('done committer does not absorb new dirty-main detections: spawns fresh for same branch', async () => {
    // Done committers are NOT reused. If a committer reaches `done` and then
    // dirt is detected again on the same branch, a fresh committer must be
    // spawned — not suppressed.
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const src1 = await queue.enqueueTask('source-1', undefined, { skipTriage: true })
    const src2 = await queue.enqueueTask('source-2', undefined, { skipTriage: true })

    const detection = {
      dirty: true as const,
      statusOutput: ' M file.ts\n',
    }
    const { spawnOrAttachMainCommitter } = await import('../main-dirty')

    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    expect(first.spawned).toBe(true)

    await queue.updateTask(first.fixTaskId, { status: 'done' })

    // Re-detect dirt on the same branch.
    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })

    // Must spawn fresh — done committer never absorbs new detections.
    expect(second.spawned).toBe(true)
    expect(second.fixTaskId).not.toBe(first.fixTaskId)

    // src2 is blocked on the fresh committer.
    const src2After = await queue.getTask(src2.id)
    expect(src2After?.status).toBe('blocked')
  })
})

describe('provisionCommitterWorktree carries dirty state into the new tree', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('preserves the dirty state on the new worktree (the committer sees what main saw)', async () => {
    // Mark main dirty.
    writeFileSync(
      resolve(repo, 'README.md'),
      'dirty-state-that-must-survive\n',
    )
    const { provisionCommitterWorktree } = await import('../git/worktree')
    const ref = await provisionCommitterWorktree({
      recoveryTaskId: 'committer-' + Math.random().toString(36).slice(2, 8),
      integrationBranch: 'main',
    })
    // The new worktree must contain the dirty content.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: ref.path,
      encoding: 'utf8',
    })
    expect(status).toContain('README.md')
    // Cleanup the worktree we created so the repo teardown is clean.
    execFileSync('git', ['worktree', 'remove', '--force', ref.path], {
      cwd: repo,
    })
  })
})

// ---------------------------------------------------------------------------
// Setup provisioning choice for a main-committer fix (regression).
//
// The dirty-main leak: setup-worktree conflated "recovery does NOT attach to
// its origin" with "use the generic createWorktree()". A main-committer fix
// does not attach to an origin (recoveryAttachesToOrigin === false), but it
// MUST provision via provisionCommitterWorktree so the integration branch's
// dirty state is checkpointed off repoRoot and applied INTO the fix worktree
// (per-task ref, never the shared stash stack). Routing
// it through createWorktree() instead branches off the clean integration tip
// and strands the dirty state on the integration checkout — so the committer
// coder sees nothing to commit and every downstream task fails
// verify:main-dirty forever. These tests pin the contract the setup branch
// relies on.
// ---------------------------------------------------------------------------

describe('setup provisioning choice for a main-committer fix', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('a main-committer fix does NOT attach to an origin worktree', async () => {
    // recoveryAttachesToOrigin === false is what steers setup away from the
    // attach-origin path; the bug was that "not attaching" then fell through to
    // createWorktree() rather than the committer path.
    const { recoveryAttachesToOrigin } = await import(
      '../../../workflows/primitives/shared'
    )
    expect(recoveryAttachesToOrigin('fix', /* isMainCommiter */ true)).toBe(
      false,
    )
    // A normal (non-committer) fix DOES attach to its origin.
    expect(recoveryAttachesToOrigin('fix', /* isMainCommiter */ false)).toBe(
      true,
    )
  })

  it('the committer path carries dirty state; the generic path strands it on main', async () => {
    // This contrast is the whole reason setup must branch on isMainCommiterFix:
    // for the SAME dirty integration checkout the two provisioning helpers
    // produce opposite worktree states.
    const { provisionCommitterWorktree, createWorktree } = await import(
      '../git/worktree'
    )

    // Generic path: branch off the (currently clean) integration tip. The
    // dirty state we introduce AFTER this call stays on repoRoot — a clean
    // committer worktree has nothing to commit.
    const clean = await createWorktree({
      taskId: 'plain-' + Math.random().toString(36).slice(2, 8),
      integrationBranch: 'main',
    })
    const cleanStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: clean.path,
      encoding: 'utf8',
    })
    expect(cleanStatus.trim()).toBe('')
    execFileSync('git', ['worktree', 'remove', '--force', clean.path], {
      cwd: repo,
    })

    // Committer path: dirty main, then provision — the dirty file must appear
    // in the fix worktree so the committer coder can commit it there.
    writeFileSync(resolve(repo, 'leaked.ts'), 'must-be-committed-in-worktree\n')
    const committer = await provisionCommitterWorktree({
      recoveryTaskId: 'committer-' + Math.random().toString(36).slice(2, 8),
      integrationBranch: 'main',
    })
    const committerStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: committer.path,
      encoding: 'utf8',
    })
    expect(committerStatus).toContain('leaked.ts')
    // And the migration moved it OFF the integration checkout...
    const mainStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    })
    expect(mainStatus).not.toContain('leaked.ts')
    // ...via a per-task checkpoint ref, never the shared stash stack.
    const stashList = execFileSync('git', ['stash', 'list'], {
      cwd: repo,
      encoding: 'utf8',
    })
    expect(stashList.trim()).toBe('')
    execFileSync('git', ['worktree', 'remove', '--force', committer.path], {
      cwd: repo,
    })
  })
})
