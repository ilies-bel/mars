/**
 * The `merge` primitive shell.
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). The merge itself
 * is delegated to the durable single-consumer merge worker via
 * `ctx.services.enqueueMergeJobAndAwait`; every task-state write below goes
 * through `ctx.services.store` (the Arc aggregate, ADR-0052) inside this shell.
 */
import { runTool } from '../../core/lib/run-tool'
import { resolveVcs } from '../../core/ports/vcs/registry'
import { type WorktreeResult as WorktreeRef, type MergeResult } from '../../core/ports/vcs/types'
import {
  MergeAbortedError,
  MERGE_HARD_TIMEOUT_MS,
  MergeHardTimeoutError,
} from '../../core/ports/vcs/errors'
import {
  CHECKPOINT_REF_PREFIX,
  SALVAGE_CHECKPOINT_TRAILER_KEY,
  SALVAGE_CHECKPOINT_TRAILER_VALUE,
} from '../../core/ports/vcs/types'

// ---------------------------------------------------------------------------
// Private helper: pure string formatter used at two sites in this module.
// Not imported from lib/git/checkpoint to keep this file free of direct
// lib/git/* imports (ADR-0097 / PRD aed916c8 slice 6).
// ---------------------------------------------------------------------------
const checkpointRefFor = (key: string): string => {
  const safe = key
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.lock$/i, '-lock')
  if (safe.length === 0) throw new Error(`checkpoint key '${key}' has no usable characters`)
  return `${CHECKPOINT_REF_PREFIX}/${safe}`
}
import { resolveContext, getStateDir } from '../../core/context'
import { type AgentEvent } from '../../core/lib/claude-stream'
import { IllegalTransitionError, getTask, updateTask } from '../../core/queue'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { findLiveWorktreeDependents } from '../../core/lib/worktree-dependents'
import { summarizeUsage } from '../../core/lib/claude-usage'
import { recordSignals } from '../../core/lib/reflect-signals'
import { runNonLlmStepWithSpan } from '../../core/lib/run-worker-with-span'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import {
  type MarsCtx,
  resolveTrace,
  resolveWorktree,
  readWorkflowInput as input,
  resolveTaskId,
  buildPhaseCtx,
  buildTraceIdentity,
  spanStore,
} from '../context'
import { validationRecorder } from '../validate-recorder'

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/** Per-call domain options for {@link merge}. All fields default. */
export interface MergeOpts {
  /** Pipeline kind. Default `'task'`. `'diagnose'` removes the worktree, marks done. */
  kind?: 'task' | 'fix' | 'diagnose'
  /** Merge target. Default `'main'`. */
  integrationBranch?: string
  /** Override the task id (defaults to `ctx.runId`). */
  taskId?: string
  /** Override the worktree (defaults to the one stashed by setupWorktree). */
  worktree?: WorktreeRef
}

export interface MergeOutput {
  taskId: string
  success: boolean
  message: string
}


/**
 * Fast-forward (+ Vega conflict reconciliation) of the task branch into the
 * integration branch. Mirrors the former `merge` step body:
 *
 *   - `kind:'diagnose'` removes the empty worktree and marks done (verdict-only),
 *   - pre-flight `checkMergeTargetStatus`: `needs-rebase` falls through to the
 *     rebase-before-ff; `dirty` parks the task failed with an operator
 *     action-queue item (does NOT burn the recovery budget); `error` fails it,
 *   - `mergeBranch` performs the serialized FF, escalating conflicts to Vega,
 *   - a Vega abort spawns a recovery fix-task; an unhandled crash stamps the
 *     task failed and spawns a fix-task,
 *   - on success removes the worktree and marks the task done.
 *
 * All task-state writes route through `ctx.services.store`.
 *
 * Usage from a scaffolded workflow:
 * ```js
 * return await ctx.step('merge', () => merge(ctx, { kind }))
 * ```
 * Vega conflict-resolution events are forwarded to
 * `ctx.emit('vcs-supervisor-event', …)` internally.
 */
