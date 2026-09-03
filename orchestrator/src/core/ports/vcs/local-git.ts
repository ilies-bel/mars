/**
 * `local-git` Vcs implementation — the default. Delegates every method to
 * the existing worktree/merge/commit helpers in `../../lib/git/`, which
 * already shell out to the local `git` binary resolved by `resolveGitBin()`
 * (`../../lib/git/internal.ts`). This is a thin translation layer: it maps
 * this Port's narrower, serializable arg/result shapes onto the richer
 * signatures those helpers already expose, so nothing about today's
 * operational behaviour changes.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWorktree,
  removeWorktree,
  attachToOriginWorktree,
  provisionCommitterWorktree,
  syncWorktreeToIntegration,
  restoreWorktreeIfMissing,
  listUncommittedPaths,
  describeUncommittedWork,
} from '../../lib/git/worktree'
import {
  mergeBranch,
  isBranchMergedIntoMain as gitIsBranchMergedIntoMain,
  isZeroCommitBranch as gitIsZeroCommitBranch,
  checkMergeTargetStatus as gitCheckMergeTargetStatus,
} from '../../lib/git/merge'
import {
  commitMain,
  autoCommitWorktreeIfDeterministic,
} from '../../lib/git/commit-main'
import { resolveGitBin, exec, execProbe, branchExists } from '../../lib/git/internal'
import { attributeIntegrationDirt as gitAttributeIntegrationDirt } from '../../lib/git/stale-tree-attribution'
import { readLastSyncedSha as gitReadLastSyncedSha } from '../../lib/git/last-synced-sha'
import { classifyPorcelainLines } from '../../lib/git/classify-porcelain'
import { autoCommitOperatorDirt as gitAutoCommitOperatorDirt } from '../../lib/git/operator-auto-commit'
import type { TraceEventStore, TraceEventInput } from '../../lib/trace-events-store'
import type { TraceCtx } from '../../lib/run-tool'
import { getAmbientTraceStore } from './ambient-trace-store'
import type {
  TraceIdentity,
  AttachToOriginWorktreeSpec,
  BranchExistsSpec,
  IntegrationDirtAttribution,
  VcsApplyPatchSpec,
  VcsAttributeIntegrationDirtSpec,
  VcsAutoCommitOperatorDirtSpec,
  VcsAutoCommitOperatorDirtResult,
  VcsAutoCommitWorktreeSpec,
  VcsAutoCommitWorktreeResult,
  VcsCheckMergeTargetSpec,
  VcsMergeTargetStatus,
  VcsIsBranchMergedSpec,
  VcsIsZeroCommitBranchSpec,
  VcsReadLastSyncedShaSpec,
  CommitResult,
  CommitSpec,
  CommitterWorktreeSpec,
  DescribeUncommittedWorkSpec,
  MergeResult,
  MergeSpec,
  RemoveWorktreeSpec,
  RestoreWorktreeOutcome,
  RestoreWorktreeSpec,
  StatusSpec,
  SyncWorktreeSpec,
  Vcs,
  VcsAddWorktreeForBranchSpec,
  VcsCaptureCheckpointSpec,
  VcsChangedFilesSpec,
  VcsCheckpoint,
  VcsCommitSummary,
  VcsCommitsInRangeSpec,
  VcsCurrentBranchSpec,
  VcsDeleteBranchSpec,
  VcsDiffTextSpec,
  VcsDiscardChangesSpec,
  VcsFetchSpec,
  VcsGitPathSpec,
  VcsHasCommitTrailerSpec,
  VcsIsAncestorSpec,
  VcsPathsChangedInRangeSpec,
  VcsRecentShasSpec,
  VcsRepoRootSpec,
  VcsResetHardSpec,
  VcsRestoreCheckpointResult,
  VcsRestoreCheckpointSpec,
  VcsRevListCountSpec,
  VcsRevListRangeSpec,
  VcsRevParseSpec,
  VcsSearchCommitsSpec,
  VcsStatus,
  VcsUpdateRefSpec,
  VcsWorkingTreeMatchesSpec,
  WorktreeResult,
  WorktreeSpec,
  WorktreeSyncOutcome,
} from './types'

// ---------------------------------------------------------------------------
// Ambient trace store registry
// ---------------------------------------------------------------------------
//
// Why ambient rather than threading a store through every Vcs spec?
//
// The Vcs interface is wire-safe: every method takes a plain serializable
// spec and returns a plain serializable result. Adding a `traceStore?` field
// to each spec would bloat every call site, change the public contract, and
// be inconsistent with how the port works as a remote adapter (ADR-0097).
//
// An ambient module-level slot keeps the interface clean. The host (server.ts
// / daemon startup) arms it once via `setLocalGitTraceStore`; every method
// in `localGitVcs` that emits trace events reads it through `safeEmit` below.
// The pattern mirrors how the TraceEventStore is propagated to
// `runWorkerWithSpan` in `../../lib/run-worker-with-span.ts`.

let _ambientTraceStore: TraceEventStore | undefined

/**
 * Arm trace capture for all `localGitVcs` method calls from this point on.
 *
 * Pass `undefined` to disarm. Idempotent — safe to call multiple times.
 *
 * Returns a dispose function that restores the prior slot value, so callers
 * that arm during a scoped operation (e.g. a test) can undo the change
 * without disrupting a concurrently-armed store.
 *
 * @example
 * // Arm at daemon startup:
 * setLocalGitTraceStore(traceEventStore)
 *
 * // Arm for the duration of a test:
 * const dispose = setLocalGitTraceStore(mockStore)
 * try { await runTest() } finally { dispose() }
 */
