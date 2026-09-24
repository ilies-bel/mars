import type { TraceEventPhase } from '../../lib/trace-events-store'
import type { AgentEvent } from '../../lib/claude-stream'

/**
 * Serializable identity fragment that Vcs specs carry so the local-git
 * implementation can reconstruct a full `TraceCtx` from the process-scoped
 * ambient store. Only the plain, JSON-serializable pieces live here — the
 * `TraceEventStore` reference is supplied separately by the ambient registry
 * (`./ambient-trace-store`), keeping specs wire-safe (ADR-0097).
 */
export interface TraceIdentity {
  taskId?: string | null
  originId?: string | null
  phase?: TraceEventPhase | null
}

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
 * carrying them through, per ADR-0097's serializability rule.
 * {@link TraceIdentity} is the serializable trace-context carrier: every
 * spec type whose corresponding local-git method shells out through
 * `exec`/`execProbe` or a `lib/git` helper accepting `traceCtx` carries an
 * optional `trace?: TraceIdentity` field, so trace attribution survives the
 * serialization boundary without pulling in the non-serializable
 * `TraceEventStore`.
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
  /** Optional trace identity. When provided alongside the ambient store, a full
   *  TraceCtx is reconstructed and forwarded to the underlying lib helper. */
  trace?: TraceIdentity
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
  /** Optional trace identity forwarded to the underlying lib helper. */
  trace?: TraceIdentity
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
  /** Optional trace identity forwarded to the underlying lib helper. */
  trace?: TraceIdentity
}

/** Result of {@link Vcs.commit}. */
export interface CommitResult {
  sha: string
}

/**
 * Gate check outcome — passed back from {@link MergeSpec.onVerifyRebasedTree}
 * and {@link MergeSpec.onProbeIntegrationAfterAutoCommit}.
 *
 * Re-declared here (rather than imported from `lib/git/merge`) to avoid a
 * circular dependency: `lib/git/merge.ts` imports {@link MergeAbortedError}
 * from this module, so importing back from `merge.ts` would form a cycle.
 * The two declarations are structurally identical; TypeScript's structural
 * typing keeps them assignable to each other.
 */
export type MergeGateOutcome = { passed: true } | { passed: false; output: string }

/**
 * Payload delivered to {@link MergeSpec.onOperatorAutoCommit}.
 *
 * Re-declared here for the same circular-dependency reason as
 * {@link MergeGateOutcome}. Mirrors `OperatorAutoCommitInfo` in
 * `lib/git/merge.ts`.
 */
export interface MergeOperatorAutoCommitInfo {
  /** SHA of the `wip(operator)` commit just created on the integration branch. */
  commitSha: string
  /** Tracked paths swept into that commit, in `git status --porcelain` order. */
  files: string[]
  /** Post-auto-commit typecheck probe outcome, or `null` when no probe was supplied. */
  probe: MergeGateOutcome | null
}

/** Args for {@link Vcs.merge}. */
export interface MergeSpec {
  branch: string
  worktreePath: string
  integrationBranch: string
  lockTimeoutMs: number
  /** Overrides the default watchdog budget (ms). */
  watchdogMs?: number
  /** Optional trace identity forwarded to the underlying lib helper. */
  trace?: TraceIdentity

  // -------------------------------------------------------------------------
  // Non-serializable extras for the in-process `local-git` adapter.
  //
  // These fields carry function types and `AbortSignal` — they cannot survive
  // a JSON serialization boundary. They are present here because the
  // `local-git` adapter is an in-process call with no serialization seam, so
  // the port CAN carry them. Any future remote adapter must silently ignore
  // them (they will be `undefined` after a JSON round-trip).
  //
  // The serializable-payload constraint belongs to the *job queue* (the
  // `merge-worker.ts` → merge job store seam), not to this port. Conflating
  // the two seams is what caused the gate regression fixed in mars-82a0b56f:
  // 164 merges landed on `main` with no verify gate running because these
  // callbacks were not forwarded through the Vcs port.
  // -------------------------------------------------------------------------

