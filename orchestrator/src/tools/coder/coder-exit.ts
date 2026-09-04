/**
 * Coder exit classification and the coder commit contract — the recovery /
 * failure half of the `runAgent` primitive.
 *
 * Split out of `tools/coder/run-agent.ts` (docs/rework/MIGRATION.md Phase D
 * hazard note: "split the exit classification into coder-exit.ts; keep the
 * rest in run-agent.ts"). Bodies are moved verbatim — no behaviour change.
 *
 * FRAMEWORK-OWNED, ARC FUNNEL INTACT (ADR-0052). This module is the other half
 * of one primitive shell, not a tool: every write below goes through the
 * `store` (`DomainTaskStore`) the shell was given, exactly as it did when
 * this code sat inline in `runAgent`. A swapped coder tool never reaches any
 * of it — it hands back a run outcome and this module decides what the task
 * row becomes.
 *
 * Two entry points, called back-to-back by `runAgent`:
 *
 *  1. {@link classifyCoderExit} — everything that makes the run itself a
 *     failure: context-budget exhaustion, a provider quota rejection, and any
 *     other non-zero exit (with the wip-checkpoint salvage and the
 *     coder-failure artifact). Each path throws a `WorkflowTerminalError`;
 *     returning normally means the coder exited 0.
 *  2. {@link enforceCoderCommitContract} — the post-condition on a *successful*
 *     exit: the coder must hand over a clean worktree with committed work.
 *     Covers the empty-diff guard and the two-stage dirty-tree escalation
 *     (corrective coder turn, then the deterministic auto-commit net).
 */
import { runTool } from '../../core/lib/run-tool'
import {
  SALVAGE_CHECKPOINT_SUBJECT_PREFIX,
  SALVAGE_CHECKPOINT_TRAILER_KEY,
  SALVAGE_CHECKPOINT_TRAILER_VALUE,
} from '../../core/ports/vcs/types'
import { resolveVcs } from '../../core/ports/vcs/registry'
import { type Worker } from '../../core/workers'
import { extractLastStreamText, type AgentEvent } from '../../core/lib/claude-stream'
import { type TaskTag, getTask, updateTask } from '../../core/queue'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { runWorkerWithSpan } from '../../core/lib/run-worker-with-span'
import {
  detectPostCoderState,
  resolveWorkerSystemPrompt,
  coderUncommittedFailure,
  CODER_EXIT_NONZERO_ABORT_MESSAGE,
  CODER_EMPTY_DIFF_ABORT_MESSAGE,
  CODER_EMPTY_DIFF_SIGNATURE,
  CODER_EMPTY_DIFF_STEP,
  CODER_UNCOMMITTED_ABORT_MESSAGE,
  CODER_UNCOMMITTED_SIGNATURE,
  CODER_UNCOMMITTED_STEP,
  CONTEXT_EXHAUSTED_ABORT_MESSAGE,
  QUOTA_REJECTED_ABORT_MESSAGE,
  POST_CODER_CLASSIFIER_ERROR_ABORT_MESSAGE,
  POST_CODER_CLASSIFIER_ERROR_SIGNATURE,
  POST_CODER_CLASSIFIER_ERROR_STEP,
} from '../../workflows/primitives/shared'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type MarsCtx, type PrimitiveTraceArgs, buildPhaseCtx, spanStore } from '../context'

/** What the worker span handed back. Structural, so a fake is easy to build. */
/**
 * The full result of one `runWorkerWithSpan` call. Distinct from
 * {@link CoderRunOutcome} below, which is the deliberately minimal,
 * import-free shape the pure disposition classifier matches against.
 */
export type CoderWorkerRunResult = Awaited<ReturnType<typeof runWorkerWithSpan>>

/** The task row as `runAgent` read it, or null when the read failed. */
export type CoderTaskRow = Awaited<ReturnType<TaskStore['getTask']>> | null

/** How the branch ended up with its commits — stamped on the post-coder trace. */
export type CommitSource = 'self' | 'corrected' | 'net' | 'no-work' | 'unknown'

/**
 * Attempt to preserve a dirty worktree as a `wip(checkpoint)` commit after a
 * code-phase failure, and describe the outcome in one line reused for the
 * task `error` column, the coder-failure artifact, and the recovery prompt.
 *
 * Shared by every code-phase failure path in {@link classifyCoderExit}
 * (context-exhausted, coder-exit-nonzero, and any future terminal exit code)
 * so an operator deciding between `mars continue` and the destructive
 * `mars restart`/`mars drop` always sees the same "worktree was clean at
 * exit" / "worktree had N uncommitted path(s)" wording regardless of which
 * failure path fired — see the mars-b1f78349 incident note: a
 * context-exhausted failure carrying 145 uncommitted lines reported nothing
 * about them because only the coder-exit-nonzero path ran this check.
 *
 * Writing the checkpoint here (at failure time) rather than leaving it to
 * `mars continue` means the work is durable and legible the moment it is at
 * risk — an operator who reaches for `mars restart`/`mars drop` first (before
 * `mars continue`) still sees it. `mars continue`'s own best-effort
 * checkpoint-before-resume step is unaffected: it just finds nothing to add
 * when this already ran.
 */
