/**
 * VCS Port — version-control operations (worktree, branch, commit, merge,
 * status) for a task, abstracted behind a swappable implementation
 * (ADR-0097 "Every seam is a cordis service Port with serializable
 * contracts").
 *
 * Every argument and result here is plain, JSON-serializable data — no
 * class instances, no functions, no `AbortSignal`, nothing that can't cross
 * a process boundary — so a future out-of-process implementation (e.g. a
 * remote git-hosting service) is a drop-in registration, not a redesign.
 *
 * One implementation exists today (see `registry.ts`):
 *   - `local-git` — the default; wraps the existing worktree/merge/commit
 *     helpers in `../../lib/git/`. Nothing changes operationally.
 *
 * The active implementation is selected by `MARS_VCS_KIND`
 * (see `../../config/registry.ts`'s `vcs` Port entry).
 *
 * Scope note: this interface covers every operation category the acceptance
 * criteria name — worktree, branch, commit, merge, status — with the
 * thinnest serializable shape that satisfies them. It deliberately narrows
 * the richer, non-serializable options the underlying `../../lib/git/*`
 * helpers accept (callbacks, `AbortSignal`, trace context) rather than
 * carrying them through, per ADR-0097's serializability rule. The dropped
 * trace context is a known, open consequence tracked in proposal `99caef46`.
 *
 * Caller adoption: the daemon, the implement pipeline's setup and merge
 * steps, and the CLI all resolve git through `resolveVcs()`. A handful of
 * direct `../../lib/git/*` imports remain — notably `captureCheckpoint`,
 * `discardWorkingTreeChanges`, and `mergeBranch` — all of which the port
 * itself declares; the HR-9/DEC-13 tension is resolved (bounded Reading B,
 * VISION.md Append 2): the port stays, HR-9 and DEC-13 are amended.
 * Migration of the remaining direct callers is deferred and tracked
 * separately from the port itself.
 */

/** Args for {@link Vcs.createWorktree}. */
export interface WorktreeSpec {
  taskId: string
  integrationBranch: string
  /** Base commit to branch from. Defaults to `integrationBranch`'s tip. */
  baseSha?: string
  /** Suffix appended to the branch/directory name, e.g. `task/<id>-<suffix>`. */
  branchSuffix?: string
}

/** Result of {@link Vcs.createWorktree}. */
export interface WorktreeResult {
  path: string
  branch: string
}

/**
 * Explanation written alongside a removed worktree so anyone who later finds
 * the directory gone can tell which task it was and why — see
 * `../../lib/git/worktree.ts`'s `WorktreeRemovalTombstone` doc comment.
 */
export interface WorktreeRemovalTombstone {
  taskId: string
  /** Why the worktree was removed, e.g. `'merged'`, `'diagnose'`. */
  reason: string
  /** The integration-branch SHA the task's work landed as, when known. */
  mergeCommitSha?: string | null
}

/** Args for {@link Vcs.removeWorktree}. */
export interface RemoveWorktreeSpec {
  path: string
  branch: string
  /** Passes `--force` to `git worktree remove`. Defaults to `true`. */
  force?: boolean
  /** Skip deleting the branch after the worktree is removed. Defaults to `false`. */
  keepBranch?: boolean
  /** When provided, a tombstone file is written before the directory is removed. */
  tombstone?: WorktreeRemovalTombstone
}

/** Args for {@link Vcs.branchExists}. */
export interface BranchExistsSpec {
  branch: string
}

/** Args for {@link Vcs.commit}. */
export interface CommitSpec {
  /** Absolute path to the worktree the commit runs in. */
  cwd: string
  message: string
  /**
   * When provided, the implementation enforces that HEAD is on
   * `task/<taskId>` before staging anything — see `commitMain`'s branch
   * guard in `../../lib/git/commit-main.ts`.
   */
  taskId?: string
}

/** Result of {@link Vcs.commit}. */
export interface CommitResult {
  sha: string
}

