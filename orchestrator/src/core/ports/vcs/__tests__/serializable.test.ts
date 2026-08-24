/**
 * The Port acceptance test for the VCS Port (ADR-0097): every arg/result
 * shape survives `JSON.parse(JSON.stringify(...))` without loss. That
 * round-trip is what makes a future out-of-process implementation (e.g. a
 * remote git-hosting service) a drop-in registration rather than a redesign.
 *
 * Plus the registry contract mirrored from `../../code-index/__tests__` /
 * `../../verifier/__tests__`: built-in registration, require-throws-naming-
 * known-kinds, and env-driven resolution through the shared Port catalog.
 */
import { describe, expect, it } from 'vitest'
import { getVcs, listVcses, registerVcs, requireVcs, resolveVcs } from '../registry'
import { localGitVcs } from '../local-git'
import type {
  AttachToOriginWorktreeSpec,
  BranchExistsSpec,
  CommitResult,
  CommitSpec,
  CommitterWorktreeSpec,
  DescribeUncommittedWorkSpec,
  MergeResult,
  MergeSpec,
  RemoveWorktreeSpec,
  RestoreWorktreeSpec,
  StatusSpec,
  SyncWorktreeSpec,
  Vcs,
  VcsCaptureCheckpointSpec,
  VcsCheckpoint,
  VcsDiffTextSpec,
  VcsHasCommitTrailerSpec,
  VcsPathsChangedInRangeSpec,
  VcsRestoreCheckpointResult,
  VcsRestoreCheckpointSpec,
  VcsRevListCountSpec,
  VcsRevParseSpec,
  VcsStatus,
  WorktreeResult,
  WorktreeSpec,
  WorktreeSyncOutcome,
} from '../types'

// Every optional member is populated so each round-trip below is a real test
// of the whole shape rather than of only the required fields.

const worktreeSpec: WorktreeSpec = {
  taskId: 'mars-c71db6a9',
  integrationBranch: 'main',
  baseSha: 'abc123def456',
  branchSuffix: 'retry',
}

const worktreeResult: WorktreeResult = {
  path: '/repo/.mars/worktrees/mars-c71db6a9-retry',
  branch: 'task/mars-c71db6a9-retry',
}

const removeWorktreeSpec: RemoveWorktreeSpec = {
  path: '/repo/.mars/worktrees/mars-c71db6a9',
  branch: 'task/mars-c71db6a9',
  force: true,
  keepBranch: false,
}

const branchExistsSpec: BranchExistsSpec = {
  branch: 'task/mars-c71db6a9',
}

const commitSpec: CommitSpec = {
  cwd: '/repo/.mars/worktrees/mars-c71db6a9',
  message: 'feat(ports): add VCS port',
  taskId: 'mars-c71db6a9',
}

const commitResult: CommitResult = {
  sha: '9f8e7d6c5b4a3210',
}

const mergeSpec: MergeSpec = {
  branch: 'task/mars-c71db6a9',
  worktreePath: '/repo/.mars/worktrees/mars-c71db6a9',
  integrationBranch: 'main',
  lockTimeoutMs: 30_000,
  watchdogMs: 900_000,
}

const mergeResult: MergeResult = {
  merged: true,
  conflictResolved: false,
  aborted: false,
  output: 'fast-forwarded main to 9f8e7d6',
  retriesAttempted: 0,
  vegaSessionId: null,
}

const statusSpec: StatusSpec = {
  cwd: '/repo/.mars/worktrees/mars-c71db6a9',
  untrackedFiles: 'all',
}

const statusResult: VcsStatus = {
  clean: false,
  statusOutput: ' M src/core/ports/vcs/types.ts\n?? .mars/scratch\n',
  orchestratorOwned: ['.mars/scratch'],
  userOwned: ['src/core/ports/vcs/types.ts'],
}

const captureCheckpointSpec: VcsCaptureCheckpointSpec = {
  cwd: '/repo/.mars/worktrees/mars-c71db6a9',
  ref: 'refs/mars/checkpoint/mars-c71db6a9',
  message: 'wip(checkpoint): salvage',
}

const checkpoint: VcsCheckpoint = {
  ref: 'refs/mars/checkpoint/mars-c71db6a9',
  sha: '1a2b3c4d5e6f7890',
  files: ['src/core/ports/vcs/types.ts'],
}

const restoreCheckpointSpec: VcsRestoreCheckpointSpec = {
  cwd: '/repo',
  sha: '1a2b3c4d5e6f7890',
}

const restoreCheckpointResult: VcsRestoreCheckpointResult = {
  ok: false,
  detail: 'unmerged paths after apply: src/core/ports/vcs/types.ts',
}

const revParseSpec: VcsRevParseSpec = {
  cwd: '/repo',
  rev: 'HEAD',
  timeoutMs: 15_000,
}

const revListCountSpec: VcsRevListCountSpec = {
  cwd: '/repo',
  range: 'main..task/mars-c71db6a9',
  timeoutMs: 15_000,
}

const diffTextSpec: VcsDiffTextSpec = {
  cwd: '/repo',
  from: 'abc123',
  to: 'def456',
  timeoutMs: 30_000,
}

const pathsChangedInRangeSpec: VcsPathsChangedInRangeSpec = {
  cwd: '/repo',
  range: 'abc123..def456',
  paths: ['orchestrator/src', 'packages/workflow'],
}