  /** Caller-supplied cancellation signal. When aborted, the in-flight merge is cancelled. */
  signal?: AbortSignal
  /**
   * Task-tier gate run on the rebased task tree, outside the merge lock.
   * Returning `{ passed: false }` ends the merge without fast-forwarding.
   */
  onVerifyRebasedTree?: (info: {
    baseSha: string
    taskSha: string
    attempt: number
  }) => Promise<MergeGateOutcome>
  /**
   * Integration-tier gate run inside the merge lock after the fast-forward.
   * A throw reverts the fast-forward.
   */
  onAfterFastForward?: (info: {
    finalTaskSha: string
    finalIntegrationSha: string
  }) => Promise<void>
  /** VCS supervisor event sink. */
  onSupervisorEvent?: (event: AgentEvent) => void | Promise<void>
  /**
   * When `true`, genuine operator dirt on the integration checkout is swept
   * into a `wip(operator)` commit so the merge can proceed.
   */
  autoCommitOperatorDirt?: boolean
  /** Cheap probe (typecheck) of `main` after an operator auto-commit. */
  onProbeIntegrationAfterAutoCommit?: (info: {
    commitSha: string
  }) => Promise<MergeGateOutcome>
  /** Notification callback fired after an operator auto-commit lands. */
  onOperatorAutoCommit?: (info: MergeOperatorAutoCommitInfo) => void | Promise<void>
  /** Fired just before Vega (the vcs-supervisor) is spawned. */
  onVegaStart?: () => void | Promise<void>
  /**
   * TEST-ONLY hook fired immediately before the CAS `git update-ref`.
   * Never set in production code.
   */
  onBeforeFastForward?: () => void | Promise<void>
  /** Best-effort sub-phase transition callback. */
  onPhase?: (phase: string) => void | Promise<void>
  /** Periodic heartbeat while the merge is in flight. */
  onHeartbeat?: (info: { elapsedMs: number; phase: string; attempt: number }) => void | Promise<void>
}

/**
 * Machine-readable reason for a `merged: false` {@link MergeResult} that is
 * any cause. The lib's `MergeResult` requires it on every negative outcome.
 *
 * Re-declared here (rather than imported from `lib/git/merge`) to keep this
 * module self-contained and serializable per ADR-0097. Consumer slices
 * migrating `merge.ts` callers import this from the port instead.
 */
export type MergeFailureReason =
  | 'rebased-verify-failed'
  | 'integration-gate-failed'
  | 'worktree-dirty-before-rebase'
  | 'rebase-no-in-progress-state'
  | 'vega-timeout'
  | 'vega-outcome-rejected'
  | 'not-fast-forwardable'
  | 'task-branch-moved'
  | 'integration-advanced'