export const merge = async (
  ctx: MarsCtx,
  opts: MergeOpts = {},
): Promise<MergeOutput> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'merge',
      mode: 'auto',
      guide: null,
    })
    return {
      taskId: resolveTaskId(ctx, opts.taskId),
      success: true,
      message: 'validation dry-run',
    }
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const store: TaskStore = ctx.services.store

  // Real coder-process liveness (not just task-row status) for THIS task id.
  // `findLiveWorktreeDependents` only sees OTHER task rows sharing the same
  // worktree/branch — it self-excludes `taskId`, so it cannot catch a
  // stale/duplicate dispatch of the SAME task id still coding while this run
  // has reached the merge step (mars-56b4584f: a stale dispatch removed a
  // worktree while an agent subprocess was still alive inside it under the
  // same task id). Every `removeWorktree` call below also checks this, in
  // addition to `findLiveWorktreeDependents`, before reclaiming the tree.
  // Absent hook (scaffolded workflows, tests without a tracker) degrades to
  // `false` — same behaviour as before this guard was added.
  const implementStillInFlight = (): boolean =>
    ctx.services.isImplementInFlight?.(taskId) ?? false

  // ── Idempotent terminal short-circuit ──────────────────────────────────────
  // When the task row is already terminal (done/failed/dropped), a re-dispatch
  // after a partial completion (e.g. daemon restart between resolveMergeJob and
  // step-completion recording) must NOT re-acquire the merge lock or re-run the
  // fast-forward. Return immediately with a synthesized MergeOutput.
  const _currentTask = await getTask(taskId, store)
  if (_currentTask !== null && MERGE_IDEMPOTENT_TERMINAL_STATUSES.has(_currentTask.status)) {
    const _priorStatus = _currentTask.status
    const _trace = await resolveTrace(ctx, taskId)
    await _trace.traceStore
      .record({
        kind: 'merge-idempotent-skip',
        taskId,
        originId: _trace.originId,
        phase: 'merge',
        payload: { priorStatus: _priorStatus },
      })
      .catch(() => {}) // trace failures must never abort a correctness path
    const _message =
      _priorStatus === 'done'
        ? `merge step: task already terminal (done), short-circuiting`
        : `merge step: task already ${_priorStatus} (already terminal), short-circuiting`
    return {
      taskId,
      success: _priorStatus === 'done',
      message: _message,
    }
  }

  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)
  const emit = (event: AgentEvent): void =>
    ctx.emit('vcs-supervisor-event', event)

  const worktreePath = worktree.path
  const branch = worktree.branch

  if (kind === 'diagnose') {
    // Mark done BEFORE removing the worktree/branch so the done-implies-merged
    // guard in updateTask can verify the branch still exists. Diagnose branches
    // always have 0 commits ahead of integration (they are verdict-only), so
    // the guard sees aheadCount===0 and allows the transition. If we removed the
    // branch first the guard would see aheadCount===null with no merge sha and
    // incorrectly redirect to failed.
    await updateTask(taskId, { status: 'done', failedPhase: null }, store)
    if (implementStillInFlight()) {
      console.log(
        `[merge] task ${taskId}: diagnose complete; PRESERVING worktree ${worktreePath} — ` +
          `a coder process is still in flight for this task id`,
      )
    } else {
      await resolveVcs().removeWorktree({
        path: worktreePath,
        branch,
        force: true,
        keepBranch: false,
        tombstone: { taskId, reason: 'diagnose' },
        trace: buildTraceIdentity(trace, taskId, 'merge'),
      })
    }
    return {
      taskId,
      success: true,
      message: 'diagnose Chore complete; verdict-driven branch runs in daemon',
    }
  }

  let vegaSpanInfo: { workerName: string; sessionId: string | null } | null = null
  // Captured inside fn() so getCommandOutput can forward it to the trace even
  // when fn() throws (integration gate failure case). Set from
  // m.integrationGateOutput when mergeBranch reports a gate failure — the
  // integration-gate runner now lives in the merge worker, which constructs
  // onAfterFastForward locally and passes it through mergeFn (mars-cd039a0b).
  let capturedIntegrationGateOutput: string | undefined
  // Fast-forward SHAs captured from the MergeResult (mergePreSha/mergePostSha)
  // and persisted into the merge step_ended payload. The Scorer runtime
  // (PRD 6cf85bc9) reconstructs the merged diff from these after the worktree
  // is removed: `git diff <mergePreSha> <mergePostSha>` — both SHAs are
  // permanent objects, so the diff stays reproducible even after the
  // integration branch advances.
  let capturedMergeShas: { mergePreSha: string; mergePostSha: string } | null =
    null

  return await runNonLlmStepWithSpan({
    stepName: 'merge',
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    taskId: taskId,
    phase: 'merge',
    traceStore: spanStore(trace),
    getVegaInfo: () => vegaSpanInfo,
    getCommandOutput: () => capturedIntegrationGateOutput,
    getExtraPayload: () => (capturedMergeShas !== null ? { ...capturedMergeShas } : {}),
    fn: async (): Promise<MergeOutput> => {
      // Periodic heartbeat: records the active merge sub-phase every
      // MARS_MERGE_HEARTBEAT_MS (default 10 s) so an operator inspecting a
      // long-running merge can see which sub-phase is hot rather than staring
      // at a silent 'merge running' span.  Cleared in the finally block so no
      // tick fires after the step returns or throws.
      let currentPhase = 'preflight'
      const heartbeatStartedAt = Date.now()
      const heartbeatIntervalMs = Number(process.env.MARS_MERGE_HEARTBEAT_MS ?? 10_000)
      const heartbeatTimer = setInterval(() => {
        void trace.traceStore
          .record({
            kind: 'merge-heartbeat',
            taskId,
            phase: 'merge',
            payload: {
              subPhase: currentPhase,
              elapsedMs: Date.now() - heartbeatStartedAt,
              taskId,
            },
          })
          .catch(() => {})
      }, heartbeatIntervalMs)
      try {
        await updateTask(
          taskId,
          { status: 'merging', failedPhase: null },
          store,
        )

        // Zero-commit guard: if the task branch has zero commits ahead of the
        // integration branch the pipeline produced no deliverable work.
        //
        // MAIN-COMMITTER EXCEPTION: a main-committer recovery task can legitimately
        // produce zero commits when the integration branch self-healed before the task
        // ran — its correct success state is a no-op (clean worktree, zero commits).
        // For every other task kind, zero commits means the coder failed to commit:
        // either the codex sandbox blocked writes to .git/worktrees/<id>/index.lock,
        // or syncWorktreeToIntegration recreated the branch at the integration tip and
        // parked the real commits on a checkpoint ref. Both scenarios are bugs; marking
        // the task done while no work reached integration is a false-green (observed in
        // mars-eb04bbda). Fail the task and preserve the worktree for investigation.
        const { repoRoot: mergeRepoRoot } = resolveContext()
        if (await resolveVcs().isZeroCommitBranch({ branch, cwd: mergeRepoRoot })) {
          // Check for the main-committer exception before deciding the outcome.
          let isMainCommitter = false
          try {
            const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
              '../../core/lib/main-dirty'
            )
            const taskRow = await getTask(taskId, store)
            isMainCommitter =
              parseMainCommiterPayload(taskRow?.recoveryPayload ?? null)?.recipe ===
              MAIN_COMMITER_RECIPE
          } catch {
            // If lookup fails, default to non-main-committer (fail-safe: prefer
            // a false negative over a false positive).
          }

          if (isMainCommitter) {
            // Expected no-op: the integration branch self-healed before this
            // main-committer recovery task ran. Accept and mark done.
            console.log(
              `[merge] task ${taskId}: branch ${branch} has zero commits ahead of ${integrationBranch} — main-committer no-op accepted`,
            )
            // Mark done BEFORE removing the worktree/branch so the done-implies-merged
            // guard in updateTask can verify the branch still exists and sees
            // aheadCount===0. If we removed the branch first, the guard would see
            // aheadCount===null with no merge sha and incorrectly redirect to failed.
            await updateTask(taskId, { status: 'done', failedPhase: null }, store)
            if (implementStillInFlight()) {
              console.log(
                `[merge] task ${taskId}: PRESERVING worktree ${worktreePath} — ` +
                  `a coder process is still in flight for this task id`,
              )
            } else {
              await resolveVcs().removeWorktree({
                path: worktreePath,
                branch,
                force: true,
                keepBranch: false,
                tombstone: { taskId, reason: 'zero-commit-main-committer-noop' },
                trace: buildTraceIdentity(trace, taskId, 'merge'),
              })
            }
            return {
              taskId,
              success: true,
              message: 'zero-commit branch — main-committer no-op accepted',
            }
          }

          // Recovery-success exception: if a completed recovery task
          // (kind='fix', fix_for_task_id=taskId, status='done') exists, the
          // recovery delivered the work on its own branch. The origin's empty
          // branch is the EXPECTED state — the pipeline produced deliverable
          // commits, just under the recovery task's SHA. Classifying this as
          // merge:zero-commit-branch would be a false failure identical to the
          // phantom-merge mirror bug (a recovery delivering work that shows up
          // as a no-op on the origin). Mark the origin done and return success.
          let doneRecoveryId: string | null = null
          try {
            const doneRecoveryResult = await store.query({
              sql: `SELECT id FROM tasks WHERE fix_for_task_id = ? AND kind = 'fix' AND status = 'done' LIMIT 1`,
              args: [taskId],
            })
            if (doneRecoveryResult.rows.length > 0) {
              doneRecoveryId = (doneRecoveryResult.rows[0] as { id: string }).id
            }
          } catch {
            // best-effort: if the probe fails, fall through to the standard
            // zero-commit-branch failure path.
          }
          if (doneRecoveryId !== null) {
            // Recovery task already landed the work. The origin's branch being
            // empty is correct — mark it done and clean up the worktree.
            // Mark done BEFORE removing the worktree/branch so the
            // done-implies-merged guard sees aheadCount===0 and allows the
            // transition (same pattern as the main-committer no-op above).
            console.log(
              `[merge] task ${taskId}: branch ${branch} has zero commits ahead of ` +
              `${integrationBranch} — recovery ${doneRecoveryId} already delivered the work; ` +
              `marking origin done`,
            )
            await updateTask(taskId, { status: 'done', failedPhase: null }, store)
            if (implementStillInFlight()) {
              console.log(
                `[merge] task ${taskId}: PRESERVING worktree ${worktreePath} — ` +
                  `a coder process is still in flight for this task id`,
              )
            } else {
              await resolveVcs().removeWorktree({
                path: worktreePath,
                branch,
                force: true,
                keepBranch: false,
                tombstone: { taskId, reason: 'zero-commit-recovery-done' },
                trace: buildTraceIdentity(trace, taskId, 'merge'),
              })
            }
            return {
              taskId,
              success: true,
              message: `zero-commit branch — recovery ${doneRecoveryId} already delivered the work`,
            }
          }

          // Non-main-committer task: zero commits is a bug. Check whether prior
          // commits existed (parked ref from phase-recovery eviction, or a
          // checkpoint ref from the code step). If so, use merge:work-lost so
          // the operator knows the work existed but was lost, not simply never
          // produced. This distinguishes the stale-merging-sweep eviction path
          // (mars-59c9fdb0: branch reset → re-queued → false-green done) from the
          // plain sandbox-blocked-commit path (no prior refs).
          let workLostRef: string | null = null
          try {
            // Check for a parked ref written by recoverPhase when it evicted this
            // task from the merging status while preserving unmerged commits.
            const parkedListR = await runTool(
              {
                tool: 'git',
                argv: ['for-each-ref', '--format=%(refname)', `refs/mars/parked/${taskId}`],
                cwd: mergeRepoRoot,
                taskId,
                originId: trace.originId,
                phase: 'merge',
                expectsFailure: true,
              },
              trace.traceStore,
            ).catch(() => null)
            if (parkedListR !== null && parkedListR.exitCode === 0 && parkedListR.stdout.trim()) {
              workLostRef = parkedListR.stdout.trim().split('\n')[0] ?? null
            }
            // Also check for a checkpoint ref written by the code step (coder ran
            // and was salvage-checkpointed before the eviction reset the branch).
            if (workLostRef === null) {
              const ckRef = checkpointRefFor(taskId)
              const ckR = await runTool(
                {
                  tool: 'git',
                  argv: ['rev-parse', '--verify', ckRef],
                  cwd: mergeRepoRoot,
                  taskId,
                  originId: trace.originId,
                  phase: 'merge',
                  expectsFailure: true,
                },
                trace.traceStore,
              ).catch(() => null)
              if (ckR !== null && ckR.exitCode === 0) workLostRef = ckRef
            }
          } catch {
            // Best-effort: if the probe fails, fall through to the default
            // zero-commit-branch classification.
          }

          const ZERO_COMMIT_SIGNATURE = workLostRef !== null
            ? MERGE_WORK_LOST_SIGNATURE
            : 'merge:zero-commit-branch'
          const errorMsg = workLostRef !== null
            ? (
              `task branch ${branch} has zero commits ahead of ${integrationBranch} but ` +
              `prior work was found at ${workLostRef}. The branch was reset (e.g. by a ` +
              `stale-merging-sweep eviction) before the commits landed in ${integrationBranch}. ` +
              `Worktree preserved at ${worktreePath} for investigation.`
            )
            : (
              `task branch ${branch} has zero commits ahead of ${integrationBranch}; ` +
              `the pipeline produced no deliverable commits. Worktree preserved at ` +
              `${worktreePath} for investigation.`
            )
          console.error(
            `[merge] task ${taskId}: zero-commit branch — failing task (was: false-green done). ${errorMsg}`,
          )
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: ZERO_COMMIT_SIGNATURE,
              failureReasonCode: ZERO_COMMIT_SIGNATURE,
              failureSignature: ZERO_COMMIT_SIGNATURE,
            },
            store,
          )
          const zeroCommitTitle = workLostRef !== null
            ? `Task ${taskId}: work lost — branch reset before commits landed`
            : `Task ${taskId}: zero-commit branch — no work delivered`
          const zeroCommitBody = workLostRef !== null
            ? [
                `Task \`${taskId}\` reached the merge gate with branch \`${branch}\` at the same ` +
                  `commit as \`${integrationBranch}\` — zero commits ahead.`,
                '',
                `**Work was found at:** \`${workLostRef}\``,
                '',
                `This means the branch was reset (likely by a stale-merging-sweep eviction) ` +
                  `before the commits landed. The parked ref above preserves the commits.`,
                '',
                `**To recover:**`,
                `1. Inspect the parked ref: \`git log ${workLostRef}\``,
                `2. Run \`mars continue ${taskId}\` to retry the merge from the preserved commits.`,
              ].join('\n')
            : [
                `Task \`${taskId}\` reached the merge gate with branch \`${branch}\` at the same ` +
                  `commit as \`${integrationBranch}\` — zero commits ahead. No work was delivered ` +
                  `to the integration branch.`,
                '',
                `**Common causes:**`,
                `1. The coder's \`git commit\` was blocked by the codex sandbox ` +
                  `(\`"Operation not permitted"\` writing to \`.git/worktrees/${taskId}/index.lock\`). ` +
                  `Auto-commit salvage may also have failed.`,
                `2. \`syncWorktreeToIntegration\` reset the branch to the integration tip ` +
                  `(conflict-recreate policy) after the coder committed — parking real commits ` +
                  `on a checkpoint ref.`,
                `3. The branch's commits already landed in \`${integrationBranch}\` under ` +
                  `different SHAs (e.g. a sibling recovery task committed and merged the same ` +
                  `diff first) and a rebase during this run silently dropped them as ` +
                  `already-applied. Before assuming data loss, check whether the work is ` +
                  `already in \`${integrationBranch}\`: \`git log ${integrationBranch} --grep ${taskId}\` ` +
                  `or diff the worktree's last known content against \`${integrationBranch}\`.`,
                '',
                `**To recover:** inspect the worktree at \`${worktreePath}\` for uncommitted ` +
                  `changes or checkpoint refs, then run \`mars continue ${taskId}\` to retry — ` +
                  `or, if cause 3 applies, no action is needed.`,
              ].join('\n')
          await raiseActionQueueItem({
            kind: 'failed',
            category: 'orchestrator',
            priority: 'high',
            title: zeroCommitTitle,
            body: zeroCommitBody,
            payload: {
              taskId,
              branch,
              integrationBranch,
              worktreePath,
              ...(workLostRef !== null ? { workLostRef } : {}),
            },
            context: { repoRoot: process.env.MARS_REPO ?? null },
            raisedBy: ZERO_COMMIT_SIGNATURE,
            signature: `${taskId}:${ZERO_COMMIT_SIGNATURE}`,
            originTaskId: taskId,
            occurrence: {
              at: new Date().toISOString(),
              taskId,
              integrationBranch,
            },
          })
          throw new WorkflowTerminalError(
            workLostRef !== null ? 'merge-work-lost' : 'merge-zero-commit',
            `${ZERO_COMMIT_SIGNATURE}: task ${taskId} branch ${branch} has zero commits ahead of ${integrationBranch}`,
          )
        }

        // Salvage-checkpoint tip guard: refuse to fast-forward a branch whose
        // TIP is still an orchestrator-authored salvage checkpoint (the
        // "coder killed ... do not merge as-is" auto-commit written by
        // coder-exit.ts when a coder is killed mid-run with uncommitted
        // changes). That commit is a safety net for the *coder resume* path
        // (`mars continue` rewinds to the coder on the same worktree so it
        // can finish the work) — it was never meant to be shippable on its
        // own. Identified STRUCTURALLY via the `Mars-Checkpoint: salvage`
        // trailer the orchestrator writes at commit time (checkpoint.ts's
        // isSalvageCheckpointCommit), not by matching the commit subject
        // text — a human commit whose subject happens to say
        // `wip(checkpoint):` carries no such trailer and is not refused. A
        // checkpoint that is NOT the tip (the coder resumed and built real
        // commits on top of it) is fine and merges normally.
        // Best-effort: this is a preflight safety check, not the merge itself.
        // A git failure here (including a spawn-level throw, e.g. a worktree
        // whose cwd vanished underneath it) must fail OPEN — skip the guard
        // and let the real merge machinery below run its own, more
        // authoritative checks — rather than aborting the whole merge step on
        // an inability to answer "is the tip a salvage checkpoint".
        let branchTipSha: string | null = null
        try {
          const branchTipR = await runTool(
            {
              tool: 'git',
              argv: ['rev-parse', branch],
              cwd: mergeRepoRoot,
              taskId,
              originId: trace.originId,
              phase: 'merge',
            },
            trace.traceStore,
          )
          branchTipSha = branchTipR.exitCode === 0 ? branchTipR.stdout.trim() : null
        } catch (err) {
          console.warn(
            `[merge] task ${taskId}: salvage-checkpoint-tip preflight could not resolve branch tip (${branch}); skipping guard:`,
            err,
          )
        }
        if (
          branchTipSha !== null &&
          (await resolveVcs().hasCommitTrailer({
            cwd: mergeRepoRoot,
            sha: branchTipSha,
            trailerKey: SALVAGE_CHECKPOINT_TRAILER_KEY,
            trailerValue: SALVAGE_CHECKPOINT_TRAILER_VALUE,
          }))
        ) {
          // Distinguish "some coder attempt landed real work, a later attempt
          // still died leaving a checkpoint on top" (a genuine defect worth an
          // operator's attention) from "this branch, across every attempt
          // including any --supersede inheritance, has NEVER held a real
          // commit" (nothing to investigate — the fix is a fresh attempt or a
          // smaller task). Both shapes refuse the merge; only the
          // classification, failedPhase, and failure signature differ, so the
          // two never collapse into one signature-storm family (ADR: see the
          // task that added this branch).
          let mergeBaseSha: string | null = null
          try {
            const mergeBaseR = await runTool(
              {
                tool: 'git',
                argv: ['merge-base', branch, integrationBranch],
                cwd: mergeRepoRoot,
                taskId,
                originId: trace.originId,
                phase: 'merge',
              },
              trace.traceStore,
            )
            mergeBaseSha = mergeBaseR.exitCode === 0 ? mergeBaseR.stdout.trim() : null
          } catch (err) {
            console.warn(
              `[merge] task ${taskId}: salvage-checkpoint-tip preflight could not resolve merge-base (${branch}..${integrationBranch}); defaulting to the genuine-defect classification:`,
              err,
            )
          }
          // Fail open to "real progress exists" (the more conservative,
          // pre-existing classification) when the merge-base is unknown.
          const hasRealProgress =
            mergeBaseSha === null ||
            (await resolveVcs().hasRealCommitAboveBase({
              cwd: mergeRepoRoot,
              baseSha: mergeBaseSha,
              tipSha: branchTipSha,
            }))

          if (!hasRealProgress) {
            const NO_PROGRESS_SIGNATURE = 'code:salvage-checkpoint-tip/no-progress'
            const errorMsg =
              `branch tip is an unfinished salvage checkpoint (${branchTipSha.slice(0, 9)}) and no coder ` +
              `attempt on this branch has ever landed a real commit — split the task or start a fresh ` +
              `attempt with \`mars task add --supersede ${taskId}\` rather than continuing on this worktree`
            await updateTask(
              taskId,
              {
                status: 'failed',
                error: errorMsg,
                failedPhase: 'code',
                failureReason: NO_PROGRESS_SIGNATURE,
                failureReasonCode: NO_PROGRESS_SIGNATURE,
                failureSignature: NO_PROGRESS_SIGNATURE,
              },
              store,
            )
            await raiseActionQueueItem({
              kind: 'failed',
              category: 'orchestrator',
              priority: 'high',
              title: `Task ${taskId}: no coder progress — branch never held a real commit`,
              body: [
                `Task \`${taskId}\`'s branch \`${branch}\` is tipped by an orchestrator-authored salvage`,
                `checkpoint commit (\`${branchTipSha.slice(0, 9)}\`), and no commit anywhere on the branch`,
                `(across any \`--supersede\` inheritance) is real, reviewed work — every commit ahead of`,
                `\`${integrationBranch}\` is itself a checkpoint. Continuing on the same worktree is unlikely`,
                `to help; the task itself likely needs a fresh attempt or a smaller scope.`,
                '',
                `**To unblock:**`,
                `1. \`mars task add --supersede ${taskId}\` — hand the branch to a fresh coder attempt.`,
                `2. Split the task into smaller pieces and re-enqueue.`,
                `3. \`mars continue ${taskId}\` remains available if you believe the existing worktree just needs one more turn.`,
              ].join('\n'),
              payload: { taskId, branch, integrationBranch, branchTipSha },
              context: { repoRoot: process.env.MARS_REPO ?? null },
              raisedBy: 'merge:salvage-checkpoint-tip-no-progress',
              signature: `${taskId}:${NO_PROGRESS_SIGNATURE}`,
              originTaskId: taskId,
              occurrence: {
                at: new Date().toISOString(),
                taskId,
                integrationBranch,
              },
            })
            throw new WorkflowTerminalError(
              'merge-salvage-checkpoint-tip-no-progress',
              `code:salvage-checkpoint-tip/no-progress: task ${taskId} branch ${branch} tip ${branchTipSha} is an unfinished salvage checkpoint with no real commit above the inherited base`,
            )
          }

          const SALVAGE_TIP_SIGNATURE = 'merge:salvage-checkpoint-tip/resumed-then-died'
          const errorMsg =
            `branch tip is an unfinished salvage checkpoint (${branchTipSha.slice(0, 9)}) — resume the coder ` +
            `with \`mars continue ${taskId}\`, or carry it forward with \`mars task add --supersede ${taskId}\``
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: SALVAGE_TIP_SIGNATURE,
              failureReasonCode: SALVAGE_TIP_SIGNATURE,
              failureSignature: SALVAGE_TIP_SIGNATURE,
            },
            store,
          )
          await raiseActionQueueItem({
            kind: 'failed',
            category: 'orchestrator',
            priority: 'high',
            title: `Task ${taskId}: merge blocked — branch tip is an unfinished checkpoint`,
            body: [
              `Task \`${taskId}\`'s branch \`${branch}\` is tipped by an orchestrator-authored salvage`,
              `checkpoint commit (\`${branchTipSha.slice(0, 9)}\`) — the auto-commit written when a coder`,
              `was killed mid-run with uncommitted changes. It is a safety net for the coder-resume path,`,
              `not a finished diff, so the merge step refused to fast-forward it into \`${integrationBranch}\`.`,
              '',
              `**To unblock:**`,
              `1. \`mars continue ${taskId}\` — resumes the coder on the existing worktree to finish the work.`,
              `2. \`mars task add --supersede ${taskId}\` — carries the branch forward onto a fresh task for a coder to finish.`,
            ].join('\n'),
            payload: { taskId, branch, integrationBranch, branchTipSha },
            context: { repoRoot: process.env.MARS_REPO ?? null },
            raisedBy: 'merge:salvage-checkpoint-tip',
            signature: `${taskId}:${SALVAGE_TIP_SIGNATURE}`,
            originTaskId: taskId,
            occurrence: {
              at: new Date().toISOString(),
              taskId,
              integrationBranch,
            },
          })
          throw new WorkflowTerminalError(
            'merge-salvage-checkpoint-tip',
            `merge:salvage-checkpoint-tip: task ${taskId} branch ${branch} tip ${branchTipSha} is an unfinished salvage checkpoint with real progress underneath`,
          )
        }

        const targetStatus = await resolveVcs().checkMergeTargetStatus({
          integrationBranch,
          taskBranch: branch,
        })
        if (targetStatus.kind === 'needs-rebase') {
          console.log(
            `[merge:preflight] task ${taskId} ${targetStatus.statusOutput}; proceeding to rebase-before-ff`,
          )
        }
        if (targetStatus.kind === 'dirty') {
          const DIRTY_TARGET_SIGNATURE = 'merge:preflight/uncommitted-changes'
          const errorMsg = `merge target ${targetStatus.targetPath} has uncommitted changes blocking fast-forward\n${targetStatus.statusOutput}`
          const dirtyPaths = targetStatus.statusOutput
            .split('\n')
            .filter((line) => /^[ MADRCU?!]{2} /.test(line))
            .map((line) => line.slice(3).trim())
            .filter(Boolean)
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: DIRTY_TARGET_SIGNATURE,
              failureReasonCode: DIRTY_TARGET_SIGNATURE,
              failureSignature: DIRTY_TARGET_SIGNATURE,
            },
            store,
          )
          await raiseActionQueueItem({
            kind: 'failed',
            category: 'orchestrator',
            priority: 'high',
            title: `Merge blocked: ${integrationBranch} is dirty: ${dirtyPaths.join(', ') || 'unknown path'}`,
            body: [
              `Task \`${taskId}\` reached the merge step with committed work on branch \`${branch}\`, but the integration checkout (\`${integrationBranch}\`) has uncommitted tracked changes.`,
              '',
              `Mars stopped before any merge reset could touch those edits. The task's committed work remains intact on branch \`${branch}\`.`,
              '',
              `**To unblock:**`,
              `1. Clean \`${integrationBranch}\`: commit the uncommitted changes listed below, or restore the paths you do not want with \`git checkout <ref> -- <paths>\`. Do NOT \`git stash\` — the stash is shared by every worktree in this repo, so a later \`pop\` can hand you another task's work.`,
              `2. Run \`mars continue ${taskId}\` — this re-attempts just the merge step without re-running the coder.`,
              '',
              `Dirty paths at failure time (may be stale — re-check before acting):`,
              '```',
              targetStatus.statusOutput,
              '```',
            ].join('\n'),
            payload: {
              taskId,
              branch,
              integrationBranch,
              targetPath: targetStatus.targetPath,
              statusOutput: targetStatus.statusOutput,
              dirtyPaths,
            },
            context: { repoRoot: process.env.MARS_REPO ?? null },
            raisedBy: 'merge:preflight:dirty-target',
            signature: `${taskId}:${DIRTY_TARGET_SIGNATURE}`,
            originTaskId: taskId,
            occurrence: {
              at: new Date().toISOString(),
              taskId,
              integrationBranch,
            },
          })
          throw new WorkflowTerminalError(
            'main-dirty-merge',
            `task ${taskId} merge:preflight detected dirty target ${integrationBranch}`,
          )
        }
        if (targetStatus.kind === 'error') {
          const errorMsg = `merge pre-flight git status failed: ${targetStatus.message}`.slice(0, 1000)
          const preflightSignature = computeFailureSignature('merge:preflight', errorMsg)
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: errorMsg,
              failureSignature: preflightSignature,
              failureReasonCode: preflightSignature,
            },
            store,
          )
          throw new Error(
            `task ${taskId} merge pre-flight failed: ${targetStatus.message}`,
          )
        }

        const supervisorConversation: AgentEvent[] = []
        let m: MergeResult
        // Unconditional queue path: delegate the merge to the durable
        // single-consumer worker. Serialisation is enforced by the worker's
        // single-consumer loop and the DB `FOR UPDATE SKIP LOCKED` claim, so
        // concurrent merge primitives don't race on the file lock.
        currentPhase = 'waiting-for-worker'

        // Hard step-level wall-clock ceiling (PRD bf7bbd39, slice 2).
        // Fires when the merge worker has CLAIMED this job but does not
        // resolve it within MERGE_HARD_TIMEOUT_MS — i.e. the worker itself
        // is wedged. The clock starts in the onClaimed callback (not at
        // enqueue time) so queue wait does not consume the execution budget.
        // A task sitting behind a long-running merge is never failed for
        // a merge that never actually ran.
        const hardAbortController = new AbortController()
        let hardTimer: ReturnType<typeof setTimeout> | undefined
        const onClaimed = (): void => {
          hardTimer = setTimeout(() => hardAbortController.abort(), MERGE_HARD_TIMEOUT_MS)
        }
        let queueResult: { status: 'done'; result: MergeResult } | { status: 'failed'; error: string; errorCode: string }
        try {
          queueResult = await Promise.race([
            ctx.services.enqueueMergeJobAndAwait({
              taskId,
              branch,
              worktreePath,
              integrationBranch,
              onClaimed,
            }),
            new Promise<never>((_, reject) => {
              if (hardAbortController.signal.aborted) {
                reject(new MergeHardTimeoutError('step-level'))
                return
              }
              hardAbortController.signal.addEventListener(
                'abort',
                () => reject(new MergeHardTimeoutError('step-level')),
                { once: true },
              )
            }),
          ])
        } catch (err: unknown) {
          if (err instanceof MergeHardTimeoutError) {
            // Do NOT unlink .merge.lock here. The lock's own finally block
            // (inside mergeBranch) is the sole authority that releases it.
            // Even though the timer starts at claim time (not enqueue time),
            // the job may not have entered mergeBranch yet — a blindly
            // unlinking would delete the mutex of a different healthy merge.

            // Establish the actual merge outcome before deciding the task
            // status. The merge job was still running when the timer fired;
            // it may have completed successfully in the background. The
            // branch is the source of truth: zero commits ahead of the
            // integration branch means the fast-forward landed.
            let branchAlreadyMerged = false
            try {
              branchAlreadyMerged = await resolveVcs().isAncestor({ cwd: mergeRepoRoot, ancestor: branch, descendant: integrationBranch })
            } catch {
              // Cannot determine merge status — fall through to the failure path.
            }

            if (branchAlreadyMerged) {
              // The merge completed successfully despite exceeding the step
              // ceiling. Mark the task done and emit a Notice so the slowness
              // stays visible without being reported as a failure.
              const noticeMsg = (
                `merge:hard-timeout — branch ${branch} is already an ancestor of ` +
                `${integrationBranch}; the merge succeeded before the step ceiling ` +
                `of ${Math.round(MERGE_HARD_TIMEOUT_MS / 60_000)} min expired`
              )
              console.log(
                `[merge] task ${taskId}: hard-timeout but merge already done — ${noticeMsg}`,
              )
              await updateTask(taskId, { status: 'done', failedPhase: null }, store)
              return {
                taskId,
                success: true,
                message: noticeMsg,
              }
            }

            const hardMsg = `merge:hard-timeout — merge step for task ${taskId} exceeded the step-level ceiling of ${Math.round(MERGE_HARD_TIMEOUT_MS / 60_000)} min`
            await updateTask(
              taskId,
              {
                status: 'failed',
                error: hardMsg,
                failedPhase: 'merge',
                failureReason: 'merge:hard-timeout',
                failureSignature: 'merge:hard-timeout',
                failureReasonCode: 'merge:hard-timeout',
              },
              store,
            )
            await handleTaskFailureWithFixTask({
              taskId,
              failingStep: 'merge:hard-timeout',
              errorOutput: hardMsg,
              branch,
              store,
            }).catch((handlerErr) => {
              console.error(
                `[failure-handler] task ${taskId} merge hard-timeout handling errored:`,
                handlerErr,
              )
            })
            throw new WorkflowTerminalError('merge-hard-timeout', hardMsg)
          }
          throw err
        } finally {
          if (hardTimer !== undefined) clearTimeout(hardTimer)
        }

        if (queueResult.status === 'failed') {
          // Task-tier gate failure at the rebased-tree verify step.
          //
          // merge-worker delivers this as { status: 'failed', error:
          // 'verify:gate/<slug>: Gate <name> rejected the change: ...' } so we
          // can stamp failedPhase:'verify' here — letting `mars continue`
          // rewind to the coder with the gate output rather than doing a
          // destructive restart (which failedPhase:'setup' would trigger via the
          // server.ts fallback on a task whose worktreePath is non-null but whose
          // failed_phase was never written).
          const verifyGateMatch = queueResult.error.match(/^(verify:gate\/[a-z][a-z0-9-]*)/)
          if (verifyGateMatch !== null) {
            const gateSignature = verifyGateMatch[1]!
            const errorMsg = queueResult.error.slice(0, 2000)
            await updateTask(
              taskId,
              {
                status: 'failed',
                error: errorMsg,
                failedPhase: 'verify',
                failureReason: errorMsg,
                failureSignature: gateSignature,
                failureReasonCode: gateSignature,
              },
              store,
            )
            await handleTaskFailureWithFixTask({
              taskId,
              failingStep: 'verify:gate',
              errorOutput: queueResult.error,
              branch,
              store,
            }).catch((err) => {
              console.error(
                `[failure-handler] task ${taskId} rebased-tree gate handling errored:`,
                err,
              )
            })
            throw new WorkflowTerminalError('verify-gate-rebased-tree', errorMsg)
          }
          // For all other worker failures, let the outer crash-handler deal
          // with this — it marks the task failed and spawns a fix-task, same
          // as a mergeBranch throw.
          throw new Error(`merge job failed (${queueResult.errorCode}): ${queueResult.error}`)
        }
        m = queueResult.result

        // Capture fast-forward SHAs from the MergeResult so the Scorer runtime
        // can reconstruct the merged diff after the worktree is removed.
        if (m.mergePreSha !== undefined && m.mergePostSha !== undefined) {
          capturedMergeShas = { mergePreSha: m.mergePreSha, mergePostSha: m.mergePostSha }
        }

        if (supervisorConversation.length > 0) {
          const supervisorUsage = summarizeUsage(supervisorConversation)
          await recordSignals(taskId, 'vcs-supervisor', supervisorUsage, store).catch(
            () => {
              // signal capture must never fail the task
            },
          )
        }

        if (m.conflictResolved) {
          vegaSpanInfo = { workerName: 'Vega', sessionId: m.vegaSessionId }
        }

        if (m.aborted) {
          // Timeout path: the vcs-supervisor subprocess was killed by the
          // per-step wall-clock timeout (exitCode 124). Surface a distinct
          // `merge:vega-timeout` signature so the action queue shows a
          // recognisable item separate from a Vega run that finished but
          // produced a bad git tree.
          if (m.vegaTimedOut) {
            const errorMsg =
              `merge:vega-timeout — vcs-supervisor timed out during conflict ` +
              `resolution for ${branch}; rebase aborted. ` +
              m.output.slice(0, 500)
            await updateTask(
              taskId,
              {
                status: 'failed',
                error: errorMsg,
                failedPhase: 'merge',
                failureReason: 'merge:vega-timeout',
                failureSignature: 'merge:vega-timeout',
                failureReasonCode: 'merge:vega-timeout',
              },
              store,
            )
            await handleTaskFailureWithFixTask({
              taskId,
              failingStep: 'merge:vega-timeout',
              errorOutput: m.output,
              branch,
              store,
            }).catch((err) => {
              console.error(
                `[failure-handler] task ${taskId} vega-timeout handling errored:`,
                err,
              )
            })
            throw new Error(errorMsg)
          }

          // ── Post-Vega abort: Vega completed but a subsequent step failed ──────
          // `m.conflictResolved === true` means:
          //   1. Vega ran to completion (terminal_reason: completed),
          //   2. The post-supervisor git checks passed (branch advanced, tree clean),
          //   3. The rebased branch tip is ALREADY persisted on `branch`.
          // The abort happened AFTER Vega, in the fast-forward, CAS retry, or a
          // transient env error — NOT because of Vega. Classifying this as
          // `vcs-supervisor-aborted` is wrong and misleading; the correct
          // classification is `merge:env-unreachable` so the operator knows the
          // failure is transient and `mars continue` will retry cleanly.
          //
          // No fix-task is spawned: the resolved rebase is already on `branch`, so
          // a fix-task that re-runs the coder would discard Vega's work. The
          // operator runs `mars continue` to retry just the merge step.
          if (m.conflictResolved) {
            const envMsg = (
              `vcs-supervisor resolved conflicts on ${branch} for task ${taskId} ` +
              `but the fast-forward was interrupted by a transient error; ` +
              `resolved rebase is preserved on ${branch} — run \`mars continue ${taskId}\` to retry`
            )
            // Store the Vega conversation in the durable trace rather than
            // embedding raw transcript JSON in the task row (VISION DEC-18).
            if ((m.supervisorConversation?.length ?? 0) > 0) {
              await trace.traceStore.appendDurableTranscript?.(
                taskId,
                m.vegaSessionId ?? `vcs-supervisor-merge-${taskId}`,
                'merge',
                JSON.stringify(m.supervisorConversation),
              ).catch(() => {})
            }
            await updateTask(
              taskId,
              {
                status: 'failed',
                error: envMsg,
                failedPhase: 'merge',
                failureReason: envMsg,
                failureReasonCode: MERGE_ENV_UNREACHABLE_REASON,
                failureSignature: MERGE_ENV_UNREACHABLE_REASON,
              },
              store,
            )
            // No fix-task: the resolved rebase is already on the branch.
            throw new Error(envMsg)
          }

          // ── Genuine Vega abort: Vega could not reconcile the conflict ─────────
          // Classify from the WRAPPED message, not the raw mergeBranch output:
          // the wrapper line is what lands in `error` and what the durable
          // recovery-spawn path re-classifies. Stamping the signature here (it
          // used to be left unset) means the abort reason — e.g. the pre-rebase
          // dirty-worktree guard's `rebase-dirty-worktree` — is on the row from
          // the first write, instead of degrading to `merge/unclassified`.
          //
          // failure_reason is a single readable sentence: which files conflicted
          // and why the merge was aborted. The raw transcript goes to the durable
          // trace store, not the task row (VISION DEC-18).
          const conflictMatch = m.output.match(/CONFLICT \([^)]+\):[^\n]*/g)
          const conflictSummary = conflictMatch
            ? conflictMatch.slice(0, 3).join('; ').slice(0, 200)
            : 'merge conflict'
          const abortErrorMsg = (
            `vcs-supervisor could not resolve ${conflictSummary} ` +
            `for task ${taskId}; worktree at ${worktreePath}`
          )
          // Store the Vega conversation in the durable trace
          if ((m.supervisorConversation?.length ?? 0) > 0) {
            await trace.traceStore.appendDurableTranscript?.(
              taskId,
              m.vegaSessionId ?? `vcs-supervisor-merge-${taskId}`,
              'merge',
              JSON.stringify(m.supervisorConversation),
            ).catch(() => {})
          }
          const abortSignature = computeFailureSignature(
            'merge:vcs-supervisor-aborted',
            abortErrorMsg,
          )
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: abortErrorMsg,
              failedPhase: 'merge',
              failureReason: abortErrorMsg,
              failureSignature: abortSignature,
              failureReasonCode: abortSignature,
            },
            store,
          )
          await handleTaskFailureWithFixTask({
            taskId,
            failingStep: 'merge:vcs-supervisor-aborted',
            errorOutput: abortErrorMsg,
            branch,
            store,
          }).catch((err) => {
            console.error(
              `[failure-handler] task ${taskId} merge abort handling errored:`,
              err,
            )
          })
          throw new Error(
            `task ${taskId} merge aborted; vcs-supervisor could not reconcile`,
          )
        }

        // Integration-tier gate failure: the fast-forward has already been
        // reverted by mergeBranch (branch is clean). Route through the standard
        // recovery path so the agent gets a fix-task seeded with the gate output.
        if (m.integrationGateFailed) {
          const gateOutput = m.integrationGateOutput ?? 'integration gates failed'
          // Capture for the span trace (getCommandOutput below reads this).
          capturedIntegrationGateOutput = gateOutput
          const errorMsg = gateOutput.slice(0, 2000)
          const gateSignature = computeFailureSignature('merge:integration-gate', errorMsg)
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: 'merge:integration-gate',
              failureSignature: gateSignature,
              failureReasonCode: gateSignature,
            },
            store,
          )
          await handleTaskFailureWithFixTask({
            taskId,
            failingStep: 'merge:integration-gate',
            errorOutput: gateOutput,
            branch,
            store,
          }).catch((err) => {
            console.error(
              `[failure-handler] task ${taskId} integration-gate failure handling errored:`,
              err,
            )
          })
          throw new Error(
            `task ${taskId} merge:integration-gate failed; fast-forward reverted`,
          )
        }

        // Post-merge ancestry assertion: verify the merged SHA is actually
        // reachable from the integration branch before marking the task done.
        //
        // WHY THIS IS NEEDED. When `mergeBranch` returns `merged: true` with a
        // `mergePostSha`, the fast-forward ref update is supposed to have
        // advanced `integrationBranch` to that SHA. But silent failures can
        // produce a false positive (e.g. the remerge zero-commit short-circuit
        // fired while the branch was recreated at the integration tip, causing
        // commits on the real task branch to be forever unreferenced — observed
        // on 6 tasks on 2026-08-05). Without this check the task is marked
        // `done` and `task/<id>` is deleted, leaving the commits unreachable and
        // reclaimable by `git gc`.
        //
        // The single `merge-base --is-ancestor` probe costs ~5ms. On failure:
        // stamp the task `failed` with a named signature, do NOT remove the
        // branch (preserves the commits for investigation), throw to abort.
        if (m.mergePostSha !== undefined) {
          const tipInIntegration = await resolveVcs().isAncestor({
            cwd: mergeRepoRoot,
            ancestor: m.mergePostSha,
            descendant: integrationBranch,
          })
          if (!tipInIntegration) {
            const assertMsg = (
              `merge:post-merge-assertion failed: ${m.mergePostSha.slice(0, 9)} is not ` +
              `reachable from ${integrationBranch} — branch ${branch} preserved for investigation`
            )
            const assertSignature = computeFailureSignature(
              'merge:post-merge-assertion',
              assertMsg,
            )
            await updateTask(
              taskId,
              {
                status: 'failed',
                error: assertMsg,
                failedPhase: 'merge',
                failureReason: 'merge:post-merge-assertion',
                failureSignature: assertSignature,
                failureReasonCode: assertSignature,
              },
              store,
            )
            throw new Error(assertMsg)
          }
        } else if (m.merged) {
          // Phantom-merge guard: the merge job reported success (m.merged: true)
          // but did not return a mergePostSha. This means the fast-forward did not
          // actually advance the integration branch — the tombstone would be written
          // with mergeCommitSha: null and reason: 'merged', which is the phantom-merge
          // symptom observed on mars-59c9fdb0 (tombstone: {reason: merged,
          // mergeCommitSha: null}). Fail instead of silently marking the task done.
          const phantomMsg = (
            `merge:phantom-merge — task ${taskId} branch ${branch} merge job reported ` +
            `merged:true but returned no mergePostSha; the fast-forward may not have ` +
            `advanced ${integrationBranch}. Branch preserved for investigation.`
          )
          const phantomSignature = computeFailureSignature('merge:phantom-merge', phantomMsg)
          console.error(`[merge] task ${taskId} phantom-merge detected: ${phantomMsg}`)
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: phantomMsg,
              failedPhase: 'merge',
              failureReason: MERGE_PHANTOM_MERGE_SIGNATURE,
              failureSignature: phantomSignature,
              failureReasonCode: MERGE_PHANTOM_MERGE_SIGNATURE,
            },
            store,
          )
          throw new WorkflowTerminalError(
            'merge-phantom-merge',
            phantomMsg,
          )
        }

        // Restore the pre-flight checkpoint if one was captured during setup.
        // When the setup step auto-stashed .mars/ orchestrator artifacts (all
        // dirt was under .mars/, so setup proceeded transparently), the
        // checkpoint ref `refs/mars/checkpoint/<taskId>-preflight` holds a
        // stash commit. Restore it now so the integration checkout returns to
        // its pre-stash state, then delete the ref. On failure we log and
        // move on — the ref is preserved so the operator can recover manually.
        const preflightRef = checkpointRefFor(`${taskId}-preflight`)
        const refProbe = await runTool(
          {
            tool: 'git',
            argv: ['rev-parse', '--verify', preflightRef],
            cwd: mergeRepoRoot,
            taskId,
            originId: trace.originId,
            phase: 'merge',
            expectsFailure: true,
          },
          trace.traceStore,
        ).catch(() => null)
        if (refProbe !== null && refProbe.exitCode === 0) {
          const preflightSha = refProbe.stdout.trim()
          const restoreResult = await resolveVcs()
            .restoreCheckpoint({ cwd: mergeRepoRoot, sha: preflightSha })
            .catch((restoreErr: unknown) => ({
              ok: false as const,
              detail: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
            }))
          if (!restoreResult.ok) {
            console.warn(
              `[merge] task ${taskId}: pre-flight checkpoint restore failed ` +
                `(${preflightRef} preserved for manual recovery): ${restoreResult.detail ?? 'unknown failure'}`,
            )
          }
          await runTool(
            {
              tool: 'git',
              argv: ['update-ref', '-d', preflightRef],
              cwd: mergeRepoRoot,
              taskId,
              originId: trace.originId,
              phase: 'merge',
            },
            trace.traceStore,
          ).catch(() => {
            // Non-fatal — the ref is cosmetic after the restore succeeds.
          })
          console.log(`[merge] task ${taskId}: restored pre-flight .mars/ artifacts from ${preflightRef}`)
        }

        // Do NOT reclaim a worktree another live task is standing on. A
        // recovery shares its ORIGIN's directory and branch
        // (`attachToOriginWorktree`), so removing them here when the recovery
        // merged pulled the tree out from under a row that was still
        // dispatchable — the origin then re-dispatched into a deleted
        // directory (mars-a13334fd did it ten times in under a minute). Keep
        // both when anyone non-terminal still references them; the sweeper
        // (`mars worktree clean` / worktree-prune) reclaims them later, once
        // every referencing row is terminal.
        const dependents = await findLiveWorktreeDependents({
          taskId,
          worktreePath,
          branch,
          store,
        })
        const inFlight = implementStillInFlight()
        if (dependents.length > 0 || inFlight) {
          const reasons: string[] = []
          if (dependents.length > 0) {
            reasons.push(
              `still referenced by ${dependents.length} non-terminal task(s): ` +
                dependents.map((d) => `${d.id}(${d.status})`).join(', '),
            )
          }
          if (inFlight) {
            reasons.push('a coder process is still in flight for this task id')
          }
          console.log(
            `[merge] task ${taskId} merged; PRESERVING worktree ${worktreePath} and branch ${branch} — ` +
              reasons.join('; '),
          )
        } else {
          await resolveVcs().removeWorktree({
            path: worktreePath,
            branch,
            force: true,
            keepBranch: false,
            tombstone: {
              taskId,
              reason: 'merged',
              mergeCommitSha: capturedMergeShas?.mergePostSha ?? null,
            },
            trace: buildTraceIdentity(trace, taskId, 'merge'),
          })
        }
        await updateTask(
          taskId,
          {
            status: 'done',
            failedPhase: null,
            mergeCommitSha: capturedMergeShas?.mergePostSha ?? null,
          },
          store,
        )

        return {
          taskId,
          success: true,
          message: m.conflictResolved
            ? 'merged with vcs-supervisor conflict resolution'
            : 'merged cleanly',
        }
      } catch (error: unknown) {
        // WorkflowTerminalError instances are fully self-handled before being
        // thrown (task already marked failed, fix-task spawned). Pass them
        // through directly so the daemon dispatch loop can suppress the generic
        // implement:crashed re-update without a double DB write.
        if (error instanceof WorkflowTerminalError) throw error

        // Race guard: if the task was already settled in a terminal state (e.g.
        // recovery-exhaustion marked it `failed`) BEFORE the merge step could
        // transition it to `merging`, the initial `updateTask(merging)` call
        // throws `IllegalTransitionError`. The task row is already correct — no
        // further DB update or fix-task spawn is needed. Exit cleanly.
        //
        // This race (recovery_exhausted:merge:crashed/unclassified) was observed
        // on task mars-5d48eda6: the recovery-exhaustion path marked the origin
        // `failed` while the merge supervisor was still advancing it. Without
        // this guard the generic crash-handler's own `updateTask(failed)` call
        // also throws `IllegalTransitionError`, which escapes the catch block as
        // an unclassified crash with a misleading signature.
        if (error instanceof IllegalTransitionError) {
          console.log(
            `[merge] task ${taskId}: already in terminal status '${error.fromStatus}' — merge step skipped (race with recovery-exhaustion)`,
          )
          throw new WorkflowTerminalError(
            'merge-already-terminal',
            `task ${taskId}: already in terminal status '${error.fromStatus}'; merge step skipped`,
          )
        }

        // ── Vega-wedged path ─────────────────────────────────────────────────
        // When mergeBranch's watchdog fires during a vcs-supervisor phase, the
        // merge lock has already been released (inside mergeBranch's finally
        // block) before MergeAbortedError is thrown. Stamp the task failed with
        // a dedicated signature and raise an actionable item so the operator can
        // inspect the worktree and `mars continue` / `mars restart`. No fix-task
        // is spawned — the supervisor session and rebase state are preserved for
        // investigation.
        if (
          error instanceof MergeAbortedError &&
          error.reason === 'watchdog' &&
          /vega|vcs-supervisor|reconcile/i.test(error.lastStep)
        ) {
          const signature = 'merge:vega-wedged'
          const vegaMsg = (
            `vcs-supervisor wedged during merge step for task ${taskId}: ` +
            `watchdog fired after ${Math.round(error.elapsedMs / 1_000)}s ` +
            `during phase '${error.lastStep}'; merge lock released, task stamped failed`
          )
          console.error(`[merge] task ${taskId} vega-wedged:`, vegaMsg)
          await raiseActionQueueItem({
            kind: 'failed',
            category: 'orchestrator',
            priority: 'high',
            title: `Task ${taskId}: vcs-supervisor wedged`,
            body: [
              `The vcs-supervisor (Vega) wedged during the merge step for task \`${taskId}\`.`,
              '',
              `**Last phase:** \`${error.lastStep}\``,
              `**Elapsed:** ${Math.round(error.elapsedMs / 1_000)}s`,
              '',
              `The merge lock has been released. Inspect the worktree at \`${worktreePath}\`` +
                ` and run \`mars continue ${taskId}\` to retry.`,
            ].join('\n'),
            payload: {
              taskId,
              branch,
              worktreePath,
              lastStep: error.lastStep,
              elapsedMs: error.elapsedMs,
            },
            context: { repoRoot: process.env.MARS_REPO ?? null },
            raisedBy: 'merge:vega-wedged',
            signature: `${taskId}:${signature}`,
            originTaskId: taskId,
          }).catch((aqErr) => {
            console.error(
              `[merge] task ${taskId} vega-wedged: failed to raise action-queue item:`,
              aqErr,
            )
          })
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: vegaMsg.slice(0, 1000),
              failedPhase: 'merge',
              failureReason: signature,
              failureSignature: signature,
              failureReasonCode: signature,
            },
            store,
          )
          // Do NOT spawn a fix-task — the operator resolves via `mars continue`
          // or `mars restart` once the vcs-supervisor blockage is cleared.
          throw error
        }

        if (
          error instanceof Error &&
          (error.message.includes('merge:preflight') ||
            error.message.includes('merge pre-flight failed') ||
            error.message.includes('merge aborted; vcs-supervisor could not reconcile') ||
            error.message.includes('merge:vega-timeout') ||
            error.message.includes('merge:main-dirty') ||
            error.message.includes('merge:integration-gate') ||
            error.message.includes('merge:post-merge-assertion') ||
            // Zero-commit / work-lost: task already marked failed + action-queue item raised.
            // Re-throw without spawning a fix task (the operator resolves via continue).
            error.message.includes('merge:zero-commit-branch') ||
            error.message.includes(MERGE_WORK_LOST_SIGNATURE) ||
            error.message.includes(MERGE_PHANTOM_MERGE_SIGNATURE))
        ) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[merge] task ${taskId} crashed:`, error)
        const crashMsg = `merge step crashed: ${message}`.slice(0, 1000)
        let crashSignature: string
        if (error instanceof MergeAbortedError && error.reason === 'watchdog') {
          crashSignature = 'merge:crashed/watchdog-' + error.lastStep.replace(/[^a-z0-9-]/gi, '-')
        } else {
          crashSignature = computeFailureSignature('merge:crashed', crashMsg)
        }
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: crashMsg,
            failedPhase: 'merge',
            failureReason: crashMsg,
            failureSignature: crashSignature,
            failureReasonCode: crashSignature,
          },
          store,
        )
        await handleTaskFailureWithFixTask({
          taskId,
          failingStep: 'merge:crashed',
          errorOutput: message,
          branch,
          store,
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${taskId} merge crash handling errored:`,
            err,
          )
        })
        throw error instanceof Error ? error : new Error(message)
      } finally {
        // Unconditional: clear the heartbeat interval whether the merge
        // succeeded, was aborted, or crashed so no tick fires after this step.
        clearInterval(heartbeatTimer)
      }
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared contract for bound merge supervision (PRD bf7bbd39).
//
// Four consumer slices all modify code that touches the merge step:
//   - "Emit periodic merge progress heartbeat"
//   - "Bound merge step with a hard wall-clock timeout"
//   - "Idempotent short-circuit when task is already terminal"
//   - "Wedged vcs-supervisor releases merge lock with actionable failure"
//
// These are the types, interfaces, constants, and error classes they share.
// No runtime logic below this line — pure types, constants, and one error
// class, with no imports, so the contract stays free of circular dependencies
// even though it now shares a module with the `merge` primitive above.
// ─────────────────────────────────────────────────────────────────────────────

