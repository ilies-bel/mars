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
import { provisionWorktreeDeps } from '../worktree-deps'

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
  // validate its integrity before reusing it. A partial checkout — e.g.
  // from an interrupted `git worktree add` or a prior crash (observed on
  // mars-caae60e2: remerge path produced a husk with no package.json and a
  // HEAD SHA that mismatched the branch tip) — leaves the worktree registered
  // on the right branch but unusable. Verify runs in that husk, fails with
  // npm ENOENT, and the task is classified as `unknown/unclassified` — a pure
  // infrastructure failure reported as a code failure.
  //
  // Integrity criteria (checked concurrently):
  //   1. `git rev-parse HEAD` in the worktree exits 0 and equals the branch
  //      tip SHA (guards against gitdir corruption / missing .git link).
  //   2. package.json is present on disk when the branch's index tracks it
  //      (guards against a partial/interrupted `git worktree add` that left
  //      tracked files absent without touching the HEAD ref).
  //
  // On any failure, drop the worktree and fall through to the
  // `git worktree add <path> <branch>` recreate path.
  if (
    existingForBranch &&
    existingForPath &&
    existingForBranch.path === existingForPath.path &&
    (await pathExists(path))
  ) {
    let worktreeIntact = false
    try {
      // Run HEAD-SHA check and manifest check concurrently.
      //
      // 1. HEAD SHA: `git rev-parse HEAD` in the worktree must succeed and
      //    equal the branch tip.  A missing or corrupt `.git` file (e.g. an
      //    aborted `git worktree add`) makes the command exit non-zero, which
      //    is enough to declare the worktree unusable.  For a normally-linked
      //    worktree HEAD is a symbolic ref → always equals branch tip; this
      //    check primarily guards against gitdir corruption.
      //
      // 2. Manifest completeness: if `package.json` is a tracked file in the
      //    branch's index (`git ls-files package.json` returns it), it must
      //    exist on disk.  A partial or interrupted checkout can leave tracked
      //    files absent without changing the HEAD ref.  We use `ls-files`
      //    rather than a bare `pathExists` so a coder who deliberately deleted
      //    package.json via a commit does NOT trigger a false rebuild (the file
      //    would no longer appear in `git ls-files` output once removed from
      //    the index).
      const [headResult, branchResult, lsResult] = await Promise.all([
        execProbe(resolveGitBin(), ['rev-parse', 'HEAD'], { cwd: path }, setupCtx),
        execProbe(resolveGitBin(), ['rev-parse', branch], { cwd }, setupCtx),
        execProbe(resolveGitBin(), ['ls-files', 'package.json'], { cwd: path }, setupCtx),
      ])
      const headSha = headResult.stdout.trim()
      const branchSha = branchResult.stdout.trim()
      const packageJsonTracked = lsResult.exitCode === 0 && lsResult.stdout.trim().length > 0
      const packageJsonPresent = packageJsonTracked
        ? await pathExists(resolve(path, 'package.json'))
        : true
      worktreeIntact =
        headResult.exitCode === 0 &&
        branchResult.exitCode === 0 &&
        headSha.length > 0 &&
        headSha === branchSha &&
        packageJsonPresent
    } catch {
      // Any error → treat as corrupt; fall through to recreate.
    }

    if (worktreeIntact) {
      await provisionWorktreeDeps({ worktreeRoot: path })
      return { path, branch }
    }

    // Corrupt or HEAD-mismatched: remove the worktree so the subsequent
    // `git worktree add <path> <branch>` path recreates it from the branch tip.
    // The `existingForPath.branch === branch` condition means the wrong-branch
    // cleanup block below is a no-op; the `existingForBranch.path === path`
    // condition means the wrong-path cleanup block is also a no-op. The
    // subsequent re-prune and `branchAlreadyExists → git worktree add` path
    // then reconstitute the worktree correctly.
    await execProbe(
      resolveGitBin(),
      ['worktree', 'remove', '--force', path],
      { cwd },
      setupCtx,
    ).catch(() => {})
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
  await provisionWorktreeDeps({ worktreeRoot: path })
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

  await provisionWorktreeDeps({ worktreeRoot: path })
  return { path, branch }
}

/**
 * Thrown by {@link provisionCommitterWorktree} when the set of files staged
 * in the committer worktree after checkpoint restore does not match the set of
 * files the checkpoint originally captured.
 *
 * A mismatch means the committer would commit a DIFFERENT set of files than
 * what was stranded on the integration branch — exactly the failure mode that
 * produced the fc56b07d incident (1,908 deletions of the Reflection surface
 * when only modifications should have been committed). The work is never lost:
 * the checkpoint ref is still intact on the per-task ref.
 */
export class CommitterTransferMismatchError extends Error {
  readonly checkpoint: { ref: string; sha: string; files: string[] }
  readonly worktreePath: string
  readonly missingFromWorktree: string[]
  readonly unexpectedInWorktree: string[]

  constructor(
    checkpoint: { ref: string; sha: string; files: string[] },
    worktreePath: string,
    missingFromWorktree: string[],
    unexpectedInWorktree: string[],
  ) {
    super(
      `Committer transfer integrity check failed: checkpoint ${checkpoint.ref} ` +
        `(${checkpoint.sha.slice(0, 9)}) captured ${checkpoint.files.length} file(s) but ` +
        `the worktree at ${worktreePath} shows a different staged diff after restore. ` +
        (missingFromWorktree.length > 0
          ? `Missing from worktree: [${missingFromWorktree.slice(0, 5).join(', ')}${missingFromWorktree.length > 5 ? ` …+${missingFromWorktree.length - 5} more` : ''}]. `
          : '') +
        (unexpectedInWorktree.length > 0
          ? `Unexpected in worktree: [${unexpectedInWorktree.slice(0, 5).join(', ')}${unexpectedInWorktree.length > 5 ? ` …+${unexpectedInWorktree.length - 5} more` : ''}]. `
          : '') +
        `The work is NOT lost — it is still anchored on ${checkpoint.ref}. ` +
        `Operator action required: inspect the checkpoint and the worktree diff before committing.`,
    )
    this.name = 'CommitterTransferMismatchError'
    this.checkpoint = checkpoint
    this.worktreePath = worktreePath
    this.missingFromWorktree = missingFromWorktree
    this.unexpectedInWorktree = unexpectedInWorktree
  }
}