/** Result of {@link Vcs.merge}. */
export interface MergeResult {
  merged: boolean
  conflictResolved: boolean
  aborted: boolean
  output: string
  /**
   * Full conversation from a vcs-supervisor (Vega) run — typed as `unknown[]` to
   * avoid importing `AgentEvent` across the serialization boundary (ADR-0097).
   * An empty array when no supervisor was invoked.
   */
  supervisorConversation?: unknown[]
  /** Number of times the rebase+fast-forward was retried due to a concurrent integration advance. */
  retriesAttempted: number
  /** Claude session id from a vcs-supervisor (Vega) run, or `null` when none was invoked. */
  vegaSessionId: string | null
  /**
   * True when the caller-supplied integration-tier gate (onAfterFastForward)
   * threw — the fast-forward has been reverted; `main` is at the pre-merge SHA.
   */
  integrationGateFailed?: boolean
  /** Failure output from the integration-tier gates when `integrationGateFailed` is true. */
  integrationGateOutput?: string
  /**
   * True when the vcs-supervisor (Vega) session was killed by the per-step
   * wall-clock timeout. `aborted` is also true in this case and any in-progress
   * rebase has been aborted.
   */
  vegaTimedOut?: boolean
  /**
   * Machine-readable reason for a `merged: false` outcome that is not an abort
   * or integration-gate failure. See {@link MergeFailureReason}.
   */
  reason?: MergeFailureReason
  /**
   * Verify output from the rebased-tree check when it rejected the rebased tree.
   * Set exactly when `reason === 'rebased-verify-failed'`.
   */
  rebasedVerifyOutput?: string
  /**
   * The SHA the integration checkout's working tree was synced to by this merge.
   * Absent when the merge did not touch the tree (aborted, no-op, or the
   * primary checkout was not on the integration branch).
   */
  lastSyncedSha?: string
  /**
   * SHA of the `wip(operator)` commit created to sweep genuine operator dirt
   * off the integration checkout, or absent when no auto-commit happened.
   */
  operatorAutoCommitSha?: string
  /**
   * The integration-branch SHA just before the fast-forward (the old tip).
   * Set only on a successful fast-forward merge.
   */
  mergePreSha?: string
  /**
   * The task-branch SHA that was fast-forwarded into `integrationBranch`
   * (the new tip). Set in the same conditions as `mergePreSha`.
   */
  mergePostSha?: string
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
  trace?: TraceIdentity
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
  /** Optional trace identity forwarded to the underlying git invocations. */
  trace?: TraceIdentity
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
  /** Optional trace identity forwarded to the underlying git invocations. */
  trace?: TraceIdentity
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
  trace?: TraceIdentity
}

/** Args for {@link Vcs.revParse}. */
export interface VcsRevParseSpec {
  cwd: string
  /** Any revision expression `git rev-parse` accepts, e.g. `"HEAD"`. */
  rev: string
  /** Optional hard timeout (ms) for the underlying git invocation. */
  timeoutMs?: number
  trace?: TraceIdentity
}

/** Args for {@link Vcs.currentBranch}. */
export interface VcsCurrentBranchSpec {
  cwd: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.repoRoot}. */
export interface VcsRepoRootSpec {
  /** Any directory inside the repository (or worktree) to resolve from. */
  cwd: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.gitPath}. */
export interface VcsGitPathSpec {
  cwd: string
  /** The `git rev-parse --git-path <name>` argument, e.g. `"rebase-merge"`. */
  name: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.revListCount}. */
export interface VcsRevListCountSpec {
  cwd: string
  /** A `git rev-list --count` range expression, e.g. `"<base>..<tip>"`. */
  range: string
  timeoutMs?: number
  trace?: TraceIdentity
}

/** Args for {@link Vcs.diffText}. */
export interface VcsDiffTextSpec {
  cwd: string
  from: string
  to: string
  timeoutMs?: number
  trace?: TraceIdentity
}

/** Args for {@link Vcs.pathsChangedInRange}. */
export interface VcsPathsChangedInRangeSpec {
  cwd: string
  /** A `git diff` range expression, e.g. `"<from>..<to>"`. */
  range: string
  /** Pathspecs passed after `--`. */
  paths: string[]
  trace?: TraceIdentity
}

/** Args for {@link Vcs.workingTreeMatches}. */
export interface VcsWorkingTreeMatchesSpec {
  cwd: string
  rev: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.recentShas}. */
export interface VcsRecentShasSpec {
  cwd: string
  rev: string
  count: number
  trace?: TraceIdentity
}

/** Args for {@link Vcs.deleteBranch}. */
export interface VcsDeleteBranchSpec {
  cwd: string
  branch: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.updateRef}. */
export interface VcsUpdateRefSpec {
  cwd: string
  /** Fully-qualified ref to update, e.g. `"refs/mars/checkpoint/<key>"`. */
  ref: string
  sha: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.hasCommitTrailer}. */
export interface VcsHasCommitTrailerSpec {
  cwd: string
  sha: string
  trailerKey: string
  trailerValue: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.revListRange}. */