// ── Periodic merge heartbeat ──────────────────────────────────────────────────

/**
 * Data emitted by the periodic merge-step heartbeat. The merge primitive and
 * merge worker emit this on a fixed interval so the phantom-task watchdog can
 * distinguish a legitimately long merge from a silently wedged one.
 *
 * Consumer: "Emit periodic merge progress heartbeat"
 */
export interface MergeHeartbeat {
  /** Task currently being merged. */
  taskId: string
  /** Wall-clock milliseconds since the merge step started. */
  elapsedMs: number
  /**
   * Most-recent sub-phase inside `mergeBranch`
   * (e.g. `'acquire-lock'`, `'rebase'`, `'vega'`, `'fast-forward'`,
   * `'integration-gate'`).
   */
  phase: string
  /** `Date.now()` value at emission time (ms since Unix epoch). */
  at: number
}

/**
 * Callback invoked on each heartbeat tick. A returned rejected Promise is
 * silently swallowed — a reporting failure must never abort or slow a merge.
 *
 * Consumer: "Emit periodic merge progress heartbeat"
 */
export type MergeHeartbeatFn = (heartbeat: MergeHeartbeat) => void | Promise<void>

/**
 * Default interval between heartbeat emissions (milliseconds). Override with
 * `MARS_MERGE_HEARTBEAT_INTERVAL_MS`.
 *
 * Consumer: "Emit periodic merge progress heartbeat"
 */