export const setLocalGitTraceStore = (store: TraceEventStore | undefined): (() => void) => {
  const previous = _ambientTraceStore
  _ambientTraceStore = store
  return () => {
    _ambientTraceStore = previous
  }
}

/**
 * The currently-armed trace store, or `undefined` when none has been set.
 * Prefer {@link safeEmit} over reading this directly to avoid duplicating the
 * best-effort guard.
 */
export const getLocalGitTraceStore = (): TraceEventStore | undefined => _ambientTraceStore

/**
 * Best-effort trace event emission using the ambient store.
 *
 * A database hiccup must never abort or slow a VCS operation, so errors from
 * `record` are swallowed. When no store has been armed the call is a no-op.
 * Consumer slices use this as the single emit path so they never repeat the
 * guard inline.
 */
export const safeEmit = async (event: TraceEventInput): Promise<void> => {
  if (_ambientTraceStore === undefined) return
  try {
    await _ambientTraceStore.record(event)
  } catch {
    // trace capture is best-effort — a DB hiccup must never fail a VCS operation
  }
}

// ---------------------------------------------------------------------------

/**
 * Reconstruct a full {@link TraceCtx} from a serializable {@link TraceIdentity}.
 *
 * Returns `undefined` when either the identity is absent or the ambient store
 * has not been armed — both are expected in non-daemon callers (CLI, tests)
 * and must leave behaviour unchanged (pass `undefined` downstream).
 *
 * The pattern keeps the Vcs port wire-safe (ADR-0097): the non-serializable
 * `TraceEventStore` reference never enters a spec; instead, it is fetched
 * from the process-scoped registry and combined with the serializable identity
 * fragments ({@link TraceIdentity.taskId}, {@link TraceIdentity.originId},
 * {@link TraceIdentity.phase}) to form a transient context object used only
 * for the duration of a single method call.
 */
const reconstructTraceCtx = (trace?: TraceIdentity | null): TraceCtx | undefined => {
  if (!trace) return undefined
  const store = getAmbientTraceStore()
  if (!store) return undefined
  return {
    taskId: trace.taskId,
    originId: trace.originId,
    phase: trace.phase,
    store,
  }
}

// ---------------------------------------------------------------------------

/**
 * Identity used for checkpoint commit objects (see {@link Vcs.captureCheckpoint}).
 * Pinned via env so a repo (or CI container) without `user.name` /
 * `user.email` configured cannot make `git commit-tree` fail and lose the
 * work it was asked to preserve.
 */
const CHECKPOINT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Mars Orchestrator',
  GIT_AUTHOR_EMAIL: 'mars@localhost',
  GIT_COMMITTER_NAME: 'Mars Orchestrator',
  GIT_COMMITTER_EMAIL: 'mars@localhost',
}