/** Args for {@link Vcs.merge}. */
export interface MergeSpec {
  branch: string
  worktreePath: string
  integrationBranch: string
  lockTimeoutMs: number
  /** Overrides the default watchdog budget (ms). */
  watchdogMs?: number
}

/** Result of {@link Vcs.merge}. */
export interface MergeResult {
  merged: boolean
  conflictResolved: boolean
  aborted: boolean
  output: string
  /** Number of times the rebase+fast-forward was retried due to a concurrent integration advance. */
  retriesAttempted: number
  /** Claude session id from a vcs-supervisor (Vega) run, or `null` when none was invoked. */
  vegaSessionId: string | null
}

/** Args for {@link Vcs.status}. */
export interface StatusSpec {
  cwd: string
  /**
   * When `'all'`, passes `--untracked-files=all` so a wholly-new directory is
   * reported file-by-file instead of collapsed to a single `dir/` entry.
   * Omit for the default (collapsed) porcelain behaviour.
   */
  untrackedFiles?: 'all'
}

/** Result of {@link Vcs.status}. */
export interface VcsStatus {
  /** True when `git status --porcelain` reported nothing. */
  clean: boolean
  statusOutput: string
  /**
   * Paths from `statusOutput` classified via `classifyPorcelainLines`
   * (`../../lib/git/classify-porcelain.ts`): paths beginning with `.mars/`
   * are orchestrator-owned artifacts, safe to auto-stash; everything else is
   * user-owned and requires operator attention.
   */
  orchestratorOwned: string[]
  userOwned: string[]
}

/** Args for {@link Vcs.captureCheckpoint}. */
export interface VcsCaptureCheckpointSpec {
  /** Working tree to capture. May be the primary checkout or any worktree. */
  cwd: string
  /** Fully-qualified ref the resulting commit object is anchored under. */
  ref: string
  /** Commit message stored on the checkpoint object. */
  message: string
  /**
   * Repo-relative file paths to exclude from the checkpoint even if they are
   * not gitignored. Set by `checkpoint.ts` after filtering the working-tree
   * status through `checkSecretPath` — this is the belt to `.gitignore`'s
   * braces: a `.gitignore` can be edited away, but the checkpoint must
   * never capture per-repo state (`.mars/`), dependency dirs
   * (`node_modules/`), or build output (`dist/`, `coverage/`).
   *
   * The implementation removes these paths from the temporary staging index
   * with `git rm --cached --ignore-unmatch` AFTER `git add -A`, so the
   * predicate operates independently of `.gitignore` rules.
   *
   * Optional — when absent or empty, no paths are excluded beyond what
   * `.gitignore` already covers.
   */
  excludePaths?: string[]
}

/**
 * A checkpoint commit captured by {@link Vcs.captureCheckpoint} — the
 * orchestrator's replacement for a `git stash` entry (see
 * `../../lib/git/checkpoint.ts` for the full rationale).
 */
export interface VcsCheckpoint {
  /** Ref anchoring the commit object (keeps it from being GC'd). */
  ref: string
  /** The checkpoint commit's sha. Restores name this, never a stack position. */
  sha: string
  /** Paths the checkpoint captured. */
  files: string[]
}

/** Args for {@link Vcs.restoreCheckpoint}. */
export interface VcsRestoreCheckpointSpec {
  /** Working tree the checkpoint is applied into. Must be clean. */
  cwd: string
  /** The checkpoint commit's sha (see {@link VcsCheckpoint.sha}). */
  sha: string
}

/** Result of {@link Vcs.restoreCheckpoint}. */
export interface VcsRestoreCheckpointResult {
  ok: boolean
  /** Populated when `ok` is `false` — human-readable failure detail. */
  detail?: string
}

/** Args for {@link Vcs.discardWorkingTreeChanges}. */
export interface VcsDiscardChangesSpec {
  /** Working tree to reset. */
  cwd: string
}