export interface VcsRevListRangeSpec {
  cwd: string
  /** A `git rev-list` range expression, e.g. `"<base>..<tip>"`. */
  range: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.attachToOriginWorktree}. */
export interface AttachToOriginWorktreeSpec {
  /** The origin (recovered) task's id — used only for diagnostics. */
  originTaskId: string
  /** The origin task's branch, as recorded on its row (`task/<origin-id>`). */
  originBranch: string
  /** The origin task's worktree path, as recorded on its row. */
  originWorktreePath: string
  /** Optional trace identity forwarded to the underlying lib helper. */
  trace?: TraceIdentity
}

/** Args for {@link Vcs.provisionCommitterWorktree}. */
export interface CommitterWorktreeSpec {
  /** Recovery task id used for path + branch naming. */
  recoveryTaskId: string
  integrationBranch: string
  /** Optional trace identity forwarded to the underlying lib helper. */
  trace?: TraceIdentity
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
  /** Optional trace identity forwarded to the underlying lib helper. */
  trace?: TraceIdentity
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
  /** Optional trace identity forwarded to the underlying lib helper. */
  trace?: TraceIdentity
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
  trace?: TraceIdentity
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
  trace?: TraceIdentity
}

/** Args for {@link Vcs.changedFiles}. */
export interface VcsChangedFilesSpec {
  cwd: string
  /** A `git diff` range expression, e.g. `"<base>...HEAD"`. */
  range: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.fetch}. */
export interface VcsFetchSpec {
  cwd: string
  remote: string
  /** Single refspec to fetch. Fetches the remote's default set when omitted. */
  branch?: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.resetHard}. */
export interface VcsResetHardSpec {
  cwd: string
  /** Revision to reset onto, e.g. an integration branch name. */
  rev: string
  trace?: TraceIdentity
}

/** Args for {@link Vcs.isAncestor}. */
export interface VcsIsAncestorSpec {
  cwd: string
  ancestor: string
  descendant: string
  trace?: TraceIdentity
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
  /** Optional trace identity forwarded to the underlying lib helper. */
  trace?: TraceIdentity
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
  trace?: TraceIdentity
}

// ---------------------------------------------------------------------------
// Slice 1 — Merge error types
// ---------------------------------------------------------------------------
//
// Re-declared here (rather than imported from `lib/git/merge`) so port consumers
// can import from a single, serializable contract file. The consumer slice that
// migrates `merge.ts` callers imports these from the port and updates `merge.ts`
// to import them from here too, eliminating the dual declaration.

/**
 * Thrown when the merge step's hard wall-clock ceiling fires before
 * `mergeBranch` returns. The merge primitive converts this to a
 * `WorkflowTerminalError` with failure-signature prefix `merge:hard-timeout`.
 */
export class MergeHardTimeoutError extends Error {
  readonly phase: string

  constructor(phase: string) {
    super(`merge hard timeout in ${phase}`)
    this.name = 'MergeHardTimeoutError'
    this.phase = phase
  }
}

/**
 * Thrown by `mergeBranch` when the merge is cancelled — either by the
 * internal watchdog timer (`reason: 'watchdog'`) or by the caller's
 * `AbortSignal` (`reason: 'external'`).
 */
export class MergeAbortedError extends Error {
  readonly reason: 'watchdog' | 'external'
  readonly elapsedMs: number
  readonly lastStep: string

  constructor(reason: 'watchdog' | 'external', elapsedMs: number, lastStep: string) {
    super(
      `mergeBranch aborted (${reason}) after ${elapsedMs}ms during step '${lastStep}'`,
    )
    this.name = 'MergeAbortedError'
    this.reason = reason
    this.elapsedMs = elapsedMs
    this.lastStep = lastStep
  }
}

