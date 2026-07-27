/**
 * Tests for the purge archive (slice 3 of PRD aa93d9cb).
 *
 * Acceptance criteria exercised here:
 *   (a) Single force-purge creates exactly 1 archive row with the correct
 *       compensation task id, force_flag=true, and purged_by='purge'.
 *   (b) Arc force-purge creates N archive rows (one per member) each carrying
 *       the same compensation_task_id and purged_by='arc-purge'.
 *   (c) Non-force purge creates archive rows with force_flag=false and
 *       compensation_task_id=null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
  listTasks: typeof import('../../queue').listTasks
}

interface PurgeTaskModule {
  corePurgeTask: typeof import('../purge-task').corePurgeTask
}

interface ArcPurgeModule {
  coreArcPurge: typeof import('../arc-purge').coreArcPurge
}

/** Archive row shape returned by SELECT * FROM purged_tasks_archive. */
interface ArchiveRow {
  id: string
  origin_id: string | null
  branch: string
  worktree_path: string | null
  terminal_status: string
  kind: string
  prompt: string
  intent: string
  integrated_commits_json: string
  compensation_task_id: string | null
  purged_at: string
  purged_by: string
  force_flag: boolean
}

/** Create a minimal git repo with one commit on main so git operations work. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-purge-archive-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; pt: PurgeTaskModule; ap: ArcPurgeModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const pt = (await import('../purge-task')) as unknown as PurgeTaskModule
  const ap = (await import('../arc-purge')) as unknown as ArcPurgeModule
  return { q, pt, ap }
}

const readArchiveRows = async (client: ReturnType<QueueModule['resolveQueueClient']>): Promise<ArchiveRow[]> => {
  const r = await client.execute({
    sql: `SELECT id, origin_id, branch, worktree_path, terminal_status, kind, prompt, intent,
                 integrated_commits_json, compensation_task_id, purged_at, purged_by, force_flag
          FROM purged_tasks_archive ORDER BY purged_at DESC`,
    args: [],
  })
  return r.rows as unknown as ArchiveRow[]
}

describe('purge archive', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) Single force-purge: 1 archive row with compensation task id ────────

  it('single force-purge of a done task creates 1 archive row with compensation_task_id', async () => {
    const { q, pt } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const task = await q.enqueueTask('build the widget', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'done' })

    const result = await pt.corePurgeTask(task.id, true, 'main', repo)

    // A compensation task was created.
    expect(result.compensationTaskId).toBeDefined()

    // Exactly one archive row was written.
    const rows = await readArchiveRows(client)
    expect(rows).toHaveLength(1)

    const archived = rows[0]
    expect(archived.id).toBe(task.id)
    expect(archived.terminal_status).toBe('done')
    expect(archived.compensation_task_id).toBe(result.compensationTaskId)
    expect(archived.purged_by).toBe('purge')
    expect(archived.force_flag).toBe(true)
  })

  // ── (b) Arc force-purge: N archive rows with the same compensation_task_id ─

  it('arc force-purge creates one archive row per member, all with the same compensation_task_id', async () => {
    const { q, ap } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Create an arc with two members, both 'done'.
    const origin = await q.enqueueTask('implement feature X', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'done' })

    const sibling = await q.enqueueTask('follow-up slice', undefined, {
      skipTriage: true,
      originId: origin.id,
    })
    await q.updateTask(sibling.id, { status: 'done' })

    const result = await ap.coreArcPurge(origin.id, true, 'main', repo)

    // Both members were purged.
    expect(result.purgedIds).toContain(origin.id)
    expect(result.purgedIds).toContain(sibling.id)

    // A compensation task was created.
    expect(result.compensationTaskId).toBeDefined()

    // Two archive rows — one per member.
    const rows = await readArchiveRows(client)
    expect(rows).toHaveLength(2)

    const archivedIds = rows.map((r) => r.id)
    expect(archivedIds).toContain(origin.id)
    expect(archivedIds).toContain(sibling.id)

    // All rows carry the same compensation_task_id.
    for (const row of rows) {
      expect(row.compensation_task_id).toBe(result.compensationTaskId)
      expect(row.purged_by).toBe('arc-purge')
      expect(row.force_flag).toBe(true)
    }
  })

  // ── (c) Non-force purge: archive row with force_flag=false, null compensation ─

  it('non-force purge creates an archive row with force_flag=false and compensation_task_id=null', async () => {
    const { q, pt } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const task = await q.enqueueTask('clean up old data', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed', error: 'build broke' })

    // Non-force purge: no unique commits ahead (no branch set), so this succeeds.
    const result = await pt.corePurgeTask(task.id, false, 'main', repo)

    // No compensation task for non-done tasks.
    expect(result.compensationTaskId).toBeUndefined()

    // One archive row was still written.
    const rows = await readArchiveRows(client)
    expect(rows).toHaveLength(1)

    const archived = rows[0]
    expect(archived.id).toBe(task.id)
    expect(archived.force_flag).toBe(false)
    expect(archived.compensation_task_id).toBeNull()
    expect(archived.purged_by).toBe('purge')
  })

  // ── Non-force purge of a done task: no compensation but archive row created ─

  it('non-force purge of a done task creates an archive row with force_flag=false and no compensation', async () => {
    const { q, pt } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const task = await q.enqueueTask('finish the dashboard', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'done' })

    // Non-force purge; no branch means no commits ahead, purge succeeds.
    const result = await pt.corePurgeTask(task.id, false, 'main', repo)

    // Non-force purge never creates a compensation task.
    expect(result.compensationTaskId).toBeUndefined()

    // Archive row is still written.
    const rows = await readArchiveRows(client)
    expect(rows).toHaveLength(1)
    expect(rows[0].force_flag).toBe(false)
    expect(rows[0].compensation_task_id).toBeNull()
  })
})
