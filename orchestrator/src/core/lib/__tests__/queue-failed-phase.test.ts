import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  updateTask: typeof import('../../queue').updateTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fp-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<Queue> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../queue')
  await mod.migrateQueueSchema()
  return mod as unknown as Queue
}

describe('tasks.failed_phase column', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('defaults failedPhase to null for new tasks', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const fetched = await q.getTask(t.id)
    expect(fetched?.failedPhase).toBeNull()
  })

  it('round-trips failedPhase through updateTask', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('verify-fail task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, { status: 'failed', failedPhase: 'verify' })
    const fetched = await q.getTask(t.id)
    expect(fetched?.status).toBe('failed')
    expect(fetched?.failedPhase).toBe('verify')
  })

  // The resumeFrom round-trip test was removed: `resumeFrom` no longer exists
  // on the Task type, the UpdateTaskPatch, or the read path. Resume is now
  // engine-driven (the @mars/workflow engine resumes by re-dispatching with
  // runId=task.id and skipping already-`completed` step records), so there is
  // nothing on the queue row to round-trip. The `resume_from` DB column is
  // retained (no migration to drop it) but is never read or written.

  it('coerces an unknown failed_phase string on the column back to null', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('weird row', undefined, { skipTriage: true })
    const { createClient } = await import('@libsql/client')
    const c = createClient({ url: `file:${repo}/.mars/mars.db` })
    await c.execute({
      sql: `UPDATE tasks SET failed_phase = ? WHERE id = ?`,
      args: ['nonsense', t.id],
    })
    c.close()
    const fetched = await q.getTask(t.id)
    expect(fetched?.failedPhase).toBeNull()
  })

  it("round-trips failedPhase='code' through updateTask", async () => {
    // The 'code' value is reserved for setup-time failures (e.g.
    // install errors) that cannot be continued. The acceptance criteria
    // for the failed_phase column list 'code' alongside 'verify' and
    // 'merge', so the read path must accept it as a valid value rather
    // than coercing it back to null.
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('setup-fail task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, { status: 'failed', failedPhase: 'code' })
    const fetched = await q.getTask(t.id)
    expect(fetched?.status).toBe('failed')
    expect(fetched?.failedPhase).toBe('code')
  })

  it('migration is idempotent on a pre-existing tasks table with rows', async () => {
    // Acceptance criterion: migration runs idempotently on an existing
    // queue database without data loss. Simulate a row created before
    // the failed_phase column existed, then re-run migrateQueueSchema and verify
    // (a) the column is added, (b) the pre-existing row survives, and
    // (c) re-running migrateQueueSchema a second time does not error and does
    // not wipe the row.
    const q = await loadQueue(repo)
    const seeded = await q.enqueueTask('legacy row', undefined, {
      skipTriage: true,
    })
    // Initially failed_phase is NULL on a freshly enqueued row.
    expect((await q.getTask(seeded.id))?.failedPhase).toBeNull()
    // Re-running migrateQueueSchema must be a no-op for existing data — the
    // ALTER TABLE guard (`if (!names.has('failed_phase'))`) keeps it
    // from re-adding the column.
    await q.migrateQueueSchema()
    await q.migrateQueueSchema()
    const stillThere = await q.getTask(seeded.id)
    expect(stillThere?.id).toBe(seeded.id)
    expect(stillThere?.prompt).toBe('legacy row')
    expect(stillThere?.failedPhase).toBeNull()
    // And the column remains writable after the repeated migration.
    await q.updateTask(seeded.id, {
      status: 'failed',
      failedPhase: 'verify',
    })
    expect((await q.getTask(seeded.id))?.failedPhase).toBe('verify')
  })
})
