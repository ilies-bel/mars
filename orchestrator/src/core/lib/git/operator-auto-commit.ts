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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

/**
 * Split a `--name-only -z` path list. NUL-terminated rather than newline:
 * without `-z`, git quotes any path with a non-ASCII or special character
 * ("caf\303\251.txt"), and a quoted path handed back to `git commit --` does
 * not name the file it came from.
 */
const namesFrom = (stdout: string): string[] =>
  stdout.split('\0').filter((path) => path.length > 0)

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
    ['diff', '--name-only', '-z', baseSha, '--'],
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
    ['diff', '--name-only', '-z', baseSha, headSha, '--'],
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

export interface RevertAutoCommitArgs {
  /** Repo root where the integration branch is checked out. */
  repoRoot: string
  /**
   * The SHA of the auto-commit to revert.  Must be a commit that still exists
   * in the repo (i.e. has not been garbage-collected).  If it no longer exists,
   * the function returns `{ reverted: false, reason: 'commit not found' }`.
   */
  commitSha: string
  /**
   * The paths that were captured in the auto-commit.  Only these paths are
   * restored to the working tree and unstaged; every other path in the repo is
   * left exactly as it is.  Callers should source this list from the
   * `AutoCommitOperatorDirtResult.files` that was recorded in the Notice.
   */
  files: string[]
  traceCtx?: TraceCtx
}

export type RevertAutoCommitResult = { reverted: true } | { reverted: false; reason: string }

/**
 * Restore the operator's uncommitted edits from an auto-commit back to the
 * working tree as unstaged modifications, without rewriting history.
 *
 * Two-step mechanics:
 *
 *   1. `git checkout <sha> -- <files>` — restores the committed content to
 *      both the index and the working tree (i.e. "as if you just staged and
 *      committed those edits by hand").
 *   2. `git reset <sha>~1 -- <files>` — resets the index for those paths to
 *      the parent commit's state, leaving the working tree untouched.
 *
 * Result: the index holds the pre-edit content and the working tree holds the
 * operator's edits, so `git status` shows the files as *unstaged* modifications
 * — indistinguishable from a fresh hand-edit.  The auto-commit remains intact
 * in the log (history is never rewritten).
 *
 * Returns `{ reverted: false, reason }` rather than throwing on any git
 * failure so the caller can surface the failure in the Notice without crashing
 * the merge path.
 */
export const revertAutoCommit = async (
  args: RevertAutoCommitArgs,
): Promise<RevertAutoCommitResult> => {
  const git = resolveGitBin()
  const { repoRoot, commitSha, files, traceCtx } = args

  if (files.length === 0) {
    return { reverted: false, reason: 'no files specified' }
  }

  // Step 0: verify the commit still exists.
  const catFile = await execProbe(
    git,
    ['cat-file', '-t', commitSha],
    { cwd: repoRoot },
    traceCtx,
  )
  if (catFile.exitCode !== 0 || catFile.stdout.trim() !== 'commit') {
    return { reverted: false, reason: 'commit not found' }
  }

  // Step 1: restore the committed content to both index and working tree.
  const checkout = await execProbe(
    git,
    ['checkout', commitSha, '--', ...files],
    { cwd: repoRoot },
    traceCtx,
  )
  if (checkout.exitCode !== 0) {
    const detail = [checkout.stderr.trim(), checkout.stdout.trim()].filter(Boolean).join(' | ')
    return {
      reverted: false,
      reason: `git checkout failed: ${detail || `(exit ${checkout.exitCode})`}`,
    }
  }

  // Step 2: reset the index for those paths to the parent commit, leaving
  // the working tree unchanged so the files appear as unstaged modifications.
  const reset = await execProbe(
    git,
    ['reset', `${commitSha}~1`, '--', ...files],
    { cwd: repoRoot },
    traceCtx,
  )
  if (reset.exitCode !== 0) {
    const detail = [reset.stderr.trim(), reset.stdout.trim()].filter(Boolean).join(' | ')
    return {
      reverted: false,
      reason: `git reset failed: ${detail || `(exit ${reset.exitCode})`}`,
    }
  }

  return { reverted: true }
}