export const DEFAULT_MERGE_HEARTBEAT_INTERVAL_MS = 15_000 // 15 s

// ── Hard step-level wall-clock timeout ───────────────────────────────────────

/**
 * Hard wall-clock ceiling (milliseconds) for the merge STEP, measured from the
 * moment the merge primitive delegates to `enqueueMergeJobAndAwait`.
 *
 * Distinguished from `DEFAULT_WATCHDOG_MS` (the git-level watchdog inside
 * `mergeBranch` that bounds the git work): the step timeout fires when the
 * merge WORKER itself is wedged — it claimed the job but never called
 * `resolveMergeJob`. That scenario is not covered by the internal per-job
 * watchdog.
 *
 * Sized as the sum of the internal per-job watchdog (35 min =
 * `VCS_SUPERVISOR_TIMEOUT_MS` 30 min + `MERGE_GIT_BUDGET_MS` 5 min) and the
 * outer grace window (10 min = `DEFAULT_OUTER_WATCHDOG_GRACE_MS`). This
 * mirrors the existing outer timeout in `enqueueMergeJobAndAwait` so the two
 * timeout values are derived from the same constant and cannot drift apart.
 *
 * Override with `MARS_MERGE_STEP_TIMEOUT_MS`.
 *
 * Consumer: "Bound merge step with a hard wall-clock timeout"
 */
