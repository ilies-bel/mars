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
 * Mirrors `commit-main.ts`'s `committer-salvage` provenance: untracked paths
 * are never swept in. An untracked path on the integration checkout may be
 * scratch work, a secret, or a build artifact nobody gitignored — putting it
 * into an automatic commit is exactly the shape of the 2026-08-17 incident
 * referenced there.
 *
 * WHY THIS IS NOT `git add -u && git commit`. By the time this runs, the
 * merge has already fast-forwarded `refs/heads/<integrationBranch>` with
 * `update-ref`, which touches no working tree. The integration checkout is
 * therefore *stale*: every file the merge just introduced is missing from the
 * index and the working tree, so `git status` reports it as a staged
 * DELETION. A blanket `git add -u` would fold those phantom deletions into
 * the commit and silently delete the work that just merged. So the operator's
 * own changes are identified positively — the diff between the sha the
 * checkout's content is actually based on and the working tree — and
 * committed by pathspec, which takes the working-tree content for exactly
 * those paths and HEAD's content for everything else.
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
  /**
   * The sha whose tree the checkout's *content* is based on: the recorded
   * last-synced sha when there is one, else the pre-merge integration sha.
   * The operator's changes are `diff(baseSha, working tree)`, which is the
   * same comparison the merge's own re-sync step uses to decide the tree
   * holds real local work.
   */
  baseSha: string
  /** The just-merged tip `refs/heads/<integrationBranch>` now points at. */
  headSha: string
  traceCtx?: TraceCtx
}

export type AutoCommitOperatorDirtResult =
  | { committed: true; sha: string; files: string[] }
  | { committed: false; reason: string }

const namesFrom = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

/**
 * Commit the operator's uncommitted tracked changes on the integration
 * checkout as a single {@link operatorWipCommitMessage} commit.
 *
 * Returns `{committed: false, reason}` rather than throwing on any git
 * failure — including the benign "nothing of the operator's to commit" case
 * and the one case that is genuinely unsafe to automate (operator and merge
 * touching the same path) — so the caller can fall back to its pre-existing
 * checkpoint-and-park handling instead of treating every non-success as
 * fatal.
 *
 * The checkout is left dirty on purpose: the commit captures the operator's
 * content but the working tree is still the stale pre-merge one. Bringing it
 * up to date is the caller's `reset --hard` (it is the caller that records
 * the resulting last-synced sha), and it is safe there precisely because
 * everything of the operator's is now a commit.
 */
export const autoCommitOperatorDirt = async (
  args: AutoCommitOperatorDirtArgs,
): Promise<AutoCommitOperatorDirtResult> => {
  const git = resolveGitBin()
  const { repoRoot, taskId, baseSha, headSha, traceCtx } = args

  // The operator's own changes: tracked paths whose working-tree content
  // differs from the sha the checkout is based on. `git diff <sha>` compares
  // that commit against the working tree and ignores the index entirely, so
  // a merely-staged change is not mistaken for the operator's and — more
  // importantly — the stale index's phantom deletions never appear here.
  const operatorDiff = await execProbe(
    git,
    ['diff', '--name-only', baseSha, '--'],
    { cwd: repoRoot },
    traceCtx,
  )
  if (operatorDiff.exitCode !== 0) {
    const detail = operatorDiff.stderr.trim() || `(exit ${operatorDiff.exitCode})`
    return { committed: false, reason: `git diff against ${baseSha.slice(0, 9)} failed: ${detail}` }
  }
  const files = namesFrom(operatorDiff.stdout)
  if (files.length === 0) {
    return { committed: false, reason: 'no tracked operator changes to commit' }
  }

  // A path the merge changed AND the operator edited cannot be resolved by
  // committing the working-tree side: that side does not contain the merged
  // change, so the commit would revert it. This needs a human, so decline and
  // let the caller's checkpoint path preserve the edit instead.
  const mergedDiff = await execProbe(
    git,
    ['diff', '--name-only', baseSha, headSha, '--'],
    { cwd: repoRoot },
    traceCtx,
  )
  if (mergedDiff.exitCode !== 0) {
    const detail = mergedDiff.stderr.trim() || `(exit ${mergedDiff.exitCode})`
    return { committed: false, reason: `git diff of the merged range failed: ${detail}` }
  }
  const mergedPaths = new Set(namesFrom(mergedDiff.stdout))
  const contested = files.filter((file) => mergedPaths.has(file))
  if (contested.length > 0) {
    return {
      committed: false,
      reason: `operator and merge both changed: ${contested.join(', ').slice(0, 200)}`,
    }
  }

  // Pathspec form: commits the working-tree content of exactly these paths on
  // top of HEAD and leaves the rest of the (stale) index out of it.
  const message = operatorWipCommitMessage(taskId)
  const commit = await execProbe(
    git,
    ['commit', '-m', message, '--', ...files],
    { cwd: repoRoot },
    traceCtx,
  )
  if (commit.exitCode !== 0) {
    const combined = [commit.stderr.trim(), commit.stdout.trim()].filter(Boolean).join(' | ')
    if (/nothing to commit|no changes added/i.test(combined)) {
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
