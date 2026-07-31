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
  | 'quota-rejected'
  | 'main-dirty-verify'
  | 'main-dirty-merge'
  | 'preview-gate'
  | 'await-human'
  | 'committer-still-dirty'

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