export const DEFAULT_MERGE_STEP_TIMEOUT_MS = 45 * 60_000 // 45 min

/**
 * Failure reason code (and action-queue title fragment) stamped when the
 * step-level hard timeout fires and the merge step is aborted.
 *
 * Consumer: "Bound merge step with a hard wall-clock timeout"
 */
export const MERGE_STEP_TIMEOUT_FAILURE_REASON = 'merge:step-timeout' as const

// ── Idempotent terminal short-circuit ─────────────────────────────────────────

/**
 * Task statuses that mean the merge step is a safe no-op. When the merge
 * primitive observes one of these statuses at entry time, it short-circuits
 * and returns without enqueueing a new merge job.
 *
 * Rationale: a `mars continue` re-entry of a task that already reached a
 * terminal state (e.g. because `resolveMergeJob` ran on a prior attempt but
 * the step-completion record was lost to a daemon restart) would otherwise
 * re-run the full merge and produce a double-done or a dirty-tree error.
 *
 * The set mirrors `TERMINAL_TASK_STATUSES` from `core/queue.ts` (`done`,
 * `failed`, `dropped`). It is redefined here to keep this module
 * dependency-free; a runtime assertion in the test suite guarantees the two
 * sets agree.
 *
 * Consumer: "Idempotent short-circuit when task is already terminal"
 */