/** Args for {@link Vcs.revParse}. */
export interface VcsRevParseSpec {
  cwd: string
  /** Any revision expression `git rev-parse` accepts, e.g. `"HEAD"`. */
  rev: string
  /** Optional hard timeout (ms) for the underlying git invocation. */
  timeoutMs?: number
}

/** Args for {@link Vcs.currentBranch}. */
export interface VcsCurrentBranchSpec {
  cwd: string
}

/** Args for {@link Vcs.repoRoot}. */
export interface VcsRepoRootSpec {
  /** Any directory inside the repository (or worktree) to resolve from. */
  cwd: string
}

/** Args for {@link Vcs.gitPath}. */
export interface VcsGitPathSpec {
  cwd: string
  /** The `git rev-parse --git-path <name>` argument, e.g. `"rebase-merge"`. */
  name: string
}

/** Args for {@link Vcs.revListCount}. */
export interface VcsRevListCountSpec {
  cwd: string
  /** A `git rev-list --count` range expression, e.g. `"<base>..<tip>"`. */
  range: string
  timeoutMs?: number
}

/** Args for {@link Vcs.diffText}. */
export interface VcsDiffTextSpec {
  cwd: string
  from: string
  to: string
  timeoutMs?: number
}

/** Args for {@link Vcs.pathsChangedInRange}. */
export interface VcsPathsChangedInRangeSpec {
  cwd: string
  /** A `git diff` range expression, e.g. `"<from>..<to>"`. */
  range: string
  /** Pathspecs passed after `--`. */
  paths: string[]
}

/** Args for {@link Vcs.workingTreeMatches}. */
export interface VcsWorkingTreeMatchesSpec {
  cwd: string
  rev: string
}

/** Args for {@link Vcs.recentShas}. */
export interface VcsRecentShasSpec {
  cwd: string
  rev: string
  count: number
}

/** Args for {@link Vcs.deleteBranch}. */
export interface VcsDeleteBranchSpec {
  cwd: string
  branch: string
}

/** Args for {@link Vcs.updateRef}. */
export interface VcsUpdateRefSpec {
  cwd: string
  /** Fully-qualified ref to update, e.g. `"refs/mars/checkpoint/<key>"`. */
  ref: string
  sha: string
}

/** Args for {@link Vcs.hasCommitTrailer}. */
export interface VcsHasCommitTrailerSpec {
  cwd: string
  sha: string
  trailerKey: string
  trailerValue: string
}

/** Args for {@link Vcs.revListRange}. */
export interface VcsRevListRangeSpec {
  cwd: string
  /** A `git rev-list` range expression, e.g. `"<base>..<tip>"`. */
  range: string
}

/** Args for {@link Vcs.attachToOriginWorktree}. */
export interface AttachToOriginWorktreeSpec {
  /** The origin (recovered) task's id — used only for diagnostics. */
  originTaskId: string
  /** The origin task's branch, as recorded on its row (`task/<origin-id>`). */
  originBranch: string
  /** The origin task's worktree path, as recorded on its row. */
  originWorktreePath: string
}

/** Args for {@link Vcs.provisionCommitterWorktree}. */
export interface CommitterWorktreeSpec {
  /** Recovery task id used for path + branch naming. */
  recoveryTaskId: string
  integrationBranch: string
}

/**
 * What to do when replaying a task branch onto the integration tip conflicts.
 * See `../../lib/git/worktree.ts`'s `WorktreeConflictPolicy` doc comment for
 * the full reasoning behind each value; re-declared here (rather than
 * imported) to keep this module's types self-contained and serializable.
 */
export type WorktreeConflictPolicy = 'escalate' | 'recreate' | 'reconcile'

/** Args for {@link Vcs.syncWorktreeToIntegration}. */
export interface SyncWorktreeSpec {
  taskId: string
  ref: WorktreeResult
  integrationBranch: string
  /** Conflict policy. Defaults to `'escalate'` — the caller opts into recreate/reconcile. */
  onConflict?: WorktreeConflictPolicy
}

