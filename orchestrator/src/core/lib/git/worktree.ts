import { resolve } from 'node:path'
import { mkdir, rm, realpath } from 'node:fs/promises'
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
import {
  captureCheckpoint,
  discardWorkingTreeChanges,
  restoreCheckpoint,
} from './checkpoint'

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
 * Thrown by {@link attachToOriginWorktree} when a recovery (kind=fix) task's
 * origin worktree is no longer on disk (e.g. cleaned up after a prior merge).
 * A recovery is meant to continue the origin's work in-place on the origin's
 * branch, so a missing worktree is a hard failure the operator must resolve —
 * the setup step catches this, fails the fix task, and raises an action-queue
 * item rather than silently recreating the worktree (see the fix-task branch of
 * the implement workflow's setup-worktree step).
 */
export class OriginWorktreeMissingError extends Error {
  readonly originTaskId: string
  readonly expectedPath: string
  readonly expectedBranch: string
  constructor(args: { originTaskId: string; expectedPath: string; expectedBranch: string }) {
    super(
      `origin worktree for recovery is missing: expected branch '${args.expectedBranch}' ` +
        `at ${args.expectedPath} (origin task ${args.originTaskId}) is not present on disk`,
    )
    this.name = 'OriginWorktreeMissingError'
    this.originTaskId = args.originTaskId
    this.expectedPath = args.expectedPath
    this.expectedBranch = args.expectedBranch
  }
}

/**
 * Thrown by {@link attachToOriginWorktree} when the origin worktree directory is
 * missing AND the branch `task/<origin-id>` no longer exists — i.e. the origin
 * task was fully cleaned up (worktree removed and branch deleted). The operator
 * must restart the origin task, not merely recover it.
 *
 * Extends {@link OriginWorktreeMissingError} so it is caught by the same handler
 * in the setup primitive, surfaces an operator action-queue item, and does not
 * silently vanish.
 */
export class RecoveryNeedsOriginRestart extends OriginWorktreeMissingError {
  constructor(originTaskId: string) {
    super({
      originTaskId,
      expectedPath: '(directory and branch both absent)',
      expectedBranch: `task/${originTaskId}`,
    })
    this.name = 'RecoveryNeedsOriginRestart'
  }
}

export interface AttachToOriginWorktreeArgs {
  /** The origin (recovered) task's id — used only for diagnostics. */
  originTaskId: string
  /** The origin task's branch, as recorded on its row (`task/<origin-id>`). */
  originBranch: string
  /** The origin task's worktree path, as recorded on its row. */
  originWorktreePath: string
  traceCtx?: TraceCtx
}

/**
 * Attach a recovery (kind=fix) dispatch to its origin task's EXISTING worktree
 * and branch instead of carving a fresh `task/<fix-id>` worktree. The recovery
 * then stacks its commit directly on top of the origin's work — the faithful
 * "continue where it stopped" behaviour, and what actually happens on disk for
 * an in-place resume.
 *
 * Recovery: when the worktree directory has been pruned from disk but the branch
 * still exists (e.g. a prior crash removed the directory without deleting the
 * branch), the function rebuilds the worktree in-place via `git worktree add`
 * and continues — the recovery can still stack its commit on the origin's branch.
 *
 * Hard failures (throw):
 *   - Directory gone AND branch also gone → {@link RecoveryNeedsOriginRestart}
 *     (operator must restart the origin task entirely)
 *   - Directory present but registered on the wrong branch →
 *     {@link OriginWorktreeMissingError} (stale git state the operator must resolve)
 */
export const attachToOriginWorktree = async (
  args: AttachToOriginWorktreeArgs,
): Promise<WorktreeRef> => {
  const { originTaskId, originBranch: branch, originWorktreePath: path } = args
  const setupCtx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'setup' }
    : undefined

  // Prune stale registrations so a worktree dir removed out-of-band is not
  // reported as still-registered below.
  await execProbe(
    resolveGitBin(),
    ['worktree', 'prune'],
    { cwd: repoRoot(), timeout: WORKTREE_GIT_TIMEOUT_MS },
    setupCtx,
  ).catch(() => {})

  const registered = await listRegisteredWorktrees(setupCtx).catch(
    () => [] as RegisteredWorktree[],
  )

  // `git worktree list --porcelain` reports the canonical realpath of each
  // worktree (e.g. macOS resolves /tmp → /private/tmp), while the recorded
  // origin path is whatever form the task row stored. Compare on realpath so a
  // symlinked path prefix doesn't make a present worktree look missing.
  const canonical = async (p: string): Promise<string> =>
    realpath(p).catch(() => p)
  const dirPresent = await pathExists(path)
  const targetReal = dirPresent ? await canonical(path) : path
  let registration: RegisteredWorktree | undefined
  for (const w of registered) {
    if ((await canonical(w.path)) === targetReal) {
      registration = w
      break
    }
  }
  const onExpectedBranch = registration?.branch === branch

  if (!dirPresent) {
    // Directory is gone — check whether the branch still exists so we can
    // rebuild the worktree in-place without discarding the origin's progress.
    const branchStillExists = await branchExists(branch, setupCtx)
    if (branchStillExists) {
      // Branch intact: re-attach it at the canonical path. After this call the
      // directory exists and git registers the worktree; the recovery can stack
      // its commit on the origin branch as normal.
      await exec(
        resolveGitBin(),
        ['worktree', 'add', path, branch],
        { cwd: repoRoot() },
        setupCtx,
      )
      // Fall through to return { path, branch }.
    } else {
      // Both the directory and the branch are gone: the origin was fully cleaned
      // up and cannot be recovered in-place. The operator must restart it.
      throw new RecoveryNeedsOriginRestart(originTaskId)
    }
  } else if (registration === undefined || !onExpectedBranch) {
    throw new OriginWorktreeMissingError({
      originTaskId,
      expectedPath: path,
      expectedBranch: branch,
    })
  }

  return { path, branch }
}