export const MERGE_IDEMPOTENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'dropped',
])

/**
 * Failure reason code logged (at debug level — this is not a real failure)
 * when the merge step short-circuits on an already-terminal task.
 *
 * Consumer: "Idempotent short-circuit when task is already terminal"
 */
export const MERGE_ALREADY_TERMINAL_REASON = 'merge:already-terminal' as const

// ── Post-Vega transient abort ──────────────────────────────────────────────────

/**
 * Failure reason code stamped when the vcs-supervisor (Vega) COMPLETED
 * successfully (`conflictResolved: true`) but a subsequent step —
 * fast-forward CAS, integration-gate call, or a transient network error —
 * aborted the merge before the ref was advanced.
 *
 * This is NOT a Vega failure: the resolved rebase is already persisted on the
 * task branch. A `mars continue` retries just the merge step and succeeds
 * cleanly without re-invoking Vega.
 *
 * Distinct from `merge:vcs-supervisor-aborted` (Vega could not reconcile) and
 * `merge:vega-timeout` (Vega was killed mid-run). No fix-task is spawned for
 * this reason; the recovery budget is not consumed.
 */
export const MERGE_ENV_UNREACHABLE_REASON = 'merge:env-unreachable' as const

// ── Wedged vcs-supervisor ─────────────────────────────────────────────────────