/**
 * Thrown by {@link provisionCommitterWorktree} when the entire staged diff in
 * the committer worktree consists only of file deletions AND the deletion count
 * exceeds {@link COMMITTER_DELETION_ONLY_THRESHOLD}.
 *
 * A pure large-scale deletion diff in the committer worktree is almost
 * certainly a corrupt state transfer rather than an intentional stranded change.
 * The fc56b07d incident committed 1,908 deletions of the Reflection surface
 * that was meant to be ADDED; this guard would have caught that.
 *
 * Threshold reasoning: small pure-deletion diffs (≤50 files) can legitimately
 * appear in a committer worktree when a developer removed an old file or
 * directory and left the deletion uncommitted. Above 50, the probability of an
 * accidental deletion-only stranded change approaches zero while the probability
 * of a corrupt transfer approaches certainty.
 */
export class CommitterDeletionOnlyError extends Error {
  readonly checkpoint: { ref: string; sha: string; files: string[] }
  readonly worktreePath: string
  readonly deletionCount: number
  readonly threshold: number

  constructor(
    checkpoint: { ref: string; sha: string; files: string[] },
    worktreePath: string,
    deletionCount: number,
    threshold: number,
  ) {
    super(
      `Committer deletion-only guard tripped: the staged diff in ${worktreePath} contains ` +
        `${deletionCount} pure file deletions (threshold: ${threshold}). A large pure-deletion ` +
        `diff almost certainly indicates a corrupt state transfer rather than an intended stranded ` +
        `change. The work is anchored on ${checkpoint.ref}. ` +
        `Operator action required: inspect the checkpoint before committing.`,
    )
    this.name = 'CommitterDeletionOnlyError'
    this.checkpoint = checkpoint
    this.worktreePath = worktreePath
    this.deletionCount = deletionCount
    this.threshold = threshold
  }
}

/**
 * Maximum number of pure file deletions allowed in a committer worktree
 * before the deletion-only guard trips. Above this count a pure-deletion diff
 * is treated as a corrupt state transfer and aborted with
 * {@link CommitterDeletionOnlyError}.
 *
 * 50 files: small enough that it catches mass-deletion accidents (the fc56b07d
 * incident had 1,908 deletions), large enough to allow legitimate cases where a
 * developer removed a sizeable directory and left it uncommitted on the
 * integration branch.
 */