export const localGitVcs: Vcs = {
  kind: 'local-git',

  async createWorktree(spec: WorktreeSpec): Promise<WorktreeResult> {
    return createWorktree({
      taskId: spec.taskId,
      integrationBranch: spec.integrationBranch,
      baseSha: spec.baseSha,
      branchSuffix: spec.branchSuffix,
      traceCtx: reconstructTraceCtx(spec.trace),
    })
  },

  async removeWorktree(spec: RemoveWorktreeSpec): Promise<void> {
    await removeWorktree(
      { path: spec.path, branch: spec.branch },
      spec.force ?? true,
      spec.keepBranch ?? false,
      reconstructTraceCtx(spec.trace),
      spec.tombstone,
    )
  },

  async branchExists(spec: BranchExistsSpec): Promise<boolean> {
    return branchExists(spec.branch)
  },

  async commit(spec: CommitSpec): Promise<CommitResult> {
    return commitMain({ cwd: spec.cwd, message: spec.message, taskId: spec.taskId, traceCtx: reconstructTraceCtx(spec.trace) })
  },

  async merge(spec: MergeSpec): Promise<MergeResult> {
    const result = await mergeBranch({
      branch: spec.branch,
      worktreePath: spec.worktreePath,
      integrationBranch: spec.integrationBranch,
      lockTimeoutMs: spec.lockTimeoutMs,
      watchdogMs: spec.watchdogMs,
      traceCtx: reconstructTraceCtx(spec.trace),
    })
    return {
      merged: result.merged,
      conflictResolved: result.conflictResolved,
      aborted: result.aborted,
      output: result.output,
      retriesAttempted: result.retriesAttempted,
      vegaSessionId: result.vegaSessionId,
      integrationGateFailed: result.integrationGateFailed,
      integrationGateOutput: result.integrationGateOutput,
      vegaTimedOut: result.vegaTimedOut,
      reason: result.reason,
      rebasedVerifyOutput: result.rebasedVerifyOutput,
      lastSyncedSha: result.lastSyncedSha,
      operatorAutoCommitSha: result.operatorAutoCommitSha,
      mergePreSha: result.mergePreSha,
      mergePostSha: result.mergePostSha,
    }
  },

  async status(spec: StatusSpec): Promise<VcsStatus> {
    const args = ['status', '--porcelain']
    if (spec.untrackedFiles === 'all') args.push('--untracked-files=all')
    const r = await execProbe(resolveGitBin(), args, { cwd: spec.cwd })
    const lines = r.stdout.split('\n').filter((l) => l.length > 0)
    const { orchestratorOwned, userOwned } = classifyPorcelainLines(lines)
    return { clean: r.stdout.trim().length === 0, statusOutput: r.stdout, orchestratorOwned, userOwned }
  },

  async captureCheckpoint(spec: VcsCaptureCheckpointSpec): Promise<VcsCheckpoint | null> {
    const { cwd, ref, message, excludePaths } = spec
    const git = resolveGitBin()
    const tc = reconstructTraceCtx(spec.trace)

    const head = (await exec(git, ['rev-parse', 'HEAD'], { cwd }, tc)).stdout.trim()
    const headTree = (await exec(git, ['rev-parse', 'HEAD^{tree}'], { cwd }, tc)).stdout.trim()

    const indexDir = await mkdtemp(join(tmpdir(), 'mars-checkpoint-'))
    const indexFile = join(indexDir, 'index')
    const env = { GIT_INDEX_FILE: indexFile }
    try {
      // Seed the temporary index from HEAD, then stage everything the working
      // tree carries. `git add -A` honours .gitignore, so ignored files stay out.
      await exec(git, ['read-tree', 'HEAD'], { cwd, env }, tc)
      await exec(git, ['add', '-A'], { cwd, env }, tc)

      // Belt to .gitignore's braces: remove any caller-requested exclusions
      // from the temporary index AFTER git add -A, so they are never committed
      // even when .gitignore has been edited away. `--ignore-unmatch` keeps the
      // call idempotent when a path was already absent from the index (e.g. it
      // was gitignored and git add -A never staged it).
      if (excludePaths && excludePaths.length > 0) {
        await exec(git, ['rm', '--cached', '--ignore-unmatch', '-r', '--', ...excludePaths], {
          cwd,
          env,
        }, tc)
      }

      const tree = (await exec(git, ['write-tree'], { cwd, env }, tc)).stdout.trim()
      if (tree === headTree) return null

      const sha = (
        await exec(git, ['commit-tree', tree, '-p', head, '-m', message], {
          cwd,
          env: CHECKPOINT_IDENTITY,
        }, tc)
      ).stdout.trim()

      // Anchor the object under the per-task ref BEFORE reporting success: an
      // unreferenced commit-tree object is GC-eligible.
      await exec(git, ['update-ref', ref, sha], { cwd }, tc)

      const files = (await exec(git, ['diff', '--name-only', head, sha], { cwd }, tc)).stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)

      return { ref, sha, files }
    } finally {
      await rm(indexDir, { recursive: true, force: true }).catch(() => {})
    }
  },

  async restoreCheckpoint(spec: VcsRestoreCheckpointSpec): Promise<VcsRestoreCheckpointResult> {
    const { cwd, sha } = spec
    const git = resolveGitBin()
    const tc = reconstructTraceCtx(spec.trace)

    const pick = await execProbe(git, ['cherry-pick', '-n', sha], { cwd }, tc)
    // Clear the sequencer/AUTO_MERGE state left by `-n`; keeps index + worktree.
    await execProbe(git, ['cherry-pick', '--quit'], { cwd }, tc).catch(() => {})

    if (pick.exitCode !== 0) {
      return { ok: false, detail: `git cherry-pick exited ${pick.exitCode}: ${pick.stderr.trim().slice(0, 300)}` }
    }

    const status = await exec(git, ['status', '--porcelain', '--untracked-files=all'], { cwd }, tc)
    const lines = status.stdout.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      return { ok: false, detail: 'the target tree is still clean after the apply' }
    }
    const conflicted = lines.filter((l) => l[0] === 'U' || l[1] === 'U')
    if (conflicted.length > 0) {
      return {
        ok: false,
        detail: `unmerged paths after apply: ${conflicted.map((l) => l.slice(3)).join(', ').slice(0, 300)}`,
      }
    }
    return { ok: true }
  },

  async discardWorkingTreeChanges(spec: VcsDiscardChangesSpec): Promise<void> {
    const { cwd } = spec
    const git = resolveGitBin()
    await exec(git, ['reset', '--hard', 'HEAD'], { cwd })
    await exec(git, ['clean', '-fd'], { cwd })
  },

  async revParse(spec: VcsRevParseSpec): Promise<string | null> {
    const { cwd, rev, timeoutMs } = spec
    const r = await execProbe(resolveGitBin(), ['rev-parse', rev], { cwd, timeout: timeoutMs })
    if (r.exitCode !== 0) return null
    const sha = r.stdout.trim()
    return sha.length === 0 ? null : sha
  },

  async repoRoot(spec: VcsRepoRootSpec): Promise<string | null> {
    const r = await execProbe(resolveGitBin(), ['rev-parse', '--show-toplevel'], { cwd: spec.cwd })
    if (r.exitCode !== 0) return null
    const root = r.stdout.trim()
    return root.length === 0 ? null : root
  },

  async updateRef(spec: VcsUpdateRefSpec): Promise<void> {
    const { cwd, ref, sha } = spec
    await exec(resolveGitBin(), ['update-ref', ref, sha], { cwd })
  },

  async hasCommitTrailer(spec: VcsHasCommitTrailerSpec): Promise<boolean> {
    const { cwd, sha, trailerKey, trailerValue } = spec
    const git = resolveGitBin()
    try {
      const result = await execProbe(
        git,
        ['log', '-1', `--format=%(trailers:key=${trailerKey},valueonly)`, sha],
        { cwd },
      )
      if (result.exitCode !== 0) return false
      return result.stdout.trim() === trailerValue
    } catch {
      // A spawn-level failure (e.g. `cwd` no longer exists) fails open to
      // "not a match" rather than propagating and aborting an unrelated caller.
      return false
    }
  },

  async revListRange(spec: VcsRevListRangeSpec): Promise<string[] | null> {
    const { cwd, range } = spec
    const git = resolveGitBin()
    try {
      const result = await execProbe(git, ['rev-list', range], { cwd })
      if (result.exitCode !== 0) return null
      return result.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    } catch {
      return null
    }
  },

  async ensureAvailable(): Promise<void> {
    resolveGitBin()
  },

  async currentBranch(spec: VcsCurrentBranchSpec): Promise<string | null> {
    const { cwd } = spec
    const r = await execProbe(resolveGitBin(), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    if (r.exitCode !== 0) return null
    const branch = r.stdout.trim()
    return branch.length === 0 ? null : branch
  },

  async gitPath(spec: VcsGitPathSpec): Promise<string> {
    const { cwd, name } = spec
    const r = await exec(resolveGitBin(), ['rev-parse', '--git-path', name], { cwd })
    return r.stdout.trim()
  },

  async revListCount(spec: VcsRevListCountSpec): Promise<number | null> {
    const { cwd, range, timeoutMs } = spec
    const r = await execProbe(resolveGitBin(), ['rev-list', '--count', range], {
      cwd,
      timeout: timeoutMs,
    })
    if (r.exitCode !== 0) return null
    const count = Number.parseInt(r.stdout.trim(), 10)
    return Number.isFinite(count) ? count : null
  },

  async diffText(spec: VcsDiffTextSpec): Promise<string | null> {
    const { cwd, from, to, timeoutMs } = spec
    try {
      const r = await exec(resolveGitBin(), ['diff', '--no-color', from, to], {
        cwd,
        timeout: timeoutMs,
      })
      return r.stdout.length > 0 ? r.stdout : null
    } catch {
      return null
    }
  },

  async pathsChangedInRange(spec: VcsPathsChangedInRangeSpec): Promise<boolean> {
    const { cwd, range, paths } = spec
    const r = await execProbe(resolveGitBin(), ['diff', '--quiet', range, '--', ...paths], { cwd })
    return r.exitCode === 1
  },

  async workingTreeMatches(spec: VcsWorkingTreeMatchesSpec): Promise<boolean> {
    const { cwd, rev } = spec
    const r = await execProbe(resolveGitBin(), ['diff', '--quiet', rev], { cwd })
    return r.exitCode === 0
  },

  async recentShas(spec: VcsRecentShasSpec): Promise<string[]> {
    const { cwd, rev, count } = spec
    const r = await execProbe(
      resolveGitBin(),
      ['log', '--format=%H', '-n', String(count), rev],
      { cwd },
    )
    if (r.exitCode !== 0) return []
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  },

  async deleteBranch(spec: VcsDeleteBranchSpec): Promise<void> {
    const { cwd, branch } = spec
    await exec(resolveGitBin(), ['branch', '-D', branch], { cwd })
  },

  async attachToOriginWorktree(spec: AttachToOriginWorktreeSpec): Promise<WorktreeResult> {
    return attachToOriginWorktree({
      originTaskId: spec.originTaskId,
      originBranch: spec.originBranch,
      originWorktreePath: spec.originWorktreePath,
      traceCtx: reconstructTraceCtx(spec.trace),
    })
  },

  async provisionCommitterWorktree(spec: CommitterWorktreeSpec): Promise<WorktreeResult> {
    return provisionCommitterWorktree({
      recoveryTaskId: spec.recoveryTaskId,
      integrationBranch: spec.integrationBranch,
      traceCtx: reconstructTraceCtx(spec.trace),
    })
  },

  async syncWorktreeToIntegration(spec: SyncWorktreeSpec): Promise<WorktreeSyncOutcome> {
    return syncWorktreeToIntegration({
      taskId: spec.taskId,
      ref: spec.ref,
      integrationBranch: spec.integrationBranch,
      onConflict: spec.onConflict,
      traceCtx: reconstructTraceCtx(spec.trace),
    })
  },

  async restoreWorktreeIfMissing(spec: RestoreWorktreeSpec): Promise<RestoreWorktreeOutcome> {
    return restoreWorktreeIfMissing({ taskId: spec.taskId, ref: spec.ref, traceCtx: reconstructTraceCtx(spec.trace) })
  },

  async listUncommittedPaths(worktreePath: string | null | undefined): Promise<string[] | null> {
    return listUncommittedPaths(worktreePath)
  },

  async describeUncommittedWork(spec: DescribeUncommittedWorkSpec): Promise<string | null> {
    return describeUncommittedWork(spec)
  },

  async commitsInRange(spec: VcsCommitsInRangeSpec): Promise<VcsCommitSummary[]> {
    const { cwd, range, abbrev } = spec
    const r = await execProbe(
      resolveGitBin(),
      ['log', `--format=${abbrev === true ? '%h' : '%H'} %s`, range],
      { cwd },
    )
    if (r.exitCode !== 0) return []
    return parseCommitSummaries(r.stdout)
  },

  async searchCommits(spec: VcsSearchCommitsSpec): Promise<VcsCommitSummary[]> {
    const { cwd, rev, grep, limit } = spec
    const args = ['log', rev, `--grep=${grep}`, '--fixed-strings', '--format=%H %s']
    if (limit !== undefined) args.push('-n', String(limit))
    const r = await execProbe(resolveGitBin(), args, { cwd })
    if (r.exitCode !== 0) return []
    return parseCommitSummaries(r.stdout)
  },

  async changedFiles(spec: VcsChangedFilesSpec): Promise<string[]> {
    const { cwd, range } = spec
    const r = await execProbe(resolveGitBin(), ['diff', range, '--name-only'], { cwd })
    if (r.exitCode !== 0) return []
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  },

  async fetch(spec: VcsFetchSpec): Promise<void> {
    const { cwd, remote, branch } = spec
    const args = ['fetch', remote]
    if (branch !== undefined) args.push(branch)
    await exec(resolveGitBin(), args, { cwd })
  },

  async resetHard(spec: VcsResetHardSpec): Promise<void> {
    const { cwd, rev } = spec
    await exec(resolveGitBin(), ['reset', '--hard', rev], { cwd })
  },

  async isAncestor(spec: VcsIsAncestorSpec): Promise<boolean> {
    const { cwd, ancestor, descendant } = spec
    const r = await execProbe(
      resolveGitBin(),
      ['merge-base', '--is-ancestor', ancestor, descendant],
      { cwd },
    )
    return r.exitCode === 0
  },

  async addWorktreeForBranch(spec: VcsAddWorktreeForBranchSpec): Promise<void> {
    const { cwd, path, branch } = spec
    await exec(resolveGitBin(), ['worktree', 'add', path, branch], { cwd })
  },

  async autoCommitOperatorDirt(
    spec: VcsAutoCommitOperatorDirtSpec,
  ): Promise<VcsAutoCommitOperatorDirtResult> {
    return gitAutoCommitOperatorDirt({
      repoRoot: spec.repoRoot,
      taskId: spec.taskId,
      baseSha: spec.baseSha,
      headSha: spec.headSha,
      traceCtx: reconstructTraceCtx(spec.trace),
    })
  },

  // --- Slice 2: branch-query helpers ---

  async isBranchMergedIntoMain(spec: VcsIsBranchMergedSpec): Promise<boolean> {
    return gitIsBranchMergedIntoMain(spec.branch, spec.cwd)
  },

  async isZeroCommitBranch(spec: VcsIsZeroCommitBranchSpec): Promise<boolean> {
    return gitIsZeroCommitBranch(spec.branch, spec.cwd)
  },

  // --- Slice 3: merge pre-check ---

  async checkMergeTargetStatus(spec: VcsCheckMergeTargetSpec): Promise<VcsMergeTargetStatus> {
    const result = await gitCheckMergeTargetStatus({
      integrationBranch: spec.integrationBranch,
      taskBranch: spec.taskBranch,
    })
    if (result.kind === 'error') {
      return { kind: 'error', message: result.error.message }
    }
    return result
  },

  // --- Slice 4: worktree auto-commit ---

  async autoCommitWorktree(spec: VcsAutoCommitWorktreeSpec): Promise<VcsAutoCommitWorktreeResult> {
    return autoCommitWorktreeIfDeterministic({
      taskId: spec.taskId,
      provenance: spec.provenance,
      integrationBranch: spec.integrationBranch,
      worktreePath: spec.worktreePath,
      dirtyFiles: spec.dirtyFiles,
    })
  },

  // --- Slice 5: integration-dirt attribution ---

  async attributeIntegrationDirt(
    spec: VcsAttributeIntegrationDirtSpec,
  ): Promise<IntegrationDirtAttribution> {
    return gitAttributeIntegrationDirt({
      repoRoot: spec.repoRoot,
      lastSyncedSha: spec.lastSyncedSha,
      headSha: spec.headSha,
    })
  },

  async readLastSyncedSha(spec: VcsReadLastSyncedShaSpec): Promise<string | null> {
    return gitReadLastSyncedSha(spec.cwd)
  },

  // --- Slice 6: patch application ---

  async applyPatch(spec: VcsApplyPatchSpec): Promise<void> {
    const { cwd, patch } = spec
    const git = resolveGitBin()
    const tmpDir = await mkdtemp(join(tmpdir(), 'mars-patch-'))
    const patchFile = join(tmpDir, 'patch.diff')
    try {
      await writeFile(patchFile, patch, 'utf-8')
      await exec(git, ['apply', '--check', patchFile], { cwd })
      await exec(git, ['apply', patchFile], { cwd })
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  },
}

/**
 * Split `git log --format=<sha> %s` output into typed rows. The sha runs to the
 * first space; everything after it is the subject (which may itself contain
 * spaces, and may be empty).
 */
const parseCommitSummaries = (stdout: string): VcsCommitSummary[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const spaceIdx = line.indexOf(' ')
      return spaceIdx === -1
        ? { sha: line, subject: '' }
        : { sha: line.slice(0, spaceIdx), subject: line.slice(spaceIdx + 1) }
    })