/**
 * Thrown when the vcs-supervisor holds the merge lock longer than
 * `DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS` without emitting a recorded
 * progress event, indicating it is permanently stuck.
 *
 * The merge primitive catches this error, releases the merge lock, raises an
 * actionable `failed` action-queue item (kind `failed`, signature
 * `merge:wedged-vcs-supervisor`), and stamps the task `failed`. The operator
 * can then inspect the worktree (the vcs-supervisor session and any rebase
 * state are preserved) and `mars continue` the task once the blockage is
 * resolved.
 *
 * Consumer: "Wedged vcs-supervisor releases merge lock with actionable failure"
 */
export class WedgedVcsSupervisorError extends Error {
  readonly taskId: string
  readonly lockHeldMs: number
  readonly lastPhase: string

  constructor(taskId: string, lockHeldMs: number, lastPhase: string) {
    super(
      `merge:wedged-vcs-supervisor — task ${taskId}: vcs-supervisor held the merge lock ` +
        `for ${Math.round(lockHeldMs / 1_000)}s without progress (last phase: ${lastPhase}); ` +
        `lock released, actionable failure raised`,
    )
    this.name = 'WedgedVcsSupervisorError'
    this.taskId = taskId
    this.lockHeldMs = lockHeldMs
    this.lastPhase = lastPhase
  }
}