/**
 * Wall-clock ceiling for {@link probeMainTypecheck}. A typecheck that has not
 * answered in two minutes is not a cheap detector any more, and the merge lock
 * is not the place to wait for it.
 */
export const PROBE_TIMEOUT_MS = 120_000

/**
 * Outcome of the post-auto-commit typecheck probe.
 *
 * Three states, not two: `'timeout'` is deliberately distinct from `false`
 * because a probe that never answered is *no signal*, not evidence of a broken
 * baseline, and must not be reported to the operator as one.
 */
export type MainTypecheckProbeResult =
  | { ok: true }
  | { ok: false; output: string }
  | { ok: 'timeout' }

/**
 * Cheap typecheck of the integration checkout, run immediately after an
 * operator auto-commit (ADR-0100 slice 7).
 *
 * This is a DETECTOR, not a gate: the merge proceeds whatever this returns.
 * Its whole job is to bound the latency between "Mars committed your
 * half-finished edit" and "you found out it does not compile" to seconds, so
 * the operator can amend before anything is built on top of it.
 *
 * NEVER throws. Every failure mode that is not "the typecheck said no" —
 * an unreadable manifest, a missing package manager, no declared typecheck at
 * all — resolves to `{ ok: true }`, because none of them are evidence that the
 * auto-commit broke anything.
 *
 * The command is the project's own declared `typecheck` npm script, looked up
 * in the repo root's `package.json` first and then in its immediate
 * subdirectories (a workspace repo declares the script per package, not at the
 * root). The first match in alphabetical order wins and it is the ONLY one
 * run: this executes inside the merge lock, so probing every package would
 * cost far more than the signal is worth. A repo that wants a different probe
 * declares a `typecheck` script at its root.
 */
export const probeMainTypecheck = async (args: {
  repoRoot: string
  timeoutMs?: number
  traceCtx?: TraceCtx
}): Promise<MainTypecheckProbeResult> => {
  const { repoRoot, timeoutMs = PROBE_TIMEOUT_MS, traceCtx } = args

  const candidates = [repoRoot]
  try {
    const entries = readdirSync(repoRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
    candidates.push(...entries.map((name) => resolve(repoRoot, name)))
  } catch {
    // Unreadable repo root — the root package.json candidate still stands.
  }

  let probeDir: string | null = null
  for (const dir of candidates) {
    const manifestPath = resolve(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        scripts?: Record<string, unknown>
      }
      const script = manifest.scripts?.['typecheck']
      if (typeof script === 'string' && script.trim() !== '') {
        probeDir = dir
        break
      }
    } catch {
      // A malformed manifest declares nothing runnable.
    }
  }
  if (probeDir === null) return { ok: true }

  // Same lockfile-based package-manager rule the gate detector uses
  // (`init/detect-verify-gates.ts`), so the probe runs the script the same way
  // the project's own verify gates do.
  const packageManager = existsSync(resolve(repoRoot, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(resolve(repoRoot, 'yarn.lock'))
      ? 'yarn'
      : existsSync(resolve(repoRoot, 'bun.lockb')) || existsSync(resolve(repoRoot, 'bun.lock'))
        ? 'bun'
        : 'npm'

  let probe: { stdout: string; stderr: string; exitCode: number }
  try {
    probe = await execProbe(
      packageManager,
      ['run', 'typecheck'],
      { cwd: probeDir, timeout: timeoutMs },
      traceCtx,
    )
  } catch {
    // Spawn failure (package manager not on PATH, directory vanished). Not a
    // broken baseline — report no signal rather than a false alarm.
    return { ok: true }
  }

  // `runTool` suffixes stderr with this marker when it kills a child on
  // `timeoutMs`; the exit code of a SIGKILLed process is otherwise
  // indistinguishable from a genuine typecheck failure.
  if (probe.stderr.includes('[runTool: killed after')) return { ok: 'timeout' }
  if (probe.exitCode === 0) return { ok: true }

  return {
    ok: false,
    output: [probe.stdout, probe.stderr]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join('\n'),
  }
}
