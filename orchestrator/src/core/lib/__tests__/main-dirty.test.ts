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
    const { checkIntegrationBranchDirty } = await import('../main-dirty')
    const r = await checkIntegrationBranchDirty({
      repoRoot: repo,
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(r.dirty).toBe(false)
    expect(r.hash).toBeNull()
    expect(r.statusOutput).toBe('')
  })

  it('returns dirty:true with a stable hash on a dirty repo', async () => {
    const { checkIntegrationBranchDirty } = await import('../main-dirty')
    dirtyRepo(repo)
    const r1 = await checkIntegrationBranchDirty({
      repoRoot: repo,
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(r1.dirty).toBe(true)
    expect(r1.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(r1.statusOutput).toContain('README.md')
    // Re-running on the same state must produce the same hash.
    const r2 = await checkIntegrationBranchDirty({
      repoRoot: repo,
      traceCtx: { store: nullTraceStore, phase: 'verify' },
    })
    expect(r2.hash).toBe(r1.hash)
  })

  it('produces different hashes for different diffs', async () => {
    const { checkIntegrationBranchDirty } = await import('../main-dirty')
    dirtyRepo(repo, 'one\n')
    const r1 = await checkIntegrationBranchDirty({
      repoRoot: repo,
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    dirtyRepo(repo, 'two\n')
    const r2 = await checkIntegrationBranchDirty({
      repoRoot: repo,
      traceCtx: { store: nullTraceStore, phase: 'setup' },
    })
    expect(r1.dirty).toBe(true)
    expect(r2.dirty).toBe(true)
    expect(r1.hash).not.toBe(r2.hash)
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

  it('spawns a fresh committer when no active one exists for the hash', async () => {
    const queue = await import('../../queue')
    await queue.initQueue()
    const src = await queue.enqueueTask('source', undefined, {
      skipTriage: true,
    })

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: {
        dirty: true,
        hash: 'deadbeef'.repeat(8),
        statusOutput: ' M README.md\n',
      },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'fake prompt body',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    expect(resolution.spawned).toBe(true)
    expect(resolution.fixTaskId).toMatch(/^[0-9a-f]{8}$/)

    const after = await queue.getTask(src.id)
    expect(after?.status).toBe('blocked')
    expect(after?.failureReason).toBe('verify:main-dirty')

    const committer = await queue.getTask(resolution.fixTaskId)
    expect(committer?.kind).toBe('fix')
    expect(committer?.fixForTaskId).toBe(src.id)
    expect(committer?.failureSignature).toBe('verify:main-dirty')
    expect(committer?.recoveryPayload).toBeTruthy()
    expect(committer?.prompt).toBe('fake prompt body')

    const { parseMainCommiterPayload } = await import('../main-dirty')
    const payload = parseMainCommiterPayload(committer!.recoveryPayload)
    expect(payload?.recipe).toBe('main-commiter')
    expect(payload?.dirtyMainHash).toBe('deadbeef'.repeat(8))
    expect(payload?.integrationBranch).toBe('main')

    // The edge is in place: source is blocked-by the committer.
    const c = queue.getClient()
    const edges = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [src.id, resolution.fixTaskId],
    })
    expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(1)
  })

  it('attaches a second source to the existing committer at the same hash', async () => {
    const queue = await import('../../queue')
    await queue.initQueue()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })
    const detection = {
      dirty: true as const,
      hash: 'cafe'.repeat(16),
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

    const c = queue.getClient()
    const edges = await c.execute({
      sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ? ORDER BY task_id`,
      args: [first.fixTaskId],
    })
    const ids = (edges.rows as unknown as Array<{ task_id: string }>)
      .map((r) => r.task_id)
      .sort()
    expect(ids).toEqual([src1.id, src2.id].sort())
  })

  it('respawns when an existing committer FAILED at a different hash', async () => {
    const queue = await import('../../queue')
    await queue.initQueue()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })

    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const first = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: {
        dirty: true,
        hash: 'a'.repeat(64),
        statusOutput: '',
      },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    // Mark the first committer as failed.
    await queue.updateTask(first.fixTaskId, {
      status: 'failed',
      error: 'simulated commit failure',
    })

    const second = await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection: {
        dirty: true,
        hash: 'b'.repeat(64),
        statusOutput: '',
      },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })
    expect(second.spawned).toBe(true)
    expect(second.fixTaskId).not.toBe(first.fixTaskId)
  })

  it('respawns when an existing committer FAILED at the SAME hash (never attach to a dead committer)', async () => {
    // A failed committer must never become a new blocker. After the fix,
    // 'failed' is removed from ACTIVE_COMMITTER_STATUSES so the dead task
    // is invisible to findActiveMainCommitter and a fresh one is always
    // spawned. This prevents the deadlock reported in the bug where tasks
    // were permanently blocked on a committer that can never succeed.
    const queue = await import('../../queue')
    await queue.initQueue()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })
    const detection = {
      dirty: true as const,
      hash: 'feed'.repeat(16),
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

  it('respawns after a committer reaches DONE (its hash is historical)', async () => {
    const queue = await import('../../queue')
    await queue.initQueue()
    const src1 = await queue.enqueueTask('source-1', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('source-2', undefined, {
      skipTriage: true,
    })
    const detection = {
      dirty: true as const,
      hash: 'aa'.repeat(32),
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
    expect(second.spawned).toBe(true)
    expect(second.fixTaskId).not.toBe(first.fixTaskId)
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
    await queue.initQueue()
    const { spawnOrAttachMainCommitter } = await import('../main-dirty')
    const src = await queue.enqueueTask('source', undefined, {
      skipTriage: true,
    })
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, hash: '1'.repeat(64), statusOutput: '' },
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

describe('failure-reason catalog routes verify:main-dirty to main-commiter', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(resolve(tmpdir(), 'mars-fr-cat-'))
    mkdirSync(stateDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('catalog get(verify:main-dirty).recipe === "main-commiter"', async () => {
    const { loadFailureReasonCatalog } = await import('../failure-reasons')
    const cat = await loadFailureReasonCatalog(stateDir)
    const entry = cat.get('verify:main-dirty')
    expect(entry.code).toBe('verify:main-dirty')
    expect(entry.recipe).toBe('main-commiter')
  })
})