export const COMMITTER_DELETION_ONLY_THRESHOLD = 50

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
 * After restore, two safety checks run before the integration checkout is
 * cleared:
 *
 *  1. **Transfer integrity** — the staged diff in the committer worktree must
 *     match the set of files the checkpoint captured. A mismatch aborts with
 *     {@link CommitterTransferMismatchError}. This would have stopped the
 *     fc56b07d incident (1,908 deletions committed when modifications were
 *     intended).
 *
 *  2. **Deletion-only guard** — a pure deletion diff whose file count exceeds
 *     {@link COMMITTER_DELETION_ONLY_THRESHOLD} aborts with
 *     {@link CommitterDeletionOnlyError}. Legitimate stranded deletions are
 *     rare; above 50 files the pattern almost certainly indicates a corrupt
 *     transfer rather than an intended change.
 *
 * Ordering is chosen so no failure can lose work:
 *  1. capture   — `repoRoot` untouched; the state now also exists as a commit.
 *  2. worktree  — created off the integration tip.
 *  3. restore   — throws loudly (`CheckpointRestoreError`) on conflict, leaving
 *                 `repoRoot` still dirty and the checkpoint ref intact.
 *  4. verify    — mismatch or deletion-only throws; `repoRoot` is still dirty.
 *  5. discard   — only once the state is provably and correctly in the worktree.
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
  const git = resolveGitBin()
  const ctx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'setup' }
    : undefined

  // Defense-in-depth guard (ADR-0058 / fix-b): refuse to migrate uncommitted
  // work off the primary checkout when the daemon was paused. A paused daemon
  // signals that an operator is actively working in the integration tree;
  // silently capturing their edits to migrate them into the committer worktree
  // is how the 2026-07-28 data-loss incident occurred. This guard is orthogonal
  // to the capture mechanism — per-task checkpoint refs removed the shared-stash
  // collision, but they do not make it correct to move an operator's live edits.
  //
  // Under normal operation fix-(a) is the primary protection: the persisted
  // pause flag makes a restarted daemon come up paused so drain() never fires
  // and this function is never called. This guard is the fallback for the
  // rare race where the persisted flag is true but dispatch slipped through
  // (e.g. an RPC resume that didn't flush the file before the restart).
  //
  // Note: `readPersistedPaused` is intentionally imported lazily so tests that
  // mock the config module don't need to set up the full daemon ecosystem.
  const { readPersistedPaused } = await import('../../daemon/config')
  if (readPersistedPaused()) {
    throw new Error(
      'provisionCommitterWorktree: daemon is paused — refusing to capture and migrate ' +
        'uncommitted changes off the integration checkout. Resolve the dispatch state through `mars operator` once ' +
        'the working tree is ready to be processed.',
    )
  }

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
    // no-op apply, which leaves `repoRoot` dirty and the checkpoint ref intact.
    await restoreCheckpoint({ cwd: worktree.path, checkpoint, traceCtx: ctx })

    // ── Safety check 1: transfer integrity ──────────────────────────────────
    // Verify the staged diff in the committer worktree matches the set of
    // files the checkpoint captured. A mismatch means the committer would
    // commit DIFFERENT files from what was stranded on the integration branch.
    // The most likely cause is a corrupt state transfer (the fc56b07d incident
    // happened because the agent committed deletions of files that should have
    // been added). `repoRoot` is still dirty at this point; this check runs
    // BEFORE discardWorkingTreeChanges so a mismatch leaves the source intact.
    const stagedDiffOut = await exec(
      git,
      ['diff', '--cached', '--name-only', 'HEAD'],
      { cwd: worktree.path },
      ctx,
    )
    const stagedFiles = new Set(
      stagedDiffOut.stdout.trim().split('\n').filter((f) => f.length > 0),
    )
    const capturedSet = new Set(checkpoint.files)
    const missingFromWorktree = checkpoint.files.filter((f) => !stagedFiles.has(f))
    const unexpectedInWorktree = [...stagedFiles].filter((f) => !capturedSet.has(f))

    if (missingFromWorktree.length > 0 || unexpectedInWorktree.length > 0) {
      // Raise an action-queue item for immediate operator visibility — the task
      // will also fail normally, but waiting for the recovery-spawn path to
      // raise an item would add latency and consume the recovery slot.
      try {
        const { raiseActionQueueItem } = await import('../action-queue')
        await raiseActionQueueItem({
          kind: 'failed',
          category: 'orchestrator',
          priority: 'urgent',
          title: `Committer transfer mismatch: ${args.recoveryTaskId} — ${missingFromWorktree.length + unexpectedInWorktree.length} file(s) differ`,
          body: [
            `The committer worktree for recovery task ${args.recoveryTaskId} shows a different staged diff`,
            `from what checkpoint ${checkpoint.ref} (${checkpoint.sha.slice(0, 9)}) captured.`,
            '',
            missingFromWorktree.length > 0
              ? `Files in checkpoint but absent from worktree (${missingFromWorktree.length}): ${missingFromWorktree.slice(0, 10).join(', ')}${missingFromWorktree.length > 10 ? ` …+${missingFromWorktree.length - 10} more` : ''}`
              : '',
            unexpectedInWorktree.length > 0
              ? `Files in worktree but absent from checkpoint (${unexpectedInWorktree.length}): ${[...unexpectedInWorktree].slice(0, 10).join(', ')}${unexpectedInWorktree.length > 10 ? ` …+${unexpectedInWorktree.length - 10} more` : ''}`
              : '',
            '',
            `The work is NOT lost — it is still anchored on ${checkpoint.ref}.`,
            `Operator action required: inspect the checkpoint and retry the task manually.`,
          ]
            .filter((l) => l.length > 0)
            .join('\n'),
          payload: { recoveryTaskId: args.recoveryTaskId, checkpointRef: checkpoint.ref },
          context: { repoRoot: process.env.MARS_REPO ?? null },
          raisedBy: 'orchestrator:committer-safety',
          signature: `committer-transfer-mismatch:${args.recoveryTaskId}`,
          occurrence: { at: new Date().toISOString(), recoveryTaskId: args.recoveryTaskId },
        })
      } catch {
        // Non-fatal: the action-queue raise is best-effort. The typed error
        // below is the primary abort signal.
      }
      throw new CommitterTransferMismatchError(
        checkpoint,
        worktree.path,
        missingFromWorktree,
        unexpectedInWorktree,
      )
    }

    // ── Safety check 2: deletion-only guard ─────────────────────────────────
    // A committer worktree whose entire staged diff consists only of file
    // deletions above COMMITTER_DELETION_ONLY_THRESHOLD is almost certainly a
    // corrupt state transfer, not an intentional stranded change.
    // (The fc56b07d incident had 1,908 such deletions.)
    const deletionsOnlyOut = await exec(
      git,
      ['diff', '--cached', '--diff-filter=D', '--name-only', 'HEAD'],
      { cwd: worktree.path },
      ctx,
    )
    const deletedFiles = deletionsOnlyOut.stdout.trim().split('\n').filter((f) => f.length > 0)
    const totalStagedCount = stagedFiles.size

    if (
      totalStagedCount > 0 &&
      deletedFiles.length === totalStagedCount &&
      deletedFiles.length > COMMITTER_DELETION_ONLY_THRESHOLD
    ) {
      try {
        const { raiseActionQueueItem } = await import('../action-queue')
        await raiseActionQueueItem({
          kind: 'failed',
          category: 'orchestrator',
          priority: 'urgent',
          title: `Committer deletion-only guard: ${args.recoveryTaskId} would commit ${deletedFiles.length} pure deletions`,
          body: [
            `The committer worktree for recovery task ${args.recoveryTaskId} contains a pure-deletion`,
            `staged diff of ${deletedFiles.length} files — above the ${COMMITTER_DELETION_ONLY_THRESHOLD}-file threshold.`,
            '',
            `A deletion-only diff of this scale almost certainly indicates a corrupt state transfer`,
            `rather than an intentional stranded change. Committing it would destroy files on the`,
            `integration branch.`,
            '',
            `The work is NOT lost — it is still anchored on checkpoint ${checkpoint.ref}.`,
            `Operator action required: inspect the checkpoint and retry the task manually.`,
          ].join('\n'),
          payload: { recoveryTaskId: args.recoveryTaskId, checkpointRef: checkpoint.ref, deletionCount: deletedFiles.length },
          context: { repoRoot: process.env.MARS_REPO ?? null },
          raisedBy: 'orchestrator:committer-safety',
          signature: `committer-deletion-only:${args.recoveryTaskId}`,
          occurrence: { at: new Date().toISOString(), recoveryTaskId: args.recoveryTaskId },
        })
      } catch {
        // Non-fatal: the action-queue raise is best-effort. The typed error
        // below is the primary abort signal.
      }
      throw new CommitterDeletionOnlyError(
        checkpoint,
        worktree.path,
        deletedFiles.length,
        COMMITTER_DELETION_ONLY_THRESHOLD,
      )
    }

    // The state is now provably and correctly in the committer's worktree,
    // so clearing the integration checkout cannot lose it.
    await discardWorkingTreeChanges({ cwd, traceCtx: ctx })
  }

  return worktree
}

