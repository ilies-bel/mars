/**
 * Unit tests for buildProgressView covering arc topology fields:
 *   - origin_id, fix_for_task_id, and kind are surfaced on each ProgressTask
 *     so the UI can cluster by arc in the Topology view.
 *
 * Tests exercise observable behaviour through the public interface only:
 * the { tasks, proposals } returned by buildProgressView.
 */

import { describe, expect, it } from 'vitest'
import {
  buildProgressView,
  type ProgressTaskRow,
  type ProgressTaskStore,
  type ProposalReader,
} from '../progress.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

const noProposals: ProposalReader = {
  listByIds: async () => [],
}

const makeRow = (overrides: Partial<ProgressTaskRow> = {}): ProgressTaskRow => ({
  id: 'task-1',
  prompt: 'Do something',
  status: 'queued',
  planFunctional: null,
  planTechnical: null,
  branch: null,
  worktreePath: null,
  error: null,
  failureSignature: null,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  blockedBy: [],
  parentProposalId: null,
  filesJson: null,
  readFirstJson: null,
  prescriptiveAction: null,
  verifyCmd: null,
  doneCriteriaJson: null,
  taskType: null,
  originId: null,
  fixForTaskId: null,
  kind: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

const makeStore = (rows: ProgressTaskRow[]): ProgressTaskStore => ({
  listProgressTasks: async () => rows,
})

// ── Arc topology field tests ──────────────────────────────────────────────────

describe('buildProgressView — arc topology fields', () => {
  it('surfaces originId on a regular task (kind=task, self-referencing origin)', async () => {
    const row = makeRow({ id: 'task-abc', originId: 'task-abc', kind: 'task', fixForTaskId: null })
    const { tasks } = await buildProgressView(makeStore([row]), noProposals)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].originId).toBe('task-abc')
    expect(tasks[0].kind).toBe('task')
    expect(tasks[0].fixForTaskId).toBeNull()
  })

  it('surfaces fixForTaskId and kind=fix on a recovery task', async () => {
    const row = makeRow({
      id: 'fix-1',
      status: 'running',
      originId: 'task-abc',
      fixForTaskId: 'task-abc',
      kind: 'fix',
    })
    const { tasks } = await buildProgressView(makeStore([row]), noProposals)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('fix-1')
    expect(tasks[0].originId).toBe('task-abc')
    expect(tasks[0].fixForTaskId).toBe('task-abc')
    expect(tasks[0].kind).toBe('fix')
  })

  it('passes null for originId/fixForTaskId/kind when DB columns are null', async () => {
    const row = makeRow({ originId: null, fixForTaskId: null, kind: null })
    const { tasks } = await buildProgressView(makeStore([row]), noProposals)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].originId).toBeNull()
    expect(tasks[0].fixForTaskId).toBeNull()
    expect(tasks[0].kind).toBeNull()
  })

  it('excludes out-of-scope tasks (done/dropped) while retaining arc fields for in-scope tasks', async () => {
    const inScope = makeRow({ id: 'in-1', status: 'failed', originId: 'origin-1', kind: 'task' })
    const outOfScope = makeRow({ id: 'out-1', status: 'done', originId: 'origin-1', kind: 'task' })
    const { tasks } = await buildProgressView(makeStore([inScope, outOfScope]), noProposals)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('in-1')
    expect(tasks[0].originId).toBe('origin-1')
  })
})