const hasCommitTrailerSpec: VcsHasCommitTrailerSpec = {
  cwd: '/repo',
  sha: 'abc123',
  trailerKey: 'Mars-Checkpoint',
  trailerValue: 'salvage',
}

const attachSpec: AttachToOriginWorktreeSpec = {
  originTaskId: 'mars-c71db6a9',
  originBranch: 'task/mars-c71db6a9',
  originWorktreePath: '/repo/.mars/worktrees/mars-c71db6a9',
}

const committerSpec: CommitterWorktreeSpec = {
  recoveryTaskId: 'fix-c71db6a9',
  integrationBranch: 'main',
}

const syncSpec: SyncWorktreeSpec = {
  taskId: 'mars-c71db6a9',
  ref: worktreeResult,
  integrationBranch: 'main',
  onConflict: 'recreate',
}

const syncOutcome: WorktreeSyncOutcome = {
  kind: 'recreated',
  from: 'abc123',
  to: 'def456',
  parkedRef: 'refs/mars/parked/mars-c71db6a9-abc123def',
  parkedCommits: [{ shortSha: 'abc1234', subject: 'wip' }],
  checkpointRef: 'refs/mars/checkpoint/setup-mars-c71db6a9',
}

const restoreSpec: RestoreWorktreeSpec = {
  taskId: 'mars-c71db6a9',
  ref: worktreeResult,
}

const describeSpec: DescribeUncommittedWorkSpec = {
  verb: 'drop',
  taskId: 'mars-c71db6a9',
  worktreePath: '/repo/.mars/worktrees/mars-c71db6a9',
}

describe('Vcs Port args/results are serializable', () => {
  it.each([
    ['WorktreeSpec', worktreeSpec],
    ['WorktreeResult', worktreeResult],
    ['RemoveWorktreeSpec', removeWorktreeSpec],
    ['BranchExistsSpec', branchExistsSpec],
    ['CommitSpec', commitSpec],
    ['CommitResult', commitResult],
    ['MergeSpec', mergeSpec],
    ['MergeResult', mergeResult],
    ['StatusSpec', statusSpec],
    ['VcsStatus', statusResult],
    ['AttachToOriginWorktreeSpec', attachSpec],
    ['CommitterWorktreeSpec', committerSpec],
    ['SyncWorktreeSpec', syncSpec],
    ['WorktreeSyncOutcome', syncOutcome],
    ['RestoreWorktreeSpec', restoreSpec],
    ['DescribeUncommittedWorkSpec', describeSpec],
    ['VcsCaptureCheckpointSpec', captureCheckpointSpec],
    ['VcsCheckpoint', checkpoint],
    ['VcsRestoreCheckpointSpec', restoreCheckpointSpec],
    ['VcsRestoreCheckpointResult', restoreCheckpointResult],
    ['VcsRevParseSpec', revParseSpec],
    ['VcsRevListCountSpec', revListCountSpec],
    ['VcsDiffTextSpec', diffTextSpec],
    ['VcsPathsChangedInRangeSpec', pathsChangedInRangeSpec],
    ['VcsHasCommitTrailerSpec', hasCommitTrailerSpec],
  ] as const)('%s round-trips through JSON.parse(JSON.stringify(...)) without loss', (_label, value) => {
    const roundTripped = JSON.parse(JSON.stringify(value)) as typeof value
    expect(roundTripped).toEqual(value)
    expect(Object.keys(roundTripped).sort()).toEqual(Object.keys(value).sort())
  })
})

describe('built-in registration', () => {
  it('registers the local-git implementation at import time', () => {
    expect(listVcses().map((impl) => impl.kind)).toContain('local-git')
  })

  it('getVcs resolves the built-in by kind', () => {
    expect(getVcs('local-git')).toBe(localGitVcs)
  })

  it('getVcs returns undefined for an unregistered kind', () => {
    expect(getVcs('nope')).toBeUndefined()
  })

  it('requireVcs throws naming the known kinds for an unregistered kind', () => {
    expect(() => requireVcs('nope')).toThrow(/Unknown Vcs implementation 'nope'/)
    expect(() => requireVcs('nope')).toThrow(/local-git/)
  })
})

describe('registerVcs()', () => {
  it('registers a new implementation and the returned disposer withdraws it', async () => {
    // Built on the built-in so the fake stays a complete `Vcs` as the Port
    // grows; only the one method this test actually calls is overridden, so
    // no real git is ever invoked.
    const fake: Vcs = {
      ...localGitVcs,
      kind: 'test-fake',
      async createWorktree(spec: WorktreeSpec) {
        return { path: `/tmp/${spec.taskId}`, branch: `task/${spec.taskId}` }
      },
    }
    const dispose = registerVcs(fake)
    expect(getVcs('test-fake')).toBe(fake)
    await expect(fake.createWorktree(worktreeSpec)).resolves.toMatchObject({
      branch: `task/${worktreeSpec.taskId}`,
    })
    dispose()
    expect(getVcs('test-fake')).toBeUndefined()
  })
})

describe('resolveVcs()', () => {
  it('defaults to the local-git implementation when the env var is unset', () => {
    expect(resolveVcs({})).toBe(localGitVcs)
  })

  it('defaults to local-git when the env var is empty', () => {
    expect(resolveVcs({ MARS_VCS_KIND: '' })).toBe(localGitVcs)
  })

  it('throws when the env var names a kind the shared Port registry does not declare', () => {
    expect(() => resolveVcs({ MARS_VCS_KIND: 'bogus' })).toThrow(/not a registered implementation/)
  })
})
