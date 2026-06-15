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
  devServerUrl: null,
  devServerPid: null,
  previewValidated: false,
  recoveryPayload: null,
  intent: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const wt = (id = 'mars-test'): DiscoveredWorktree => ({
  path: `/tmp/${id}`,
  branch: `task/${id}`,
  taskId: id,
})

// Fixed timestamps for stale-rule tests — arbitrary values, never wall-clock.
const FIXED_MIDNIGHT_MS = 1_000_000
const BEFORE_MIDNIGHT_MS = FIXED_MIDNIGHT_MS - 1
const AFTER_MIDNIGHT_MS = FIXED_MIDNIGHT_MS + 1

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

  // ── Stale-rule tests ────────────────────────────────────────────────────────

  it('removes an other-status worktree whose directory mtime is before today midnight', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      getTask: async () => baseTask({ status: 'blocked' }),
      todayMidnightMs: FIXED_MIDNIGHT_MS,
      getDirMtimeMs: () => BEFORE_MIDNIGHT_MS,
    })
    expect(result.verdict).toBe('remove-stale')
  })

  it('keeps an other-status worktree whose directory mtime is on or after today midnight', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      getTask: async () => baseTask({ status: 'blocked' }),
      todayMidnightMs: FIXED_MIDNIGHT_MS,
      getDirMtimeMs: () => AFTER_MIDNIGHT_MS,
    })
    expect(result.verdict).toBe('skip-other')
  })

  it('keeps an in-flight worktree even when its directory mtime is before today midnight', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      getTask: async () => baseTask({ status: 'running' }),
      todayMidnightMs: FIXED_MIDNIGHT_MS,
      getDirMtimeMs: () => BEFORE_MIDNIGHT_MS,
    })
    expect(result.verdict).toBe('skip-in-flight')
  })

  it('keeps a failed worktree even when its directory mtime is before today midnight', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      getTask: async () => baseTask({ status: 'failed' }),
      todayMidnightMs: FIXED_MIDNIGHT_MS,
      getDirMtimeMs: () => BEFORE_MIDNIGHT_MS,
    })
    expect(result.verdict).toBe('skip-failed')
  })

  it('uses the injected todayMidnightMs as the cutoff (stale cutoff is caller-supplied)', async () => {
    // mtime is exactly at midnight — not before it — so NOT stale
    const atMidnight = await classifyWorktreeForPrune(wt('at'), {
      getTask: async () => baseTask({ id: 'at', status: 'draft' }),
      todayMidnightMs: FIXED_MIDNIGHT_MS,
      getDirMtimeMs: () => FIXED_MIDNIGHT_MS,
    })
    expect(atMidnight.verdict).toBe('skip-other')

    // mtime is 1ms before midnight — stale
    const justBefore = await classifyWorktreeForPrune(wt('before'), {
      getTask: async () => baseTask({ id: 'before', status: 'draft' }),
      todayMidnightMs: FIXED_MIDNIGHT_MS,
      getDirMtimeMs: () => FIXED_MIDNIGHT_MS - 1,
    })
    expect(justBefore.verdict).toBe('remove-stale')
  })

  it('stale rule: mixed set spanning in-flight, failed, prior-day, and today dirs', async () => {
    type TaskEntry = { status: TaskStatus | null; mtime: number }
    const entries: Record<string, TaskEntry> = {
      // Prior-day dirs
      'stale-blocked': { status: 'blocked', mtime: BEFORE_MIDNIGHT_MS },
      'stale-draft': { status: 'draft', mtime: BEFORE_MIDNIGHT_MS },
      // Prior-day dir but in-flight — protected
      'inflight-old': { status: 'running', mtime: BEFORE_MIDNIGHT_MS },
      // Prior-day dir but failed — protected
      'failed-old': { status: 'failed', mtime: BEFORE_MIDNIGHT_MS },
      // Terminal tasks already removed regardless of mtime
      'done-old': { status: 'done', mtime: BEFORE_MIDNIGHT_MS },
      'dropped-old': { status: 'dropped', mtime: BEFORE_MIDNIGHT_MS },
      // Today's dirs — skip-other regardless
      'blocked-today': { status: 'blocked', mtime: AFTER_MIDNIGHT_MS },
      'inflight-today': { status: 'queued', mtime: AFTER_MIDNIGHT_MS },
      'failed-today': { status: 'failed', mtime: AFTER_MIDNIGHT_MS },
    }

    const results = await Promise.all(
      Object.entries(entries).map(([id, { status, mtime }]) =>
        classifyWorktreeForPrune(wt(id), {
          getTask: async () => (status ? baseTask({ id, status }) : null),
          todayMidnightMs: FIXED_MIDNIGHT_MS,
          getDirMtimeMs: () => mtime,
        }),
      ),
    )

    const verdictById = Object.fromEntries(
      results.map((r) => [r.worktree.taskId, r.verdict]),
    )

    // Stale prior-day other-status → removed
    expect(verdictById['stale-blocked']).toBe('remove-stale')
    expect(verdictById['stale-draft']).toBe('remove-stale')

    // Prior-day in-flight → protected
    expect(verdictById['inflight-old']).toBe('skip-in-flight')

    // Prior-day failed → protected
    expect(verdictById['failed-old']).toBe('skip-failed')

    // Terminal (already removed regardless of mtime)
    expect(verdictById['done-old']).toBe('remove-done')
    expect(verdictById['dropped-old']).toBe('remove-dropped')

    // Today's dirs — other-status kept
    expect(verdictById['blocked-today']).toBe('skip-other')

    // Today's dirs — in-flight always kept
    expect(verdictById['inflight-today']).toBe('skip-in-flight')

    // Today's dirs — failed always kept
    expect(verdictById['failed-today']).toBe('skip-failed')
  })
})
