import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createClient } from '@libsql/client'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  updateTask: typeof import('../../queue').updateTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-csi-test-'))
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

describe('tasks.claude_session_ids (append-only history)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('defaults to an empty array for new tasks', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('fresh task', undefined, { skipTriage: true })
    const fetched = await q.getTask(t.id)
    expect(fetched?.claudeSessionIds).toEqual([])
    expect(fetched?.claudeSessionId).toBeNull()
  })

  it('mirrors the latest pointer and appends to the array on each set', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('multi-session', undefined, { skipTriage: true })

    await q.updateTask(t.id, { claudeSessionId: 'sess-a' })
    const afterFirst = await q.getTask(t.id)
    expect(afterFirst?.claudeSessionId).toBe('sess-a')
    expect(afterFirst?.claudeSessionIds).toEqual(['sess-a'])

    await q.updateTask(t.id, { claudeSessionId: 'sess-b' })
    const afterSecond = await q.getTask(t.id)
    expect(afterSecond?.claudeSessionId).toBe('sess-b')
    expect(afterSecond?.claudeSessionIds).toEqual(['sess-a', 'sess-b'])

    await q.updateTask(t.id, { claudeSessionId: 'sess-c' })
    const afterThird = await q.getTask(t.id)
    expect(afterThird?.claudeSessionIds).toEqual(['sess-a', 'sess-b', 'sess-c'])
  })

  it('deduplicates: setting the same session id twice does not duplicate the entry', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('dedup task', undefined, { skipTriage: true })

    await q.updateTask(t.id, { claudeSessionId: 'sess-a' })
    await q.updateTask(t.id, { claudeSessionId: 'sess-a' })
    await q.updateTask(t.id, { claudeSessionId: 'sess-b' })
    await q.updateTask(t.id, { claudeSessionId: 'sess-a' })

    const fetched = await q.getTask(t.id)
    expect(fetched?.claudeSessionIds).toEqual(['sess-a', 'sess-b'])
    expect(fetched?.claudeSessionId).toBe('sess-a')
  })

  it('does not touch the array when claudeSessionId is patched to null', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('null clear', undefined, { skipTriage: true })

    await q.updateTask(t.id, { claudeSessionId: 'sess-a' })
    await q.updateTask(t.id, { claudeSessionId: null })
    const fetched = await q.getTask(t.id)
    expect(fetched?.claudeSessionId).toBeNull()
    expect(fetched?.claudeSessionIds).toEqual(['sess-a'])
  })

  it('backfills claude_session_ids from a legacy row with only claude_session_id set', async () => {
    // Lay down a row before the new column exists, then run the
    // migration via migrateQueueSchema() and confirm the array gets seeded.
    const queueDb = `file:${repo}/.mars/mars.db`
    const c = createClient({ url: queueDb })
    await c.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      plan_functional TEXT, plan_technical TEXT, branch TEXT, worktree_path TEXT,
      claude_session_id TEXT, error TEXT, drop_reason TEXT,
      recovery_spawned_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    const now = new Date().toISOString()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, claude_session_id, created_at, updated_at)
            VALUES ('legacy-1', 'old', 'done', 'legacy-sess', ?, ?)`,
      args: [now, now],
    })
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, claude_session_id, created_at, updated_at)
            VALUES ('legacy-2', 'old', 'done', NULL, ?, ?)`,
      args: [now, now],
    })
    c.close()

    const q = await loadQueue(repo)
    const t1 = await q.getTask('legacy-1')
    expect(t1?.claudeSessionIds).toEqual(['legacy-sess'])
    const t2 = await q.getTask('legacy-2')
    expect(t2?.claudeSessionIds).toEqual([])
  })
})