/** A single commit parked off a recreated branch — `<shortSha> <subject>`. */
export interface ParkedCommit {
  shortSha: string
  subject: string
}

/** Result of {@link Vcs.syncWorktreeToIntegration}. */
export type WorktreeSyncOutcome =
  | { kind: 'already-current' }
  | {
      kind: 'rebased'
      from: string
      to: string
      checkpointRef: string | null
    }
  | {
      kind: 'reconciled'
      from: string
      to: string
      checkpointRef: string | null
      vegaSessionId: string | null
    }
  | {
      kind: 'recreated'
      from: string
      to: string
      parkedRef: string
      parkedCommits: ParkedCommit[]
      checkpointRef: string | null
    }

/** Args for {@link Vcs.restoreWorktreeIfMissing}. */
export interface RestoreWorktreeSpec {
  taskId: string
  ref: WorktreeResult
}

/** Result of {@link Vcs.restoreWorktreeIfMissing}. */
export type RestoreWorktreeOutcome = 'present' | 'rebuilt'

/** Args for {@link Vcs.describeUncommittedWork}. */
export interface DescribeUncommittedWorkSpec {
  verb: 'restart' | 'drop'
  taskId: string
  worktreePath: string | null | undefined
}

/** A single commit as reported by {@link Vcs.commitsInRange} / {@link Vcs.searchCommits}. */
export interface VcsCommitSummary {
  /** Abbreviated when the request asked for it, full-length otherwise. */
  sha: string
  /** The commit's subject line (`%s`). */
  subject: string
}

/** Args for {@link Vcs.commitsInRange}. */
export interface VcsCommitsInRangeSpec {
  cwd: string
  /** A `git log` range expression, e.g. `"<base>..HEAD"`. */
  range: string
  /** Report abbreviated shas (`%h`) instead of full ones (`%H`). */
  abbrev?: boolean
}

/** Args for {@link Vcs.searchCommits}. */
export interface VcsSearchCommitsSpec {
  cwd: string
  /** Revision to walk, e.g. an integration branch name. */
  rev: string
  /** Literal substring to match against commit messages (`--grep` + `--fixed-strings`). */
  grep: string
  /** Cap on the number of commits returned (`-n`). Unbounded when omitted. */
  limit?: number
}

/** Args for {@link Vcs.changedFiles}. */
export interface VcsChangedFilesSpec {
  cwd: string
  /** A `git diff` range expression, e.g. `"<base>...HEAD"`. */
  range: string
}

/** Args for {@link Vcs.fetch}. */
export interface VcsFetchSpec {
  cwd: string
  remote: string
  /** Single refspec to fetch. Fetches the remote's default set when omitted. */
  branch?: string
}

/** Args for {@link Vcs.resetHard}. */
export interface VcsResetHardSpec {
  cwd: string
  /** Revision to reset onto, e.g. an integration branch name. */
  rev: string
}

/** Args for {@link Vcs.isAncestor}. */
export interface VcsIsAncestorSpec {
  cwd: string
  ancestor: string
  descendant: string
}

/** Args for {@link Vcs.autoCommitOperatorDirt}. */
export interface VcsAutoCommitOperatorDirtSpec {
  /** Repo root where the integration branch is checked out (NOT a worktree). */
  repoRoot: string
  /** Task whose merge the auto-commit is unblocking — named in the message. */
  taskId: string
  /**
   * The sha whose tree the checkout's content is based on: the recorded
   * last-synced sha when there is one, else the pre-merge integration sha.
   */
  baseSha: string
  /** The just-merged tip `refs/heads/<integrationBranch>` now points at. */
  headSha: string
}

/** Result of {@link Vcs.autoCommitOperatorDirt}. */
export type VcsAutoCommitOperatorDirtResult =
  | { committed: true; sha: string; files: string[] }
  | { committed: false; reason: string }

/** Args for {@link Vcs.addWorktreeForBranch}. */
export interface VcsAddWorktreeForBranchSpec {
  /** Directory the `git worktree add` runs from — any path inside the repo. */
  cwd: string
  /** Absolute path the new worktree is created at. */
  path: string
  /** Existing branch to check out into it. */
  branch: string
}

