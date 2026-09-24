/**
 * The Port acceptance test for the VCS Port (ADR-0097): every arg/result
 * shape survives `JSON.parse(JSON.stringify(...))` without loss. That
 * round-trip is what makes a future out-of-process implementation (e.g. a
 * remote git-hosting service) a drop-in registration rather than a redesign.
 *
 * Plus the registry contract mirrored from `../../code-index/__tests__` /
 * `../../verifier/__tests__`: built-in registration, require-throws-naming-
 * known-kinds, and env-driven resolution through the shared Port catalog.
 *
 * Plus exhaustive spy tests for merge arg/result forwarding (mars-98dbffe1):
 * - Every MergeSpec field is asserted to arrive at mergeBranch, per field.
 * - The onVerifyRebasedTree gate is proven to be invoked when the spy calls it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── Module-level mock (hoisted before all imports by vitest) ─────────────────
//
// Intercepts mergeBranch inside local-git.ts so spy tests can verify
// forwarding without invoking real git. Existing serializable round-trip tests
// are unaffected — they never call localGitVcs.merge().

const _mergeBranchSpy = vi.fn()

vi.mock('../../../lib/git/merge.js', () => ({
  mergeBranch: (...args: unknown[]) => _mergeBranchSpy(...args),
  isBranchMergedIntoMain: vi.fn().mockResolvedValue(false),
  isZeroCommitBranch: vi.fn().mockResolvedValue(false),
  checkMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
}))
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
  trace: { taskId: 't', originId: 'o', phase: 'setup' },
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

// ── Merge field forwarding — exhaustive per-field spy test (mars-98dbffe1) ──
//
// These tests guard the `local-git` adapter's `merge()` implementation against
// the class of bug that caused mars-82a0b56f (164 merges, no verify gate):
// a callback silently dropped at the local-git → mergeBranch boundary.
//
// DESIGN: assertions are per-field, NOT `toMatchObject` on a subset.
// A `toMatchObject` check on a subset of fields is exactly how this passed
// review the first time — it proved the fields that were already forwarded
// and could not catch the ones that were missing.
//
// See also: merge-callback-forwarding.test.ts (same directory) for targeted
// callback-subset regression tests, and merge-worker.test.ts for the full
// integration path that proves the gate runs end-to-end.

describe('merge() — exhaustive per-field forwarding to mergeBranch', () => {
  const FAKE_MERGE_RESULT = {
    merged: true,
    conflictResolved: false,
    aborted: false,
    output: 'fast-forwarded',
    supervisorConversation: [],
    retriesAttempted: 0,
    vegaSessionId: null,
  }

  beforeEach(() => {
    _mergeBranchSpy.mockReset()
    _mergeBranchSpy.mockResolvedValue(FAKE_MERGE_RESULT)
  })

  it('forwards all 16 MergeSpec fields to mergeBranch, each asserted individually', async () => {
    /**
     * This test catches any forward omission immediately and names the
     * missing field. It checks all 16 fields in MERGE_ARG_KEYS — the same
     * list the compile-time exhaustiveness guard tracks. Adding a new field
     * to MergeArgs → compile error from the guard → developer updates
     * MERGE_ARG_KEYS → this test must also cover the new field.
     */
    const ac = new AbortController()
    const onVerifyRebasedTree = vi.fn().mockResolvedValue({ passed: true })
    const onAfterFastForward = vi.fn().mockResolvedValue(undefined)
    const onSupervisorEvent = vi.fn()
    const onOperatorAutoCommit = vi.fn()
    const onProbeIntegrationAfterAutoCommit = vi.fn().mockResolvedValue({ passed: true })
    const onVegaStart = vi.fn()
    const onBeforeFastForward = vi.fn()
    const onPhase = vi.fn()
    const onHeartbeat = vi.fn()

    await localGitVcs.merge({
      branch: 'task/spy-all-fields',
      worktreePath: '/tmp/spy-worktree',
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      watchdogMs: 45_000,
      signal: ac.signal,
      onVerifyRebasedTree,
      onAfterFastForward,
      onSupervisorEvent,
      autoCommitOperatorDirt: true,
      onOperatorAutoCommit,
      onProbeIntegrationAfterAutoCommit,
      onVegaStart,
      onBeforeFastForward,
      onPhase,
      onHeartbeat,
    })

    expect(_mergeBranchSpy).toHaveBeenCalledOnce()
    const args = _mergeBranchSpy.mock.calls[0]![0] as Record<string, unknown>

    // Required scalar fields
    expect(args['branch'], 'branch').toBe('task/spy-all-fields')
    expect(args['worktreePath'], 'worktreePath').toBe('/tmp/spy-worktree')
    expect(args['integrationBranch'], 'integrationBranch').toBe('main')
    expect(args['lockTimeoutMs'], 'lockTimeoutMs').toBe(30_000)

    // Optional scalar fields
    expect(args['watchdogMs'], 'watchdogMs').toBe(45_000)
    expect(args['autoCommitOperatorDirt'], 'autoCommitOperatorDirt').toBe(true)

    // Non-serializable fields — identity (reference equality)
    expect(args['signal'], 'signal').toBe(ac.signal)
    expect(args['onVerifyRebasedTree'], 'onVerifyRebasedTree').toBe(onVerifyRebasedTree)
    expect(args['onAfterFastForward'], 'onAfterFastForward').toBe(onAfterFastForward)
    expect(args['onSupervisorEvent'], 'onSupervisorEvent').toBe(onSupervisorEvent)
    expect(args['onOperatorAutoCommit'], 'onOperatorAutoCommit').toBe(onOperatorAutoCommit)
    expect(args['onProbeIntegrationAfterAutoCommit'], 'onProbeIntegrationAfterAutoCommit').toBe(
      onProbeIntegrationAfterAutoCommit,
    )
    expect(args['onVegaStart'], 'onVegaStart').toBe(onVegaStart)
    expect(args['onBeforeFastForward'], 'onBeforeFastForward').toBe(onBeforeFastForward)
    expect(args['onPhase'], 'onPhase').toBe(onPhase)
    expect(args['onHeartbeat'], 'onHeartbeat').toBe(onHeartbeat)
  })

  it('invokes onVerifyRebasedTree when the spy calls it — the gate runs end-to-end', async () => {
    /**
     * Behavioural regression test for mars-82a0b56f.
     *
     * Proves that the gate callback reaches mergeBranch AND is actually
     * invoked when mergeBranch calls it. The spy simulates what the real
     * mergeBranch does: if onVerifyRebasedTree is present, call it. On
     * unfixed code the callback arrived as undefined and the gate was silently
     * skipped — this test would have caught that.
     *
     * The full integration path (merge-worker constructs the gate → passes to
     * resolveVcs().merge() → localGitVcs.merge() → mergeBranch → gate runs)
     * is covered by the "task-tier gate must run" test in merge-worker.test.ts.
     */
    const gate = vi.fn().mockResolvedValue({ passed: true })

    _mergeBranchSpy.mockImplementationOnce(
      async (args: {
        onVerifyRebasedTree?: (info: {
          baseSha: string
          taskSha: string
          attempt: number
        }) => Promise<{ passed: boolean }>
      }) => {
        if (args.onVerifyRebasedTree) {
          await args.onVerifyRebasedTree({
            baseSha: 'b'.repeat(40),
            taskSha: 'a'.repeat(40),
            attempt: 1,
          })
        }
        return { ...FAKE_MERGE_RESULT }
      },
    )

    await localGitVcs.merge({
      branch: 'task/gate-test',
      worktreePath: '/tmp/gate-worktree',
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      onVerifyRebasedTree: gate,
    })

    expect(
      gate,
      'onVerifyRebasedTree gate must be invoked when mergeBranch calls it',
    ).toHaveBeenCalledOnce()
    expect(gate).toHaveBeenCalledWith({
      baseSha: 'b'.repeat(40),
      taskSha: 'a'.repeat(40),
      attempt: 1,
    })
  })

  it('MergeResult.supervisorConversation is forwarded from the lib result', async () => {
    /**
     * Regression guard: supervisorConversation was previously missing from
     * the return literal in local-git.ts merge(). The forwardedResult:
     * GitMergeResult annotation now catches this at compile time (it is a
     * required field in GitMergeResult). This test is the runtime complement.
     */
    const conversation = [{ type: 'text', text: 'rebase done' }]
    _mergeBranchSpy.mockResolvedValueOnce({ ...FAKE_MERGE_RESULT, supervisorConversation: conversation })

    const result = await localGitVcs.merge({
      branch: 'task/conv-test',
      worktreePath: '/tmp/conv-worktree',
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    expect(
      (result as { supervisorConversation?: unknown }).supervisorConversation,
      'supervisorConversation must be forwarded from the lib result',
    ).toBe(conversation)
  })
})

describe('registry built-in registration under vi.resetModules()', () => {
  it('resolves local-git whichever root enters the module graph first', async () => {
    for (const firstRoot of ['../../../lib/git/checkpoint', '../local-git', '../registry']) {
      vi.resetModules()
      await import(firstRoot)
      const reg = await import('../registry')
      expect(reg.requireVcs('local-git').kind).toBe('local-git')
      expect(reg.listVcses().map((impl) => impl.kind)).toContain('local-git')
    }
  })
})
