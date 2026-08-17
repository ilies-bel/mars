/**
 * Worktree currency — bring a task's worktree up to date with the integration
 * branch before anything runs inside it.
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). Called by both
 * `setupWorktree` and `runAgent`; the second call is a
 * `merge-base --is-ancestor` no-op whenever the first ran.
 */
import { type TraceCtx } from '../../core/lib/run-tool'
import {
  syncWorktreeToIntegration,
  WorktreeRebaseConflictError,
  type WorktreeConflictPolicy,
  type WorktreeRef,
} from '../../core/lib/git/worktree'
import { updateTask } from '../../core/queue'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { WORKTREE_REBASE_CONFLICT_ABORT_MESSAGE } from '../../workflows/primitives/shared'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'

// ---------------------------------------------------------------------------
// worktree currency
// ---------------------------------------------------------------------------

/**
 * Bring a task's worktree up to date with the integration branch before
 * anything runs inside it.
 *
 * THE DEFECT THIS CLOSES. `mars restart` deliberately preserves `task/<id>`
 * whenever the branch carries unmerged commits (deleting it would destroy the
 * failed attempt's work). `createWorktree` then re-attaches that preserved
 * branch AT ITS OLD TIP rather than branching off the integration tip, so a
 * restarted task re-ran `code` and `verify` against superseded source —
 * worktrees were measured 46-89 commits behind `main`, and `verify` re-failed
 * on assertions `main` had already fixed. No number of restarts could drain
 * such a task. Recovery (`kind:'fix'`) tasks attach to the ORIGIN's worktree,
 * so a stale origin poisoned its recovery for free.
 *
 * Called from two places, because they cover disjoint dispatch paths and the
 * second is a `merge-base --is-ancestor` no-op whenever the first ran:
 *   - `setupWorktree`, before deps are installed, so the install sees current
 *     manifests — this is the path a restarted task takes;
 *   - `runAgent`'s preflight, which is the ONLY guaranteed pre-`code` hook on a
 *     checkpoint-resume (`mars continue`, a watchdog retry), where the completed
 *     `setup` step short-circuits entirely.
 *
 * CONFLICT POLICY — and why it is keyed on the dispatch path, not on how
 * valuable the commits look. I cannot tell "genuinely valuable unique commits"
 * from "superseded auto-commits" safely: a `chore(auto-commit)` subject is only
 * evidence about WHO committed (the orchestrator rescuing a coder's edits), not
 * about whether the diff matters, and judging that needs intent the git
 * metadata does not carry. So the rule is blunt and derived from what each
 * dispatch path has already promised:
 *
 *   - the task carves its OWN branch at setup → `'recreate'`. `mars restart`
 *     already means "run this from scratch": it deletes the run journal, nulls
 *     `branch`/`worktreePath`, and keeps `task/<id>` purely as an archive.
 *     Parking the tip on `refs/mars/parked/<id>-<sha>` honours that archive
 *     obligation without dragging a superseded partial turn forward.
 *   - a recovery attached to its ORIGIN's worktree, or a checkpoint-resume →
 *     `'reconcile'`. The existing commits ARE the premise of the run, so they
 *     must not be reset — but they must not be a dead end either. The live
 *     conflict goes to the vcs-supervisor, the agent this repo already uses for
 *     exactly this at merge time; only if Vega cannot finish does the task fail
 *     with a NAMED, `orchestration`-classified signature (the single recovery
 *     slot is not burnt on a code fixer that cannot see a git conflict) and an
 *     operator item.
 *   - a main-commiter worktree → `'escalate'`. It is carved off the integration
 *     tip, so it is current by construction and cannot reach this at all.
 *
 * WHY NOT A "VALUABLE VS SUPERSEDED COMMITS" TEST for the recovery case. The
 * proposal was to recreate when the origin's only commits are orchestrator
 * `chore(auto-commit)` turns. The live case that motivated this refutes it:
 * `fix-ec2f6c04`'s origin `mars-76fef59f` was described as carrying an
 * auto-commit partial turn, but its one unique commit is
 * `fix(ui): preserve persisted action queue kinds` — a deliberate coder commit,
 * conflicting in a single test file. An auto-commit subject records WHO
 * committed (the orchestrator rescuing a coder's uncommitted edits), never
 * whether the diff matters, so the signal would have discarded real work.
 *
 * `'recreate'` is a SUCCESS path: it records no failure signature, so a fleet
 * of stale branches cannot trip the signature-storm breaker and pause dispatch.
 * It is also idempotent — afterwards the branch IS the integration tip, so a
 * repeat pass short-circuits at `already-current`. Both properties matter: 24
 * of the ~65 active tasks currently carry a divergent branch and will be
 * restarted together.
 */