/**
 * Thrown by {@link restoreWorktreeIfMissing} when a resumed run's worktree
 * directory is gone AND its branch no longer exists, so there is nothing left
 * on disk or in git to resume from. The task must be restarted from setup —
 * the caller stamps a named failure signature rather than letting the run
 * spawn into a non-existent directory.
 */
export class ResumeWorktreeUnrecoverable extends Error {
  readonly taskId: string
  readonly expectedPath: string
  readonly expectedBranch: string
  constructor(args: { taskId: string; expectedPath: string; expectedBranch: string }) {
    super(
      `worktree for resumed task ${args.taskId} is unrecoverable: directory ${args.expectedPath} ` +
        `is absent and branch '${args.expectedBranch}' no longer exists`,
    )
    this.name = 'ResumeWorktreeUnrecoverable'
    this.taskId = args.taskId
    this.expectedPath = args.expectedPath
    this.expectedBranch = args.expectedBranch
  }
}

export type RestoreWorktreeOutcome = 'present' | 'rebuilt'

/**
 * Guarantee that a resumed run's worktree directory actually exists on disk
 * before anything is spawned inside it.
 *
 * WHY THIS EXISTS. Checkpoint-resume replays a run with `runId = task.id`, so
 * a completed `setup` step short-circuits and the worktree ref is
 * reconstituted from the task row (`resolveWorktree`). Nothing on that path
 * revalidates the directory. If the worktree was removed while the task was
 * parked — a recovery task that shares the origin's worktree merging and
 * cleaning it up, an operator drop, a prune — the resumed `code` step spawns
 * the provider CLI with `cwd` pointing at a deleted directory. Node reports
 * that as `spawn <bin> ENOENT` → exit 127 in a few milliseconds, which reads
 * as "command not found" and is bucketed as a contentless coder-exit-nonzero.
 * The binary was never the problem and the retry could never succeed.
 *
 * Repair mirrors {@link attachToOriginWorktree}: if the branch still exists,
 * the committed work is intact and the worktree is re-attached in place with
 * `git worktree add <path> <branch>`, so the resumed coder picks up exactly
 * where it stopped. If the branch is gone too, nothing can be resumed and
 * {@link ResumeWorktreeUnrecoverable} is thrown for the caller to surface as a
 * named failure.
 *
 * @returns `'present'` when the directory was already there (the overwhelmingly
 *          common case — one `existsSync` and no git calls), `'rebuilt'` when
 *          it had to be re-attached from the branch.
 * @throws {ResumeWorktreeUnrecoverable} when directory and branch are both gone.
 */
export const restoreWorktreeIfMissing = async (args: {
  taskId: string
  ref: WorktreeRef
  traceCtx?: TraceCtx
}): Promise<RestoreWorktreeOutcome> => {
  const { taskId, ref } = args
  const { path, branch } = ref

  if (await pathExists(path)) {
    await provisionWorktreeDeps({ worktreeRoot: path })
    return 'present'
  }

  const ctx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'setup' }
    : undefined

  // Drop stale registrations so `git worktree add` is not refused with
  // "already registered" for a path that no longer exists on disk.
  await execProbe(
    resolveGitBin(),
    ['worktree', 'prune'],
    { cwd: repoRoot(), timeout: WORKTREE_GIT_TIMEOUT_MS },
    ctx,
  ).catch(() => {})

  if (!(await branchExists(branch, ctx))) {
    throw new ResumeWorktreeUnrecoverable({
      taskId,
      expectedPath: path,
      expectedBranch: branch,
    })
  }

  await mkdir(resolve(path, '..'), { recursive: true })
  await exec(
    resolveGitBin(),
    ['worktree', 'add', path, branch],
    { cwd: repoRoot() },
    ctx,
  )
  await provisionWorktreeDeps({ worktreeRoot: path })
  return 'rebuilt'
}

/**
 * Thrown by {@link syncWorktreeToIntegration} when replaying the task branch
 * onto the integration tip conflicts. The rebase has been aborted and any
 * uncommitted work restored, so the worktree is left EXACTLY as it was found —
 * never half-rebased, never emptied.
 */
export class WorktreeRebaseConflictError extends Error {
  readonly taskId: string
  readonly worktreePath: string
  readonly branch: string
  readonly integrationBranch: string
  /** Combined stdout+stderr of the failed `git rebase`, truncated. */
  readonly rebaseOutput: string
  /** Checkpoint ref holding the uncommitted work, or null when the tree was clean. */
  readonly checkpointRef: string | null

  constructor(args: {
    taskId: string
    worktreePath: string
    branch: string
    integrationBranch: string
    rebaseOutput: string
    checkpointRef: string | null
  }) {
    super(
      `cannot bring worktree for task ${args.taskId} up to date: replaying ${args.branch} onto ` +
        `${args.integrationBranch} conflicts. The rebase was aborted and the worktree left ` +
        `untouched at ${args.worktreePath}; no commit and no uncommitted change was discarded` +
        (args.checkpointRef === null
          ? ''
          : ` (uncommitted work is also anchored on ${args.checkpointRef})`) +
        `.\n${args.rebaseOutput}`,
    )
    this.name = 'WorktreeRebaseConflictError'
    this.taskId = args.taskId
    this.worktreePath = args.worktreePath
    this.branch = args.branch
    this.integrationBranch = args.integrationBranch
    this.rebaseOutput = args.rebaseOutput
    this.checkpointRef = args.checkpointRef
  }
}