/**
 * Hard wall-clock ceiling (milliseconds) for the merge STEP — sized to fire
 * only when the merge job has clearly stalled past its own internal watchdog.
 * Defaults to `DEFAULT_WATCHDOG_MS + 2 min` (≈ 17 min at standard config).
 *
 * Override with `MARS_MERGE_HARD_TIMEOUT_MS`. Re-declared here from
 * `lib/git/merge.ts` so port consumers import from a single location.
 *
 * ⚠️  When `MARS_VCS_SUPERVISOR_TIMEOUT_MS` is changed but
 * `MARS_MERGE_HARD_TIMEOUT_MS` is not, this constant stays at the hardcoded
 * fallback while `lib/git/merge.ts`'s value tracks the supervisor budget. Set
 * `MARS_MERGE_HARD_TIMEOUT_MS` explicitly in that case.
 */
export const MERGE_HARD_TIMEOUT_MS = Number(
  process.env.MARS_MERGE_HARD_TIMEOUT_MS ?? 17 * 60 * 1000,
)

// ---------------------------------------------------------------------------
// Slice 2 — Branch-query helpers (worktree-clean + worktree-prune migration)
// ---------------------------------------------------------------------------

/** Args for {@link Vcs.isBranchMergedIntoMain}. */
export interface VcsIsBranchMergedSpec {
  /** Branch ref to test, e.g. `task/<id>`. */
  branch: string
  /** Repo root (or any directory inside the repo). */
  cwd: string
}

/** Args for {@link Vcs.isZeroCommitBranch}. */
export interface VcsIsZeroCommitBranchSpec {
  /** Branch ref whose commit-count relative to `main` is tested. */
  branch: string
  /** Repo root (or any directory inside the repo). */
  cwd: string
}

// ---------------------------------------------------------------------------
// Slice 3 — Merge target pre-check (merge.ts tools migration)
// ---------------------------------------------------------------------------

/**
 * Serializable counterpart of `MergeTargetStatus` from `lib/git/merge.ts`.
 * The `error` variant carries `message: string` rather than an `Error` instance
 * so the result can cross a process boundary (ADR-0097).
 */
export type VcsMergeTargetStatus =
  | { kind: 'clean' }
  /** The task branch has diverged from / fallen behind integration. Recoverable — `merge` rebases first. */
  | { kind: 'needs-rebase'; targetPath: string; statusOutput: string }
  /** Tracked, uncommitted change on the integration checkout. Blocking. */
  | { kind: 'dirty'; targetPath: string; statusOutput: string }
  /** A ref did not resolve or git failed unexpectedly. */
  | { kind: 'error'; message: string }

/** Args for {@link Vcs.checkMergeTargetStatus}. */
export interface VcsCheckMergeTargetSpec {
  integrationBranch: string
  taskBranch: string
}

// ---------------------------------------------------------------------------
// Slice 4 — Checkpoint constants + autoCommitWorktree (coder-exit migration)
// ---------------------------------------------------------------------------

/**
 * Namespace prefix for all orchestrator checkpoint refs.
 * Re-exported here from `lib/git/checkpoint.ts` so port consumers import from
 * a single location; the consumer slice updates `checkpoint.ts` to import from
 * here.
 */
export const CHECKPOINT_REF_PREFIX = 'refs/mars/checkpoint' as const

/**
 * Subject prefix of every orchestrator-authored salvage checkpoint commit.
 * Re-exported here from `lib/salvage-checkpoint-subjects.ts` so port consumers
 * import from a single location.
 */
export const SALVAGE_CHECKPOINT_SUBJECT_PREFIX = 'wip(checkpoint):' as const

/** Trailer key on salvage checkpoint commits. */
export const SALVAGE_CHECKPOINT_TRAILER_KEY = 'Mars-Checkpoint' as const

/** Trailer value on salvage checkpoint commits. */
export const SALVAGE_CHECKPOINT_TRAILER_VALUE = 'salvage' as const

