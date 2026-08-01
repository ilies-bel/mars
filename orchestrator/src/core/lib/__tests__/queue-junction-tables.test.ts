/**
 * Junction-table round-trip tests.
 *
 * These tests verify that spec.files, spec.doneCriteria, and claudeSessionIds
 * are stored in the normalized junction tables (task_spec_files,
 * task_done_criteria, task_claude_sessions) and can be read back through the
 * public API.
 *
 * The legacy JSON columns (files_json, done_criteria_json, claude_session_ids)
 * have been dropped from the tasks table; all reads now go exclusively through
 * the junction tables via TASK_SEL correlated subqueries.
 */
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

  it('reads claudeSessionIds from task_claude_sessions junction table', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('sessions task', undefined, { skipTriage: true })

    await q.updateTask(t.id, { claudeSessionId: 'sess-x' })
    await q.updateTask(t.id, { claudeSessionId: 'sess-y' })

    // The legacy tasks.claude_session_ids column is dropped; data lives only
    // in the junction table. Verify the public interface still returns it.
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

  it('reads spec.files from task_spec_files junction table', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('files task', undefined, {
      spec: {
        files: ['src/a.ts', 'src/b.ts'],
        doneCriteria: [],
        verifyCmd: null,        mergeMode: 'auto',
      },
    })

    // The legacy tasks.files_json column is dropped; data lives only
    // in the junction table. Verify the public interface still returns it.
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

  it('reads spec.doneCriteria from task_done_criteria junction table', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('criteria task', undefined, {
      spec: {
        files: [],
        doneCriteria: ['all tests pass', 'type-checks clean'],
        verifyCmd: 'npm test',        mergeMode: 'auto',
      },
    })

    // The legacy tasks.done_criteria_json column is dropped; data lives only
    // in the junction table. Verify the public interface still returns it.
    const fetched = await q.getTask(t.id)
    expect(fetched?.spec?.doneCriteria).toEqual(['all tests pass', 'type-checks clean'])
  })
})
