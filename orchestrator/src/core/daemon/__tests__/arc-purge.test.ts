/**
 * Tests for `coreArcPurge` — the core used by the `mars arc purge <id>` CLI
 * command and the `arc-purge` daemon op.
 *
 * Acceptance criteria:
 *   (a) Purging any member id drops the origin AND all same-origin siblings
 *       (tasks sharing origin_id) AND fix children (fix_for_task_id → origin)
 *       from the DB.
 *   (b) A cross-arc dependent (blocked on the origin, different origin_id) is
 *       released to 'queued' after the arc is purged.
 *   (c) Providing a non-origin member id still resolves and purges the whole arc.
 *   (d) Without --force, the purge is refused (before deleting anything) when
 *       ANY member branch has unique commits ahead of the integration branch.
 *   (e) With --force, the purge succeeds even when members have commits ahead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
  addBlockers: typeof import('../../queue').addBlockers
}

interface ArcPurgeModule {
  coreArcPurge: typeof import('../arc-purge').coreArcPurge
}

/** Create a minimal git repo with one commit on main so git operations work. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-arc-purge-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

/** Create a branch with one unique commit (not reachable from main). */
const makeBranchWithCommit = (repo: string, branch: string): void => {
  const fileName = `work-${branch.replace(/\//g, '-')}.txt`
  execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
  writeFileSync(resolve(repo, fileName), `work\n`)
  // Add only the specific work file, never `.mars/` or other DB files.
  execFileSync('git', ['add', fileName], { cwd: repo })
  execFileSync('git', ['commit', '-m', `feat: work on ${branch}`], { cwd: repo })
  execFileSync('git', ['checkout', 'main'], { cwd: repo })
}

