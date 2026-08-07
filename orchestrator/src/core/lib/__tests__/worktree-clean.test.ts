import { describe, expect, it } from 'vitest'
import {
  classifyWorktree,
  type DiscoveredWorktree,
} from '../worktree-clean'
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

const makeDeps = (opts: {
  task?: Task | null
  merged?: boolean
  zeroCommit?: boolean
}) => ({
  getTask: async () => opts.task ?? null,
  isBranchMergedIntoMain: async () => opts.merged ?? false,
  isZeroCommitBranch: async () => opts.zeroCommit ?? false,
})

describe('classifyWorktree', () => {
  it('removes done+merged worktrees', async () => {
    const result = await classifyWorktree(
      wt(),
      '/repo',
      makeDeps({ task: baseTask({ status: 'done' }), merged: true }),
    )
    expect(result.verdict).toBe('remove-done-merged')
  })

  it('keeps done+not-merged worktrees as desync', async () => {
    const result = await classifyWorktree(
      wt(),
      '/repo',
      makeDeps({ task: baseTask({ status: 'done' }), merged: false }),
    )
    expect(result.verdict).toBe('skip-desync')
  })

  it('removes failed+zero-commit worktrees', async () => {
    const result = await classifyWorktree(
      wt(),
      '/repo',
      makeDeps({ task: baseTask({ status: 'failed' }), zeroCommit: true }),
    )
    expect(result.verdict).toBe('remove-failed-zero-commit')
  })

  it('removes dropped+zero-commit worktrees', async () => {
    const result = await classifyWorktree(
      wt(),
      '/repo',
      makeDeps({ task: baseTask({ status: 'dropped' }), zeroCommit: true }),
    )
    expect(result.verdict).toBe('remove-failed-zero-commit')
  })

  it('keeps failed+committed worktrees (caller may want the work)', async () => {
    const result = await classifyWorktree(
      wt(),
      '/repo',
      makeDeps({ task: baseTask({ status: 'failed' }), zeroCommit: false }),
    )
    expect(result.verdict).toBe('skip-other')
  })

  it('removes orphan worktrees with zero-commit branches', async () => {
    const result = await classifyWorktree(
      wt(),
      '/repo',
      makeDeps({ task: null, zeroCommit: true }),
    )
    expect(result.verdict).toBe('remove-orphan-zero-commit')
  })

  it('reports orphan worktrees with committed branches', async () => {
    const result = await classifyWorktree(
      wt(),
      '/repo',
      makeDeps({ task: null, zeroCommit: false }),
    )
    expect(result.verdict).toBe('report-orphan-committed')
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
      const result = await classifyWorktree(
        wt(),
        '/repo',
        makeDeps({ task: baseTask({ status }) }),
      )
      expect(result.verdict).toBe('skip-in-flight')
    })
  }
})
