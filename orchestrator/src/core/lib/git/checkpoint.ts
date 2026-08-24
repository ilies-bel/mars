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
 * Subject-line prefix written by the workflow's code-phase failure handler
 * when the coder exits non-zero with uncommitted paths. Any commit whose
 * subject starts with this prefix is a salvage snapshot produced by the
 * orchestrator — not reviewed, human-authored work — and must not be treated
 * as a finished diff ready to merge.
 *
 * Reuse this constant wherever the subject is read back (e.g. `mars continue`
 * branch-classification) so the two sites cannot drift apart.
 */
export const SALVAGE_CHECKPOINT_SUBJECT_PREFIX = 'wip(checkpoint):'

/**
 * Git trailer key/value written in the BODY of every salvage checkpoint
 * commit (see `coder-exit.ts`), alongside {@link SALVAGE_CHECKPOINT_SUBJECT_PREFIX}.
 *
 * The subject prefix is a human-legible label; this trailer is the
 * STRUCTURAL marker. Merge-time gating (`isSalvageCheckpointCommit` below)
 * reads the trailer back with `git log --format=%(trailers:...)`, a git
 * primitive that parses the commit body's trailer block, rather than
 * substring-matching the subject text. That distinction matters: a human
 * commit whose subject happens to start with `wip(checkpoint):` has no
 * `Mars-Checkpoint` trailer and must NOT be treated as an orchestrator
 * salvage snapshot.
 */
export const SALVAGE_CHECKPOINT_TRAILER_KEY = 'Mars-Checkpoint'
export const SALVAGE_CHECKPOINT_TRAILER_VALUE = 'salvage'

/**
 * True when `sha` (typically a branch tip, checked at merge time) carries
 * the `Mars-Checkpoint: salvage` trailer — i.e. it is an orchestrator-written
 * salvage checkpoint commit, not reviewed human-authored work. See
 * {@link SALVAGE_CHECKPOINT_TRAILER_KEY} for why this is structural rather
 * than a subject-line grep. Returns `false` (never throws) when `sha` does
 * not resolve, so a bad ref fails open to "not a checkpoint" rather than
 * blocking an unrelated merge.
 */
export const isSalvageCheckpointCommit = async (
  cwd: string,
  sha: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  const git = resolveGitBin()
  try {
    const result = await execProbe(
      git,
      [
        'log',
        '-1',
        `--format=%(trailers:key=${SALVAGE_CHECKPOINT_TRAILER_KEY},valueonly)`,
        sha,
      ],
      { cwd },
      traceCtx,
    )
    if (result.exitCode !== 0) return false
    return result.stdout.trim() === SALVAGE_CHECKPOINT_TRAILER_VALUE
  } catch {
    // `execProbe` throws (rather than returning a non-zero exit) on a
    // spawn-level failure — e.g. `cwd` no longer exists. That is exactly the
    // kind of "cannot answer" this function's contract already promises to
    // fail open on, so a thrown spawn error is caught here too rather than
    // propagating and aborting an unrelated merge.
    return false
  }
}

/**
 * The per-task briefing `Arc.createOrigin` appends to a `--supersede` task's
 * prompt when the branch it inherits is tipped by a salvage checkpoint (see
 * `isSalvageCheckpointCommit`). Without this, a coder dispatched onto a
 * superseded branch has no signal that the commit at its tip is a "do not
 * merge as-is" auto-commit, not real progress — and the merge step refuses to
 * fast-forward a branch left in that state (`merge:salvage-checkpoint-tip[/...]`
 * / `code:salvage-checkpoint-tip/no-progress`).
 */
export const buildSupersedeSalvageTipBrief = (taskId: string): string =>
  [
    '## Inherited salvage checkpoint',
    '',
    "This task's branch was inherited from a superseded task (`mars task add --supersede`), " +
      'and the branch is currently tipped by an orchestrator-authored salvage checkpoint commit ' +
      `(subject starts with \`${SALVAGE_CHECKPOINT_SUBJECT_PREFIX}\`) — not a finished diff. It was ` +
      'auto-committed when a prior coder was killed mid-run with uncommitted changes. Do not treat it ' +
      'as done work, and do not just leave another checkpoint on top of it:',
    '',
    '1. Inspect it first — `git log -p -1` for what was salvaged, `git log --oneline` for the full history.',
    '2. Finish the real work and land it as a genuine commit as early as you can. The merge step refuses ' +
      'to fast-forward a branch whose tip is still a raw checkpoint commit.',
    '3. Commit in small increments as you go, so a genuine commit is always the most recent one on the branch.',
    '4. If you are running low on context before finishing, commit what you have and file a ' +
      `\`mars task add --blocked-by ${taskId}\` follow-up rather than leaving the tip as an unfinished checkpoint.`,
  ].join('\n')

