/**
 * Per-task working-tree checkpoints — the orchestrator's replacement for
 * `git stash`.
 *
 * ## Why `git stash` is banned in orchestrator machinery
 *
 * Mars runs every task in its own linked git worktree, but `refs/stash` lives
 * in the repository's COMMON git dir: every linked worktree shares one stash
 * stack. Entries are addressed by position (`stash@{0}`, `stash@{1}`) and each
 * push shifts every existing index. With several tasks in flight, a `stash pop`
 * issued by one task can therefore restore an entry pushed by a completely
 * different task — silently moving one task's uncommitted work into another
 * task's tree, or destroying it. That happened for real on this repo: a pop
 * returned a `.gitignore` change belonging to an unrelated task branch, and
 * only a human reading the diff noticed.
 *
 * ## The replacement
 *
 * A checkpoint is a plain commit object written with `git commit-tree` (never
 * `refs/stash`, never a stack) and anchored under a per-task ref:
 *
 *     refs/mars/checkpoint/<key>
 *
 * `<key>` is the task id, so two concurrent tasks address two different refs
 * and neither can consume the other's checkpoint. Restoring names the exact
 * object (`git cherry-pick -n <sha>`), never a stack position, so a restore is
 * deterministic no matter what else the daemon did in between.
 *
 * ## Capture semantics (explicit, because `git stash` got these wrong)
 *
 * Capture builds a tree from a TEMPORARY index (`GIT_INDEX_FILE`) seeded from
 * HEAD and updated with `git add -A`, so a checkpoint contains:
 *
 *  - modifications to tracked files (staged or unstaged — the distinction is
 *    intentionally flattened),
 *  - deletions of tracked files,
 *  - untracked files that are NOT ignored.
 *
 * It never contains ignored files (`.gitignore` / `.git/info/exclude`), exactly
 * like `git stash push --include-untracked`. `discardWorkingTreeChanges` leaves
 * ignored files on disk for the same reason, so a checkpoint+discard pair is
 * lossless for everything a checkpoint can hold. Ignored paths therefore stay
 * behind on the source tree; callers that need a fully pristine tree must deal
 * with them separately (the dirty-main classifier deliberately treats plain
 * `!!` entries as benign).
 *
 * Restoring is loud on failure: `restoreCheckpoint` throws
 * `CheckpointRestoreError` (naming the ref, the sha and the recovery command)
 * rather than leaving a half-applied or silently-empty tree behind.
 *
 * ## Retention
 *
 * Checkpoint refs are NOT deleted after a successful restore: the ref is the
 * recovery artifact an operator needs when a restore lands somewhere
 * unexpected, and one ref per task is cheap. Prune them with
 * `git for-each-ref --format='%(refname)' refs/mars/checkpoint | xargs -n1 git update-ref -d`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exec, execProbe, resolveGitBin, type TraceCtx } from './internal'

/** Ref namespace every checkpoint lives under. Never `refs/stash`. */
export const CHECKPOINT_REF_PREFIX = 'refs/mars/checkpoint'

/**
 * Identity used for the checkpoint commit object. Pinned via env so a repo
 * (or CI container) without `user.name` / `user.email` configured cannot make
 * `git commit-tree` fail and lose the work it was asked to preserve.
 */
const CHECKPOINT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Mars Orchestrator',
  GIT_AUTHOR_EMAIL: 'mars@localhost',
  GIT_COMMITTER_NAME: 'Mars Orchestrator',
  GIT_COMMITTER_EMAIL: 'mars@localhost',
}

/**
 * Map an arbitrary key (a task id, in practice) onto a legal ref component:
 * anything outside `[A-Za-z0-9._-]` becomes `-`, leading dots are dropped and
 * a `.lock` suffix is neutralised. Distinct task ids stay distinct — the
 * isolation guarantee rests on this.
 */
export const checkpointRefFor = (key: string): string => {
  const safe = key
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.lock$/i, '-lock')
  if (safe.length === 0) throw new Error(`checkpoint key '${key}' has no usable characters`)
  return `${CHECKPOINT_REF_PREFIX}/${safe}`
}

export interface Checkpoint {
  /** Per-task ref anchoring the commit object (keeps it from being GC'd). */
  ref: string
  /** The checkpoint commit's SHA. Restores name this, never a stack position. */
  sha: string
  /** Paths the checkpoint captured, from `git diff --name-only <parent> <sha>`. */
  files: string[]
}

/** Thrown when a checkpoint could not be applied onto a target worktree. */
export class CheckpointRestoreError extends Error {
  readonly checkpoint: Checkpoint
  readonly targetPath: string

  constructor(checkpoint: Checkpoint, targetPath: string, detail: string) {
    super(
      `failed to restore checkpoint ${checkpoint.ref} (${checkpoint.sha.slice(0, 9)}) into ${targetPath}: ${detail}. ` +
        `The work is NOT lost — it is anchored on ${checkpoint.ref}. Recover it with: ` +
        `git -C ${targetPath} cherry-pick -n ${checkpoint.ref}; git -C ${targetPath} cherry-pick --quit`,
    )
    this.name = 'CheckpointRestoreError'
    this.checkpoint = checkpoint
    this.targetPath = targetPath
  }
}