/** Args for {@link Vcs.autoCommitWorktree}. */
export interface VcsAutoCommitWorktreeSpec {
  /** Task whose dirty worktree is being committed — named in the commit. */
  taskId: string
  /**
   * Where the dirty content came from. Drives the commit message.
   * - `'coder-left-dirty'`: coder exited without staging all work.
   * - `'committer-salvage'`: main-committer recovery is capturing the integration snapshot.
   */
  provenance: 'coder-left-dirty' | 'committer-salvage'
  /** Integration branch, named in the commit message for provenance. */
  integrationBranch: string
  /** Absolute path to the worktree directory. */
  worktreePath: string
  /** Dirty file paths to attempt to commit (unsafe paths are filtered out internally). */
  dirtyFiles: string[]
}

/**
 * Result of {@link Vcs.autoCommitWorktree}.
 *
 * Mirrors `AutoCommitResult` from `lib/git/commit-main.ts`; re-declared here
 * to keep the port contract self-contained.
 */
export type VcsAutoCommitWorktreeResult =
  | { committed: true; sha: string }
  | {
      committed: false
      refusal:
        | 'unsafe-path'
        | 'git'
        | 'main-branch'
        | 'wrong-branch'
        | 'nothing-to-commit'
      reason: string
    }

// ---------------------------------------------------------------------------
// Slice 5 — Attribution helpers (main-dirty-dispatch migration)
// ---------------------------------------------------------------------------

/**
 * Classification of dirt on the integration checkout's working tree.
 *
 * Re-declared here (rather than imported from `lib/git/stale-tree-attribution`)
 * to keep the port contract self-contained per ADR-0097. The consumer slice
 * migrating `stale-tree-attribution.ts` callers imports this from the port.
 */
export type IntegrationDirtAttribution =
  | { kind: 'clean' }
  | { kind: 'stale-tree-debris'; range: string }
  | { kind: 'operator-dirt'; statusOutput: string }

/** Args for {@link Vcs.attributeIntegrationDirt}. */
export interface VcsAttributeIntegrationDirtSpec {
  /** Repo root where the integration branch is checked out (NOT a worktree). */
  repoRoot: string
  /**
   * The SHA the checkout's working tree was last resynced to, or `null` when
   * unknown. `null` always yields `operator-dirt` — see `stale-tree-attribution.ts`.
   */
  lastSyncedSha: string | null
  /** The current tip of the integration branch (`refs/heads/<branch>`). */
  headSha: string
}

/** Args for {@link Vcs.readLastSyncedSha}. */
export interface VcsReadLastSyncedShaSpec {
  /** Repo root where `.mars/last-synced-sha` lives. */
  cwd: string
}

// ---------------------------------------------------------------------------
// Slice 6 — applyPatch (steward-workflow-patch migration)
// ---------------------------------------------------------------------------

/** Args for {@link Vcs.applyPatch}. */
export interface VcsApplyPatchSpec {
  /** Working directory passed to `git apply`. */
  cwd: string
  /**
   * Unified diff content to apply. The implementation writes this to a
   * temporary file and invokes `git apply --check` (dry-run) then
   * `git apply` (commit), cleaning up the temp file in all cases.
   */
  patch: string
}

// ---------------------------------------------------------------------------
// Slice 7 — diff-summary (task-changes surface)
// ---------------------------------------------------------------------------

/** One file entry returned by {@link Vcs.diffSummary}. */
export interface VcsDiffFileStat {
  /** The file path (new path for renames). */
  path: string
  /** The original path before a rename; undefined for non-rename statuses. */
  oldPath?: string
  /**
   * Change status: A = added, M = modified, D = deleted, R = renamed,
   * C = copied. Other exotic statuses (T, U) are normalised to M.
   */
  status: 'A' | 'M' | 'D' | 'R' | 'C'
  /** Lines added; -1 for binary files. */
  additions: number
  /** Lines deleted; -1 for binary files. */
  deletions: number
}

/** Args for {@link Vcs.diffSummary}. */
export interface VcsDiffSummarySpec {
  cwd: string
  /** A `git diff` range expression, e.g. `"<base>..<head>"`. */
  range: string
  timeoutMs?: number
  trace?: TraceIdentity
}