/**
 * How long (milliseconds) the vcs-supervisor may hold the merge lock without
 * emitting a progress event before the merge step declares it wedged and
 * throws `WedgedVcsSupervisorError`. Override with
 * `MARS_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS`.
 *
 * Must be generous enough to allow the supervisor to finish a complex
 * multi-file conflict resolution (typical: 5–15 min) while staying well below
 * the 30-minute `VCS_SUPERVISOR_TIMEOUT_MS` so a truly wedged session is
 * detected before the supervisor's own wall-clock budget fires.
 *
 * Consumer: "Wedged vcs-supervisor releases merge lock with actionable failure"
 */
export const DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS = 20 * 60_000 // 20 min

/**
 * Failure reason code stamped when the wedged-supervisor heuristic fires.
 *
 * Consumer: "Wedged vcs-supervisor releases merge lock with actionable failure"
 */
export const MERGE_WEDGED_VCS_SUPERVISOR_REASON = 'merge:wedged-vcs-supervisor' as const

// ── Work-lost zero-commit branch ──────────────────────────────────────────────

/**
 * Failure reason code stamped when the zero-commit guard fires AND the merge
 * step finds evidence that this task previously had commits (a parked ref
 * written by `recoverPhase` during a stale-merging-sweep eviction, or a
 * checkpoint ref written by the code step).
 *
 * Distinct from `merge:zero-commit-branch` (task never produced commits) —
 * this indicates the commits existed but were lost before reaching the
 * integration branch (e.g. the branch was reset by an eviction while the
 * original merge job was still queued). The parked ref carries the lost
 * commits; `mars continue` can restore them.
 *
 * Root cause: mars-59c9fdb0 (2026-09-04) — stale-merging-sweep eviction reset
 * the branch while an old merge job was in the queue; the re-queued code step
 * created a fresh zero-commit branch; the old merge job ran on the fresh branch
 * and produced a false-green done with mergeCommitSha: null.
 */
export const MERGE_WORK_LOST_SIGNATURE = 'merge:work-lost' as const

/**
 * Ref namespace under which `recoverPhase` parks branch tips before clearing
 * the task row's branch pointer during a stale-merging-sweep eviction.
 *
 * Format: `refs/mars/parked/<taskId>/<timestamp-ms>`
 *
 * The merge step's work-lost guard probes `refs/mars/parked/<taskId>` via
 * `git for-each-ref` to detect prior commits on a zero-commit branch.
 */
export const PARKED_REF_PREFIX = 'refs/mars/parked' as const

// ── Phantom-merge condition ───────────────────────────────────────────────────

/**
 * Failure reason code stamped when the merge step detects a phantom merge:
 * the merge job reported `merged: true` but returned no `mergePostSha`.
 *
 * A null `mergePostSha` means the fast-forward did not produce a new SHA —
 * the integration branch was not actually advanced. Writing a tombstone with
 * `{reason: 'merged', mergeCommitSha: null}` and marking the task done in
 * this state is the P3 bug (observed on mars-59c9fdb0). The phantom-merge
 * guard catches this case and stamps the task failed instead.
 *
 * The corresponding derived action-queue condition (`phantom-merge`) is raised
 * when a done-task tombstone has `reason=merged` and `mergeCommitSha=null`.
 */
export const MERGE_PHANTOM_MERGE_SIGNATURE = 'merge:phantom-merge' as const