export interface CaptureCheckpointArgs {
  /** Working tree to capture. May be the primary checkout or any worktree. */
  cwd: string
  /** Namespacing key — the task id that owns this checkpoint. */
  key: string
  /** Commit message stored on the checkpoint object. */
  message: string
  traceCtx?: TraceCtx
}

/**
 * Capture `cwd`'s uncommitted state as a commit object under
 * `refs/mars/checkpoint/<key>`, WITHOUT touching the working tree and without
 * touching `refs/stash`.
 *
 * Returns `null` when there is nothing to capture (the tree matches HEAD once
 * ignored files are discounted) — callers treat that as a benign skip.
 */
export const captureCheckpoint = async (
  args: CaptureCheckpointArgs,
): Promise<Checkpoint | null> => {
  const { cwd, key, message, traceCtx } = args
  const git = resolveGitBin()
  const ref = checkpointRefFor(key)

  const head = (await exec(git, ['rev-parse', 'HEAD'], { cwd }, traceCtx)).stdout.trim()
  const headTree = (
    await exec(git, ['rev-parse', 'HEAD^{tree}'], { cwd }, traceCtx)
  ).stdout.trim()

  const indexDir = await mkdtemp(join(tmpdir(), 'mars-checkpoint-'))
  const indexFile = join(indexDir, 'index')
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    // Seed the temporary index from HEAD, then stage everything the working
    // tree carries. `git add -A` honours .gitignore, so ignored files stay out.
    await exec(git, ['read-tree', 'HEAD'], { cwd, env }, traceCtx)
    await exec(git, ['add', '-A'], { cwd, env }, traceCtx)
    const tree = (await exec(git, ['write-tree'], { cwd, env }, traceCtx)).stdout.trim()
    if (tree === headTree) return null

    const sha = (
      await exec(
        git,
        ['commit-tree', tree, '-p', head, '-m', message],
        { cwd, env: CHECKPOINT_IDENTITY },
        traceCtx,
      )
    ).stdout.trim()

    // Anchor the object under the per-task ref BEFORE reporting success: an
    // unreferenced commit-tree object is GC-eligible.
    await exec(git, ['update-ref', ref, sha], { cwd }, traceCtx)

    const files = (
      await exec(git, ['diff', '--name-only', head, sha], { cwd }, traceCtx)
    ).stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    return { ref, sha, files }
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => {})
  }
}

export interface RestoreCheckpointArgs {
  /** Working tree the checkpoint is applied into. Must be clean. */
  cwd: string
  checkpoint: Checkpoint
  traceCtx?: TraceCtx
}

/**
 * Apply a checkpoint into `cwd` by naming its exact commit object. Uses a
 * three-way `cherry-pick -n` so a target whose HEAD has moved past the
 * checkpoint's parent still merges correctly instead of reverting the newer
 * commits; the sequencer state is cleared afterwards so the target does not
 * look mid-cherry-pick to whatever runs next.
 *
 * Throws `CheckpointRestoreError` when the apply fails, conflicts, or produces
 * a tree with no changes at all. Never silently leaves the target unchanged.
 */
export const restoreCheckpoint = async (
  args: RestoreCheckpointArgs,
): Promise<void> => {
  const { cwd, checkpoint, traceCtx } = args
  const git = resolveGitBin()

  const pick = await execProbe(
    git,
    ['cherry-pick', '-n', checkpoint.sha],
    { cwd },
    traceCtx,
  )
  // Clear the sequencer/AUTO_MERGE state left by `-n`; keeps index + worktree.
  await execProbe(git, ['cherry-pick', '--quit'], { cwd }, traceCtx).catch(() => {})

  if (pick.exitCode !== 0) {
    throw new CheckpointRestoreError(
      checkpoint,
      cwd,
      `git cherry-pick exited ${pick.exitCode}: ${pick.stderr.trim().slice(0, 300)}`,
    )
  }

  const status = await exec(
    git,
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd },
    traceCtx,
  )
  const lines = status.stdout.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) {
    throw new CheckpointRestoreError(
      checkpoint,
      cwd,
      'the target tree is still clean after the apply',
    )
  }
  const conflicted = lines.filter((l) => l[0] === 'U' || l[1] === 'U')
  if (conflicted.length > 0) {
    throw new CheckpointRestoreError(
      checkpoint,
      cwd,
      `unmerged paths after apply: ${conflicted.map((l) => l.slice(3)).join(', ').slice(0, 300)}`,
    )
  }
}

export interface DiscardWorkingTreeChangesArgs {
  /** Working tree to reset. */
  cwd: string
  traceCtx?: TraceCtx
}

/**
 * Drop every uncommitted change in `cwd`: `reset --hard HEAD` for tracked
 * paths plus `clean -fd` for untracked ones. Ignored files are deliberately
 * left alone (no `-x`) — they are outside what a checkpoint can capture and
 * blowing away `node_modules/` or `.mars/` here would be catastrophic.
 *
 * ONLY call this after `captureCheckpoint` returned a checkpoint (or when the
 * changes are provably redundant); it is the destructive half of the
 * capture-then-clean pair that replaces `git stash push`.
 */
export const discardWorkingTreeChanges = async (
  args: DiscardWorkingTreeChangesArgs,
): Promise<void> => {
  const { cwd, traceCtx } = args
  const git = resolveGitBin()
  await exec(git, ['reset', '--hard', 'HEAD'], { cwd }, traceCtx)
  await exec(git, ['clean', '-fd'], { cwd }, traceCtx)
}