/**
 * True when at least one commit in `base..tip` is NOT an orchestrator-authored
 * salvage checkpoint — i.e. some coder attempt landed real, reviewed work on
 * this branch, even if a LATER attempt subsequently died leaving a checkpoint
 * back at the tip. `base` is typically `merge-base(branch, integrationBranch)`,
 * so the range covers every commit any coder has ever made on the branch,
 * across every `--supersede` inheritance.
 *
 * Used at merge time (alongside {@link isSalvageCheckpointCommit}) to
 * distinguish two shapes of "tip is a checkpoint" that call for different
 * responses:
 *
 *  - `true` (real commit exists below the tip): a coder made genuine progress
 *    and a later attempt still died mid-run — worth an operator's attention
 *    (`mars continue` to finish it, or `mars task add --supersede` to hand it
 *    to a fresh coder).
 *  - `false` (every commit above `base` is itself a checkpoint): no coder has
 *    EVER landed real work on this branch, including through any supersede
 *    chain — continuing to poke the same worktree is unlikely to help; the
 *    task itself likely needs to be split or restarted from scratch.
 *
 * Fails open to `true` (assume real progress exists) on any git error. That
 * keeps an unanswerable case in the existing, more conservative "genuine
 * defect" bucket rather than silently reclassifying it into the machine-
 * decided "no progress" bucket on an inability to check.
 */
export const hasRealCommitAboveBase = async (
  cwd: string,
  base: string,
  tip: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  const git = resolveGitBin()
  try {
    const result = await execProbe(git, ['rev-list', `${base}..${tip}`], { cwd }, traceCtx)
    if (result.exitCode !== 0) return true
    const shas = result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const sha of shas) {
      if (!(await isSalvageCheckpointCommit(cwd, sha, traceCtx))) return true
    }
    return false
  } catch {
    return true
  }
}

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
        { cwd, env: { ...process.env, ...CHECKPOINT_IDENTITY } as Record<string, string> },
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

export interface AnchorBranchTipArgs {
  /** Worktree whose current branch tip should be anchored. */
  worktreePath: string
  /**
   * Namespacing key. The tip's short sha is appended automatically so a
   * caller that anchors the same branch more than once (e.g. two degraded
   * `step done` calls in a row) parks each tip under its own ref instead of
   * clobbering the previous one — same convention as {@link parkedRefFor} in
   * `worktree.ts`.
   */
  key: string
  traceCtx?: TraceCtx
}

export interface AnchorBranchTipResult {
  /** Ref anchoring the tip. Never garbage-collected while it exists. */
  ref: string
  /** The branch tip's sha at the moment it was anchored. */
  sha: string
}

/**
 * Anchor a worktree's CURRENT branch tip on a per-task ref, without touching
 * the branch, the working tree, or any uncommitted changes.
 *
 * Unlike {@link captureCheckpoint} — which snapshots uncommitted changes into
 * a brand-new commit object — this names the branch's existing HEAD commit
 * directly with a single idempotent `git update-ref`. It is a pure safety
 * net: on the common path nothing ever reads the ref back; it only matters if
 * something downstream unexpectedly resets the branch.
 *
 * Returns `null` (rather than throwing) when `HEAD` cannot be resolved (e.g.
 * an unborn branch) — callers treat that as "nothing to anchor" and proceed.
 */
