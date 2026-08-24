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
 * Scope note (tracer-bullet slice, PRD ae17340a slice 36): this interface
 * covers every operation category the acceptance criteria name — worktree,
 * branch, commit, merge, status — with the thinnest serializable shape that
 * satisfies them. It deliberately narrows the richer, non-serializable
 * options the underlying `../../lib/git/*` helpers accept (callbacks,
 * `AbortSignal`, trace context) rather than carrying them through; wiring
 * existing callers onto this Port is left to a later slice.
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

/** Args for {@link Vcs.removeWorktree}. */
export interface RemoveWorktreeSpec {
  path: string
  branch: string
  /** Passes `--force` to `git worktree remove`. Defaults to `true`. */
  force?: boolean
  /** Skip deleting the branch after the worktree is removed. Defaults to `false`. */
  keepBranch?: boolean
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
}

/** Result of {@link Vcs.status}. */
export interface VcsStatus {
  /** True when `git status --porcelain` reported nothing. */
  clean: boolean
  statusOutput: string
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
}