// ---------------------------------------------------------------------------
// Slice 8 — hasRealCommitAboveBase (merge.ts no-progress guard migration)
// ---------------------------------------------------------------------------

/** Args for {@link Vcs.hasRealCommitAboveBase}. */
export interface VcsHasRealCommitAboveBaseSpec {
  /** Repository root (or any directory inside the repo). */
  cwd: string
  /** The merge-base SHA — commits at or below this are excluded. */
  baseSha: string
  /** The branch tip SHA to walk from. */
  tipSha: string
  trace?: TraceIdentity
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
  /**
   * Per-file diff summary for `spec.range`: status (A/M/D/R/C), additions, and
   * deletions for every file changed. Runs `--numstat` + `--name-status`
   * together and combines by position. Returns `[]` on any git failure.
   */
  diffSummary(spec: VcsDiffSummarySpec): Promise<VcsDiffFileStat[]>
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

  // --- Slice 2: branch-query helpers ---

  /**
   * True when `spec.branch` is a fast-forward ancestor of `main` AND
   * `main` has no commits ahead of it (i.e. the branch tip was already
   * merged). Returns `false` on any git failure.
   */
  isBranchMergedIntoMain(spec: VcsIsBranchMergedSpec): Promise<boolean>

  /**
   * True when `spec.branch` has no commits ahead of `main` (tip equals
   * the merge-base). Returns `false` on any git failure.
   */
  isZeroCommitBranch(spec: VcsIsZeroCommitBranchSpec): Promise<boolean>

  // --- Slice 3: merge pre-check ---

  /**
   * Classify the merge target ahead of a `merge()` call — whether the
   * integration checkout is clean, needs a rebase, is dirty, or errored.
   * Callers inspect the `kind` to decide whether to park the task or proceed.
   */
  checkMergeTargetStatus(spec: VcsCheckMergeTargetSpec): Promise<VcsMergeTargetStatus>

  // --- Slice 4: worktree auto-commit ---

  /**
   * Deterministically commit the dirty content of a task worktree, filtering
   * out unsafe paths (secrets, dependency dirs, build output). Returns
   * `{committed: false, …}` rather than throwing on refusal — callers decide
   * what to do next. Never commits to the integration branch.
   */
  autoCommitWorktree(spec: VcsAutoCommitWorktreeSpec): Promise<VcsAutoCommitWorktreeResult>

  // --- Slice 5: integration-dirt attribution ---

  /**
   * Classify dirt on the integration checkout as stale-tree debris (safe to
   * reset) or genuine operator dirt (must be auto-committed or parked).
   */
  attributeIntegrationDirt(
    spec: VcsAttributeIntegrationDirtSpec,
  ): Promise<IntegrationDirtAttribution>

  /**
   * Read the last-synced SHA from `.mars/last-synced-sha` in `spec.cwd`.
   * Returns `null` when the file does not exist or cannot be read.
   */
  readLastSyncedSha(spec: VcsReadLastSyncedShaSpec): Promise<string | null>

  // --- Slice 6: patch application ---

  /**
   * Apply `spec.patch` (unified diff content) in `spec.cwd` via `git apply`.
   * Runs `git apply --check` first; throws when either step fails.
   */
  applyPatch(spec: VcsApplyPatchSpec): Promise<void>

  // --- Slice 7: no-progress guard ---

  /**
   * True when at least one commit in `baseSha..tipSha` is NOT an
   * orchestrator-authored salvage checkpoint (i.e. lacks the
   * `Mars-Checkpoint: salvage` trailer). False when every commit in the range
   * is a salvage checkpoint, or when `baseSha === tipSha`. Fails open to
   * `true` (assume progress) when the commit list cannot be resolved, so
   * callers that act on "no real progress" are conservative.
   */
  hasRealCommitAboveBase(spec: VcsHasRealCommitAboveBaseSpec): Promise<boolean>
}
