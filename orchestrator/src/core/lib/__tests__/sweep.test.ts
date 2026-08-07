import { describe, expect, it } from 'vitest'
import {
  findOrphanTaskBranches,
  runSweep,
  runSweepVerb,
  type OrphanCommit,
  type SweepDeps,
  type SweepVerbDeps,
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
  failureReasonCode: null,
  stallDiagnostics: null,
  recoverySpawnedCount: 0,
  envRestartCount: 0,
  fixForTaskId: null,
  failureSignature: null,
  originId: overrides.id ?? 'mars-known',
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

const makeSweepVerbDeps = (
  overrides: Partial<SweepVerbDeps> = {},
): SweepVerbDeps => ({
  listTaskBranches: async () => ['task/mars-orphan'],
  getTask: async () => null,
  listUniqueCommits: async () => [
    { shortSha: 'abc1234', subject: 'first commit' },
    { shortSha: 'def5678', subject: 'second commit' },
  ],
  prompt: async () => 'keep',
  deleteBranch: async () => {},
  cherryPickCommits: async () => ({ ok: true as const }),
  ...overrides,
})

describe('runSweepVerb (interactive)', () => {
  it('keep — branch and commits are untouched', async () => {
    const deleteCalls: string[] = []
    const cherryPickCalls: OrphanCommit[][] = []
    const result = await runSweepVerb({
      integrationBranch: 'main',
      log: () => {},
      deps: makeSweepVerbDeps({
        prompt: async () => 'keep',
        deleteBranch: async (b) => {
          deleteCalls.push(b)
        },
        cherryPickCommits: async (c) => {
          cherryPickCalls.push(c)
          return { ok: true as const }
        },
      }),
    })
    expect(result.kept).toEqual(['task/mars-orphan'])
    expect(deleteCalls).toEqual([])
    expect(cherryPickCalls).toEqual([])
  })

  it('delete — deleteBranch is called with the branch name', async () => {
    const deleteCalls: string[] = []
    const result = await runSweepVerb({
      integrationBranch: 'main',
      log: () => {},
      deps: makeSweepVerbDeps({
        prompt: async () => 'delete',
        deleteBranch: async (b) => {
          deleteCalls.push(b)
        },
      }),
    })
    expect(result.deleted).toEqual(['task/mars-orphan'])
    expect(deleteCalls).toEqual(['task/mars-orphan'])
  })

  it('cherry-pick — commits applied oldest-first, then branch deleted', async () => {
    const cherryPickOrder: string[] = []
    const deleteCalls: string[] = []
    const result = await runSweepVerb({
      integrationBranch: 'main',
      log: () => {},
      deps: makeSweepVerbDeps({
        // git log order is newest-first: abc1234 newest, def5678 oldest
        listUniqueCommits: async () => [
          { shortSha: 'abc1234', subject: 'newest commit' },
          { shortSha: 'def5678', subject: 'oldest commit' },
        ],
        prompt: async () => 'cherry-pick',
        deleteBranch: async (b) => {
          deleteCalls.push(b)
        },
        cherryPickCommits: async (commits) => {
          for (const c of commits) cherryPickOrder.push(c.shortSha)
          return { ok: true as const }
        },
      }),
    })
    // oldest-first: def5678 then abc1234
    expect(cherryPickOrder).toEqual(['def5678', 'abc1234'])
    expect(deleteCalls).toEqual(['task/mars-orphan'])
    expect(result.cherryPicked).toEqual(['task/mars-orphan'])
  })

  it('cherry-pick conflict — logs the conflicting commit, branch left intact', async () => {
    const deleteCalls: string[] = []
    const lines: string[] = []
    const result = await runSweepVerb({
      integrationBranch: 'main',
      log: (line) => lines.push(line),
      deps: makeSweepVerbDeps({
        prompt: async () => 'cherry-pick',
        deleteBranch: async (b) => {
          deleteCalls.push(b)
        },
        cherryPickCommits: async () => ({
          ok: false as const,
          conflictingCommit: { shortSha: 'abc1234', subject: 'first commit' },
        }),
      }),
    })
    expect(deleteCalls).toEqual([])
    expect(result.conflicted).toEqual(['task/mars-orphan'])
    expect(
      lines.some((l) => l.includes('abc1234') && l.includes('conflict')),
    ).toBe(true)
  })

  it('each orphan gets its own prompt — no branch touched without explicit choice', async () => {
    const promptedBranches: string[] = []
    const deleteCalls: string[] = []
    await runSweepVerb({
      integrationBranch: 'main',
      log: () => {},
      deps: makeSweepVerbDeps({
        listTaskBranches: async () => ['task/mars-a', 'task/mars-b'],
        prompt: async (orphan) => {
          promptedBranches.push(orphan.branch)
          return orphan.branch === 'task/mars-a' ? 'keep' : 'delete'
        },
        deleteBranch: async (b) => {
          deleteCalls.push(b)
        },
      }),
    })
    expect(promptedBranches).toEqual(['task/mars-a', 'task/mars-b'])
    // only mars-b was deleted
    expect(deleteCalls).toEqual(['task/mars-b'])
  })

  it('prints no orphan message and returns empty result when no orphans exist', async () => {
    const lines: string[] = []
    const result = await runSweepVerb({
      integrationBranch: 'main',
      log: (line) => lines.push(line),
      deps: makeSweepVerbDeps({
        listTaskBranches: async () => [],
      }),
    })
    expect(result.orphans).toEqual([])
    expect(lines).toEqual(['no orphan task branches'])
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
