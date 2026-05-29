import { describe, expect, it } from 'vitest'
import { classifyWorktreeForPrune } from '../worktree-prune'
import type { DiscoveredWorktree } from '../worktree-clean'
import type { Task, TaskStatus } from '../../queue'

const baseTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? 'mars-test',
  prompt: 'test',
  status: 'done',
  plan: null,
  branch: 'task/mars-test',
  worktreePath: '/tmp/mars-test',
  claudeSessionId: null,
  claudeSessionIds: [],
  error: null,
  author: null,
  dropReason: null,
  failureReason: null,
  failureReasonCode: null,
  retryCount: 0,
  fixForTaskId: null,
  failureSignature: null,
  originId: 'mars-test',
  priority: 0,
  failedPhase: null,
  spec: null,
  tags: ['coder'],
  integrationHeadSha: null,
  recoveryPayload: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const wt = (id = 'mars-test'): DiscoveredWorktree => ({
  path: `/tmp/${id}`,
  branch: `task/${id}`,
  taskId: id,
})

describe('classifyWorktreeForPrune', () => {
  it('removes done worktrees', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      getTask: async () => baseTask({ status: 'done' }),
    })
    expect(result.verdict).toBe('remove-done')
  })

  it('removes dropped worktrees', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      getTask: async () => baseTask({ status: 'dropped' }),
    })
    expect(result.verdict).toBe('remove-dropped')
  })

  it('removes orphan worktrees (no task row)', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      getTask: async () => null,
    })
    expect(result.verdict).toBe('remove-orphan')
  })

  it('keeps failed worktrees', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      getTask: async () => baseTask({ status: 'failed' }),
    })
    expect(result.verdict).toBe('skip-failed')
  })

  const inFlightStatuses: TaskStatus[] = [
    'queued',
    'running',
    'verifying',
    'merging',
    'vega-reconciling',
  ]
  for (const status of inFlightStatuses) {
    it(`keeps in-flight worktrees (${status})`, async () => {
      const result = await classifyWorktreeForPrune(wt(), {
        getTask: async () => baseTask({ status }),
      })
      expect(result.verdict).toBe('skip-in-flight')
    })
  }

  it('classifies a mixed set of directories spanning done, dropped, failed, in-flight, and orphan', async () => {
    const tasksByDir: Record<string, Task | null> = {
      'done-task': baseTask({ id: 'done-task', status: 'done' }),
      'dropped-task': baseTask({ id: 'dropped-task', status: 'dropped' }),
      'failed-task': baseTask({ id: 'failed-task', status: 'failed' }),
      'queued-task': baseTask({ id: 'queued-task', status: 'queued' }),
      'running-task': baseTask({ id: 'running-task', status: 'running' }),
      'verifying-task': baseTask({ id: 'verifying-task', status: 'verifying' }),
      'merging-task': baseTask({ id: 'merging-task', status: 'merging' }),
      'orphan-task': null,
    }

    const dirs = Object.keys(tasksByDir).map(wt)
    const results = await Promise.all(
      dirs.map((d) =>
        classifyWorktreeForPrune(d, {
          getTask: async (id) => tasksByDir[id] ?? null,
        }),
      ),
    )

    const verdictById = Object.fromEntries(
      results.map((r) => [r.worktree.taskId, r.verdict]),
    )

    // Removed: done, dropped, orphan
    expect(verdictById['done-task']).toBe('remove-done')
    expect(verdictById['dropped-task']).toBe('remove-dropped')
    expect(verdictById['orphan-task']).toBe('remove-orphan')

    // Kept: failed
    expect(verdictById['failed-task']).toBe('skip-failed')

    // Kept: all in-flight statuses
    expect(verdictById['queued-task']).toBe('skip-in-flight')
    expect(verdictById['running-task']).toBe('skip-in-flight')
    expect(verdictById['verifying-task']).toBe('skip-in-flight')
    expect(verdictById['merging-task']).toBe('skip-in-flight')
  })
})