const checkpointDirtyWorktree = async (args: {
  taskId: string
  originId: string
  branch: string
  worktreePath: string
  integrationBranch: string
  trace: PrimitiveTraceArgs
  exitCode: number
  /** Short cause phrase for the commit subject, e.g. "coder killed" or "coder ran out of context". */
  killCause: string
}): Promise<{ checkpointFiles: string[] | null; worktreeNote: string }> => {
  const { taskId, originId, branch, worktreePath, integrationBranch, trace, exitCode, killCause } =
    args

  // Before reporting failure, detect whether the coder did real work before
  // it was killed. A watchdog kill, timeout, context-budget abort, or quota
  // death can leave completed but uncommitted changes in the worktree — work
  // that would be silently lost if the fixer starts from a clean tree (or an
  // operator restarts/drops the task before ever looking). Preserve those
  // changes as a wip(checkpoint) commit so the recovery fixer inherits a
  // reviewable, rebuildable baseline. The marker is intentionally
  // unambiguous so the fixer can distinguish checkpointed WIP from
  // deliberate commits and knows not to merge as-is.
  let checkpointFiles: string[] | null = null
  try {
    const postState = await detectPostCoderState({
      worktreePath,
      integrationBranch,
      traceCtx: buildPhaseCtx(trace, taskId, 'code'),
    })
    if (
      postState.kind === 'dirty-no-commits' ||
      postState.kind === 'dirty-with-commits'
    ) {
      // Branch-safety guard: the checkpoint commit must land ONLY on the
      // task's own branch (task/<id>), never on the integration branch
      // (`main`) or any other freeform branch. The 2026-08-05 incident
      // (commit 93addc75) was caused by this path committing to `main` when
      // the worktreePath resolved to the main checkout.
      const headBranchR = await runTool(
        {
          tool: 'git',
          argv: ['rev-parse', '--abbrev-ref', 'HEAD'],
          cwd: worktreePath,
          taskId,
          originId,
          phase: 'code',
        },
        trace.traceStore,
      )
      const headBranch = headBranchR.exitCode === 0 ? headBranchR.stdout.trim() : null
      if (headBranch !== branch) {
        const isOnMain = headBranch === 'main' || headBranch === 'master'
        const refusalReason = isOnMain
          ? `HEAD is on the integration branch '${headBranch}' — wip(checkpoint) commits must land on the task branch '${branch}'`
          : `HEAD is on '${headBranch ?? '(detached)'}', expected task branch '${branch}'`
        console.warn(
          `[code] task ${taskId}: SKIPPING wip(checkpoint) commit — branch guard tripped: ${refusalReason}. ` +
            `Dirty paths (${postState.dirtyFiles.length}): ${postState.dirtyFiles.slice(0, 10).join(', ')}`,
        )
        // Raise an operator alert so the uncommitted work is not silently lost.
        await raiseActionQueueItem({
          kind: 'failed',
          category: 'orchestrator',
          priority: 'urgent',
          title: `Task ${taskId}: wip-checkpoint BLOCKED — wrong branch '${headBranch ?? '(detached)'}' (expected '${branch}')`,
          body: [
            `Task ${taskId}'s coder exited with exit code ${exitCode} leaving ${postState.dirtyFiles.length} uncommitted path(s),`,
            `but the wip(checkpoint) commit was BLOCKED because the worktree HEAD is on`,
            `'${headBranch ?? '(detached HEAD)'}' instead of the task's own branch '${branch}'.`,
            '',
            isOnMain
              ? `This is the scenario that produced commit 93addc75 on main (2026-08-05 incident). Nothing was committed.`
              : `Committing to a non-task branch would land work on an unowned branch.`,
            '',
            'The uncommitted work may be lost. Inspect the worktree manually:',
            `  Worktree: ${worktreePath}`,
            `  Actual HEAD branch: ${headBranch ?? '(detached HEAD)'}`,
            `  Expected branch: ${branch}`,
            '',
            'Dirty paths:',
            ...postState.dirtyFiles.map((f) => `  ${f}`),
          ].join('\n'),
          payload: {
            taskId,
            worktreePath,
            actualBranch: headBranch,
            expectedBranch: branch,
            dirtyFiles: postState.dirtyFiles,
            coderExitCode: exitCode,
          },
          context: { repoRoot: process.env.MARS_REPO ?? null },
          raisedBy: 'workflow:code:wip-checkpoint-branch-guard',
          signature: `wip-checkpoint-branch-guard:${taskId}`,
          originTaskId: taskId,
        }).catch((raiseErr) => {
          console.error(
            `[code] task ${taskId}: wip-checkpoint branch-guard action-queue raise errored:`,
            raiseErr,
          )
        })
      } else {
        // Branch is correct — proceed with the checkpoint commit.
        const addR = await runTool(
          {
            tool: 'git',
            argv: ['add', '-A'],
            cwd: worktreePath,
            taskId,
            originId,
            phase: 'code',
          },
          trace.traceStore,
        )
        if (addR.exitCode === 0) {
          // The subject line is a human-legible label; the trailer below is
          // the STRUCTURAL marker the merge step gates on (see
          // checkpoint.ts's isSalvageCheckpointCommit) so a human commit
          // that happens to start with the same subject text is never
          // mistaken for an orchestrator salvage snapshot.
          const commitMsg = `${SALVAGE_CHECKPOINT_SUBJECT_PREFIX} ${killCause} (exit ${exitCode}) with ${postState.dirtyFiles.length} uncommitted path(s) — do not merge as-is\n\n${SALVAGE_CHECKPOINT_TRAILER_KEY}: ${SALVAGE_CHECKPOINT_TRAILER_VALUE}`
          const commitR = await runTool(
            {
              tool: 'git',
              argv: ['commit', '-m', commitMsg],
              cwd: worktreePath,
              taskId,
              originId,
              phase: 'code',
            },
            trace.traceStore,
          )
          if (commitR.exitCode === 0) {
            checkpointFiles = postState.dirtyFiles
            console.log(
              `[code] task ${taskId}: checkpointed ${postState.dirtyFiles.length} uncommitted path(s) as wip(checkpoint) commit (exit ${exitCode})`,
            )
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[code] task ${taskId}: checkpoint attempt failed, continuing:`, err)
  }

  const worktreeNote =
    checkpointFiles !== null
      ? `worktree had ${checkpointFiles.length} uncommitted path(s); preserved as wip(checkpoint) commit on branch ${branch}`
      : 'worktree was clean at exit (no uncommitted work found)'

  return { checkpointFiles, worktreeNote }
}

/**
 * Classify a finished coder run and fail the task when the run itself failed.
 *
 * Returns normally only when the coder exited 0; every other shape stamps the
 * task through `store`, spawns at most one recovery fix-task, and throws a
 * `WorkflowTerminalError`.
 */
export const classifyCoderExit = async (args: {
  r: CoderWorkerRunResult
  taskId: string
  store: TaskStore
  branch: string
  worktreePath: string
  integrationBranch: string
  trace: PrimitiveTraceArgs
  originId: string
  sessionKey: string
}): Promise<void> => {
  const {
    r,
    taskId,
    store,
    branch,
    worktreePath,
    integrationBranch,
    trace,
    originId,
    sessionKey,
  } = args

  // Context-budget hard abort: spawn a resume fix-task and throw the sentinel.
  if (r.exitCode === 138 && r.stderr.includes('context budget exhausted')) {
    // Same worktree-dirt detection + wip(checkpoint) salvage as the
    // coder-exit-nonzero path below. Context exhaustion is the failure mode
    // most likely to leave substantial uncommitted work — the coder was
    // mid-task, not bailing — so recording (and preserving) worktree state
    // here matters at least as much as it does there.
    const { checkpointFiles, worktreeNote } = await checkpointDirtyWorktree({
      taskId,
      originId,
      branch,
      worktreePath,
      integrationBranch,
      trace,
      exitCode: r.exitCode,
      killCause: 'coder ran out of context',
    })
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: `context-exhausted: coder hit the context token budget limit. ${worktreeNote}`,
        failedPhase: 'code',
        failureReason: 'context-exhausted',
        failureReasonCode: 'context-exhausted',
        // Self-heal keys off `failure_signature`, not `failure_reason_code`:
        // a NULL here hides the failure from recipe matching, the storm streak
        // counter and the Steward brief.
        failureSignature: computeFailureSignature(
          'code:context-exhausted',
          'context budget exhausted (maxContextTokens) mid-code',
        ),
      },
      store,
    )
    await handleTaskFailureWithFixTask({
      taskId,
      failingStep: 'code:context-exhausted',
      errorOutput: `context budget exhausted (maxContextTokens) mid-code; ${worktreeNote}`,
      branch,
      store,
      recipeContext: {
        targetPath: worktreePath,
        statusOutput:
          checkpointFiles !== null
            ? `The coder ran out of context budget mid-implementation. The worktree had ${checkpointFiles.length} uncommitted path(s) which have been preserved as a wip(checkpoint) commit on branch ${branch}. Review the checkpoint (\`git -C ${worktreePath} log -p -1\`) and continue from there — do NOT redo work that is already in the checkpoint commit.`
            : `The coder ran out of context budget mid-implementation. The worktree at ${worktreePath} was clean at exit (no uncommitted work found) — everything it did was already committed.`,
        targetBranch: branch,
        originalPrompt: '',
      },
    })
    console.log(
      `[ctx] task ${taskId}: context-exhausted; ${worktreeNote}; recovery fix-task spawned to resume the existing worktree`,
    )
    throw new WorkflowTerminalError('context-exhausted', CONTEXT_EXHAUSTED_ABORT_MESSAGE(taskId))
  }

  // Provider rate/spend-limit rejection (GLOBAL ENVIRONMENTAL CONDITION).
  //
  // When the provider rejects the run before the coder can do any work (e.g.
  // monthly spend limit, five-hour rate limit), the Claude CLI emits a
  // `rate_limit_event` followed by a `result` event with is_error:true and
  // api_error_status:429, then exits non-zero. This is NOT a code failure —
  // the coder never ran, the worktree is untouched, and spawning a recovery
  // fix-task would instantly hit the same rejection and burn the single
  // recovery slot with nothing to show for it.
  //
  // Correct response: re-queue with the worktree intact, throw a quota-
  // rejection sentinel that the daemon catches to pause dispatch until
  // resetsAt and raise exactly one level-triggered action-queue row.
  if (r.exitCode !== 0 && r.quotaRejected !== null) {
    // Increment the quota-rejected counter so the poll-fallback ceiling can
    // discount these attempts. Fetch the current value for a safe increment;
    // the task semaphore guarantees one active coder per task so no race.
    const currentTask = await getTask(taskId, store)
    const nextQuotaRejectedAttempts = (currentTask?.quotaRejectedAttempts ?? 0) + 1
    await updateTask(taskId, { status: 'queued', quotaRejectedAttempts: nextQuotaRejectedAttempts }, store)
    console.log(
      `[code] task ${taskId}: env-rejected by provider quota (resetsAt=${r.quotaRejected.resetsAt}); re-queued; quotaRejectedAttempts=${nextQuotaRejectedAttempts}`,
    )
    throw new WorkflowTerminalError('quota-rejected', QUOTA_REJECTED_ABORT_MESSAGE(taskId, r.quotaRejected.resetsAt), { resetsAt: r.quotaRejected.resetsAt })
  }

  // API connectivity failure (ENOTFOUND / ECONNREFUSED / EAI_AGAIN /
  // api_retry@max_retries / terminal_reason:api_error).
  //
  // Design decisions (2026-09-03 dns-outage incident post-mortem):
  //
  // 1. BACKOFF: No explicit per-task backoff timer. The dispatch loop's
  //    natural overhead (queue polling, semaphore scheduling) provides de facto
  //    spacing between attempts, and DNS outages resolve in seconds to minutes
  //    — well inside the 2-hour requeue-ceiling window. Adding a per-task
  //    sleep-then-requeue would require either a background timer (complexity)
  //    or a new scheduler field (schema change). The existing
  //    REQUEUE_MAX_RETRY_MS guard (2 h) is the backstop if a network partition
  //    persists. Revisit if future incidents show a need for explicit delay.
  //
  // 2. BOUNDING: ENV_API_UNREACHABLE_MAX_ATTEMPTS (10) — a generous ceiling
  //    matching the Claude CLI's own api_retry limit. After this many env-
  //    unreachable re-queues the task fails with `env:api-unreachable` and an
  //    operator action-queue item. The fix-task recovery budget (ADR-0040) is
  //    NOT consumed — this path never calls handleTaskFailureWithFixTask.
  //    The envApiUnreachableAttempts counter is discounted from the
  //    requeue-ceiling effective-attempt count so env failures do not trigger
  //    the "stuck in re-queue" escalation.
  if (r.exitCode !== 0 && isApiConnectivityFailure(r)) {
    const currentTask = await getTask(taskId, store)
    const nextAttempts = (currentTask?.envApiUnreachableAttempts ?? 0) + 1

    if (nextAttempts <= ENV_API_UNREACHABLE_MAX_ATTEMPTS) {
      // Below ceiling — re-queue WITHOUT consuming the fix-task recovery slot.
      await updateTask(
        taskId,
        { status: 'queued', envApiUnreachableAttempts: nextAttempts },
        store,
      )
      console.log(
        `[code] task ${taskId}: env-api-unreachable (attempt ${nextAttempts}/${ENV_API_UNREACHABLE_MAX_ATTEMPTS}); re-queued without fix-task`,
      )
      throw new WorkflowTerminalError(
        'env-api-unreachable',
        `task ${taskId} re-queued: API unreachable (attempt ${nextAttempts}/${ENV_API_UNREACHABLE_MAX_ATTEMPTS}); network connectivity failure, not a code defect`,
      )
    }

    // Ceiling reached — fail for real with a distinct signature so the storm
    // breaker and action queue can distinguish it from code:coder-exit-nonzero.
    // Still no fix-task: an operator alert is the correct escalation when the
    // network has been broken for this many consecutive attempts.
    const errorMsg = `env-api-unreachable ceiling reached (${nextAttempts} attempts): API was unreachable for all ${nextAttempts} dispatch attempts — DNS or network failure, not a code defect`
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: errorMsg,
        failedPhase: 'code',
        failureReason: 'env:api-unreachable',
        failureReasonCode: 'env:api-unreachable',
        failureSignature: computeFailureSignature(
          'env:api-unreachable',
          'API Error: Unable to connect to API ENOTFOUND',
        ),
        envApiUnreachableAttempts: nextAttempts,
      },
      store,
    )
    await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'urgent',
      title: `Task ${taskId}: env-api-unreachable ceiling reached (${nextAttempts} attempts)`,
      body: [
        `Task ${taskId} failed to reach the API ${nextAttempts} consecutive times (ceiling: ${ENV_API_UNREACHABLE_MAX_ATTEMPTS}).`,
        `This is a network-level failure (ENOTFOUND / ECONNREFUSED / EAI_AGAIN), not a code defect.`,
        `The fix-task recovery budget was NOT consumed — this is an operator-resolvable condition.`,
        ``,
        `Resolve: check network connectivity, then \`mars continue ${taskId}\` to resume.`,
      ].join('\n'),
      payload: { taskId, envApiUnreachableAttempts: nextAttempts },
      context: { repoRoot: process.env.MARS_REPO ?? null },
      raisedBy: 'workflow:code:env-api-unreachable-ceiling',
      signature: `env-api-unreachable-ceiling:${taskId}`,
      originTaskId: taskId,
    }).catch((raiseErr) => {
      console.error(
        `[code] task ${taskId}: env-api-unreachable ceiling action-queue raise errored:`,
        raiseErr,
      )
    })
    console.log(
      `[code] task ${taskId}: env-api-unreachable ceiling reached (${nextAttempts} attempts); task failed with env:api-unreachable signature`,
    )
    throw new WorkflowTerminalError(
      'env-api-unreachable-ceiling',
      `task ${taskId} failed: env-api-unreachable ceiling reached (${nextAttempts} attempts)`,
    )
  }

  // Catch-all for any OTHER non-zero coder exit (138/context-exhausted is the
  // only sentinel handled above). Previously such an exit fell straight through
  // to the normal return: verify then no-ops on the untouched worktree and an
  // empty diff merges as a false "done". A real example is claude rejecting a
  // bad --session-id ("Invalid session ID. Must be a valid UUID.") and exiting
  // before doing any work. Treat it as a code-phase failure: stamp the task,
  // spawn exactly one recovery fix-task, and throw to stop before verify/merge.
  if (r.exitCode !== 0) {
    // --- Termination cause ---------------------------------------------------
    // Map well-known exit codes to a human-readable cause. SIGKILL (137) and
    // SIGTERM (143) come from `runSubprocessStreaming`'s fixed close handler
    // (which now maps `signal` to the conventional 128+N codes). 124 is the
    // timeout sentinel. 138 is context-budget exhaustion / external abort.
    // `transportDropped` is checked FIRST, ahead of the exit-code ladder: a
    // dropped provider connection can surface under any exit code, and
    // reaching this point at all means the bounded immediate-retry loop in
    // `run-agent.ts` already tried once and hit the same drop again — name
    // the transport as the cause instead of blaming the coder or a generic
    // "unclassified" exit.
    const terminationCause =
      r.transportDropped === true
        ? 'provider-transport-dropped (connection closed mid-response)'
        : r.exitCode === 137
          ? 'killed-by-SIGKILL'
          : r.exitCode === 143
            ? 'killed-by-SIGTERM'
            : r.exitCode === 124
              ? 'timed-out'
              : r.exitCode === 138
                ? 'aborted (context-budget or external cancel)'
                : `natural-exit-or-unclassified (exit ${r.exitCode})`

    // --- Zero-message detection ----------------------------------------------
    // When the coder did not exchange even one message with the provider it
    // did not attempt the work — the exit was a startup, auth, or
    // recursion-guard failure. Name it explicitly so operators are not left
    // guessing why the worktree is clean and the stderr is sparse.
    const messageCount = r.conversation.length
    const zeroMessageNote =
      messageCount === 0
        ? ' ZERO MESSAGES EXCHANGED WITH PROVIDER (coder did not attempt the work — likely a startup, auth, or recursion-guard failure).'
        : ''

    // --- Bounded head + tail capture -----------------------------------------
    // Head matters: auth / startup failures print early and scroll away before
    // the tail. Keep the first 2 kB AND the last 2 kB of each stream so that
    // both early errors and final-state messages are always preserved.
    const HEAD_CHARS = 2000
    const TAIL_CHARS = 2000
    const stdoutLen = r.stdout.length
    const stderrLen = r.stderr.length
    const stdoutHead = r.stdout.slice(0, HEAD_CHARS)
    const stdoutTail = stdoutLen > HEAD_CHARS ? r.stdout.slice(-TAIL_CHARS) : ''
    const stderrHead = r.stderr.slice(0, HEAD_CHARS)
    const stderrTail = stderrLen > HEAD_CHARS ? r.stderr.slice(-TAIL_CHARS) : ''

    // diagText drives the task `error` column and the failure signature. It
    // uses the stderr tail (last chunk) for compat with existing signature
    // recipes and tests; the full head+tail are in the artifact file.
    const stderrTailForDiag = r.stderr.trim().slice(-1000)
    // When the claude CLI dies from an API-level rejection (e.g. monthly spend
    // limit, auth error) it exits non-zero but writes nothing to stderr — the
    // actual cause arrives in the event stream as a `result` event or a final
    // assistant message. Fall back to that text so the task `error` field is
    // diagnosable without reading the raw transcript.
    const diagText =
      stderrTailForDiag.length > 0
        ? `stderr tail:\n${stderrTailForDiag}`
        : (() => {
            const streamText = extractLastStreamText(r.conversation)
            return streamText
              ? `stderr empty; last stream text:\n${streamText.slice(-500)}`
              : `stderr empty; no stream text captured`
          })()

    // Detect-and-salvage the worktree before reporting failure. Identical to
    // the context-exhausted path above — see `checkpointDirtyWorktree`.
    const { checkpointFiles, worktreeNote } = await checkpointDirtyWorktree({
      taskId,
      originId,
      branch,
      worktreePath,
      integrationBranch,
      trace,
      exitCode: r.exitCode,
      killCause: 'coder killed',
    })

    // --- Per-run artifact file -----------------------------------------------
    // Write a bounded head+tail of both stdout and stderr to a named file
    // under .mars/coder-failures/ so `mars diagnose` can find it without
    // having to reconstruct from the truncated `tasks.error` string.
    // Written AFTER the checkpoint so the artifact itself never appears as a
    // dirty file that the checkpoint would commit.
    let artifactPath: string | null = null
    try {
      const failureDir = join(worktreePath, '.mars', 'coder-failures')
      mkdirSync(failureDir, { recursive: true })
      artifactPath = join(failureDir, `${sessionKey}.log`)
      const artifactLines: string[] = [
        `=== coder-failure: task=${taskId} session=${sessionKey} ===`,
        `exit-code: ${r.exitCode}`,
        `termination-cause: ${terminationCause}`,
        `messages-exchanged: ${messageCount}`,
        `worktree: ${worktreeNote}`,
        '',
        `--- stdout (${stdoutLen} chars total; head=${Math.min(HEAD_CHARS, stdoutLen)}) ---`,
        stdoutHead,
        ...(stdoutTail.length > 0
          ? [`--- stdout tail (last ${stdoutTail.length} chars) ---`, stdoutTail]
          : []),
        '',
        `--- stderr (${stderrLen} chars total; head=${Math.min(HEAD_CHARS, stderrLen)}) ---`,
        stderrHead,
        ...(stderrTail.length > 0
          ? [`--- stderr tail (last ${stderrTail.length} chars) ---`, stderrTail]
          : []),
        '',
        '=== end ===',
      ]
      writeFileSync(artifactPath, artifactLines.join('\n'))
    } catch (artifactWriteErr) {
      console.warn(
        `[code] task ${taskId}: failed to write coder-failure artifact:`,
        artifactWriteErr,
      )
      artifactPath = null
    }
    const artifactNote =
      artifactPath !== null ? ` Diagnostic artifact: ${artifactPath}` : ''

    // When the coder exits by SIGTERM (143) or SIGKILL (137) — a process kill,
    // not a code defect — prepend a sentinel line that mirrors the pattern
    // `runVerifyStep` uses for verify:killed. `computeFailureSignature` detects
    // this marker first and overrides the nominal `code:coder-exit-nonzero` gate
    // with `code:killed/sigterm` or `code:killed/sigkill`, routing the failure
    // to the environmental re-queue path instead of spawning a recovery Chore.
    const signalName =
      r.exitCode === 143 ? 'SIGTERM' : r.exitCode === 137 ? 'SIGKILL' : null
    const signalMarker =
      signalName !== null ? `code child killed by ${signalName} (exit ${r.exitCode})\n` : ''

    // One string, two consumers: the row's `error` column and the signature the
    // failure handler computes. Deriving both from the same text keeps the
    // stamped signature identical to the one the handler mints, so
    // `upsertFixTask`'s (taskId, signature) dedup agrees across the two paths.
    const coderExitOutput = `${signalMarker}coder process exited ${r.exitCode}.${zeroMessageNote} ${worktreeNote}. ${diagText}${artifactNote}`
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: `coder exited ${r.exitCode} before completing; termination: ${terminationCause};${zeroMessageNote} ${diagText}${artifactNote}`,
        failedPhase: 'code',
        failureReason: 'coder-exit-nonzero',
        failureReasonCode: 'coder-exit-nonzero',
        // Without this the row lands with a NULL signature and is invisible to
        // recipe matching (`code:coder-exit-nonzero/api-unreachable` and
        // friends), the storm streak counter and the Steward brief.
        failureSignature: computeFailureSignature(
          'code:coder-exit-nonzero',
          coderExitOutput,
        ),
      },
      store,
    )
    await handleTaskFailureWithFixTask({
      taskId,
      failingStep: 'code:coder-exit-nonzero',
      errorOutput: coderExitOutput,
      branch,
      store,
      recipeContext: {
        targetPath: worktreePath,
        statusOutput:
          checkpointFiles !== null
            ? `The coder exited ${r.exitCode} mid-run. The worktree had ${checkpointFiles.length} uncommitted path(s) which have been preserved as a wip(checkpoint) commit on branch ${branch}. Review the checkpoint (\`git -C ${worktreePath} log -p -1\`) and continue from there — do NOT redo work that is already in the checkpoint commit.`
            : `The coder exited ${r.exitCode} and the worktree was clean at exit (no uncommitted work found). Investigate the exit cause from the diagnostic text before retrying.`,
        targetBranch: branch,
        originalPrompt: '',
      },
    })
    console.log(
      `[code] task ${taskId}: coder exited ${r.exitCode}; recovery fix-task spawned`,
    )
    throw new WorkflowTerminalError('coder-exit-nonzero', CODER_EXIT_NONZERO_ABORT_MESSAGE(taskId, r.exitCode))
  }
}

