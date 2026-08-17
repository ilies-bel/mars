/**
 * The `setupWorktree` primitive shell.
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). Framework-owned:
 * every task-state write below goes through `ctx.services.store` (the Arc
 * aggregate, ADR-0052), so a user-owned workflow that composes this primitive
 * cannot strand a task.
 */
import { type StepHandle } from '@mars/workflow'
import { runTool } from '../../core/lib/run-tool'
import {
  createWorktree,
  provisionCommitterWorktree,
  attachToOriginWorktree,
  OriginWorktreeMissingError,
  syncWorktreeToIntegration,
  type WorktreeConflictPolicy,
  type WorktreeRef,
} from '../../core/lib/git/worktree'
import { captureCheckpoint, discardWorkingTreeChanges } from '../../core/lib/git/checkpoint'
import { classifyPorcelainLines } from '../../core/lib/git/classify-porcelain'
import { resolveContext } from '../../core/context'
import {
  installWorktreeDeps,
  repairInstallInPlace,
  WorktreeInstallError,
  WorktreeModulesMissingError,
} from '../../core/lib/worktree-install'
import {
  getTask,
  hasIncompleteBlockers,
  TERMINAL_TASK_STATUSES,
  updateTask,
} from '../../core/queue'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { runNonLlmStepWithSpan } from '../../core/lib/run-worker-with-span'
import {
  recoveryAttachesToOrigin,
  BLOCKERS_ABORT_MESSAGE,
  ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE,
} from '../../workflows/primitives/shared'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import { loadOrBuildIndexCard } from '../../core/lib/index-card/cache.js'
import {
  type MarsCtx,
  resolveTrace,
  readWorkflowInput as input,
  resolveTaskId,
  buildPhaseCtx,
  spanStore,
  cacheWorktree,
  cacheIndexCard,
} from '../context'
import { validationRecorder } from '../validate-recorder'
import { ensureWorktreeCurrent } from './worktree-currency'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getStateDir } from '../../core/context'
import { RESCUE_OPERATOR_TAG } from '../../core/rescue-operator-spawn'
import { checkWorktreeIntegrity } from '../../workflows/lib/worktree-integrity'
import { computeDepFingerprint } from '../../workflows/lib/dep-fingerprint'

// ---------------------------------------------------------------------------
// setupWorktree
// ---------------------------------------------------------------------------

/** Per-call domain options for {@link setupWorktree}. All fields default. */
export interface SetupWorktreeOpts {
  /** Pipeline kind. Default `'task'`. `'fix'` attaches to the origin worktree. */
  kind?: 'task' | 'fix' | 'diagnose'
  /** Merge target. Default `'main'`. */
  integrationBranch?: string
  /** Serialised recovery payload (`tasks.recovery_payload`); only on `kind:'fix'`. Default null. */
  recoveryPayload?: string | null
  /** The origin task a recovery recovers (`tasks.fix_for_task_id`). Default null. */
  fixForTaskId?: string | null
  /** Override the task id (defaults to `ctx.runId`). */
  taskId?: string
  /**
   * Conflict policy for {@link syncWorktreeToIntegration}. Overrides the
   * default policy that is derived from `kind`:
   *
   * - Default for `kind:'task'`: `'recreate'` — safe for a fresh branch that
   *   has never been coded yet; the old tip is parked on a ref.
   * - Default for `kind:'fix'`: `'reconcile'` — the origin's existing commits
   *   must not be reset; invoke the vcs-supervisor on conflict.
   *
   * **Use `'reconcile'` for remerge workflows** where the task branch already
   * carries commits that must survive the sync. Passing `'recreate'` (or
   * accepting the default) silently parks the commits and resets to integration
   * tip, after which `isZeroCommitBranch` fires and the merge is skipped with
   * `status='done'` — data loss without an error.
   */
  onConflict?: WorktreeConflictPolicy
}

export interface SetupWorktreeResult {
  path: string
  branch: string
  /** Index-card text to inject into the worker prompt, or null when unavailable. */
  indexCard: string | null
}

