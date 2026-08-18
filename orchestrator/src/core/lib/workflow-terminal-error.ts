/**
 * WorkflowTerminalError — the single discriminant that replaces 8+
 * message-substring predicates (is*Error functions) for sentinel dispatch.
 *
 * Workflows throw this (subclassing Error) instead of `new Error(MESSAGE(…))`;
 * the dispatch loop in server.ts does a single `instanceof` check and then
 * switches on `.kind` rather than importing and calling a family of
 * string-matching predicate functions.
 *
 * The `.meta` bag carries kind-specific data without requiring a union of
 * subclasses: only `resetsAt` (quota-rejected) and `stepName` (await-human)
 * are defined today.
 */

export type WorkflowTerminalKind =
  | 'blockers-abort'
  | 'context-exhausted'
  | 'origin-worktree-missing'
  /**
   * A resumed run's own worktree directory is gone and its branch no longer
   * exists, so the run cannot be re-attached. Distinct from
   * `origin-worktree-missing`, which is a recovery (fix) task failing to
   * attach to a DIFFERENT task's worktree.
   */
  | 'resume-worktree-missing'
  /**
   * A task's worktree could not be brought up to date with the integration
   * branch because replaying its branch conflicts. The rebase was aborted and
   * the worktree left exactly as found — an operator-owned git condition, not
   * a code defect, so no recovery fixer is spawned.
   */
  | 'worktree-rebase-conflict'
  | 'origin-terminal'
  | 'coder-exit-nonzero'
  | 'coder-uncommitted'
  | 'coder-empty-diff'
  | 'quota-rejected'
  | 'main-dirty-verify'
  | 'main-dirty-merge'
  | 'preview-gate'
  | 'await-human'
  | 'committer-still-dirty'
  /**
   * The setup step found uncommitted changes on the integration branch before
   * spawning the coder. The task is marked failed (NOT blocked — zero edges would
   * violate the edgeless-blocked invariant) and a dirty-integration action-queue
   * item is raised. The operator must clean the integration branch and then
   * restart the task (`mars restart <id>`).
   */
  | 'setup-dirty-integration'
  /**
   * The merge gate detected that the task branch has zero commits ahead of the
   * integration branch. For non-main-committer tasks this is a defect — either
   * the coder's git commits were blocked by the sandbox (index.lock permission
   * denied) or syncWorktreeToIntegration reset the branch to the integration
   * tip. The task is failed and an operator action-queue item is raised; the
   * worktree is preserved for investigation.
   */
  | 'merge-zero-commit'
  /**
   * The post-coder worktree classifier (`detectPostCoderState`) failed to
   * determine the worktree state after the corrective coder turn, even after
   * one retry. Carrying a stale pre-correction snapshot forward risks reporting
   * files as uncommitted when the corrective turn may have committed them, so
   * the run fails with this distinct signature instead. The worktree may contain
   * committed work — prefer `mars continue` over `mars restart`.
   */
  | 'post-coder-classifier-error'
  /**
   * The merge step tried to transition the task to `merging` but found the task
   * already in a terminal status (`failed` / `done` / `dropped`). This is a
   * benign race: the recovery-exhaustion path (or another concurrent writer)
   * already settled the task before the merge step could start. The task DB
   * state is already correct; no further update or fix-task spawn is needed.
   * The merge step exits cleanly without touching the task row.
   */
  | 'merge-already-terminal'
  /**
   * The merge step's hard wall-clock ceiling fired before
   * `enqueueMergeJobAndAwait` returned. The task has been marked `failed`
   * with `failureSignature: 'merge:hard-timeout'` and a fix-task spawned.
   * The merge primitive throws this so the daemon dispatch loop can suppress
   * the generic `implement:crashed` re-update.
   */
  | 'merge-hard-timeout'

export interface WorkflowTerminalMeta {
  /** Unix epoch seconds at which the provider quota resets. Only set for `quota-rejected`. */
  resetsAt?: number
  /** The await-human step name. Only set for `await-human`. */
  stepName?: string
}

export class WorkflowTerminalError extends Error {
  readonly kind: WorkflowTerminalKind
  readonly meta: Readonly<WorkflowTerminalMeta>

  constructor(
    kind: WorkflowTerminalKind,
    message: string,
    meta: WorkflowTerminalMeta = {},
  ) {
    super(message)
    this.name = 'WorkflowTerminalError'
    this.kind = kind
    this.meta = meta
  }
}
