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
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
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

  it('a legacy row with only claude_session_id set keeps its pointer and derives history from the junction table', async () => {
    // The history array is derived entirely from `task_claude_sessions`
    // (see TASK_SEL) — there is no column-to-junction backfill any more.
    // A legacy row whose only trace is the `claude_session_id` pointer
    // therefore keeps the pointer but starts with an empty history, and the
    // junction is populated from the next `updateTask` write onward.
    const q = await loadQueue(repo)
    const c = q.resolveQueueClient()
    const now = new Date().toISOString()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, claude_session_id, author_kind, author_name, origin_id, created_at, updated_at)
            VALUES ('legacy-1', 'old', 'done', 'legacy-sess', 'human', 'test', 'legacy-1', ?, ?)`,
      args: [now, now],
    })
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, claude_session_id, author_kind, author_name, origin_id, created_at, updated_at)
            VALUES ('legacy-2', 'old', 'queued', NULL, 'human', 'test', 'legacy-2', ?, ?)`,
      args: [now, now],
    })

    const t1 = await q.getTask('legacy-1')
    expect(t1?.claudeSessionId).toBe('legacy-sess')
    expect(t1?.claudeSessionIds).toEqual([])
    const t2 = await q.getTask('legacy-2')
    expect(t2?.claudeSessionIds).toEqual([])

    // History starts accruing from the first post-migration session write.
    await q.updateTask('legacy-2', { claudeSessionId: 'sess-new' })
    const after = await q.getTask('legacy-2')
    expect(after?.claudeSessionId).toBe('sess-new')
    expect(after?.claudeSessionIds).toEqual(['sess-new'])
  })
})