export const ensureWorktreeCurrent = async (args: {
  taskId: string
  ref: WorktreeRef
  integrationBranch: string
  phase: 'setup' | 'code'
  onConflict: WorktreeConflictPolicy
  traceCtx?: TraceCtx
  store: TaskStore
}): Promise<void> => {
  const { taskId, ref, integrationBranch, phase, onConflict, store } = args
  try {
    const outcome = await syncWorktreeToIntegration({
      taskId,
      ref,
      integrationBranch,
      onConflict,
      traceCtx: args.traceCtx,
    })
    if (outcome.kind === 'rebased') {
      console.log(
        `[worktree-sync] task ${taskId}: replayed ${ref.branch} onto ${integrationBranch} ` +
          `(${outcome.from.slice(0, 9)} -> ${outcome.to.slice(0, 9)})` +
          (outcome.checkpointRef === null
            ? ''
            : `; uncommitted work parked on ${outcome.checkpointRef} and restored`),
      )
    }
    if (outcome.kind === 'reconciled') {
      console.log(
        `[worktree-sync] task ${taskId}: vcs-supervisor reconciled ${ref.branch} onto ` +
          `${integrationBranch} (${outcome.from.slice(0, 9)} -> ${outcome.to.slice(0, 9)})` +
          (outcome.vegaSessionId === null
            ? ''
            : `; vega session ${outcome.vegaSessionId}`),
      )
    }
    // `recreated` is logged (loudly, with the parked ref and the recovery
    // command) by syncWorktreeToIntegration itself. Neither it nor `reconciled`
    // is a failure: no status write, no signature, no action-queue row — so
    // neither can feed the signature-storm breaker.
  } catch (err) {
    if (!(err instanceof WorktreeRebaseConflictError)) throw err
    const reason = `${phase}:worktree-rebase-conflict`
    const summary = err.message
    const signature = computeFailureSignature(reason, summary)
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: summary,
        failedPhase: phase,
        failureReason: reason,
        failureSignature: signature,
        failureReasonCode: signature,
      },
      store,
    )
    await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${taskId}: branch ${err.branch} conflicts with ${err.integrationBranch}`,
      body: [
        `Task ${taskId}'s worktree is behind ${err.integrationBranch} and its branch ${err.branch} cannot be replayed onto the current tip — the rebase conflicts.`,
        '',
        'Nothing was discarded. The rebase was aborted, so the worktree at',
        `  ${err.worktreePath}`,
        'is byte-for-byte what it was: every commit on the branch is intact, and any uncommitted change was restored' +
          (err.checkpointRef === null
            ? '.'
            : ` (it is also anchored on ${err.checkpointRef}).`),
        '',
        'The task was NOT allowed to continue on stale code: running it would re-verify against source that ' +
          `${err.integrationBranch} has already moved past, which is how a restarted task fails forever.`,
        '',
        'Resolve explicitly — reconcile the conflict in the worktree and',
        `\`git -C ${err.worktreePath} rebase ${err.integrationBranch}\`, then \`mars restart ${taskId}\`;`,
        `or \`mars purge --force ${taskId}\` if the branch's work is no longer wanted.`,
        '',
        'Rebase output:',
        err.rebaseOutput,
      ].join('\n'),
      payload: {
        taskId,
        branch: err.branch,
        integrationBranch: err.integrationBranch,
        worktreePath: err.worktreePath,
        checkpointRef: err.checkpointRef,
        failureReason: reason,
      },
      context: { repoRoot: process.env.MARS_REPO ?? null },
      raisedBy: `agent:${phase}-worktree-sync`,
      signature: `${taskId}:${reason}`,
      originTaskId: taskId,
    }).catch((raiseErr) => {
      console.error(
        `[worktree-sync] task ${taskId} rebase-conflict escalation errored:`,
        raiseErr,
      )
    })
    throw new WorkflowTerminalError(
      'worktree-rebase-conflict',
      WORKTREE_REBASE_CONFLICT_ABORT_MESSAGE(taskId),
    )
  }
}
