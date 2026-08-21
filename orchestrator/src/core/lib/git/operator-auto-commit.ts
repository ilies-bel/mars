/**
 * ADR-0100 slice 6 ("Auto-commit genuine operator dirt as a wip(operator)
 * commit with a Notice"): the git mechanics for sweeping genuine operator
 * dirt on the integration checkout into a single commit so a merge can
 * proceed without losing the edit or parking the queue.
 *
 * Scope is deliberately narrow — pure git plumbing only. The *policy*
 * decision ("should we even attempt this") is resolved one layer up by the
 * caller of `mergeBranch` from `isOperatorAutoCommitDisabled(resolveControlLevers())`
 * and passed in as `MergeArgs.autoCommitOperatorDirt` (see `./merge.ts`'s
 * ADR-0100 shared-contract banner) — this module does not import the
 * config/levers layer, so the git primitives stay decoupled from operator
 * lever state and are trivially testable against a real temp repo.
 *
 * Mirrors `commit-main.ts`'s `committer-salvage` provenance: `git add -u`
 * stages ONLY tracked modifications/deletions, never untracked files. An
 * untracked path on the integration checkout may be scratch work, a secret,
 * or a build artifact nobody gitignored — sweeping it into an automatic
 * commit is exactly the shape of the 2026-08-17 incident referenced there.
 */
import { exec, execProbe, resolveGitBin } from './internal'
import type { TraceCtx } from './internal'

/**
 * The exact commit subject used when genuine operator dirt on the
 * integration checkout is auto-committed to unblock a merge. Operator-visible
 * and therefore pinned: the operator greps for it, the Notice quotes it, and
 * `mars` tooling recognises an auto-commit by it.
 */
export const operatorWipCommitMessage = (taskId: string): string =>
  `wip(operator): auto-committed to unblock merge of ${taskId}`

export interface AutoCommitOperatorDirtArgs {
  /** Repo root where the integration branch is checked out (NOT a worktree). */
  repoRoot: string
  /** Task whose merge the auto-commit is unblocking — named in the message. */
  taskId: string
  traceCtx?: TraceCtx
}

export type AutoCommitOperatorDirtResult =
  | { committed: true; sha: string; files: string[] }
  | { committed: false; reason: string }

/**
 * `git add -u && git commit -m <operatorWipCommitMessage>` in `repoRoot`.
 *
 * Returns `{committed: false, reason}` rather than throwing on any git
 * failure — including the benign "nothing to commit" case, which can happen
 * if the caller's own dirt classification and this call race a concurrent
 * change — so the caller can fall back to its pre-existing handling instead
 * of treating every non-success as fatal.
 */
export const autoCommitOperatorDirt = async (
  args: AutoCommitOperatorDirtArgs,
): Promise<AutoCommitOperatorDirtResult> => {
  const git = resolveGitBin()
  const { repoRoot, taskId, traceCtx } = args

  // Snapshot the tracked paths about to move into the commit BEFORE staging —
  // `git commit` itself returns no machine-readable file list, and the
  // caller (mergeBranch) reports these paths on `OperatorAutoCommitInfo`.
  const statusBefore = await execProbe(
    git,
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: repoRoot },
    traceCtx,
  )
  const files = statusBefore.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())

  const add = await execProbe(git, ['add', '-u'], { cwd: repoRoot }, traceCtx)
  if (add.exitCode !== 0) {
    const detail =
      [add.stderr.trim(), add.stdout.trim()].filter(Boolean).join(' | ') ||
      `(exit ${add.exitCode}, no output)`
    return { committed: false, reason: `git add -u failed: ${detail}` }
  }

  const message = operatorWipCommitMessage(taskId)
  const commit = await execProbe(git, ['commit', '-m', message], { cwd: repoRoot }, traceCtx)
  if (commit.exitCode !== 0) {
    const combined = [commit.stderr.trim(), commit.stdout.trim()].filter(Boolean).join(' | ')
    if (/nothing to commit|working tree clean/i.test(combined)) {
      return { committed: false, reason: combined || 'nothing to commit' }
    }
    return {
      committed: false,
      reason: `git commit failed: ${combined || `(exit ${commit.exitCode}, no output)`}`,
    }
  }

  const rev = await exec(git, ['rev-parse', 'HEAD'], { cwd: repoRoot }, traceCtx)
  return { committed: true, sha: rev.stdout.trim(), files }
}