/**
 * Ref namespace holding the pre-recreate tip of a task branch that could not be
 * replayed onto the integration tip. Like `refs/mars/checkpoint`, and unlike
 * `refs/stash`, it is per-task, addressed by name, and never a stack — so no
 * task can consume another's parked history.
 */
export const PARKED_REF_PREFIX = 'refs/mars/parked'

/**
 * Ref for a parked branch tip: `refs/mars/parked/<taskId>-<shortSha>`.
 *
 * The sha is part of the name so a task that is recreated more than once parks
 * each tip under its own ref instead of clobbering the previous one. Flat (not
 * nested under a per-task directory) so `<taskId>` and `<taskId>/<sha>` can
 * never collide as a git D/F conflict.
 */
const parkedRefFor = (taskId: string, sha: string): string => {
  const safe = taskId
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.lock$/i, '-lock')
  if (safe.length === 0) throw new Error(`parked key '${taskId}' has no usable characters`)
  return `${PARKED_REF_PREFIX}/${safe}-${sha.slice(0, 9)}`
}

interface ParkedCommit {
  shortSha: string
  subject: string
}

/**
 * What to do when replaying the task branch onto the integration tip conflicts.
 *
 * `'escalate'` — abort, restore the tree exactly as found, throw
 * {@link WorktreeRebaseConflictError}. The conservative default, and correct
 * where a conflict cannot arise anyway (a main-commiter worktree is carved off
 * the integration tip, so it is current by construction).
 *
 * `'recreate'` — park the old tip on `refs/mars/parked/<id>-<sha>` and reset the
 * branch onto the integration tip, so the coder redoes the work against current
 * source. Correct on the setup path for a task that carves its OWN branch,
 * because that is what `mars restart` already means: it deletes the run journal
 * so the pipeline starts at step 0, nulls `branch`/`worktreePath`, and keeps
 * `task/<id>` only as an ARCHIVE (its own action-queue copy says "preserved to
 * avoid losing committed work … cherry-pick or purge"). Reusing that archive as
 * the live work branch was the original defect; parking it on a ref honours the
 * archive obligation without dragging superseded commits forward.
 *
 * `'reconcile'` — hand the in-progress conflicted rebase to the vcs-supervisor
 * (Vega), the agent this repo already uses for exactly this problem at merge
 * time; fall back to `'escalate'` if it cannot finish. Correct wherever the
 * branch's existing commits ARE the premise of the run and therefore must not
 * be reset: a recovery (`kind:'fix'`) attached to its origin's worktree to
 * continue that work in place, or a checkpoint-resume whose prompt tells the
 * coder "prior progress is already in this worktree".
 *
 * Those two used to be `'escalate'`, which was a DEAD END. A recovery exists to
 * fix its origin's work; if the origin's branch conflicts with integration the
 * recovery could never start, so it failed, and its origin sat `blocked` behind
 * a permanently-failed blocker forever (17 tasks stranded this way in one
 * session). Refusing to reset that work was right — but refusing to reconcile
 * it was not: a genuine content conflict is precisely what a conflict resolver
 * is for, and Vega's prompt is written about the git state ("a `git rebase
 * <target>` of <source> just conflicted in this worktree"), not about the merge
 * phase, so it is accurate here verbatim.
 */
export type WorktreeConflictPolicy = 'escalate' | 'recreate' | 'reconcile'

export type WorktreeSyncOutcome =
  | { kind: 'already-current' }
  | {
      kind: 'rebased'
      /** Task-branch tip before the replay. */
      from: string
      /** Task-branch tip after the replay (contains the integration tip). */
      to: string
      /** Checkpoint ref the uncommitted work was parked on, or null. */
      checkpointRef: string | null
    }
  | {
      kind: 'reconciled'
      /** Task-branch tip before the replay. */
      from: string
      /** Task-branch tip after Vega finished the rebase. */
      to: string
      /** Checkpoint ref the uncommitted work was parked on, or null. */
      checkpointRef: string | null
      /** Vega's session id, when the conversation carried one. */
      vegaSessionId: string | null
    }
  | {
      kind: 'recreated'
      /** Task-branch tip before the reset — reachable forever via `parkedRef`. */
      from: string
      /** The integration tip the branch now points at. */
      to: string
      /** Ref anchoring the pre-reset tip. Never null on this outcome. */
      parkedRef: string
      /** The commits that were on the branch and are now only on `parkedRef`. */
      parkedCommits: ParkedCommit[]
      /** Checkpoint ref holding the uncommitted work, or null if the tree was clean. */
      checkpointRef: string | null
    }

