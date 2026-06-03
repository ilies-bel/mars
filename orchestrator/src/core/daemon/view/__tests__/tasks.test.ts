/**
 * Unit tests for buildTasksView — the canonical shape of GET /view/tasks.
 *
 * Acceptance criteria:
 *  - every row carries a `cluster` field (Cluster | null)
 *  - every row carries a `blockedBy` array (empty when no blockers)
 *  - cluster is correct per-status (matches clusterFor contract)
 *  - terminal statuses (done/draft/dropped) get null cluster
 *  - blockedBy is populated from task_blockers junction
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { buildTasksView, buildTaskViewById } from '../tasks.js'

// ── DB helpers ────────────────────────────────────────────────────────────────

const setupDb = async (): Promise<{ client: Client; dir: string }> => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-tasks-view-test-'))
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  const client = createClient({ url: `file:${resolve(dir, 'mars.db')}` })
  await client.execute(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_functional TEXT,
      plan_technical TEXT,
      branch TEXT,
      worktree_path TEXT,
      error TEXT,
      failure_signature TEXT,
      drop_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      parent_proposal_id TEXT,
      files_json TEXT,
      read_first_json TEXT,
      prescriptive_action TEXT,
      verify_cmd TEXT,
      done_criteria_json TEXT,
      task_type TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE task_blockers (
      task_id TEXT NOT NULL,
      blocker_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, blocker_task_id)
    )
  `)
  return { client, dir }
}

const insertTask = async (
  client: Client,
  id: string,
  status: string,
): Promise<void> => {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, `prompt for ${id}`, status, now, now],
  })
}

const addBlocker = async (
  client: Client,
  taskId: string,
  blockerId: string,
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO task_blockers (task_id, blocker_task_id) VALUES (?, ?)`,
    args: [taskId, blockerId],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildTasksView', () => {
  let client: Client
  let dir: string

  beforeEach(async () => {
    const setup = await setupDb()
    client = setup.client
    dir = setup.dir
  })

  afterEach(() => {
    client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an empty tasks array when no tasks exist', async () => {
    const result = await buildTasksView(client)
    expect(result.tasks).toEqual([])
  })

  it('every row carries a cluster field', async () => {
    await insertTask(client, 't-queued', 'queued')
    await insertTask(client, 't-running', 'running')
    const { tasks } = await buildTasksView(client)
    expect(tasks).toHaveLength(2)
    for (const t of tasks) {
      expect('cluster' in t).toBe(true)
    }
  })

  it('every row carries a blockedBy array', async () => {
    await insertTask(client, 't-queued', 'queued')
    const { tasks } = await buildTasksView(client)
    expect(tasks[0]).toHaveProperty('blockedBy')
    expect(Array.isArray(tasks[0]!.blockedBy)).toBe(true)
  })

  it('maps non-terminal statuses to the correct cluster', async () => {
    await insertTask(client, 't-queued', 'queued')
    await insertTask(client, 't-running', 'running')
    await insertTask(client, 't-verifying', 'verifying')
    await insertTask(client, 't-merging', 'merging')
    await insertTask(client, 't-vega', 'vega-reconciling')
    await insertTask(client, 't-blocked', 'blocked')
    await insertTask(client, 't-failed', 'failed')

    const { tasks } = await buildTasksView(client)
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t.cluster]))

    expect(byId['t-queued']).toBe('Queued')
    expect(byId['t-running']).toBe('In progress')
    expect(byId['t-verifying']).toBe('In progress')
    expect(byId['t-merging']).toBe('In progress')
    expect(byId['t-vega']).toBe('In progress')
    expect(byId['t-blocked']).toBe('Blocked')
    expect(byId['t-failed']).toBe('Failed')
  })

  it('terminal statuses (done/draft/dropped) get a null cluster', async () => {
    await insertTask(client, 't-done', 'done')
    await insertTask(client, 't-draft', 'draft')
    await insertTask(client, 't-dropped', 'dropped')

    const { tasks } = await buildTasksView(client)
    for (const t of tasks) {
      expect(t.cluster).toBeNull()
    }
  })

  it('returns all tasks including terminal ones (no filtering)', async () => {
    await insertTask(client, 't-queued', 'queued')
    await insertTask(client, 't-done', 'done')
    await insertTask(client, 't-draft', 'draft')

    const { tasks } = await buildTasksView(client)
    const ids = tasks.map((t) => t.id).sort()
    expect(ids).toEqual(['t-done', 't-draft', 't-queued'])
  })

  it('populates blockedBy from task_blockers junction table', async () => {
    await insertTask(client, 't-blocker-1', 'done')
    await insertTask(client, 't-blocker-2', 'done')
    await insertTask(client, 't-blocked', 'blocked')
    await addBlocker(client, 't-blocked', 't-blocker-1')
    await addBlocker(client, 't-blocked', 't-blocker-2')

    const { tasks } = await buildTasksView(client)
    const blocked = tasks.find((t) => t.id === 't-blocked')
    expect(blocked).toBeDefined()
    expect(blocked!.blockedBy.sort()).toEqual(['t-blocker-1', 't-blocker-2'])
  })

  it('sets blockedBy to an empty array for tasks with no blockers', async () => {
    await insertTask(client, 't-queued', 'queued')

    const { tasks } = await buildTasksView(client)
    expect(tasks[0]!.blockedBy).toEqual([])
  })

  it('blockerTaskId is the first blocker when multiple blockers exist', async () => {
    await insertTask(client, 't-a', 'done')
    await insertTask(client, 't-b', 'done')
    await insertTask(client, 't-blocked', 'blocked')
    await addBlocker(client, 't-blocked', 't-a')
    await addBlocker(client, 't-blocked', 't-b')

    const { tasks } = await buildTasksView(client)
    const blocked = tasks.find((t) => t.id === 't-blocked')
    expect(blocked!.blockerTaskId).toBeTruthy()
    expect(['t-a', 't-b']).toContain(blocked!.blockerTaskId)
  })
})

describe('buildTaskViewById', () => {
  let client: Client
  let dir: string

  beforeEach(async () => {
    const setup = await setupDb()
    client = setup.client
    dir = setup.dir
  })

  afterEach(() => {
    client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no task with the given id exists', async () => {
    const result = await buildTaskViewById(client, 'nonexistent')
    expect(result).toBeNull()
  })

  it('returns { task } wrapping the matching TaskViewItem when id exists', async () => {
    await insertTask(client, 't-queued', 'queued')
    const result = await buildTaskViewById(client, 't-queued')
    expect(result).not.toBeNull()
    expect(result!.task.id).toBe('t-queued')
    expect(result!.task.status).toBe('queued')
  })

  it('returned task deep-equals the matching element from buildTasksView', async () => {
    await insertTask(client, 't-a', 'done')
    await insertTask(client, 't-b', 'queued')
    await addBlocker(client, 't-b', 't-a')

    const { tasks } = await buildTasksView(client)
    const fromList = tasks.find((t) => t.id === 't-b')

    const result = await buildTaskViewById(client, 't-b')
    expect(result).not.toBeNull()
    expect(result!.task).toEqual(fromList)
  })
})