/** Returns true if the local branch exists in the repo. */
const branchExists = (repo: string, branch: string): boolean => {
  try {
    execSync(`git rev-parse --verify refs/heads/${branch}`, {
      cwd: repo,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ap: ArcPurgeModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ap = (await import('../arc-purge')) as unknown as ArcPurgeModule
  return { q, ap }
}

describe('coreArcPurge', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: arc purge drops origin + sibling + fix child ────────────
  it('purges origin, same-origin sibling, and fix child in one operation', async () => {
    const { q, ap } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const now = new Date().toISOString()

    // Create the 3-task arc.
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'failed', error: 'test' })

    // Same-origin sibling: origin_id = origin.id, fix_for_task_id = NULL
    const sibling = await q.enqueueTask('sibling task', undefined, {
      skipTriage: true,
      originId: origin.id,
    })
    await q.updateTask(sibling.id, { status: 'failed', error: 'test' })

    // Fix child: kind='fix', fix_for_task_id = origin.id, origin_id = origin.id
    const fixId = `fix-${origin.id.slice(0, 8)}`
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, kind, origin_id, created_at, updated_at)
            VALUES (?, 'fix task', 'failed', ?, 'fix', ?, ?, ?)`,
      args: [fixId, origin.id, origin.id, now, now],
    })

    // Purge the whole arc.
    const result = await ap.coreArcPurge(origin.id, true, 'main', repo)

    expect(result.originId).toBe(origin.id)
    expect(result.purgedIds).toHaveLength(3)
    expect(result.purgedIds).toContain(origin.id)
    expect(result.purgedIds).toContain(sibling.id)
    expect(result.purgedIds).toContain(fixId)

    // All three rows must be gone from the DB.
    expect(await q.getTask(origin.id)).toBeNull()
    expect(await q.getTask(sibling.id)).toBeNull()
    const fixRow = await client.execute({
      sql: `SELECT id FROM tasks WHERE id = ?`,
      args: [fixId],
    })
    expect(fixRow.rows).toHaveLength(0)
  })

  // ── Cross-arc dependent released to 'queued' ──────────────────────────────
  it('releases a cross-arc dependent to queued after purging the arc', async () => {
    const { q, ap } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'failed', error: 'test' })

    // Cross-arc dependent: different origin_id, blocked on origin.
    const dependent = await q.enqueueTask('dependent task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(dependent.id, { status: 'blocked' })
    // Insert blocker edge directly (addBlockers guards against fix-task edges,
    // which don't apply here, but we use raw SQL for test clarity).
    await client.execute({
      sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [dependent.id, origin.id, new Date().toISOString()],
    })

    await ap.coreArcPurge(origin.id, true, 'main', repo)

    // Origin is gone; dependent is released to 'queued'.
    expect(await q.getTask(origin.id)).toBeNull()
    const dep = await q.getTask(dependent.id)
    expect(dep?.status).toBe('queued')
  })

  // ── Member id (non-origin) resolves to the full arc ───────────────────────
  it('accepts a non-origin member id and still purges the whole arc', async () => {
    const { q, ap } = await loadModules(repo)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'failed', error: 'test' })

    const sibling = await q.enqueueTask('sibling task', undefined, {
      skipTriage: true,
      originId: origin.id,
    })
    await q.updateTask(sibling.id, { status: 'failed', error: 'test' })

    // Provide the sibling id, not the origin id.
    const result = await ap.coreArcPurge(sibling.id, true, 'main', repo)

    expect(result.originId).toBe(origin.id)
    expect(result.purgedIds).toContain(origin.id)
    expect(result.purgedIds).toContain(sibling.id)
    expect(await q.getTask(origin.id)).toBeNull()
    expect(await q.getTask(sibling.id)).toBeNull()
  })

  // ── Commit-ahead guard: refused before deleting anything ──────────────────
  it('refuses (before any deletion) when a member branch has unique commits and force=false', async () => {
    const { q, ap } = await loadModules(repo)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'failed', error: 'test' })

    const sibling = await q.enqueueTask('sibling task', undefined, {
      skipTriage: true,
      originId: origin.id,
    })
    await q.updateTask(sibling.id, { status: 'failed', error: 'test' })

    // Give the sibling's branch a unique commit so it triggers the guard.
    const siblingBranch = `task/${sibling.id}`
    makeBranchWithCommit(repo, siblingBranch)
    await q.updateTask(sibling.id, { branch: siblingBranch })

    // Purge without force — must throw before deleting anything.
    await expect(
      ap.coreArcPurge(origin.id, false, 'main', repo),
    ).rejects.toThrow(/unique commits ahead/)

    // Neither member was deleted.
    expect(await q.getTask(origin.id)).not.toBeNull()
    expect(await q.getTask(sibling.id)).not.toBeNull()
    expect(branchExists(repo, siblingBranch)).toBe(true)
  })

  // ── Force flag bypasses commit-ahead guard ────────────────────────────────
  it('purges all members even when branches are ahead when force=true', async () => {
    const { q, ap } = await loadModules(repo)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'failed', error: 'test' })

    const sibling = await q.enqueueTask('sibling task', undefined, {
      skipTriage: true,
      originId: origin.id,
    })
    await q.updateTask(sibling.id, { status: 'failed', error: 'test' })

    const siblingBranch = `task/${sibling.id}`
    makeBranchWithCommit(repo, siblingBranch)
    await q.updateTask(sibling.id, { branch: siblingBranch })

    const originBranch = `task/${origin.id}`
    makeBranchWithCommit(repo, originBranch)
    await q.updateTask(origin.id, { branch: originBranch })

    // Purge with force=true.
    const result = await ap.coreArcPurge(origin.id, true, 'main', repo)

    expect(result.purgedIds).toContain(origin.id)
    expect(result.purgedIds).toContain(sibling.id)
    expect(await q.getTask(origin.id)).toBeNull()
    expect(await q.getTask(sibling.id)).toBeNull()
    // Both branches should be deleted.
    expect(branchExists(repo, siblingBranch)).toBe(false)
    expect(branchExists(repo, originBranch)).toBe(false)
  })
})
