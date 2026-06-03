import { resolve } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { getStateDir } from '../../context'
import {
  exec,
  execProbe,
  resolveGitBin,
  repoRoot,
  pathExists,
  branchExists,
  listRegisteredWorktrees,
  WORKTREE_GIT_TIMEOUT_MS,
  type TraceCtx,
  type RegisteredWorktree,
} from './internal'

export interface CreateWorktreeArgs {
  taskId: string
  integrationBranch: string
  baseSha?: string
  branchSuffix?: string
  /** Optional trace context. When supplied, every git invocation issued by
   *  this call funnels through `runTool` with `phase: 'setup'`. */
  traceCtx?: TraceCtx
}

export interface WorktreeRef {
  path: string
  branch: string
}

export const createWorktree = async ({
  taskId,
  integrationBranch,
  baseSha,
  branchSuffix,
  traceCtx,
}: CreateWorktreeArgs): Promise<WorktreeRef> => {
  const suffix = branchSuffix ? `-${branchSuffix}` : ''
  const branch = `task/${taskId}${suffix}`
  const dirName = `${taskId}${suffix}`
  const path = resolve(getStateDir(), `worktrees/${dirName}`)
  const startPoint = baseSha ?? integrationBranch
  const cwd = repoRoot()
  // Default phase to setup for createWorktree calls if the caller didn't pin
  // a phase explicitly. Most callers are workflows in the setup step.
  const setupCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'setup' }
    : undefined

  await mkdir(resolve(path, '..'), { recursive: true })

  // Prune any stale worktree registrations (paths recorded in .git/worktrees
  // that no longer exist on disk) before inspecting state. Both prune and
  // list are time-boxed: a corrupt .git/worktrees directory with many
  // entries can make these commands hang indefinitely, stalling every
  // implement dispatch until slots exhaust. Errors and timeouts fall through
  // to .catch below so createWorktree proceeds with an empty registration list.
  await execProbe(
    resolveGitBin(),
    ['worktree', 'prune'],
    { cwd, timeout: WORKTREE_GIT_TIMEOUT_MS },
    setupCtx,
  ).catch(() => {})

  const registered = await listRegisteredWorktrees(setupCtx).catch(
    () => [] as RegisteredWorktree[],
  )
  const existingForBranch = registered.find((w) => w.branch === branch)
  const existingForPath = registered.find((w) => w.path === path)

  // Already-registered worktree at the expected path on the expected branch:
  // reuse it as-is. This is the "skip if it already exists" path.
  if (
    existingForBranch &&
    existingForPath &&
    existingForBranch.path === existingForPath.path &&
    (await pathExists(path))
  ) {
    return { path, branch }
  }

  // Worktree registered at our path but on a different branch (or detached).
  // It's stale state from a previous run — drop it.
  if (existingForPath && existingForPath.branch !== branch) {
    await execProbe(
      resolveGitBin(),
      ['worktree', 'remove', '--force', existingForPath.path],
      { cwd },
      setupCtx,
    ).catch(() => {})
  }

  // Worktree registered for our branch at a different path. Drop that
  // registration so we can re-attach the branch at the canonical path.
  if (existingForBranch && existingForBranch.path !== path) {
    await execProbe(
      resolveGitBin(),
      ['worktree', 'remove', '--force', existingForBranch.path],
      { cwd },
      setupCtx,
    ).catch(() => {})
  }

  // Re-prune in case the removes above left dangling refs.
  await execProbe(
    resolveGitBin(),
    ['worktree', 'prune'],
    { cwd, timeout: WORKTREE_GIT_TIMEOUT_MS },
    setupCtx,
  ).catch(() => {})

  // If a directory still exists at our target path with no live worktree
  // registration, it's leftover filesystem state — wipe it.
  if (await pathExists(path)) {
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }

  const branchAlreadyExists = await branchExists(branch, setupCtx)
  const args = branchAlreadyExists
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, startPoint]
  await exec(resolveGitBin(), args, { cwd }, setupCtx)
  return { path, branch }
}