/**
 * Provision (or attach to) the worktree the rest of the pipeline runs in, then
 * install its deps. Mirrors the former `setup-worktree` step body verbatim:
 *
 *   - aborts (throws) when the task has incomplete blockers,
 *   - `kind:'fix'` (non-main-commiter) ATTACHES to the origin's worktree+branch
 *     and stacks its commit there; a missing origin worktree fails the fix,
 *     raises an operator action-queue item, and throws the missing-worktree
 *     sentinel,
 *   - everything else CREATES a fresh `task/<id>` worktree off integration,
 *   - records the integration HEAD sha, installs deps, and on a frozen-install
 *     failure attempts an in-place lockfile repair before escalating to a
 *     fix-task.
 *
 * Every task-state write goes through `ctx.services.store` (the Arc funnel), so
 * a custom workflow composing this primitive cannot strand a task.
 *
 * Usage from a scaffolded workflow:
 * ```js
 * const worktree = await ctx.step('setup', () => setupWorktree(ctx, { kind }))
 * ```
 * Stashes the resolved worktree on `ctx` so later `verify`/`merge` calls read
 * it without the caller threading it.
 */
export const setupWorktree = async (
  ctx: MarsCtx,
  opts: SetupWorktreeOpts = {},
): Promise<SetupWorktreeResult> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'setupWorktree',
      mode: 'auto',
      guide: null,
    })
    const inert = { path: '(validation dry-run)', branch: 'validate', indexCard: null }
    cacheWorktree(ctx, inert)
    return inert
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default. Plumbing
  // (store / trace / handle) is pulled off ctx; the author never passes it.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const recoveryPayload =
    opts.recoveryPayload ?? input(ctx).recoveryPayload ?? null
  const fixForTaskId = opts.fixForTaskId ?? input(ctx).fixForTaskId ?? null
  const store: TaskStore = ctx.services.store
  const trace = await resolveTrace(ctx, taskId)
  const handle: Pick<StepHandle, 'setSha'> | undefined =
    ctx.currentStep ?? undefined

  const result = await runSetupWorktree()
  // Memoise so verify/merge can read the worktree without re-threading it.
  // WorktreeRef and SetupWorktreeResult are the same { path, branch } shape.
  cacheWorktree(ctx, { path: result.path, branch: result.branch })
  // Stash the index card so runAgent can inject it into the prompt without
  // re-threading it through the step boundary.
  cacheIndexCard(ctx, result.indexCard)
  return result

  async function runSetupWorktree(): Promise<SetupWorktreeResult> {
  // Check blockers BEFORE the span: an abort here means no setup work ran, so
  // no span should be emitted.
  if (await hasIncompleteBlockers(taskId, store)) {
    throw new WorkflowTerminalError('blockers-abort', BLOCKERS_ABORT_MESSAGE(taskId))
  }

  // Resolve a recovery (kind=fix) task's worktree by attaching to its origin's
  // existing worktree + branch. A missing origin worktree is a hard,
  // operator-owned failure — stamp the fix failed, raise an action-queue item,
  // and throw the sentinel; never silently recreate (that would discard the
  // origin's in-progress work).
  const attachOriginWorktreeForFix = async (): Promise<WorktreeRef> => {
    const originTaskId = fixForTaskId
    if (originTaskId === null) {
      throw new Error(
        `recovery ${taskId} has kind='fix' but no fixForTaskId; cannot resolve origin worktree`,
      )
    }
    const origin = await getTask(originTaskId, store)
    if (origin !== null && TERMINAL_TASK_STATUSES.has(origin.status)) {
      await updateTask(
        taskId,
        {
          status: 'dropped',
          dropReason: origin.status === 'done' ? 'origin-succeeded' : 'arc-rescued',
        },
        store,
      )
      throw new WorkflowTerminalError(
        'origin-terminal',
        `Chore ${taskId} was dropped because origin ${originTaskId} is already ${origin.status}`,
      )
    }
    const originBranch = origin?.branch ?? null
    const originWorktreePath = origin?.worktreePath ?? null
    try {
      if (origin === null || originBranch === null || originWorktreePath === null) {
        throw new OriginWorktreeMissingError({
          originTaskId,
          expectedPath: originWorktreePath ?? '(unrecorded)',
          expectedBranch: originBranch ?? '(unrecorded)',
        })
      }
      return await attachToOriginWorktree({
        originTaskId,
        originBranch,
        originWorktreePath,
        traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
      })
    } catch (err) {
      if (!(err instanceof OriginWorktreeMissingError)) throw err
      const summary = err.message
      const missingSignature = computeFailureSignature(
        'setup:origin-worktree-missing',
        summary,
      )
      await updateTask(
        taskId,
        {
          status: 'failed',
          error: summary,
          failedPhase: 'code',
          failureReason: 'setup:origin-worktree-missing',
          failureSignature: missingSignature,
          failureReasonCode: missingSignature,
        },
        store,
      )
      await raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Recovery ${taskId} cannot attach: origin worktree for ${originTaskId} is gone`,
        body: [
          `Recovery task ${taskId} (kind=fix) recovers origin task ${originTaskId}, but the origin's worktree is no longer on disk, so the recovery cannot continue the origin's in-progress work in place.`,
          '',
          'Context:',
          `  Expected branch: ${err.expectedBranch}`,
          `  Expected worktree: ${err.expectedPath}`,
          '',
          'Resolve explicitly — e.g. `mars restart` the origin to re-run it from a fresh worktree, or `mars purge` it if the work is no longer needed. The orchestrator does not silently recreate a recovery worktree, because branching off the integration tip would discard the origin\'s in-progress changes.',
        ].join('\n'),
        payload: {
          recoveryTaskId: taskId,
          originTaskId,
          expectedBranch: err.expectedBranch,
          expectedWorktreePath: err.expectedPath,
        },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'agent:setup-worktree',
        signature: `${originTaskId}:setup:origin-worktree-missing`,
        originTaskId,
        occurrence: {
          at: new Date().toISOString(),
          recoveryTaskId: taskId,
        },
      }).catch((raiseErr) => {
        console.error(
          `[setup] recovery ${taskId} origin-worktree-missing escalation errored:`,
          raiseErr,
        )
      })
      throw new WorkflowTerminalError('origin-worktree-missing', ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE(taskId))
    }
  }

  return await runNonLlmStepWithSpan({
    stepName: 'setup-worktree',
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    taskId: taskId,
    phase: 'setup',
    traceStore: spanStore(trace),
    fn: async (): Promise<SetupWorktreeResult> => {
      await updateTask(taskId, { status: 'running' }, store)

      // Ordinary recovery (kind=fix) tasks attach to the origin's worktree;
      // a main-commiter recovery (also kind=fix) carves its own fresh worktree.
      let isMainCommiterFix = false
      if (kind === 'fix' && recoveryPayload != null) {
        const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
          '../../core/lib/main-dirty'
        )
        isMainCommiterFix =
          parseMainCommiterPayload(recoveryPayload)?.recipe ===
          MAIN_COMMITER_RECIPE
      }
      const attachesToOrigin = recoveryAttachesToOrigin(
        kind,
        isMainCommiterFix,
      )

      // Integration branch dirty-tree guard: park the task as 'blocked' when
      // the merge target has uncommitted changes. A dirty integration checkout
      // cannot be fast-forwarded into cleanly; catching this here (before the
      // worktree is even created) eliminates the failure class where tasks
      // reach merge and fail with "merge target has uncommitted changes".
      //
      // Main-committer fix tasks are exempt — they exist specifically to clean
      // a dirty integration branch and must proceed even when main is dirty.
      if (!isMainCommiterFix) {
        const { checkIntegrationBranchDirty } = await import('../../core/lib/main-dirty')
        const { repoRoot: integRoot } = resolveContext()
        const dirtyCheck = await checkIntegrationBranchDirty({
          repoRoot: integRoot,
          integrationBranch,
          traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
        }).catch((err: unknown) => {
          console.warn(
            `[setup:dirty-guard] task ${taskId} integration dirty check errored, proceeding: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          return { dirty: false, statusOutput: '' }
        })
        if (dirtyCheck.dirty) {
          const rawLines = dirtyCheck.statusOutput.split('\n').filter((l) => l.length > 0)
          const { userOwned } = classifyPorcelainLines(rawLines)

          if (userOwned.length === 0) {
            // All dirty paths are under .mars/ — orchestrator-owned artifacts.
            // Auto-stash them via a per-task checkpoint ref (never git stash),
            // discard the working-tree changes, and let setup proceed. The
            // merge step restores the checkpoint after the fast-forward.
            const preflightCheckpoint = await captureCheckpoint({
              cwd: integRoot,
              key: `${taskId}-preflight`,
              message: `pre-flight: auto-stash orchestrator artifacts for task ${taskId}`,
              traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
            }).catch((err: unknown) => {
              console.warn(
                `[setup:dirty-guard] task ${taskId} .mars/ auto-stash errored (proceeding without stash): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
              return null
            })
            if (preflightCheckpoint !== null) {
              await discardWorkingTreeChanges({
                cwd: integRoot,
                traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
              })
              console.log(
                `[setup:dirty-guard] task ${taskId}: auto-stashed ${preflightCheckpoint.files.length} .mars/ ` +
                  `artifact(s) to ${preflightCheckpoint.ref}; proceeding`,
              )
            }
            // Fall through — setup continues normally
          } else {
            // One or more user-owned paths are dirty — fail the task.
            //
            // Per the edgeless-blocked invariant (blocker-invariant.ts), 'blocked'
            // requires at least one task_blockers edge pointing at a concrete blocker
            // task.  A dirty integration branch has no blocker task to wait on, so
            // 'blocked' is the wrong terminal — it violates the invariant and leaves
            // the task unrecoverable without `mars unblock` + `mars restart`.
            //
            // 'failed' + actionQueue item is the correct pattern:
            //   - the operator sees an actionable alert to clean the branch
            //   - `mars restart` (or the self-heal recovery spawner) retries the task
            //   - no orphaned 'blocked' row with zero edges can accumulate
            const dirtyPaths = rawLines.map((l) => l.trim()).filter((l) => l.length > 0)
            const dirtyMsg = `integration branch '${integrationBranch}' has uncommitted changes`
            const dirtySignature = computeFailureSignature('setup:dirty-integration', dirtyMsg)
            await updateTask(taskId, {
              status: 'failed',
              error: dirtyMsg,
              failedPhase: 'setup',
              failureReason: dirtyMsg,
              failureSignature: dirtySignature,
              failureReasonCode: dirtySignature,
            }, store)
            await raiseActionQueueItem({
              kind: 'dirty-integration',
              category: 'orchestrator',
              priority: 'high',
              title: `merge target ${integrationBranch} has uncommitted changes`,
              body: [
                `Task ${taskId} was stopped because the integration branch '${integrationBranch}' has uncommitted changes.`,
                'Merging into a dirty checkout would corrupt the integration branch.',
                '',
                'Dirty paths:',
                ...dirtyPaths.map((p) => `  ${p}`),
                '',
                `Resolve: clean the integration branch checkout, then \`mars restart ${taskId}\`.`,
              ].join('\n'),
              payload: { taskId, integrationBranch, dirtyPaths, statusOutput: dirtyCheck.statusOutput },
              context: { repoRoot: integRoot },
              raisedBy: 'agent:setup-worktree:dirty-integration',
              signature: `${taskId}:setup:dirty-integration`,
              originTaskId: taskId,
            }).catch((raiseErr: unknown) => {
              console.error(
                `[setup] task ${taskId} dirty-integration action-queue raise errored:`,
                raiseErr,
              )
            })
            throw new WorkflowTerminalError(
              'setup-dirty-integration',
              `Task ${taskId}: ${dirtyMsg} — task failed`,
            )
          }
        }
      }

      // Guard: rescue-operator tasks become obsolete when their arc origin
      // reaches 'done' after the rescue was enqueued. Between spawn time and
      // this dispatch point, a concurrent recovery can settle the arc — there
      // is then no valid RescueVerdict the worker can emit (restart, continue,
      // and supersede all presuppose a still-failing arc). Drop the rescue
      // cleanly here rather than running the RescueOperator Worker.
      //
      // Mirrors the analogous origin-terminal guard in `attachOriginWorktreeForFix`
      // (see lines above) for kind='fix' recovery tasks.
      //
      // Observed 2026-08-18: rescue mars-68b1b5ac was dispatched after its arc
      // origin mars-291a4dc0 had already reached 'done', leaving the worker no
      // valid verdict to emit. The recovery (fix-0e4937b8) had to land an empty
      // commit to exit cleanly.
      {
        const selfTask = await store.getTask(taskId).catch(() => null)
        if (selfTask?.tags?.includes(RESCUE_OPERATOR_TAG) && selfTask.originId !== taskId) {
          const arcOrigin = await getTask(selfTask.originId, store)
          if (arcOrigin?.status === 'done') {
            await updateTask(taskId, { status: 'dropped', dropReason: 'origin-succeeded' }, store)
            console.info(
              `[setup] rescue-operator ${taskId} dropped — arc origin ${selfTask.originId} already done`,
            )
            throw new WorkflowTerminalError(
              'origin-terminal',
              `Rescue-operator ${taskId} dropped: arc origin ${selfTask.originId} is already done`,
            )
          }
        }
      }

      // A main-commiter recovery MUST carry the integration branch's dirty
      // state into its fresh worktree (checkpoint capture on repoRoot → apply
      // by object id in the worktree, see `core/lib/git/checkpoint.ts`) so the
      // committer coder sees the files it is meant to commit.
      // The generic createWorktree() branches off the clean integration tip
      // and leaves the dirty state stranded on the integration checkout —
      // every downstream task then fails verify:main-dirty forever.
      let ref: WorktreeRef
      let worktreeReused = false
      if (attachesToOrigin) {
        ref = await attachOriginWorktreeForFix()
      } else if (isMainCommiterFix) {
        ref = await provisionCommitterWorktree({
          recoveryTaskId: taskId,
          integrationBranch,
          traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
        })
      } else {
        // Check whether the existing linked worktree for this task is
        // structurally sound before calling createWorktree — which prunes
        // registrations, probes git, and may recreate a branch from scratch.
        // A passing integrity check means the directory, git link, and branch
        // are all intact; we reuse it in place and save the overhead.
        const expectedBranch = `task/${taskId}`
        const expectedPath = resolve(getStateDir(), `worktrees/${taskId}`)
        const integrity = await checkWorktreeIntegrity(expectedPath, expectedBranch)
        if (integrity.ok) {
          ref = { path: expectedPath, branch: expectedBranch }
          worktreeReused = true
        } else {
          ref = await createWorktree({
            taskId,
            integrationBranch,
            traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
          })
        }
      }
      await updateTask(
        taskId,
        { branch: ref.branch, worktreePath: ref.path },
        store,
      )

      // The worktree exists — but existing is not the same as CURRENT. A
      // preserved `task/<id>` branch (restart) or an attached origin worktree
      // (recovery) starts at whatever tip it was left at, which is how a
      // restarted task ended up verifying against source dozens of commits
      // behind the integration branch. Replay it onto the tip BEFORE deps are
      // installed, so the install below reads the current manifests.
      //
      // Only a task that carves its OWN branch may recreate on conflict.
      //
      // A recovery attached to its origin's worktree exists to continue THAT
      // work in place, so its commits must not be reset — but escalating was a
      // dead end: the recovery could never start, so it failed, and its origin
      // sat blocked behind a permanently-failed blocker. It reconciles instead,
      // handing the live conflict to the vcs-supervisor and only escalating if
      // Vega cannot finish.
      //
      // A main-commiter worktree is carved off the integration tip and is
      // therefore current by construction; it keeps the conservative default.

      // Compute the effective conflict policy. An explicit `onConflict` in opts
      // always wins. This lets remerge workflows pass `'reconcile'` to prevent a
      // diverged branch from being silently recreated (which would zero its
      // commits, trigger the `isZeroCommitBranch` short-circuit, and mark the
      // task done while the commits were never in integration — the root cause
      // of the silent data-loss bug this option was added to fix).
      //
      // Safety guard for the remerge workflow: when the caller did NOT set
      // onConflict explicitly and the resolved default would be 'recreate',
      // check whether this is a remerge task. Remerge tasks run on the
      // task.workflow='remerge' pipeline; their branch commits are the final
      // product waiting to be merged and must NEVER be silently parked-and-reset.
      // An old .mars/workflows/remerge-workflow.js (before the explicit
      // { onConflict: 'reconcile' } opt was added to the template) would
      // otherwise default to 'recreate', zeroing those commits on a conflicting
      // rebase. The guard auto-promotes to 'reconcile' so no commit is lost even
      // with a stale template.
      const _resolvedOnConflict: WorktreeConflictPolicy = opts.onConflict ?? (
        isMainCommiterFix ? 'escalate'
        : attachesToOrigin ? 'reconcile'
        : 'recreate'
      )
      let _effectiveOnConflict: WorktreeConflictPolicy = _resolvedOnConflict
      if (opts.onConflict === undefined && _resolvedOnConflict === 'recreate') {
        const _taskRow = await store.getTask(taskId).catch(() => null)
        if (_taskRow?.workflow === 'remerge') {
          console.warn(
            `[setup] task ${taskId}: workflow=remerge but onConflict was not set; ` +
              `promoting to 'reconcile' to protect committed work. ` +
              `Upgrade .mars/workflows/remerge-workflow.js to pass ` +
              `{ onConflict: 'reconcile' } to suppress this warning.`,
          )
          _effectiveOnConflict = 'reconcile'
        }
      }

      await ensureWorktreeCurrent({
        taskId,
        ref,
        integrationBranch,
        phase: 'setup',
        onConflict: _effectiveOnConflict,
        traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
        store,
      })

      // Capture the integration HEAD sha at setup time (non-fatal).
      let integrationHeadSha = ''
      try {
        const { repoRoot } = resolveContext()
        const r = await runTool(
          {
            tool: 'git',
            argv: ['rev-parse', integrationBranch],
            cwd: repoRoot,
            taskId,
            originId: trace.originId,
            phase: 'setup',
          },
          trace.traceStore,
        )
        if (r.exitCode !== 0) throw new Error(`rev-parse exit ${r.exitCode}`)
        integrationHeadSha = r.stdout.trim()
        handle?.setSha(integrationHeadSha)
        await updateTask(taskId, { integrationHeadSha }, store)
      } catch {
        // Non-fatal: leave integration_head_sha as null.
      }

      // Build or load the index card for this task (best-effort, non-fatal).
      // The card is keyed on (integrationHeadSha, spec.files) so a warm disk
      // cache hit (same commit, same file shortlist) is free — no I/O beyond
      // a single stat(). An empty file list or missing SHA skips the card.
      const spec = input(ctx).spec ?? null
      let setupIndexCard: string | null = null
      if (integrationHeadSha && spec !== null && spec.files.length > 0) {
        try {
          const cardResult = loadOrBuildIndexCard({
            taskId,
            commitSha: integrationHeadSha,
            files: spec.files,
          })
          setupIndexCard = cardResult.text
          await trace.traceStore.record({
            kind: 'index-card.attached',
            taskId,
            originId: trace.originId,
            phase: 'setup',
            payload: {
              cacheKey: cardResult.cacheKey,
              tokens: cardResult.tokens,
              cacheHit: cardResult.cacheHit,
            },
          })
        } catch (cardErr) {
          console.warn(
            `[setup] task ${taskId}: index-card build failed (non-fatal):`,
            cardErr instanceof Error ? cardErr.message : String(cardErr),
          )
        }
      }

      // Dep-fingerprint check: skip installWorktreeDeps when the package
      // manifests and lockfiles are unchanged since the last successful install.
      // The fingerprint is persisted inside the worktree at .mars/dep-fingerprint
      // so a recovery rerrun (same worktree, same branch) can compare against it.
      const depFingerprintPath = join(ref.path, '.mars', 'dep-fingerprint')
      const newFp = await computeDepFingerprint(ref.path)
      let oldFp: string | null = null
      try {
        oldFp = (await readFile(depFingerprintPath, 'utf8')).trim()
      } catch {
        // File absent or unreadable — treat as fingerprint mismatch.
      }
      const depsSkipped = newFp !== null && newFp === oldFp

      if (!depsSkipped) {
        try {
          const summary = await installWorktreeDeps({
            worktreeRoot: ref.path,
            requireModuleTrees: true,
            log: (line) => console.log(line),
            traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
          })
          if (summary.sites.length > 0) {
            console.log(
              `[setup] task ${taskId} install completed in ${(
                summary.totalDurationMs / 1000
              ).toFixed(1)}s (${summary.sites.length} manifest${summary.sites.length === 1 ? '' : 's'})`,
            )
          }
          // Persist the fingerprint so the next setup invocation can skip
          // the install when manifests/lockfiles are unchanged.
          if (newFp !== null) {
            mkdirSync(join(ref.path, '.mars'), { recursive: true })
            writeFileSync(depFingerprintPath, newFp)
          }
        } catch (error: unknown) {
          const isInstallErr = error instanceof WorktreeInstallError
          const isModulesMissingErr = error instanceof WorktreeModulesMissingError
          const errorOutput = isInstallErr ? error.message : String(error)
          const failingStep = isModulesMissingErr
            ? error.failureStep
            : 'setup:install'

          // Repair-in-place FIRST: a frozen-install failure is an environment
          // failure, not a code defect. Reconcile the lockfile in the origin's
          // own worktree and continue; only escalate if the repair fails.
          if (isInstallErr) {
            try {
              const repair = await repairInstallInPlace({
                site: error.site,
                log: (line) => console.log(line),
                traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
              })
              if (repair.repaired) {
                if (repair.lockfileChanged) {
                  // Branch-safety guard: the lockfile-repair commit must land on
                  // the task's own branch, not on the integration branch.
                  const headBranchR = await runTool(
                    {
                      tool: 'git',
                      argv: ['rev-parse', '--abbrev-ref', 'HEAD'],
                      cwd: ref.path,
                      taskId,
                      originId: trace.originId,
                      phase: 'setup',
                    },
                    trace.traceStore,
                  )
                  const headBranch =
                    headBranchR.exitCode === 0 ? headBranchR.stdout.trim() : null
                  if (headBranch !== ref.branch) {
                    throw new Error(
                      `[setup:install] task ${taskId} branch-guard: lockfile repair would commit to ` +
                        `'${headBranch ?? '(detached)'}' but expected '${ref.branch}'; refusing commit`,
                    )
                  }
                  for (const argv of [
                    ['add', '-A'],
                    [
                      'commit',
                      '-m',
                      `chore(setup): reconcile ${error.site.lockfile} with manifest (in-place install repair)`,
                    ],
                  ]) {
                    const c = await runTool(
                      {
                        tool: 'git',
                        argv,
                        cwd: ref.path,
                        taskId,
                        originId: trace.originId,
                        phase: 'setup',
                      },
                      trace.traceStore,
                    )
                    if (c.exitCode !== 0) {
                      throw new Error(
                        `git ${argv[0]} after lockfile repair exited ${c.exitCode}: ${c.stderr}`,
                      )
                    }
                  }
                  console.log(
                    `[setup:install] task ${taskId} reconciled ${error.site.lockfile} in place and committed; continuing`,
                  )
                } else {
                  console.log(
                    `[setup:install] task ${taskId} install recovered in place (no lockfile change); continuing`,
                  )
                }
                // Persist fingerprint after successful in-place repair.
                if (newFp !== null) {
                  mkdirSync(join(ref.path, '.mars'), { recursive: true })
                  writeFileSync(depFingerprintPath, newFp)
                }
                // Emit log before early return so exactly one line appears per run.
                console.log(
                  `[setup] task ${taskId}: ${worktreeReused ? 'setup:reused-worktree' : 'setup:fresh-install'} (deps repaired in place)`,
                )
                return { path: ref.path, branch: ref.branch, indexCard: setupIndexCard }
              }
              console.log(
                `[setup:install] task ${taskId} in-place repair did not reconcile; escalating to fix-task`,
              )
            } catch (repairErr: unknown) {
              console.error(
                `[setup:install] task ${taskId} in-place repair errored; escalating to fix-task:`,
                repairErr,
              )
            }
          }

          const failSummary = errorOutput.slice(0, 1000)
          const setupSignature = computeFailureSignature(failingStep, errorOutput)
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: failSummary,
              failedPhase: 'code',
              failureReason: isModulesMissingErr ? failingStep : failSummary,
              failureSignature: setupSignature,
              failureReasonCode: setupSignature,
            },
            store,
          )
          await handleTaskFailureWithFixTask({
            taskId,
            failingStep,
            errorOutput: isModulesMissingErr
              ? `dependency module tree missing\n${errorOutput}`
              : `frozen-lockfile install failed\n${errorOutput}`,
            branch: ref.branch,
            store,
            recipeContext: {
              targetPath: isInstallErr || isModulesMissingErr ? error.site.dir : ref.path,
              statusOutput: errorOutput,
              targetBranch: ref.branch,
              originalPrompt: '',
            },
          }).catch((err) => {
            console.error(
              `[failure-handler] task ${taskId} ${failingStep} handling errored:`,
              err,
            )
          })
          throw error instanceof Error ? error : new Error(errorOutput)
        }
      }

      // Emit exactly one structured log line per setup run recording which
      // branch was taken. Mutually exclusive:
      //   setup:reused-deps     — worktree reused AND dep install skipped
      //   setup:reused-worktree — worktree reused, deps reinstalled
      //   setup:fresh-install   — full fresh setup (new worktree + install)
      if (depsSkipped) {
        console.log(`[setup] task ${taskId}: setup:reused-deps (dep fingerprint matched; install skipped)`)
      } else if (worktreeReused) {
        console.log(`[setup] task ${taskId}: setup:reused-worktree (existing worktree reused; deps reinstalled)`)
      } else {
        console.log(`[setup] task ${taskId}: setup:fresh-install (worktree created; deps installed)`)
      }

      return { path: ref.path, branch: ref.branch, indexCard: setupIndexCard }
    },
  })
  }
}
