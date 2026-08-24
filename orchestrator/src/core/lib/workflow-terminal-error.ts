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
 * subclasses: only `resetsAt` (quota-rejected) and `stepName` (preview-gate)
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
  /**
   * The worktree this run would code in is already held by a live coder for a
   * different task. A worktree is a single-writer resource (`git add -A`,
   * `git clean`, rebase), so a second agent in the same tree corrupts both
   * runs. Operator-owned scheduling condition, not a code defect: the holder
   * has to finish or be stopped before this task can be re-dispatched.
   */
  | 'worktree-lease-held'
  | 'origin-terminal'
  | 'coder-exit-nonzero'
  | 'coder-uncommitted'
  | 'coder-empty-diff'
  | 'quota-rejected'
  | 'main-dirty-verify'
  | 'main-dirty-merge'
  | 'preview-gate'
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
  /**
   * The merge step found the task branch's TIP to be an orchestrator-authored
   * salvage checkpoint — the "coder killed … do not merge as-is" auto-commit
   * `coder-exit.ts` writes when a coder dies with uncommitted changes. That
   * commit is a safety net for the coder-resume path, not a finished diff, so
   * fast-forwarding it into the integration branch is refused. Identified
   * structurally via the `Mars-Checkpoint: salvage` commit trailer, never by
   * matching subject text.
   *
   * This kind specifically means a REAL commit exists between the branch's
   * base and the checkpoint tip (`hasRealCommitAboveBase` returned `true`) —
   * some coder attempt landed genuine work and a LATER attempt still died
   * mid-run, leaving a checkpoint back on top. That is worth an operator's
   * attention: `mars continue <id>` (resume the coder on the existing
   * worktree) or `mars task add --supersede <id>` (hand the branch to a fresh
   * coder). See {@link 'merge-salvage-checkpoint-tip-no-progress'} for the
   * sibling case where the branch has never held any real commit.
   */
  | 'merge-salvage-checkpoint-tip'
  /**
   * The merge step found the task branch's TIP to be a salvage checkpoint
   * (same detection as {@link 'merge-salvage-checkpoint-tip'}) but, unlike
   * that kind, `hasRealCommitAboveBase` found NO real commit anywhere between
   * the branch's base and the tip — every commit the branch has ever carried,
   * across any `--supersede` inheritance, is itself an orchestrator checkpoint.
   * No coder attempt on this branch has ever landed real work, so this is
   * classified as a code-phase failure (`failedPhase: 'code'`,
   * `failureSignature` under the `code:` namespace) rather than a merge
   * defect: the fix is a fresh attempt (`mars task add --supersede <id>`) or
   * splitting the task, not investigating the merge machinery.
   */
  | 'merge-salvage-checkpoint-tip-no-progress'

export interface WorkflowTerminalMeta {
  /** Unix epoch seconds at which the provider quota resets. Only set for `quota-rejected`. */
  resetsAt?: number
  /**
   * The name of the step that parked. Only set for `preview-gate`, whose
   * daemon handler uses it to locate and patch the `workflow_step_runs` row.
   */
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