export const anchorBranchTip = async (
  args: AnchorBranchTipArgs,
): Promise<AnchorBranchTipResult | null> => {
  const { worktreePath, key, traceCtx } = args
  const git = resolveGitBin()
  const head = await execProbe(git, ['rev-parse', 'HEAD'], { cwd: worktreePath }, traceCtx)
  if (head.exitCode !== 0) return null
  const sha = head.stdout.trim()
  if (sha.length === 0) return null
  const ref = checkpointRefFor(`${key}-${sha.slice(0, 9)}`)
  await exec(git, ['update-ref', ref, sha], { cwd: worktreePath }, traceCtx)
  return { ref, sha }
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

/**
 * Cadence for {@link startPeriodicCheckpoint} below. Three minutes balances
 * "durable soon enough that a hard kill loses little" against "don't shell
 * out to `git` every few seconds for every in-flight coder". Override via
 * `MARS_CODE_CHECKPOINT_INTERVAL_MS` (used by tests and available for a
 * tighter recovery SLA in production).
 */
const DEFAULT_CODE_CHECKPOINT_INTERVAL_MS = 3 * 60 * 1000

export interface PeriodicCheckpointArgs {
  /** Working tree to snapshot on a cadence. May be the primary checkout or
   *  any worktree. */
  cwd: string
  /** Namespacing key — same rules as {@link captureCheckpoint}'s `key`. */
  key: string
  /**
   * Commit message prefix. A 1-based tick counter is appended (`"<prefix>
   * #3"`) so successive snapshots are distinguishable in `git log --all` /
   * `git reflog` on the checkpoint ref.
   */
  messagePrefix: string
  /**
   * Cadence in ms. Defaults to `MARS_CODE_CHECKPOINT_INTERVAL_MS` or
   * {@link DEFAULT_CODE_CHECKPOINT_INTERVAL_MS}.
   */
  intervalMs?: number
  traceCtx?: TraceCtx
  /**
   * Fired after each successful (non-null) capture. Best-effort — a throw
   * here is swallowed, same as a capture failure, so a broken listener can
   * never take down the run the checkpoint is protecting.
   */
  onCheckpoint?: (checkpoint: Checkpoint) => void
  /**
   * Fired when a capture attempt throws. Best-effort telemetry hook — a
   * periodic checkpoint is a safety net and must never interrupt or fail
   * the work it is protecting, so the error is reported here rather than
   * thrown.
   */
  onError?: (err: unknown) => void
}

export interface PeriodicCheckpointHandle {
  /**
   * Stop the timer and await any in-flight capture before resolving, so a
   * caller that immediately proceeds to read or commit the same worktree
   * (e.g. the coder-exit classifier) never races a checkpoint that is still
   * mid-write to its temporary index.
   */
  stop: () => Promise<void>
}

/**
 * Snapshot `cwd`'s uncommitted state on a fixed cadence via
 * {@link captureCheckpoint}, independent of whether or how the process
 * producing that work eventually exits.
 *
 * Why this exists: a coder subprocess that is hard-killed (watchdog
 * timeout, context exhaustion, OOM) never reaches any exit-time recovery
 * hook — the only work that survives a kill like that is whatever was
 * already committed. Observed on 2026-08-20: three `code:context-exhausted`
 * failures in a row each left 100+ uncommitted lines with zero commits
 * ahead, recoverable only because an operator happened to inspect the
 * worktree by hand before picking a recovery verb. A periodic checkpoint
 * makes that recovery automatic and operator-free: work lands on
 * `refs/mars/checkpoint/<key>` as it is produced, not only after (and if)
 * the process that produced it gets a chance to react to its own death.
 *
 * Never touches the working tree, the index, or the branch — identical
 * capture semantics to a single {@link captureCheckpoint} call, just on a
 * timer. Overlapping ticks are serialized (a slow capture plus a fast timer
 * never runs two `git` invocations against the same `cwd` concurrently), a
 * capture that throws is swallowed via `onError`, and a tree that hasn't
 * changed since the last tick is a silent no-op (`captureCheckpoint`
 * returns `null`) — so a coder that commits its own work on a normal
 * cadence never gets a duplicate or conflicting checkpoint commit appended
 * on top of it.
 */
export const startPeriodicCheckpoint = (
  args: PeriodicCheckpointArgs,
): PeriodicCheckpointHandle => {
  const { cwd, key, messagePrefix, traceCtx, onCheckpoint, onError } = args
  const intervalMs =
    args.intervalMs ??
    Number(process.env.MARS_CODE_CHECKPOINT_INTERVAL_MS ?? DEFAULT_CODE_CHECKPOINT_INTERVAL_MS)

  let stopped = false
  let tick = 0
  // Chain every capture attempt onto whatever is already in flight so a slow
  // capture and the next timer firing never run `git` against the same `cwd`
  // concurrently.
  let inFlight: Promise<void> = Promise.resolve()

  const captureTick = (): void => {
    inFlight = inFlight.then(async () => {
      if (stopped) return
      tick += 1
      try {
        const checkpoint = await captureCheckpoint({
          cwd,
          key,
          message: `${messagePrefix} #${tick}`,
          traceCtx,
        })
        if (checkpoint) onCheckpoint?.(checkpoint)
      } catch (err) {
        onError?.(err)
      }
    })
  }

  const timer = setInterval(captureTick, intervalMs)
  // A periodic checkpoint must never be the reason a workflow step's process
  // hangs at exit — it rides alongside the coder as a safety net, not a
  // reason to keep the event loop alive on its own.
  timer.unref?.()

  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}