/**
 * Guarantee that a task's worktree contains the current integration tip before
 * anything runs inside it.
 *
 * WHY THIS EXISTS. `createWorktree` only branches off `integrationBranch` when
 * the branch does NOT already exist; when `task/<id>` is already present it
 * does a bare `git worktree add <path> <branch>`, which checks out the branch
 * at whatever SHA it was left at. `mars restart` deliberately preserves
 * `task/<id>` whenever it carries unmerged commits (it is the archive that
 * keeps a failed attempt's work from being deleted), so a restart-then-dispatch
 * cycle re-attached the OLD tip: worktrees were observed 46-89 commits behind
 * `main`. The `code` step then ran against superseded source and `verify`
 * re-failed on assertions that had already been fixed on `main` — the restarted
 * task could never drain, no matter how many times it was restarted.
 * `attachToOriginWorktree` inherits the same staleness, so a stale origin
 * poisoned its recovery too.
 *
 * WHAT IT DOES. Replays the task branch onto the integration tip with the same
 * `git rebase` the merge step already uses (`mergeBranch` Step 1), so a synced
 * worktree is by construction fast-forwardable at merge time.
 *
 * SAFETY. Uncommitted work is never destroyed:
 *  1. resolve the integration tip once, by SHA, so a concurrent advance cannot
 *     make the ancestry check and the rebase disagree;
 *  2. short-circuit when the tip is already an ancestor of HEAD (the common
 *     case — one `merge-base --is-ancestor` probe and nothing else);
 *  3. park uncommitted work on this task's own `refs/mars/checkpoint/setup-<id>`
 *     ref (NEVER `git stash` — `refs/stash` is shared by every linked worktree
 *     here and is addressed by shifting positions, so a parallel task's pop can
 *     swallow it) and only then clean the tree;
 *  4. rebase; on conflict `git rebase --abort` FIRST, so the worktree is never
 *     left half-rebased, and only then apply `onConflict`;
 *  5. restore the checkpoint on the success path too.
 *
 * CONFLICT. `onConflict` decides — see {@link WorktreeConflictPolicy}. Under
 * `'escalate'` the tree is restored byte-for-byte and
 * {@link WorktreeRebaseConflictError} is thrown. Under `'recreate'` the old tip
 * is anchored on `refs/mars/parked/<id>-<sha>` and the branch is reset onto the
 * integration tip; the uncommitted work stays anchored on the checkpoint ref
 * (it is NOT re-applied onto a base it was never written against). Both are
 * lossless — every commit and every captured file remains reachable by ref name
 * — and neither can leave a rebase in progress.
 *
 * WHY `'recreate'` MUST NOT FAIL THE TASK. Measured on the live repo, 24 of the
 * ~65 active tasks carry a divergent branch, every one of them `ahead` 1-2 and
 * `behind` up to 335. That is the normal population, not an edge case: three
 * consecutive conflicts trip the signature-storm breaker
 * (`SIGNATURE_STORM_TRIP_THRESHOLD`) and PAUSE ALL DISPATCH, which is strictly
 * worse for the operator than the stale-code bug this module fixes. `'recreate'`
 * is a SUCCESS path — it records no failure signature, so it cannot storm — and
 * it is idempotent: afterwards the branch IS the integration tip, so a second
 * pass short-circuits at `already-current`.
 *
 * @throws {WorktreeRebaseConflictError} when the replay conflicts and
 *   `onConflict` is `'escalate'`.
 */
/**
 * True when `cwd` has a rebase in progress (`rebase-merge/` or `rebase-apply/`
 * under the worktree's git dir). Mirrors the identical probe in `merge.ts`.
 */
const isRebaseInProgress = async (
  git: string,
  cwd: string,
  ctx: TraceCtx | undefined,
): Promise<boolean> => {
  for (const which of ['rebase-merge', 'rebase-apply']) {
    const r = await execProbe(
      git,
      ['rev-parse', '--git-path', which],
      { cwd },
      ctx,
    ).catch(() => null)
    if (r === null || r.exitCode !== 0) continue
    const dir = r.stdout.trim()
    // `--git-path` resolves relative to the worktree's git dir, but git may
    // return a relative path — resolve it against cwd before probing.
    if (dir.length > 0 && (await pathExists(resolve(cwd, dir)))) return true
  }
  return false
}

/**
 * Hand a live, conflicted rebase to the vcs-supervisor and verify the result
 * against git rather than against Vega's own account of it.
 *
 * The acceptance test is lifted verbatim from `mergeBranch`'s conflict branch,
 * because the same three lies are possible: the agent can stop mid-rebase, can
 * claim success without advancing the branch, or can leave conflict markers
 * staged. Any of those, and we abort the rebase and report failure — the caller
 * then escalates with the worktree untouched.
 *
 * @returns the new tip on success, or `null` when Vega could not finish (the
 *   rebase has been aborted by then, so the caller must not abort again).
 */
const reconcileWithSupervisor = async (args: {
  git: string
  taskId: string
  path: string
  branch: string
  integrationBranch: string
  /** Branch tip before the rebase started. */
  from: string
  ctx: TraceCtx | undefined
}): Promise<{ to: string; vegaSessionId: string | null } | null> => {
  const { git, taskId, path, branch, integrationBranch, from, ctx } = args
  const { invokeVcsSupervisor, VCS_SUPERVISOR_TIMEOUT_MS } = await import('./merge')
  const { extractSessionIdFromConversation } = await import('./claude')

  console.log(
    `[worktree-sync] task ${taskId}: ${branch} conflicts with ${integrationBranch}; ` +
      `dispatching vcs-supervisor to reconcile the in-progress rebase`,
  )

  const sup = await invokeVcsSupervisor(
    branch,
    integrationBranch,
    path,
    VCS_SUPERVISOR_TIMEOUT_MS,
  ).catch((err: unknown) => {
    console.error(`[worktree-sync] task ${taskId}: vcs-supervisor spawn failed:`, err)
    return null
  })

  const stillInProgress = await isRebaseInProgress(git, path, ctx)
  const to =
    sup === null
      ? from
      : (await execProbe(git, ['rev-parse', 'HEAD'], { cwd: path }, ctx)).stdout.trim()
  const advanced = to !== from && to.length > 0
  const treeClean = await (async (): Promise<boolean> => {
    const unstaged = await execProbe(git, ['diff', '--quiet'], { cwd: path }, ctx)
    if (unstaged.exitCode !== 0) return false
    const staged = await execProbe(git, ['diff', '--cached', '--quiet'], { cwd: path }, ctx)
    return staged.exitCode === 0
  })()

  if (sup === null || stillInProgress || !advanced || !treeClean) {
    console.warn(
      `[worktree-sync] task ${taskId}: vcs-supervisor outcome rejected by git ` +
        `(spawned=${sup !== null}, stillInProgress=${stillInProgress}, advanced=${advanced}, ` +
        `treeClean=${treeClean}); aborting the rebase and escalating`,
    )
    await execProbe(git, ['rebase', '--abort'], { cwd: path }, ctx).catch(() => {})
    return null
  }

  const vegaSessionId = extractSessionIdFromConversation(sup.conversation)
  console.log(
    `[worktree-sync] task ${taskId}: vcs-supervisor reconciled ${branch} onto ` +
      `${integrationBranch} (${from.slice(0, 9)} -> ${to.slice(0, 9)})`,
  )
  return { to, vegaSessionId }
}

