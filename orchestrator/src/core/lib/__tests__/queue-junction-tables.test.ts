/**
 * Junction-table round-trip tests.
 *
 * These tests verify that spec.files, spec.doneCriteria, and claudeSessionIds
 * are stored in the normalized junction tables (task_spec_files,
 * task_done_criteria, task_claude_sessions) and can be read back even when the
 * legacy JSON columns (files_json, done_criteria_json, claude_session_ids) on
 * the tasks table are NULL.
 *
 * Each test is intentionally adversarial: it enqueues / updates a task, then
 * NULLs out the legacy column directly, and asserts the value is still
 * returned. Under the old (legacy-column) read path the assertion fails; under
 * the normalized (junction-table) read path it passes.
 */
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-jt-test-'))
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

describe('junction-table read path: session IDs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reads claudeSessionIds from task_claude_sessions even when tasks.claude_session_ids is cleared', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('sessions task', undefined, { skipTriage: true })

    await q.updateTask(t.id, { claudeSessionId: 'sess-x' })
    await q.updateTask(t.id, { claudeSessionId: 'sess-y' })

    // Simulate the new state where the legacy JSON column is not written.
    const db = createClient({ url: `file:${repo}/.mars/mars.db` })
    await db.execute({
      sql: `UPDATE tasks SET claude_session_ids = '[]' WHERE id = ?`,
      args: [t.id],
    })
    db.close()

    const fetched = await q.getTask(t.id)
    expect(fetched?.claudeSessionIds).toEqual(['sess-x', 'sess-y'])
  })
})

describe('junction-table read path: spec files', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reads spec.files from task_spec_files even when tasks.files_json is cleared', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('files task', undefined, {
      spec: {
        files: ['src/a.ts', 'src/b.ts'],
        doneCriteria: [],
        verifyCmd: null,
        taskType: 'auto',
      },
    })

    // Null out the legacy column.
    const db = createClient({ url: `file:${repo}/.mars/mars.db` })
    await db.execute({
      sql: `UPDATE tasks SET files_json = NULL WHERE id = ?`,
      args: [t.id],
    })
    db.close()

    const fetched = await q.getTask(t.id)
    expect(fetched?.spec?.files).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('junction-table read path: done criteria', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reads spec.doneCriteria from task_done_criteria even when tasks.done_criteria_json is cleared', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('criteria task', undefined, {
      spec: {
        files: [],
        doneCriteria: ['all tests pass', 'type-checks clean'],
        verifyCmd: 'npm test',
        taskType: 'auto',
      },
    })

    // Null out the legacy column.
    const db = createClient({ url: `file:${repo}/.mars/mars.db` })
    await db.execute({
      sql: `UPDATE tasks SET done_criteria_json = NULL WHERE id = ?`,
      args: [t.id],
    })
    db.close()

    const fetched = await q.getTask(t.id)
    expect(fetched?.spec?.doneCriteria).toEqual(['all tests pass', 'type-checks clean'])
  })
})