/**
 * The VCS Port contract. Every method is async and every arg/result is
 * serializable — see the module doc comment above.
 */
export interface Vcs {
  /** Stable identifier of this implementation (matches its registry.ts `kind`). */
  readonly kind: string
  /** Create (or reuse, when already registered and intact) a task worktree. */
  createWorktree(spec: WorktreeSpec): Promise<WorktreeResult>
  /** Remove a worktree and, unless `keepBranch`, its branch. */
  removeWorktree(spec: RemoveWorktreeSpec): Promise<void>
  /** True when `spec.branch` exists locally. */
  branchExists(spec: BranchExistsSpec): Promise<boolean>
  /** Stage every change and commit in `spec.cwd`. */
  commit(spec: CommitSpec): Promise<CommitResult>
  /** Rebase `spec.branch` onto `spec.integrationBranch` and fast-forward. */
  merge(spec: MergeSpec): Promise<MergeResult>
  /** Report whether `spec.cwd` has a clean tracked working tree. */
  status(spec: StatusSpec): Promise<VcsStatus>
  /** Attach a recovery (kind=fix) dispatch to its origin task's existing worktree+branch. */
  attachToOriginWorktree(spec: AttachToOriginWorktreeSpec): Promise<WorktreeResult>
  /** Provision the worktree a main-commiter recovery runs inside. */
  provisionCommitterWorktree(spec: CommitterWorktreeSpec): Promise<WorktreeResult>
  /** Guarantee a task's worktree contains the current integration tip. */
  syncWorktreeToIntegration(spec: SyncWorktreeSpec): Promise<WorktreeSyncOutcome>
  /** Guarantee a resumed run's worktree directory actually exists on disk. */
  restoreWorktreeIfMissing(spec: RestoreWorktreeSpec): Promise<RestoreWorktreeOutcome>
  /** List uncommitted paths in a worktree, or `null` when unknown (missing/not-a-worktree). */
  listUncommittedPaths(worktreePath: string | null | undefined): Promise<string[] | null>
  /** Build the refusal message for a destructive verb, or `null` when nothing would be lost. */
  describeUncommittedWork(spec: DescribeUncommittedWorkSpec): Promise<string | null>
  /**
   * Capture `spec.cwd`'s uncommitted state as a commit object anchored under
   * `spec.ref`, without touching the working tree. Returns `null` when there
   * is nothing to capture (the tree matches HEAD once ignored files are
   * discounted).
   */
  captureCheckpoint(spec: VcsCaptureCheckpointSpec): Promise<VcsCheckpoint | null>
  /** Apply the checkpoint commit `spec.sha` onto `spec.cwd` via a three-way cherry-pick. */
  restoreCheckpoint(spec: VcsRestoreCheckpointSpec): Promise<VcsRestoreCheckpointResult>
  /**
   * Drop every uncommitted change in `spec.cwd` (hard-reset tracked paths,
   * clean untracked ones). Ignored files are left alone.
   */
  discardWorkingTreeChanges(spec: VcsDiscardChangesSpec): Promise<void>
  /** Resolve `spec.rev` in `spec.cwd`. Returns `null` when it cannot be resolved. */
  revParse(spec: VcsRevParseSpec): Promise<string | null>
  /** Point `spec.ref` at `spec.sha`. */
  updateRef(spec: VcsUpdateRefSpec): Promise<void>
  /** True when commit `spec.sha` carries a `spec.trailerKey: spec.trailerValue` trailer. Fails open to `false`. */
  hasCommitTrailer(spec: VcsHasCommitTrailerSpec): Promise<boolean>
  /**
   * List commit shas in `spec.range`. Returns `null` on failure — callers
   * that treat an unanswerable check as "assume real progress exists"
   * pass the `null` straight through.
   */
  revListRange(spec: VcsRevListRangeSpec): Promise<string[] | null>
  /** Throws with the standard "git binary not found on PATH" message when no git binary can be resolved. */
  ensureAvailable(): Promise<void>
  /** Current branch name for `spec.cwd` (`rev-parse --abbrev-ref HEAD`). Returns `null` when unresolvable (e.g. detached HEAD reports `"HEAD"`, an error returns `null`). */
  currentBranch(spec: VcsCurrentBranchSpec): Promise<string | null>
  /** Top-level directory of the repository containing `spec.cwd` (`rev-parse --show-toplevel`). Returns `null` when `spec.cwd` is not inside a repository. */
  repoRoot(spec: VcsRepoRootSpec): Promise<string | null>
  /** Resolve a `.git`-relative admin path (`rev-parse --git-path <name>`), absolute even inside a linked worktree. */
  gitPath(spec: VcsGitPathSpec): Promise<string>
  /** Count commits in `spec.range` (`rev-list --count`). Returns `null` on failure or a non-numeric result. */
  revListCount(spec: VcsRevListCountSpec): Promise<number | null>
  /** Full diff text between two revisions (`diff --no-color`). Returns `null` on failure. */
  diffText(spec: VcsDiffTextSpec): Promise<string | null>
  /** True when any of `spec.paths` differ across `spec.range` (`diff --quiet <range> -- <paths>`, exit code 1). */
  pathsChangedInRange(spec: VcsPathsChangedInRangeSpec): Promise<boolean>
  /** True when `spec.cwd`'s working tree (index included) is byte-identical to `spec.rev` (`diff --quiet <rev>`, exit code 0). */
  workingTreeMatches(spec: VcsWorkingTreeMatchesSpec): Promise<boolean>
  /** Up to `spec.count` commit shas starting at `spec.rev`, newest first (`log --format=%H -n <count> <rev>`). */
  recentShas(spec: VcsRecentShasSpec): Promise<string[]>
  /** Force-delete a local branch (`branch -D`). Throws on failure — callers that treat deletion as best-effort catch it themselves. */
  deleteBranch(spec: VcsDeleteBranchSpec): Promise<void>
  /** Commits in `spec.range`, newest first (`log --format=%H %s`). Returns `[]` on failure. */
  commitsInRange(spec: VcsCommitsInRangeSpec): Promise<VcsCommitSummary[]>
  /** Commits reachable from `spec.rev` whose message contains `spec.grep` literally. Returns `[]` on failure. */
  searchCommits(spec: VcsSearchCommitsSpec): Promise<VcsCommitSummary[]>
  /** Paths that differ across `spec.range` (`diff --name-only`). Returns `[]` on failure. */
  changedFiles(spec: VcsChangedFilesSpec): Promise<string[]>
  /** Fetch from a remote. Throws on failure — callers that treat the network as optional catch it themselves. */
  fetch(spec: VcsFetchSpec): Promise<void>
  /** Hard-reset `spec.cwd` onto `spec.rev` (`reset --hard`). Throws on failure. */
  resetHard(spec: VcsResetHardSpec): Promise<void>
  /** True when `spec.ancestor` is an ancestor of `spec.descendant` (`merge-base --is-ancestor`). */
  isAncestor(spec: VcsIsAncestorSpec): Promise<boolean>
  /** Check an existing branch out into a new worktree (`worktree add <path> <branch>`). Throws on failure. */
  addWorktreeForBranch(spec: VcsAddWorktreeForBranchSpec): Promise<void>
  /**
   * Commit the operator's uncommitted tracked changes on the integration
   * checkout as a single `wip(operator): …` commit. Returns
   * `{committed: false, reason}` rather than throwing on any git failure —
   * including the benign "nothing to commit" case — so callers can fall back
   * to checkpoint-and-park handling instead of treating non-success as fatal.
   */
  autoCommitOperatorDirt(spec: VcsAutoCommitOperatorDirtSpec): Promise<VcsAutoCommitOperatorDirtResult>
}