/**
 * Slice F.2 (main-commiter): provision a worktree the committer recovery
 * runs inside. The committer's whole purpose is to read the dirty state of
 * the integration branch and commit / stash it; the dirty state lives on
 * the repo's main checkout (`getRepoRoot()`), so a vanilla `createWorktree`
 * pointing at a `task/<id>` branch would land the committer in a CLEAN tree
 * — the wrong workspace.
 *
 * Approach: stash the dirty state in `repoRoot` (with `--include-untracked`),
 * spin up a fresh worktree at `.mars/worktrees/<recoveryTaskId>/` on a new
 * branch off `integrationBranch`, then pop the stash inside that worktree.
 * The result is that the recovery agent sees exactly the same `git status`
 * it would have seen in `repoRoot`, but in its own isolated working tree
 * (so concurrent task worktrees branched off main aren't affected by the
 * committer's edits until it commits on the integration branch via
 * `git -C <committerWorktree> commit` and the orchestrator later merges).
 *
 * If `git stash` produces no entry (e.g. only untracked-ignored files exist
 * which the stash refuses to capture), the worktree is still created on
 * the integration branch — the recipe re-checks `git status` at start and
 * exits successfully on a clean tree.
 */
export interface CommitterWorktreeArgs {
  /** Recovery task id used for path + branch naming. */
  recoveryTaskId: string
  integrationBranch: string
  traceCtx?: TraceCtx
}

export const provisionCommitterWorktree = async (
  args: CommitterWorktreeArgs,
): Promise<WorktreeRef> => {
  const cwd = repoRoot()
  const ctx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'setup' }
    : undefined

  // Stash the dirty state in the main checkout. `--include-untracked` covers
  // untracked-but-not-ignored files so the committer sees the full picture.
  // `git stash push` returns non-zero when there is nothing to stash; treat
  // that as a benign skip so a stale-detection race (state cleaned between
  // our probe and this call) doesn't hard-fail the recovery spawn.
  const stashMessage = `mars main-commiter spawn ${args.recoveryTaskId}`
  const stashed = await execProbe(
    resolveGitBin(),
    ['stash', 'push', '--include-untracked', '-m', stashMessage],
    { cwd },
    ctx,
  )
  // Standard git output: "No local changes to save" means we have nothing
  // to migrate; stick with the clean integration branch and let the
  // recipe re-check.
  const haveStash =
    stashed.exitCode === 0 && !/No local changes to save/i.test(stashed.stdout)

  // Build the worktree on a fresh branch off the integration tip via the
  // standard `createWorktree`. The branch is `task/<recoveryTaskId>` and
  // lives under `.mars/worktrees/<recoveryTaskId>/` — same conventions
  // as a normal Coder worktree so cleanup (`removeWorktree`) is uniform.
  const worktree = await createWorktree({
    taskId: args.recoveryTaskId,
    integrationBranch: args.integrationBranch,
    traceCtx: ctx,
  })

  if (haveStash) {
    // Pop the stash into the new worktree. `stash pop` on conflicts is a
    // recoverable state for the agent (it sees the conflicted files in
    // `git status`); we surface the exit code as a probe rather than
    // throwing, so the recipe can decide what to do.
    await execProbe(resolveGitBin(), ['stash', 'pop'], { cwd: worktree.path }, ctx)
  }

  return worktree
}

export const resolveSha = async (
  ref: string,
  traceCtx?: TraceCtx,
): Promise<string> => {
  const { stdout } = await exec(
    resolveGitBin(),
    ['rev-parse', ref],
    { cwd: repoRoot() },
    traceCtx,
  )
  return stdout.trim()
}

export const removeWorktree = async (
  ref: WorktreeRef,
  force = true,
  keepBranch = false,
  traceCtx?: TraceCtx,
): Promise<void> => {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(ref.path)
  await exec(resolveGitBin(), args, { cwd: repoRoot() }, traceCtx)
  if (!keepBranch) {
    await execProbe(
      resolveGitBin(),
      ['branch', '-D', ref.branch],
      { cwd: repoRoot() },
      traceCtx,
    ).catch(() => {})
  }
}
