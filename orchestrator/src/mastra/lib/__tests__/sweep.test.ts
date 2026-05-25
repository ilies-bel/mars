import { describe, expect, it } from 'vitest'
import {
  findOrphanTaskBranches,
  runSweep,
  type SweepDeps,
} from '../sweep'
import type { Task } from '../../queue'

const baseTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? 'mars-known',
  prompt: 'test',
  status: 'queued',
  plan: null,
  branch: `task/${overrides.id ?? 'mars-known'}`,
  worktreePath: null,
  claudeSessionId: null,
  claudeSessionIds: [],
  error: null,
  author: null,
  dropReason: null,
  failureReason: null,
  retryCount: 0,
  fixForTaskId: null,
  failureSignature: null,
  originId: overrides.id ?? 'mars-known',
  priority: 0,
  failedPhase: null,
  resumeFrom: null,
  spec: null,
  integrationHeadSha: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const makeDeps = (overrides: Partial<SweepDeps>): SweepDeps => ({
  listTaskBranches: async () => [],
  getTask: async () => null,
  listUniqueCommits: async () => [],
  ...overrides,
})

describe('findOrphanTaskBranches', () => {
  it('reports task/<id> branches whose id has no matching queue row', async () => {
    const result = await findOrphanTaskBranches(
      'main',
      makeDeps({
        listTaskBranches: async () => ['task/mars-orphan'],
        getTask: async () => null,
        listUniqueCommits: async () => [
          { shortSha: 'abc1234', subject: 'first commit' },
          { shortSha: 'def5678', subject: 'second commit' },
        ],
      }),
    )

    expect(result).toEqual([
      {
        branch: 'task/mars-orphan',
        taskId: 'mars-orphan',
        commits: [
          { shortSha: 'abc1234', subject: 'first commit' },
          { shortSha: 'def5678', subject: 'second commit' },
        ],
      },
    ])
  })

  it('omits branches whose id is present in the queue', async () => {
    const result = await findOrphanTaskBranches(
      'main',
      makeDeps({
        listTaskBranches: async () => ['task/mars-known', 'task/mars-orphan'],
        getTask: async (id) =>
          id === 'mars-known' ? baseTask({ id: 'mars-known' }) : null,
        listUniqueCommits: async () => [
          { shortSha: 'aaa1111', subject: 'work' },
        ],
      }),
    )

    expect(result.map((o) => o.taskId)).toEqual(['mars-orphan'])
  })

  it('returns an empty list when no branches are orphaned', async () => {
    const result = await findOrphanTaskBranches(
      'main',
      makeDeps({
        listTaskBranches: async () => ['task/mars-known'],
        getTask: async () => baseTask({ id: 'mars-known' }),
      }),
    )

    expect(result).toEqual([])
  })

  it('ignores local branches that do not match the task/<id> prefix', async () => {
    const taskCalls: string[] = []
    const result = await findOrphanTaskBranches(
      'main',
      makeDeps({
        listTaskBranches: async () => [
          'main',
          'feature/foo',
          'task/mars-orphan',
        ],
        getTask: async (id) => {
          taskCalls.push(id)
          return null
        },
      }),
    )

    expect(result.map((o) => o.branch)).toEqual(['task/mars-orphan'])
    // Only the task/<id> branch should be queried against the queue.
    expect(taskCalls).toEqual(['mars-orphan'])
  })
})

describe('runSweep (presentation)', () => {
  it('prints a clear empty-state message when no orphans exist', async () => {
    const lines: string[] = []
    const summary = await runSweep({
      integrationBranch: 'main',
      log: (line) => lines.push(line),
      deps: {
        listTaskBranches: async () => [],
        getTask: async () => null,
        listUniqueCommits: async () => [],
      },
    })
    expect(summary.orphans).toEqual([])
    expect(lines).toEqual(['no orphan task branches'])
  })

  it('prints each orphan branch followed by indented <short-sha> <subject> lines', async () => {
    const lines: string[] = []
    await runSweep({
      integrationBranch: 'main',
      log: (line) => lines.push(line),
      deps: {
        listTaskBranches: async () => ['task/mars-orphan'],
        getTask: async () => null,
        listUniqueCommits: async () => [
          { shortSha: 'abc1234', subject: 'add sweep verb' },
          { shortSha: 'def5678', subject: 'wire help text' },
        ],
      },
    })
    expect(lines).toEqual([
      'task/mars-orphan',
      '  abc1234 add sweep verb',
      '  def5678 wire help text',
    ])
  })
})
