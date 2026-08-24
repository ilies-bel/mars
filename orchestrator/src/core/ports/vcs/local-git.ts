/**
 * `local-git` Vcs implementation — the default. Delegates every method to
 * the existing worktree/merge/commit helpers in `../../lib/git/`, which
 * already shell out to the local `git` binary resolved by `resolveGitBin()`
 * (`../../lib/git/internal.ts`). This is a thin translation layer: it maps
 * this Port's narrower, serializable arg/result shapes onto the richer
 * signatures those helpers already expose, so nothing about today's
 * operational behaviour changes.
 */
import { createWorktree, removeWorktree } from '../../lib/git/worktree'
import { mergeBranch } from '../../lib/git/merge'
import { commitMain } from '../../lib/git/commit-main'
import { resolveGitBin, execProbe, branchExists } from '../../lib/git/internal'
import type {
  BranchExistsSpec,
  CommitResult,
  CommitSpec,
  MergeResult,
  MergeSpec,
  RemoveWorktreeSpec,
  StatusSpec,
  Vcs,
  VcsStatus,
  WorktreeResult,
  WorktreeSpec,
} from './types'

export const localGitVcs: Vcs = {
  kind: 'local-git',

  async createWorktree(spec: WorktreeSpec): Promise<WorktreeResult> {
    return createWorktree({
      taskId: spec.taskId,
      integrationBranch: spec.integrationBranch,
      baseSha: spec.baseSha,
      branchSuffix: spec.branchSuffix,
    })
  },

  async removeWorktree(spec: RemoveWorktreeSpec): Promise<void> {
    await removeWorktree(
      { path: spec.path, branch: spec.branch },
      spec.force ?? true,
      spec.keepBranch ?? false,
    )
  },

  async branchExists(spec: BranchExistsSpec): Promise<boolean> {
    return branchExists(spec.branch)
  },

  async commit(spec: CommitSpec): Promise<CommitResult> {
    return commitMain({ cwd: spec.cwd, message: spec.message, taskId: spec.taskId })
  },

  async merge(spec: MergeSpec): Promise<MergeResult> {
    const result = await mergeBranch({
      branch: spec.branch,
      worktreePath: spec.worktreePath,
      integrationBranch: spec.integrationBranch,
      lockTimeoutMs: spec.lockTimeoutMs,
      watchdogMs: spec.watchdogMs,
    })
    return {
      merged: result.merged,
      conflictResolved: result.conflictResolved,
      aborted: result.aborted,
      output: result.output,
      retriesAttempted: result.retriesAttempted,
      vegaSessionId: result.vegaSessionId,
    }
  },

  async status(spec: StatusSpec): Promise<VcsStatus> {
    const r = await execProbe(resolveGitBin(), ['status', '--porcelain'], { cwd: spec.cwd })
    return { clean: r.stdout.trim().length === 0, statusOutput: r.stdout }
  },
}