/**
 * `<shortSha> <subject>` for every commit on HEAD that is not in `baseSha`.
 * Best-effort: a failure here must never block the reset it merely annotates.
 */
const readCommitsAhead = async (
  git: string,
  cwd: string,
  baseSha: string,
  ctx: TraceCtx | undefined,
): Promise<ParkedCommit[]> => {
  const r = await execProbe(
    git,
    ['log', '--format=%h%x09%s', `${baseSha}..HEAD`],
    { cwd },
    ctx,
  ).catch(() => null)
  if (r === null || r.exitCode !== 0) return []
  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf('\t')
      return tab === -1
        ? { shortSha: line, subject: '' }
        : { shortSha: line.slice(0, tab), subject: line.slice(tab + 1) }
    })
}

export const syncWorktreeToIntegration = async (args: {
  taskId: string
  ref: WorktreeRef
  integrationBranch: string
  /** Conflict policy. Defaults to `'escalate'` — the caller opts into recreate. */
  onConflict?: WorktreeConflictPolicy
  traceCtx?: TraceCtx
}): Promise<WorktreeSyncOutcome> => {
  const { taskId, ref, integrationBranch, onConflict = 'escalate' } = args
  const { path, branch } = ref
  const ctx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'setup' }
    : undefined
  const git = resolveGitBin()

  // Pin the target by SHA. `integrationBranch` honours INTEGRATION_BRANCH via
  // the caller; resolving it once means the ancestry probe below and the rebase
  // are talking about the same commit even if the branch advances mid-setup.
  const integrationSha = (
    await exec(
      git,
      ['rev-parse', `${integrationBranch}^{commit}`],
      { cwd: repoRoot() },
      ctx,
    )
  ).stdout.trim()

  // Cheap short-circuit: a freshly-carved worktree (and any branch that has
  // already been rebased) is already current. Exit 0 = ancestor.
  const ancestry = await execProbe(
    git,
    ['merge-base', '--is-ancestor', integrationSha, 'HEAD'],
    { cwd: path },
    ctx,
  )
  if (ancestry.exitCode === 0) return { kind: 'already-current' }

  const from = (
    await exec(git, ['rev-parse', 'HEAD'], { cwd: path }, ctx)
  ).stdout.trim()

  // Park uncommitted work BEFORE touching the tree. `git rebase` refuses to
  // start on a dirty tree, and the point of this step is to leave nothing
  // behind. A null checkpoint means there was nothing capturable.
  const checkpoint = await captureCheckpoint({
    cwd: path,
    key: `setup-${taskId}`,
    message: `mars: park uncommitted work before replaying ${branch} onto ${integrationBranch}`,
    traceCtx: ctx,
  })
  if (checkpoint !== null) {
    await discardWorkingTreeChanges({ cwd: path, traceCtx: ctx })
  }

  const rebase = await execProbe(git, ['rebase', integrationSha], { cwd: path }, ctx)
  if (rebase.exitCode !== 0) {
    // Probe the on-disk rebase state BEFORE deciding anything: `'reconcile'`
    // hands the LIVE rebase to Vega, whose prompt asserts one is in progress,
    // so aborting first would make that premise false. A rebase can also exit
    // non-zero WITHOUT creating any state (bad upstream ref, empty-commit
    // stop) — mergeBranch guards the same way — and then there is nothing for
    // a resolver to reconcile.
    const conflictInProgress = await isRebaseInProgress(git, path, ctx)

    if (onConflict === 'reconcile' && conflictInProgress) {
      const reconciled = await reconcileWithSupervisor({
        git,
        taskId,
        path,
        branch,
        integrationBranch,
        from,
        ctx,
      })
      if (reconciled !== null) {
        if (checkpoint !== null) {
          await restoreCheckpoint({ cwd: path, checkpoint, traceCtx: ctx })
        }
        return {
          kind: 'reconciled',
          from,
          to: reconciled.to,
          checkpointRef: checkpoint?.ref ?? null,
          vegaSessionId: reconciled.vegaSessionId,
        }
      }
      // Vega could not finish; it has already aborted the rebase. Fall through
      // to the escalate tail below, which restores the tree and throws.
    }

    // Never leave a half-rebased worktree behind.
    await execProbe(git, ['rebase', '--abort'], { cwd: path }, ctx).catch(() => {})

    // Confirm the abort actually settled. `--abort` exits non-zero when no
    // rebase was in progress, which is harmless. What is NOT harmless is
    // rebase state SURVIVING the abort: `reset --hard` would then repoint the
    // branch while leaving the worktree mid-rebase. Refuse to recreate in that
    // case and fall through to escalate, which touches nothing.
    const rebaseStillInProgress = await isRebaseInProgress(git, path, ctx)

    if (onConflict === 'recreate' && !rebaseStillInProgress) {
      // Read the commits we are about to move off the branch BEFORE moving it,
      // so the log/report can name them. `%h\t%s` keeps parsing trivial.
      const parkedCommits = await readCommitsAhead(git, path, integrationSha, ctx)

      // Anchor the old tip under this task's own ref. `-m` writes a reflog
      // entry, so `git reflog <ref>` explains where it came from months later.
      const parkedRef = parkedRefFor(taskId, from)
      await exec(
        git,
        [
          'update-ref',
          '-m',
          `mars: parked ${branch} tip before recreating off ${integrationBranch}`,
          parkedRef,
          from,
        ],
        { cwd: repoRoot() },
        ctx,
      )

      // Move the branch onto the integration tip. HEAD is on `branch`, so this
      // repoints the branch itself; `clean -fd` drops untracked stragglers but
      // (no `-x`) leaves ignored files like node_modules alone.
      await exec(git, ['reset', '--hard', integrationSha], { cwd: path }, ctx)
      await exec(git, ['clean', '-fd'], { cwd: path }, ctx)

      // Deliberately NOT restoring the checkpoint: the uncommitted work was
      // written against the old base, and re-applying it onto a tip that
      // conflicts with the very commits it accompanied would hand the coder a
      // mangled tree. It stays reachable on the checkpoint ref instead.
      console.warn(
        `[worktree-sync] task ${taskId}: ${branch} conflicts with ${integrationBranch}; ` +
          `RECREATED off the integration tip so the coder works against current source. ` +
          `Nothing was destroyed — ${parkedCommits.length} commit(s) parked on ${parkedRef} ` +
          `(${from.slice(0, 9)})` +
          (checkpoint === null
            ? ''
            : `, uncommitted work on ${checkpoint.ref} (${checkpoint.sha.slice(0, 9)})`) +
          `. Inspect: git -C ${repoRoot()} log ${integrationBranch}..${parkedRef}` +
          `. Recover: git -C ${path} cherry-pick -n ${parkedRef}; git -C ${path} cherry-pick --quit` +
          (parkedCommits.length === 0
            ? ''
            : `. Parked: ${parkedCommits.map((c) => `${c.shortSha} ${c.subject}`).join(' | ').slice(0, 500)}`),
      )

      return {
        kind: 'recreated',
        from,
        to: integrationSha,
        parkedRef,
        parkedCommits,
        checkpointRef: checkpoint?.ref ?? null,
      }
    }

    // 'escalate': put the parked work back so the tree is exactly what we found.
    if (checkpoint !== null) {
      await restoreCheckpoint({ cwd: path, checkpoint, traceCtx: ctx }).catch(
        (restoreErr: unknown) => {
          // The work is still anchored on the checkpoint ref; the error message
          // below names it, so this is recoverable rather than lost.
          console.error(
            `[worktree-sync] task ${taskId}: could not restore ${checkpoint.ref} after aborting the rebase:`,
            restoreErr,
          )
        },
      )
    }
    throw new WorktreeRebaseConflictError({
      taskId,
      worktreePath: path,
      branch,
      integrationBranch,
      rebaseOutput: `${rebase.stdout}${rebase.stderr}`.trim().slice(0, 2000),
      checkpointRef: checkpoint?.ref ?? null,
    })
  }

  if (checkpoint !== null) {
    // Throws CheckpointRestoreError (naming the ref + recovery command) rather
    // than silently handing the coder a tree that lost its uncommitted state.
    await restoreCheckpoint({ cwd: path, checkpoint, traceCtx: ctx })
  }

  const to = (
    await exec(git, ['rev-parse', 'HEAD'], { cwd: path }, ctx)
  ).stdout.trim()
  return { kind: 'rebased', from, to, checkpointRef: checkpoint?.ref ?? null }
}