/**
 * Enforce the coder commit contract on a run that exited 0: the worktree must
 * be clean and the work must be committed on the task branch.
 *
 * Returns the {@link CommitSource} for the post-coder trace record. Throws a
 * `WorkflowTerminalError` when the contract cannot be satisfied (empty diff,
 * or a dirty tree that neither the corrective coder turn nor the deterministic
 * auto-commit net could resolve).
 */
export const enforceCoderCommitContract = async (args: {
  ctx: MarsCtx
  taskId: string
  store: TaskStore
  branch: string
  worktreePath: string
  integrationBranch: string
  trace: PrimitiveTraceArgs
  originId: string
  fullTask: CoderTaskRow
  worker: Worker
  primaryTag: TaskTag
  emit: (event: AgentEvent) => void
}): Promise<CommitSource> => {
  const {
    ctx,
    taskId,
    store,
    branch,
    worktreePath,
    integrationBranch,
    trace,
    originId,
    fullTask,
    worker,
    primaryTag,
    emit,
  } = args

  // Classify the worktree end-state. A `dirty-no-commits` tree (the coder did
  // real work but never ran `git commit`) is NOT benign: it silently falls
  // through verify (the has-diff gate reads 0 commits ahead and PASSES it as a
  // no-op) into merge, which rebases an empty branch and dispatches the
  // vcs-supervisor with a "rebase just conflicted / is in progress" prompt that
  // is false — Vega aborts, no recipe matches, and the first-principles recovery
  // idles until the phantom-task watchdog ceiling kills it (~2h; observed on
  // mars-c6cab686 / fix-64929590). Catch it here, at the earliest point, and
  // spawn exactly one cheap recovery whose only job is to commit the work that
  // is already in the worktree — mirroring the coder-exit-nonzero handler above.
  // Classifier failures (`error`) stay best-effort: log and fall through, so a
  // transient git hiccup never blocks an otherwise-good run.
  let postState: Awaited<ReturnType<typeof detectPostCoderState>> | null = null
  let commitSource: 'self' | 'corrected' | 'net' | 'no-work' | 'unknown' = 'unknown'
  try {
    postState = await detectPostCoderState({
      worktreePath,
      integrationBranch,
      traceCtx: buildPhaseCtx(trace, taskId, 'code'),
    })
    if (postState.kind === 'error') {
      console.warn(
        `[post-coder] task ${taskId}: classifier error: ${postState.error}`,
      )
    }
    if (postState.kind === 'clean-with-commits') commitSource = 'self'
    if (postState.kind === 'clean-no-work') commitSource = 'no-work'
  } catch (err) {
    console.warn(
      `[post-coder] task ${taskId}: classifier threw, continuing:`,
      err,
    )
  }

  // Report-workflow tasks (ADR-0056) are read-only by design: the pipeline
  // never runs verify or merge, so there is nothing downstream for a commit
  // to feed into, and a Worker like RescueOperator is explicitly denied
  // `git commit` (see RESCUE_OPERATOR_DENIED_TOOLS). Exempt them from every
  // check below — mirrors the existing main-committer exemption just below,
  // but for the whole contract rather than only the empty-diff guard. Zero
  // commits (or an untouched/dirty worktree the agent was never meant to
  // clean up) is the correct, expected end state here, not a defect to
  // escalate through a corrective turn or the auto-commit net.
  if (fullTask?.workflow === 'report') {
    console.log(
      `[post-coder] task ${taskId}: workflow=report — commit contract not enforced (postState=${postState?.kind ?? 'unknown'})`,
    )
    return commitSource
  }

  // --- Empty-diff guard -------------------------------------------------------
  // `clean-no-work` (0 commits ahead, worktree clean) after a coder exit 0
  // almost always means the worker bailed silently — it printed something,
  // decided it was done, and exited without touching a single file. That is
  // never correct for a real coding task: the task appears 'done' in the UI
  // but produced zero work (the mars-f2a5d4ea incident). Detect it here,
  // before the dirty-check, and fail with a named signature so recovery can
  // re-run the prompt.
  //
  // Exception: main-committer recovery tasks. Their correct success state IS
  // zero commits — they exist specifically to handle the case where the
  // integration branch self-healed before the task ran. parseMainCommiterPayload
  // returns a non-null value for those tasks; we let them fall through.
  if (postState?.kind === 'clean-no-work') {
    const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
      '../../core/lib/main-dirty'
    )
    const isMainCommitter =
      parseMainCommiterPayload(fullTask?.recoveryPayload ?? null)?.recipe === MAIN_COMMITER_RECIPE
    if (!isMainCommitter) {
      const errorMsg = CODER_EMPTY_DIFF_ABORT_MESSAGE(taskId, integrationBranch)
      console.log(
        `[post-coder] task ${taskId}: clean-no-work — coder produced zero commits, failing with ${CODER_EMPTY_DIFF_SIGNATURE}`,
      )
      await updateTask(
        taskId,
        {
          status: 'failed',
          error: errorMsg,
          failedPhase: 'code',
          failureReason: CODER_EMPTY_DIFF_STEP,
          failureSignature: CODER_EMPTY_DIFF_SIGNATURE,
          failureReasonCode: CODER_EMPTY_DIFF_SIGNATURE,
        },
        store,
      )
      throw new WorkflowTerminalError('coder-empty-diff', errorMsg)
    }
    console.log(
      `[post-coder] task ${taskId}: clean-no-work on main-committer recovery — no-op accepted`,
    )
  }

  // --- Coder commit contract -----------------------------------------------
  // Post-condition on the `code` step: the coder must hand over a CLEAN
  // worktree. TWO shapes violate it and they are the SAME defect, so they get
  // the SAME two-stage escalation:
  //
  //   `dirty-no-commits`   — the coder committed nothing at all.
  //   `dirty-with-commits` — the coder committed once, kept working, and left
  //                          the rest dirty.
  //
  // Until 2026-07 only the first shape was recoverable; the second failed the
  // task outright as `code:commit-contract/uncommitted-changes`, on the theory
  // that a coder which had already committed deliberately chose to leave the
  // rest out. Live evidence says otherwise: that signature became the single
  // largest source of task failures and tripped the signature-storm circuit
  // breaker, and the leftover paths were ordinary source and test files the
  // coder simply never got around to committing. Failing a task for it throws
  // away a worktree full of good work over a missing `git commit`.
  //
  // The escalation is the one `fix-recipes.ts` already documents for
  // `code/uncommitted-changes`, now applied to both shapes:
  //
  //   1. One corrective coder turn — the coder gets to commit its own work
  //      rather than have the orchestrator take authorship of it.
  //   2. A guarded, deterministic `git add -A && git commit` net, attributed to
  //      the orchestrator (`chore(auto-commit): task <id> — …`) so history
  //      never implies the agent committed it.
  //
  // Only when BOTH fail is the task terminal — the guard refused an unsafe
  // path (`.env`, `.mars/`, `node_modules`), or git itself rejected the commit
  // (pre-commit hook, nothing stageable). That case keeps the registered
  // `code/uncommitted-changes` signature, which failure-kinds.ts and
  // fix-recipes.ts both know how to name and recover.
  if (postState?.kind === 'dirty-no-commits' || postState?.kind === 'dirty-with-commits') {
    const dirtyList = postState.dirtyFiles.join('\n  ')
    const committedNote =
      postState.kind === 'dirty-with-commits'
        ? `${postState.commitsAhead} commit(s) ahead of ${integrationBranch}`
        : `0 commits ahead of ${integrationBranch}`
    console.log(
      `[post-coder] task ${taskId}: dirty tree with ${committedNote} — coder left ${postState.dirtyFiles.length} uncommitted path(s):\n  ${dirtyList}`,
    )

    // A clean process exit with a dirty worktree is a recoverable instruction
    // adherence failure, not a reason to immediately take authorship of the
    // change. Give the same Coder one short, worktree-backed correction turn
    // first. Codex exec is ephemeral, so this deliberately starts a second
    // process; the worktree is the continuation state.
    const alreadyCommittedLine =
      postState.kind === 'dirty-with-commits'
        ? `You already made ${postState.commitsAhead} commit(s) on this branch, but these paths were left out.\n\n`
        : ''
    const correction = await runWorkerWithSpan({
      worker,
      prompt: `${alreadyCommittedLine}Your previous pass left uncommitted changes in these paths:\n  ${dirtyList}\n\nCommit them now. Do not make unrelated changes.`,
      runOptions: {
        cwd: worktreePath,
        // See the matching comment in tools/coder/run-agent.ts: a Worker with
        // its own pinned `config.systemPrompt` must keep it on this corrective
        // turn too, or it silently reverts to the generic Coder brief.
        systemPrompt: worker.config.systemPrompt ?? resolveWorkerSystemPrompt(primaryTag),
        onEvent: async (event) => emit?.(event),
        onPid: ctx.services.onPid,
        externalAbort: ctx.signal,
      },
      traceStore: spanStore(trace),
      stepName: 'commit-correction',
      workflowInstanceId: trace.workflowInstanceId,
      originId,
      taskId,
      phase: 'code',
      modelTier: 'fast',
    })

    if (ctx.signal.aborted) throw new Error(`task ${taskId} stopped by operator`)

    try {
      const correctedState = await detectPostCoderState({
        worktreePath,
        integrationBranch,
        traceCtx: buildPhaseCtx(trace, taskId, 'code'),
      })
      if (correctedState.kind === 'clean-with-commits') {
        postState = correctedState
        commitSource = 'corrected'
        console.log(
          `[post-coder] task ${taskId}: coder committed ${correctedState.commitsAhead} change(s) on corrective turn`,
        )
      } else if (correctedState.kind === 'error') {
        console.warn(
          `[post-coder] task ${taskId}: corrective classifier error: ${correctedState.error}; retrying once`,
        )
        // Retry once — the observed rev-list failure was transient (the same
        // probe succeeded minutes earlier in the same worktree and `main` was
        // present throughout). One bounded retry covers the common transient-git-
        // hiccup case without masking a persistent failure.
        const retryState = await detectPostCoderState({
          worktreePath,
          integrationBranch,
          traceCtx: buildPhaseCtx(trace, taskId, 'code'),
        })
        if (retryState.kind !== 'error') {
          // Retry succeeded — update postState normally.
          if (retryState.kind === 'clean-with-commits') {
            postState = retryState
            commitSource = 'corrected'
            console.log(
              `[post-coder] task ${taskId}: retry classifier: coder committed ${retryState.commitsAhead} change(s) on corrective turn`,
            )
          } else {
            postState = retryState
            console.warn(
              `[post-coder] task ${taskId}: retry classifier: corrective turn exited ${correction.exitCode} without a commit; using the auto-commit net`,
            )
          }
        } else {
          // Both the initial and retry classifications failed. Carrying the
          // stale pre-correction snapshot forward risks reporting dirty-file
          // counts that are no longer true (the corrective turn may have
          // committed all of them). Fail with a distinct, honest signature
          // so the operator can inspect the worktree rather than restarting
          // (which discards potentially-committed work).
          const classifierError = retryState.error
          const errorMsg = POST_CODER_CLASSIFIER_ERROR_ABORT_MESSAGE(
            taskId,
            classifierError,
            worktreePath,
          )
          console.error(
            `[post-coder] task ${taskId}: classifier retry also failed (${classifierError}); refusing to use stale pre-correction state`,
          )
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'code',
              failureReason: POST_CODER_CLASSIFIER_ERROR_STEP,
              failureSignature: POST_CODER_CLASSIFIER_ERROR_SIGNATURE,
              failureReasonCode: POST_CODER_CLASSIFIER_ERROR_SIGNATURE,
            },
            store,
          )
          await raiseActionQueueItem({
            kind: 'failed',
            category: 'orchestrator',
            priority: 'high',
            title: `Post-coder classifier failed for task ${taskId}: worktree state unknown after corrective turn`,
            body: errorMsg,
            payload: {
              taskId,
              worktreePath,
              classifierError,
            },
            context: { repoRoot: process.env.MARS_REPO ?? null },
            raisedBy: 'workflow:code:post-coder-classifier-error',
            signature: `post-coder-classifier-error:${taskId}`,
            originTaskId: taskId,
          }).catch((raiseErr) => {
            console.error(
              `[post-coder] task ${taskId}: action-queue raise for classifier error errored:`,
              raiseErr,
            )
          })
          throw new WorkflowTerminalError(
            'post-coder-classifier-error',
            errorMsg,
          )
        }
      } else {
        postState = correctedState
        console.warn(
          `[post-coder] task ${taskId}: corrective commit turn exited ${correction.exitCode} without a commit; using the auto-commit net`,
        )
      }
    } catch (err) {
      // Re-throw terminal errors (e.g. post-coder-classifier-error) so they
      // are not swallowed and do not let stale state fall into Stage 2.
      if (err instanceof WorkflowTerminalError) throw err
      console.warn(`[post-coder] task ${taskId}: corrective classifier threw; using the auto-commit net:`, err)
    }
  }

  // Stage 2 — the deterministic net. Runs for both dirty shapes, so a coder
  // that committed once and left the rest dirty is no longer terminal.
  if (postState?.kind === 'dirty-no-commits' || postState?.kind === 'dirty-with-commits') {
    const dirtyList = postState.dirtyFiles.join('\n  ')
    const commitsAhead =
      postState.kind === 'dirty-with-commits' ? postState.commitsAhead : 0
    const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
      '../../core/lib/main-dirty'
    )
    const provenance =
      parseMainCommiterPayload(fullTask?.recoveryPayload ?? null)?.recipe === MAIN_COMMITER_RECIPE
        ? 'committer-salvage'
        : 'coder-left-dirty'
    const autoResult = await resolveVcs().autoCommitWorktree({
      taskId,
      provenance,
      integrationBranch,
      worktreePath,
      dirtyFiles: postState.dirtyFiles,
    })

    if (autoResult.committed) {
      commitSource = 'net'
      console.log(
        `[post-coder] task ${taskId}: auto-committed ${postState.dirtyFiles.length} path(s) as ${autoResult.sha.slice(0, 8)} (on top of ${commitsAhead} coder commit(s))`,
      )
    } else if (autoResult.refusal === 'nothing-to-commit') {
      // The worktree is already clean — the desired post-condition holds.
      // This happens when a stale dirty-file snapshot from before the
      // corrective turn is used after the coder already committed everything.
      // Treat it as a successful no-op and fall through to verify.
      console.log(
        `[post-coder] task ${taskId}: auto-commit skipped — worktree already clean (${autoResult.reason}); falling through to verify`,
      )
    } else {
      // Genuinely terminal: the guard refused an unsafe path, or git rejected
      // the commit. Either way nothing landed and nothing can land without an
      // operator, so this keeps failing — with the ONE registered signature.
      const errorMsg = coderUncommittedFailure({
        taskId,
        worktreePath,
        branch,
        integrationBranch,
        dirtyFiles: postState.dirtyFiles,
        commitsAhead,
        autoCommitReason: autoResult.reason,
      })
      console.log(
        `[post-coder] task ${taskId}: auto-commit refused (${autoResult.refusal}) — ${autoResult.reason}`,
      )
      await updateTask(
        taskId,
        {
          status: 'failed',
          error: errorMsg,
          failedPhase: 'code',
          // `failure_reason` doubles as the fine-grained failing step for the
          // durable recovery-spawn subscriber (`asStepId(task.failureReason)`),
          // which recomputes the signature from it. It must stay the bare step
          // id that, combined with the "has uncommitted changes" phrase in
          // `error`, recomputes to CODER_UNCOMMITTED_SIGNATURE — the prose
          // lives in `error`.
          failureReason: CODER_UNCOMMITTED_STEP,
          failureReasonCode: 'orchestration:coder-left-uncommitted-unfixable',
          // Stamp the structured signature so the action queue can name this
          // failure (failure-kinds.ts) and self-heal can find its recipe
          // (fix-recipes.ts `code/uncommitted-changes`). Without it the row
          // resolves to the generic "A pipeline step did not complete".
          failureSignature: CODER_UNCOMMITTED_SIGNATURE,
        },
        store,
      )
      await raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Auto-commit failed for task ${taskId}: coder left uncommitted work`,
        body: [
          `Task ${taskId} coder exited cleanly but left ${postState.dirtyFiles.length} uncommitted path(s) (${commitsAhead} commit(s) ahead of ${integrationBranch}).`,
          'A corrective coder turn ran first and did not commit them.',
          `Deterministic auto-commit was then attempted and refused (${autoResult.refusal}): ${autoResult.reason}`,
          '',
          'Dirty files:',
          `  ${dirtyList}`,
          '',
          `Worktree: ${worktreePath}`,
          '',
          'Resolve: inspect the worktree, commit manually if the work is viable, or `mars purge` the task.',
        ].join('\n'),
        payload: {
          taskId,
          worktreePath,
          dirtyFiles: postState.dirtyFiles,
          commitsAhead,
          autoCommitRefusal: autoResult.refusal,
          autoCommitReason: autoResult.reason,
        },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'workflow:code:auto-commit-failed',
        signature: `coder-uncommitted:${taskId}`,
      }).catch((raiseErr) => {
        console.error(
          `[post-coder] task ${taskId}: action-queue raise for auto-commit failure errored:`,
          raiseErr,
        )
      })
      throw new WorkflowTerminalError('coder-uncommitted', CODER_UNCOMMITTED_ABORT_MESSAGE(taskId))
    }
  }

  return commitSource
}


// ═══════════════════════════════════════════════════════════════════════════
// Fine-grained coder-exit disposition classifier.
//
// Pure classification logic used by the run-agent retry-bound slice to decide
// whether a finished coder run warrants a single lightweight retry
// (retryable-transient) or hands off to the full recovery path above
// (terminal-recovery). It deliberately matches only a minimal structural
// subset of a run result ({@link CoderRunOutcome}) so the rules stay
// independent of the provider/DB-heavy machinery above.
//
// Exit codes handled by DEDICATED paths in `runAgent` BEFORE the catch-all
// block (138 context-exhausted, quota-rejected non-zero) are NOT passed to
// this classifier — callers must guard those first.
// ═══════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// Fine-grained disposition classifier (classifyCoderExitDisposition)
// ---------------------------------------------------------------------------

/**
 * Minimal observable shape of a finished coder run used by
 * {@link classifyCoderExitDisposition}.
 *
 * Deliberately mirrors only the fields relevant to classification so this
 * module can remain free of runtime imports from `core/lib/git/claude`.
 */
export interface CoderRunOutcome {
  /** Process exit code. */
  exitCode: number
  /** Combined stderr text from the coder process. */
  stderr: string
  /**
   * Non-null when the provider rejected this run due to rate/spend limits.
   * Mirrors `RunAgentResult.quotaRejected`.
   */
  quotaRejected: { resetsAt: number } | null
  /**
   * Provider conversation messages.  Length 0 means the coder never reached
   * the provider (startup, auth, or recursion-guard failure).
   */
  conversation: readonly unknown[]
  /**
   * True when the provider's own stream reported its connection severed
   * mid-response (see `extractTransportDropped` in `claude-stream.ts`).
   * Mirrors `RunAgentResult.transportDropped`. Optional/undefined is treated
   * identically to `false` — only the Claude adapter currently populates it.
   */
  transportDropped?: boolean
  /**
   * True when the run failed due to an API connectivity failure (ENOTFOUND,
   * ECONNREFUSED, EAI_AGAIN, etc.) rather than a code defect. Optional/
   * undefined is treated as `false`. Callers may set this explicitly; the
   * classifier also derives it from `stderr` and `conversation` when absent.
   */
  apiUnreachable?: boolean
}

/**
 * Maximum number of env-api-unreachable re-queues before the task is failed
 * for real (with an `env:api-unreachable` signature, no fix-task spawned).
 * Matches the Claude CLI's own built-in api_retry ceiling so the task never
 * outlives a failure the CLI already retried exhaustively.
 *
 * Deliberately generous: DNS outages resolve in seconds to minutes; 10
 * attempts across natural dispatch delays gives ~10–30 minutes of tolerance.
 */
const ENV_API_UNREACHABLE_MAX_ATTEMPTS = 10

/**
 * Detect whether a finished coder run failed due to API connectivity failure —
 * a network-level unreachability (ENOTFOUND, ECONNREFUSED, EAI_AGAIN, …) that
 * is independent of the task's code.
 *
 * Detection sources (highest to lowest confidence):
 *  1. Caller pre-set `r.apiUnreachable === true` (explicit override).
 *  2. Stderr text matching known connectivity error codes.
 *  3. Event-stream events: `{ type: 'system', subtype: 'api_retry', attempt,
 *     max_retries }` where `attempt >= max_retries` (CLI exhausted its own
 *     retry loop), or `{ type: 'result', terminal_reason: 'api_error' }`.
 *  4. Result-event text containing connectivity error codes.
 *
 * Used by both {@link classifyCoderExitDisposition} (pure classifier) and
 * {@link classifyCoderExit} (full handler), so it takes the minimal shared
 * shape present on both {@link CoderRunOutcome} and {@link CoderWorkerRunResult}.
 */
function isApiConnectivityFailure(r: {
  stderr: string
  conversation: readonly unknown[]
  apiUnreachable?: boolean
}): boolean {
  if (r.apiUnreachable === true) return true

  // Stderr: plain-text connectivity error codes from the CLI or Node.js.
  // ETIMEDOUT is included per the 2026-09-03 incident post-mortem: a TCP
  // connect timeout is a network-level failure identical to ENOTFOUND — the
  // coder never reached the API, so spending the recovery slot is wrong.
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|Unable to connect to API/i.test(r.stderr)) return true

  // Event stream: scan for api_retry-at-max and result:api_error.
  for (const event of r.conversation) {
    if (event === null || typeof event !== 'object') continue
    const e = event as Record<string, unknown>

    // { type: 'system', subtype: 'api_retry', attempt: N, max_retries: N }
    // The CLI emits this on every retry attempt; reaching max_retries means it
    // exhausted its own bounded retry loop — identical to the 2026-09-03 incident.
    if (e['type'] === 'system' && e['subtype'] === 'api_retry') {
      const attempt = e['attempt']
      const maxRetries = e['max_retries']
      if (
        typeof attempt === 'number' &&
        typeof maxRetries === 'number' &&
        attempt >= maxRetries
      ) {
        return true
      }
    }

    // { type: 'result', terminal_reason: 'api_error' }
    if (e['type'] === 'result' && e['terminal_reason'] === 'api_error') return true

    // Result text containing connectivity error codes (fallback).
    const resultText = e['result']
    if (
      typeof resultText === 'string' &&
      /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|Unable to connect to API/i.test(resultText)
    ) {
      return true
    }
  }

  return false
}

/**
 * Fine-grained disposition of a finished coder run.
 *
 * - `success` — exit 0; the coder completed normally.
 * - `retryable-transient` — environmental kill with no prior progress; a
 *   single lightweight re-dispatch on the same worktree is safe.
 * - `terminal-recovery` — the existing fix-task / recovery path applies; the
 *   run must not enter the retry loop.
 * - `terminal-env-unreachable` — network-level connectivity failure; the task
 *   should be re-queued WITHOUT consuming the fix-task recovery budget. The
 *   full handler ({@link classifyCoderExit}) enforces a separate ceiling
 *   ({@link ENV_API_UNREACHABLE_MAX_ATTEMPTS}) after which it fails for real.
 * - `terminal-manual` — operator intervention required (reserved for future use).
 * - `terminal-operator-stop` — operator cancelled; no retry, no recovery.
 */
export type CoderExitDisposition =
  | { kind: 'success' }
  | { kind: 'retryable-transient'; reason: string }
  | { kind: 'terminal-recovery'; reason: string }
  | { kind: 'terminal-env-unreachable'; reason: string }
  | { kind: 'terminal-manual' }
  | { kind: 'terminal-operator-stop' }

/**
 * Pure classifier for a finished coder run.
 *
 * Inspects the exit code, stderr, quota state, conversation length, and
 * whether the workflow abort signal fired, then returns a
 * {@link CoderExitDisposition} that describes what should happen next.
 *
 * Classification rules (in priority order):
 *
 * 1. `aborted` (operator stop) → `terminal-operator-stop`
 * 2. exit 0 → `success`
 * 3. exit 138 + "context budget exhausted" in stderr → `terminal-recovery`
 *    (has its own recovery path; must not enter the retry loop)
 * 4. `quotaRejected !== null` → `terminal-recovery`
 *    (has its own re-queue mechanism; must not enter the retry loop)
 * 4.5. API connectivity failure (ENOTFOUND / ECONNREFUSED / EAI_AGAIN /
 *    api_retry@max_retries / terminal_reason:api_error) →
 *    `terminal-env-unreachable`  (re-queued without consuming the fix-task
 *    recovery budget; checked BEFORE the message-count rules because the
 *    CLI's own retry-exhaustion event can land in the conversation regardless
 *    of how many messages were exchanged)
 * 5. `transportDropped === true` → `retryable-transient`
 *    (the provider's own connection was severed mid-response — nothing about
 *    the task was tested, regardless of exit code or message count; safe to
 *    retry immediately rather than burn the recovery slot on a doomed repair)
 * 6. SIGKILL (137) or SIGTERM (143) with zero messages → `retryable-transient`
 *    (environmental kill before provider contact; safe to retry)
 * 7. SIGKILL or SIGTERM with prior messages → `terminal-recovery`
 *    (coder was making progress when killed; worktree may hold partial work)
 * 8. Any non-zero exit with zero messages → `retryable-transient`
 *    (startup / auth / recursion-guard failure; retry is safe)
 * 9. Natural non-zero exit with messages → `terminal-recovery`
 *    (coder ran and failed; fix-task recovery applies)
 *
 * @param r - Observable facts about the coder run.
 * @param aborted - True when `ctx.signal.aborted` fired before this call.
 */
export function classifyCoderExitDisposition({
  r,
  aborted,
}: {
  r: CoderRunOutcome
  aborted: boolean
}): CoderExitDisposition {
  // Rule 1 — operator cancellation takes priority over all exit-code logic.
  if (aborted) {
    return { kind: 'terminal-operator-stop' }
  }

  // Rule 2 — exit 0 = coder completed normally.
  if (r.exitCode === 0) {
    return { kind: 'success' }
  }

  // Rule 3 — context-budget exhaustion has its own fix-task recovery path and
  // must not be re-dispatched by the retry loop.
  if (r.exitCode === 138 && r.stderr.includes('context budget exhausted')) {
    return { kind: 'terminal-recovery', reason: 'context-budget-exhausted' }
  }

  // Rule 4 — provider rate/spend-limit rejection has its own re-queue
  // mechanism; the retry loop must not interfere.
  if (r.quotaRejected !== null) {
    return { kind: 'terminal-recovery', reason: 'quota-rejected' }
  }

  // Rule 4.5 — API connectivity failure (ENOTFOUND / ECONNREFUSED /
  // EAI_AGAIN / api_retry@max_retries / terminal_reason:api_error).
  //
  // Checked BEFORE the message-count rules because the CLI's own retry-
  // exhaustion event (`api_retry` with attempt === max_retries) can appear
  // in the conversation regardless of how many real messages were exchanged.
  // Without this guard, a connectivity failure with messages would fall
  // through to Rule 9 (`natural-exit`) and spawn a fix-task — exactly the
  // 2026-09-03 incident that burned eight recovery slots on a DNS outage.
  //
  // The full handler (classifyCoderExit) enforces a per-task ceiling and
  // re-queues without touching the fix-task recovery budget.
  if (isApiConnectivityFailure(r)) {
    return { kind: 'terminal-env-unreachable', reason: 'api-unreachable' }
  }

  // Rule 5 — provider transport failure: the connection to the API was
  // severed mid-response (see `extractTransportDropped`). This is checked
  // BEFORE message-count logic on purpose: the CLI's own error text about the
  // drop can itself land as a conversation entry, so a naive "messageCount ===
  // 0" check would miss it and misclassify the run as `natural-exit` (Rule 9)
  // — exactly the 2026-08-20 incident (mars-8693f3a4 and its recovery chain)
  // that burned four recovery slots on a dropped socket, none of which ever
  // reached real coding work.
  if (r.transportDropped === true) {
    return { kind: 'retryable-transient', reason: 'provider-transport-dropped' }
  }

  // Rules 6–9 — non-zero exit (not aborted, not quota, not context-exhausted,
  // not a transport drop).
  const messageCount = r.conversation.length

  if (r.exitCode === 137 || r.exitCode === 143) {
    // Environmental signal kill.  Distinguishing factor: whether the coder had
    // already reached the provider before the kill.
    if (messageCount === 0) {
      // Rule 6 — killed before any provider contact; safe to retry.
      return { kind: 'retryable-transient', reason: 'sigkill-no-progress' }
    }
    // Rule 7 — killed while doing real work; worktree may hold partial commits.
    return { kind: 'terminal-recovery', reason: 'killed-with-progress' }
  }

  if (messageCount === 0) {
    // Rule 8 — startup / auth / recursion-guard failure; the coder never
    // reached the provider so the worktree is untouched.  A retry is safe.
    return { kind: 'retryable-transient', reason: 'zero-messages' }
  }

  // Rule 9 — natural non-zero exit after real work; fix-task recovery applies.
  return { kind: 'terminal-recovery', reason: 'natural-exit' }
}

