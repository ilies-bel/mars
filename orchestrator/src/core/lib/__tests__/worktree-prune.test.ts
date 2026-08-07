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
  stallDiagnostics: null,
  recoverySpawnedCount: 0,
  envRestartCount: 0,
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
  leaseOwner: null,
  leasedAt: null,
  leaseNote: null,
  originSessionId: null,
  workflow: null,
  currentStepName: null,
  currentStepGuide: null,
  qa: 'auto',
  deferrable: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const wt = (id = 'mars-test'): DiscoveredWorktree => ({
  path: `/tmp/${id}`,
  branch: `task/${id}`,
  taskId: id,
})

/** Shared injectable deps that never hit real git. Tests override what they need. */
const fakeDeps = {
  repoRoot: '/fake-repo',
  isBranchMergedIntoMain: async () => true,
}

describe('classifyWorktreeForPrune', () => {
  // ── Removal cases ──────────────────────────────────────────────────────────

  it('(d) removes done worktrees whose branch is merged into main', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      ...fakeDeps,
      getTask: async () => baseTask({ status: 'done' }),
      isBranchMergedIntoMain: async () => true,
    })
    expect(result.verdict).toBe('remove-done')
  })

  it('(f) removes dropped worktrees', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      ...fakeDeps,
      getTask: async () => baseTask({ status: 'dropped' }),
    })
    expect(result.verdict).toBe('remove-dropped')
  })

  it('(e) removes orphan worktrees (no task row)', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      ...fakeDeps,
      getTask: async () => null,
    })
    expect(result.verdict).toBe('remove-orphan')
  })

  // ── Keep cases ─────────────────────────────────────────────────────────────

  it('(a) keeps done worktrees whose branch is NOT merged into main (desync)', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      ...fakeDeps,
      getTask: async () => baseTask({ status: 'done' }),
      isBranchMergedIntoMain: async () => false,
    })
    expect(result.verdict).toBe('skip-desync')
  })

  it('(b) keeps awaiting-human worktrees regardless of directory age', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      ...fakeDeps,
      getTask: async () => baseTask({ status: 'awaiting-human' }),
    })
    expect(result.verdict).toBe('skip-other')
  })

  it('(c) keeps blocked worktrees regardless of directory age', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      ...fakeDeps,
      getTask: async () => baseTask({ status: 'blocked' }),
    })
    expect(result.verdict).toBe('skip-other')
  })

  it('(c) keeps draft worktrees regardless of directory age', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      ...fakeDeps,
      getTask: async () => baseTask({ status: 'draft' }),
    })
    expect(result.verdict).toBe('skip-other')
  })

  it('keeps failed worktrees', async () => {
    const result = await classifyWorktreeForPrune(wt(), {
      ...fakeDeps,
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
        ...fakeDeps,
        getTask: async () => baseTask({ status }),
      })
      expect(result.verdict).toBe('skip-in-flight')
    })
  }

  // ── desync: isBranchMergedIntoMain is called with the right branch/root ───

  it('passes branch and repoRoot to isBranchMergedIntoMain', async () => {
    const calls: Array<{ branch: string; repoRoot: string }> = []
    await classifyWorktreeForPrune(wt('mars-abc'), {
      getTask: async () => baseTask({ status: 'done' }),
      repoRoot: '/my-repo',
      isBranchMergedIntoMain: async (branch, repoRoot) => {
        calls.push({ branch, repoRoot })
        return true
      },
    })
    expect(calls).toEqual([{ branch: 'task/mars-abc', repoRoot: '/my-repo' }])
  })

  // ── Mixed-set integration test ─────────────────────────────────────────────

  it('classifies a mixed set spanning done-merged, done-unmerged, dropped, failed, in-flight, orphan, and live statuses', async () => {
    type Entry = { status: TaskStatus | null; merged?: boolean }
    const entries: Record<string, Entry> = {
      'done-merged': { status: 'done', merged: true },
      'done-unmerged': { status: 'done', merged: false },
      'dropped-task': { status: 'dropped' },
      'failed-task': { status: 'failed' },
      'queued-task': { status: 'queued' },
      'running-task': { status: 'running' },
      'verifying-task': { status: 'verifying' },
      'merging-task': { status: 'merging' },
      'awaiting-human-task': { status: 'awaiting-human' },
      'blocked-task': { status: 'blocked' },
      'draft-task': { status: 'draft' },
      'orphan-task': { status: null },
    }

    const dirs = Object.keys(entries).map(wt)
    const results = await Promise.all(
      dirs.map((d) =>
        classifyWorktreeForPrune(d, {
          getTask: async (id) => {
            const entry = entries[id]
            return entry?.status ? baseTask({ id, status: entry.status }) : null
          },
          repoRoot: '/fake-repo',
          isBranchMergedIntoMain: async (branch) => {
            const id = branch.replace('task/', '')
            return entries[id]?.merged ?? true
          },
        }),
      ),
    )

    const verdictById = Object.fromEntries(
      results.map((r) => [r.worktree.taskId, r.verdict]),
    )

    // Removed:
    expect(verdictById['done-merged']).toBe('remove-done')
    expect(verdictById['dropped-task']).toBe('remove-dropped')
    expect(verdictById['orphan-task']).toBe('remove-orphan')

    // Kept — desync (done but unmerged):
    expect(verdictById['done-unmerged']).toBe('skip-desync')

    // Kept — failed:
    expect(verdictById['failed-task']).toBe('skip-failed')

    // Kept — all in-flight statuses:
    expect(verdictById['queued-task']).toBe('skip-in-flight')
    expect(verdictById['running-task']).toBe('skip-in-flight')
    expect(verdictById['verifying-task']).toBe('skip-in-flight')
    expect(verdictById['merging-task']).toBe('skip-in-flight')

    // Kept — live non-terminal statuses (never removed regardless of age):
    expect(verdictById['awaiting-human-task']).toBe('skip-other')
    expect(verdictById['blocked-task']).toBe('skip-other')
    expect(verdictById['draft-task']).toBe('skip-other')
  })
})