/**
 * Slice F.2 (main-commiter): provision a worktree the committer recovery
 * runs inside. The committer's whole purpose is to read the dirty state of
 * the integration branch and dispose of it; the dirty state lives on
 * the repo's main checkout (`getRepoRoot()`), so a vanilla `createWorktree`
 * pointing at a `task/<id>` branch would land the committer in a CLEAN tree
 * — the wrong workspace.
 *
 * Approach: capture the dirty state of `repoRoot` as a per-task CHECKPOINT
 * (`refs/mars/checkpoint/<recoveryTaskId>` — see `checkpoint.ts`), spin up a
 * fresh worktree at `.mars/worktrees/<recoveryTaskId>/` on a new branch off
 * `integrationBranch`, apply the checkpoint by naming its exact commit object
 * inside that worktree, and only then clear `repoRoot`. The result is that the
 * recovery agent sees the same `git status` it would have seen in `repoRoot`,
 * but in its own isolated working tree.
 *
 * This deliberately does NOT use `git stash`: `refs/stash` is shared by every
 * linked worktree in the repo and is addressed by shifting positions, so with
 * tasks running in parallel a `stash pop` here could consume an entry pushed by
 * an unrelated task. A checkpoint ref is per-task and is restored by object id,
 * so one task's checkpoint is un-poppable by another.
 *
 * Ordering is chosen so no failure can lose work:
 *  1. capture   — `repoRoot` untouched; the state now also exists as a commit.
 *  2. worktree  — created off the integration tip.
 *  3. restore   — throws loudly (`CheckpointRestoreError`) on conflict, leaving
 *                 `repoRoot` still dirty and the checkpoint ref intact.
 *  4. discard   — only once the state is provably present in the worktree.
 *
 * If there is nothing to capture (e.g. only ignored files are dirty, which a
 * checkpoint deliberately never holds) the worktree is still created on the
 * integration branch — the recipe re-checks `git status` at start and exits
 * successfully on a clean tree.
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

  // Capture the dirty state of the main checkout onto this recovery task's own
  // checkpoint ref. Untracked-but-not-ignored files are included so the
  // committer sees the full picture; ignored files are never captured (and are
  // left on disk by the discard below). A `null` result means there was nothing
  // to migrate — a stale-detection race, or ignored-only dirt — so we stick
  // with the clean integration branch and let the recipe re-check.
  const checkpoint = await captureCheckpoint({
    cwd,
    key: args.recoveryTaskId,
    message: `mars main-commiter spawn ${args.recoveryTaskId}`,
    traceCtx: ctx,
  })

  // Build the worktree on a fresh branch off the integration tip via the
  // standard `createWorktree`. The branch is `task/<recoveryTaskId>` and
  // lives under `.mars/worktrees/<recoveryTaskId>/` — same conventions
  // as a normal Coder worktree so cleanup (`removeWorktree`) is uniform.
  const worktree = await createWorktree({
    taskId: args.recoveryTaskId,
    integrationBranch: args.integrationBranch,
    traceCtx: ctx,
  })

  if (checkpoint !== null) {
    // Apply by object id — never by stack position. Throws on conflict or on a
    // no-op apply, which leaves `repoRoot` dirty and the ref intact rather than
    // silently stranding the operator's work.
    await restoreCheckpoint({ cwd: worktree.path, checkpoint, traceCtx: ctx })
    // The state is now provably in the committer's worktree, so clearing the
    // integration checkout cannot lose it.
    await discardWorkingTreeChanges({ cwd, traceCtx: ctx })
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
