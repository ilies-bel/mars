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
  type AggregateReader,
  type ProgressAggregates,
  type ProgressTaskRow,
  type ProgressTaskStore,
  type ProposalReader,
} from '../progress.js'

describe('buildProgressView task priority', () => {
  it('includes the numeric priority of a queued task in its non-empty payload', async () => {
    const { tasks } = await buildProgressView(
      makeStore([makeRow({ id: 'queued-high', priority: 3 })]),
      noProposals,
      zeroAggregates,
    )

    expect(tasks).toEqual([
      expect.objectContaining({ id: 'queued-high', priority: 3 }),
    ])
  })
})

// ── Test helpers ──────────────────────────────────────────────────────────────

const noProposals: ProposalReader = {
  listByIds: async () => [],
}

const zeroAggregates: AggregateReader = {
  readAggregates: async () => ({ doneToday: 0, doneTotal: 0, failedOpen: 0 }),
}

const makeRow = (overrides: Partial<ProgressTaskRow> = {}): ProgressTaskRow => ({
  id: 'task-1',
  prompt: 'Do something',
  intent: null,
  status: 'queued',
  priority: 0,
  planFunctional: null,
  planTechnical: null,
  branch: null,
  worktreePath: null,
  error: null,
  failureSignature: null,
  dropReason: null,
  recoverySpawnedCount: 0,
  blockerTaskId: null,
  blockedBy: [],
  parentProposalId: null,
  filesJson: null,
  readFirstJson: null,
  prescriptiveAction: null,
  verifyCmd: null,
  doneCriteriaJson: null,
  mergeMode: null,
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
    const { tasks } = await buildProgressView(makeStore([row]), noProposals, zeroAggregates)
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
    const { tasks } = await buildProgressView(makeStore([row]), noProposals, zeroAggregates)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('fix-1')
    expect(tasks[0].originId).toBe('task-abc')
    expect(tasks[0].fixForTaskId).toBe('task-abc')
    expect(tasks[0].kind).toBe('fix')
  })

  it('passes null for originId/fixForTaskId/kind when DB columns are null', async () => {
    const row = makeRow({ originId: null, fixForTaskId: null, kind: null })
    const { tasks } = await buildProgressView(makeStore([row]), noProposals, zeroAggregates)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].originId).toBeNull()
    expect(tasks[0].fixForTaskId).toBeNull()
    expect(tasks[0].kind).toBeNull()
  })

  it('excludes out-of-scope tasks (dropped) while retaining arc fields for in-scope tasks', async () => {
    const inScope = makeRow({ id: 'in-1', status: 'failed', originId: 'origin-1', kind: 'task' })
    const outOfScope = makeRow({ id: 'out-1', status: 'dropped', originId: 'origin-1', kind: 'task' })
    const { tasks } = await buildProgressView(makeStore([inScope, outOfScope]), noProposals, zeroAggregates)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('in-1')
    expect(tasks[0].originId).toBe('origin-1')
  })
})

// ── Aggregate counts ──────────────────────────────────────────────────────────

describe('buildProgressView — aggregate counts', () => {
  it('includes aggregate counts from the reader in the returned payload', async () => {
    const expected: ProgressAggregates = { doneToday: 7, doneTotal: 142, failedOpen: 3 }
    const reader: AggregateReader = { readAggregates: async () => expected }
    const { aggregates } = await buildProgressView(makeStore([]), noProposals, reader)
    expect(aggregates).toEqual(expected)
  })

  it('does not conflate aggregate counts with in-scope task rows', async () => {
    const row = makeRow({ id: 'q-1', status: 'queued' })
    const reader: AggregateReader = {
      readAggregates: async () => ({ doneToday: 5, doneTotal: 99, failedOpen: 2 }),
    }
    const { tasks, aggregates } = await buildProgressView(makeStore([row]), noProposals, reader)
    // Only in-scope (non-done/dropped) rows appear in the task list.
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('q-1')
    // Aggregate counts come from the reader, not from the task rows.
    expect(aggregates.doneTotal).toBe(99)
    expect(aggregates.doneToday).toBe(5)
    expect(aggregates.failedOpen).toBe(2)
  })

  it('passes through failedOpen unchanged — reader is responsible for excluding recovery tasks', async () => {
    // The real createAggregateReader filters AND fix_for_task_id IS NULL so
    // that a failed origin + its failed recovery count as 1, not 2.
    // buildProgressView must NOT re-count from the task rows; it trusts the
    // reader. This test pins that contract: two failed tasks in the view but
    // the reader says failedOpen=1 → the view reports 1.
    const reader: AggregateReader = {
      readAggregates: async () => ({ doneToday: 0, doneTotal: 0, failedOpen: 1 }),
    }
    const failedOrigin = makeRow({ id: 'origin-1', status: 'failed', fixForTaskId: null })
    const failedRecovery = makeRow({ id: 'fix-1', status: 'failed', fixForTaskId: 'origin-1' })
    const { aggregates } = await buildProgressView(
      makeStore([failedOrigin, failedRecovery]),
      noProposals,
      reader,
    )
    // Reader already excluded the recovery row; view must not inflate to 2.
    expect(aggregates.failedOpen).toBe(1)
  })
})

describe('buildProgressView — completed-arc pruning', () => {
  it('drops Done tasks whose arc has no active member', async () => {
    const staleDone = makeRow({ id: 'old-1', status: 'done' })
    const alsoDone = makeRow({ id: 'old-2', status: 'done', originId: 'old-1' })
    const { tasks } = await buildProgressView(
      makeStore([staleDone, alsoDone]),
      noProposals,
      zeroAggregates,
    )
    expect(tasks).toHaveLength(0)
  })

  it('keeps a Done origin whose arc still has an active task (board arc title)', async () => {
    // The board resolves an arc's title from its origin. Dropping a Done origin
    // makes the active arc render as "Abandoned arc / origin force-purged".
    const doneOrigin = makeRow({ id: 'origin-1', status: 'done' })
    const activeChild = makeRow({ id: 'child-1', status: 'running', originId: 'origin-1' })
    const { tasks } = await buildProgressView(
      makeStore([doneOrigin, activeChild]),
      noProposals,
      zeroAggregates,
    )
    expect(tasks.map((t) => t.id).sort()).toEqual(['child-1', 'origin-1'])
  })

  it('keeps a Done task sharing only a parent proposal with an active task', async () => {
    // The topology keys arcs by parentProposalId first, so proposal siblings
    // belong to the same arc even with no origin_id relationship.
    const doneSibling = makeRow({ id: 'slice-1', status: 'done', parentProposalId: 'prd-1' })
    const activeSibling = makeRow({ id: 'slice-2', status: 'queued', parentProposalId: 'prd-1' })
    const { tasks } = await buildProgressView(
      makeStore([doneSibling, activeSibling]),
      noProposals,
      zeroAggregates,
    )
    expect(tasks.map((t) => t.id).sort()).toEqual(['slice-1', 'slice-2'])
  })

  it('never prunes non-Done tasks', async () => {
    const failed = makeRow({ id: 'f-1', status: 'failed' })
    const { tasks } = await buildProgressView(
      makeStore([failed]),
      noProposals,
      zeroAggregates,
    )
    expect(tasks.map((t) => t.id)).toEqual(['f-1'])
  })
})