/**
 * List the uncommitted paths in a worktree, newest state as of right now.
 *
 * Returns `[]` for a clean tree and `null` when the answer is unknown — the
 * path is absent, is not a git worktree, or `git status` failed. `null` is
 * deliberately distinct from `[]`: the destructive-verb guards below must not
 * read "I could not look" as "there is nothing there".
 *
 * Shared by the three surfaces that have to answer "would this destroy
 * uncommitted work?" — the `mars restart` guard, the `mars drop` guard, and
 * the derived `failed` action-queue row. Before this existed only the
 * commits-ahead half of that question was asked, so a task sitting at
 * `ahead=0` with a worktree full of uncommitted work looked, to all three,
 * exactly like a task with nothing to lose.
 */
export const listUncommittedPaths = async (
  worktreePath: string | null | undefined,
): Promise<string[] | null> => {
  if (!worktreePath) return null
  if (!(await pathExists(worktreePath))) return null
  const git = resolveGitBin()
  const status = await execProbe(
    git,
    ['status', '--porcelain'],
    { cwd: worktreePath, timeout: WORKTREE_GIT_TIMEOUT_MS },
  )
  if (status.exitCode !== 0) return null
  return status.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== '')
}

/**
 * Build the refusal a destructive verb should print when its task's worktree
 * holds uncommitted work, or `null` when there is nothing to protect.
 *
 * Shared by `mars restart` and `mars drop` so both name the same facts in the
 * same shape: how many paths, which ones, and the two ways out. Neither verb
 * may proceed on a non-null result without `--force`.
 */
export const describeUncommittedWork = async (args: {
  verb: 'restart' | 'drop'
  taskId: string
  worktreePath: string | null | undefined
}): Promise<string | null> => {
  const { verb, taskId, worktreePath } = args
  const dirtyPaths = await listUncommittedPaths(worktreePath).catch(() => null)
  if (dirtyPaths === null || dirtyPaths.length === 0) return null
  return (
    `refusing to ${verb} task ${taskId}: worktree ${worktreePath} has ` +
    `${dirtyPaths.length} uncommitted path(s) that ${verb} would destroy:\n` +
    dirtyPaths.map((path) => `  ${path}`).join('\n') +
    `\nCommit them, resume on this worktree with \`mars continue ${taskId}\`, ` +
    `or rerun with --force to discard them.`
  )
}

export const removeWorktree = async (
  ref: WorktreeRef,
  force = true,
  keepBranch = false,
  traceCtx?: TraceCtx,
): Promise<void> => {
  // Before removing the worktree, repair any cross-worktree node_modules
  // symlinks that pnpm may have left in the parent repo. This prevents
  // dangling symlinks in the parent's ui/node_modules/ after the worktree
  // (and its node_modules symlink) is deleted.
  const { repairNodeModulesAfterWorktreeRemoval } = await import('../worktree-deps')
  await repairNodeModulesAfterWorktreeRemoval(repoRoot(), ref.path).catch((err) =>
    console.warn(`[removeWorktree] repair-node-modules failed (non-fatal):`, err),
  )

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
