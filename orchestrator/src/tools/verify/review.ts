/**
 * The `review` primitive shell (the verify step; `verify` is its alias in
 * the primitive registry).
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). Framework-owned:
 * gate selection and gate execution are delegated (`selectVerifySteps` and
 * the Verifier Port resolved via `resolveVerifier`), but every task-state
 * write below goes through
 * `ctx.services.store` (the Arc aggregate, ADR-0052) inside this shell. A
 * plugin that swaps the gates cannot change whether the outcome is recorded.
 *
 * This module itself now sits behind the Verifier Port as the `review` kind
 * (`../../core/ports/verifier/review-verifier.ts`, registered alongside the
 * gate-execution-level `local` kind) — that is the only module allowed to
 * import `review` from here directly. Every other caller resolves it via
 * `requireVerifier('review')` (or the `review` re-export from `../index.ts`,
 * which already goes through the Port).
 */
import { runTool } from '../../core/lib/run-tool'
import {
  restoreWorktreeIfMissing,
  ResumeWorktreeUnrecoverable,
  type WorktreeRef,
} from '../../core/lib/git/worktree'
import {
  selectVerifySteps,
  getChangedFiles,
  SPEC_VERIFY_CMD_STEP,
  VERIFY_TIMEOUT_MARKER,
  type VerifyStepSpec,
} from '../../core/lib/git/verify'
// The verify gates run through the Verifier Port, not the runner module
// (ADR-0097). `resolveVerifier` returns the implementation selected by
// `MARS_VERIFIER_KIND`; the default `local` binding wraps `verifyChanges`,
// so behaviour here is unchanged.
import { resolveVerifier } from '../../core/ports/verifier/registry'
import type { VerifierRunArgs, VerifierRunContext } from '../../core/ports/verifier/types'
// The suite-level infra retry asks the heuristic registry, not a hard-coded
// pattern list (TARGET §4.5). `infra-failure-patterns` is the built-in that
// answers today; a repo can register its own ahead of it.
import { isInfraFailure } from '../../registries/verify-heuristics'
import { appendEnrichmentScopes, recordEnrichmentShadowRuns } from '../../core/lib/gate-enrichment'
import { createWorker, Workers } from '../../core/workers'
import { resolveContext, getStateDir } from '../../core/context'
import { extractLastStreamText } from '../../core/lib/claude-stream'
import { readWorkerOutputText } from '../../core/lib/worker-json'
import { type TaskSpec, updateTask } from '../../core/queue'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { observeVerifyGateFailure } from '../../core/lib/gate-meta-monitor'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { quarantineVerifyGate } from '../../core/verify-gates'
import { buildEventInsert } from '../../bus/publisher'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { PROVIDER_MODELS, type ProviderModelTier } from '../../core/workers/provider-types'
import { runWorkerWithSpan, runNonLlmStepWithSpan } from '../../core/lib/run-worker-with-span'
import { type RanVerifyStep } from '../../core/lib/derive-repro-command'
import { failureExcerpt, MAIN_DIRTY_VERIFY_MESSAGE } from '../../workflows/primitives/shared'
// The one deliberate cross-family edge under tools/: the `reviewType: 'manual'`
// gate parks the task for a human rather than passing/failing it, so `review`
// hands off to the human family. Deployment is reached from the same gate
// (TARGET §4.4). Everything else stays inside its own family.
import { awaitHuman } from '../human/await-human'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import { loadDeployConfig, DeployConfigError } from '../../core/lib/deployment/config'
import { getProvider } from '../../core/lib/deployment/registry'
import { type DeployResult } from '../../core/lib/deployment/provider'
import { ReviewPacketSchema, type ReviewPacket } from '../../core/lib/review-packet'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  type MarsCtx,
  resolveTrace,
  resolveWorktree,
  readWorkflowInput as input,
  resolveTaskId,
  buildPhaseCtx,
  spanStore,
} from '../context'
import { validationRecorder } from '../validate-recorder'
import { buildSessionKey } from '../coder/session-key'

// ---------------------------------------------------------------------------
// review (formerly verify)
// ---------------------------------------------------------------------------

/** Per-call domain options for {@link review}. All fields default. */
export interface ReviewOpts {
  /** Pipeline kind. Default `'task'`. `'diagnose'` short-circuits. */
  kind?: 'task' | 'fix' | 'diagnose'
  /** Merge target. Default `'main'`. */
  integrationBranch?: string
  /** Serialised recovery payload; only on `kind:'fix'`. Default null. */
  recoveryPayload?: string | null
  /** Override the task id (defaults to `ctx.runId`). */
  taskId?: string
  /** Override the worktree (defaults to the one stashed by setupWorktree). */
  worktree?: WorktreeRef
  /**
   * Review type — WHO executes this step (workflow-declared).
   *   - `'auto'` (default) runs scope-aware typecheck/tests/lint.
   *   - `'manual'` boots the stack and parks for human QA.
   *   - `'full-review'` spawns a review agent that produces a ReviewPacket
   *     with findings across correctness/security/style/test-coverage.
   */
  reviewType?: 'auto' | 'manual' | 'full-review'
  /** Step guide for a `'manual'` step. Reserved for future use. */
  guide?: string
  /**
   * Structured task spec. Default null (falls back to `ctx.input.spec`).
   * When `spec.verifyCmd` is non-null, it is executed verbatim as a
   * required verify step before the configured gate steps, so the
   * acceptance command from the task brief is always exercised.
   */
  spec?: TaskSpec | null
  /**
   * Model tier for this review step. Meaningful for `reviewType:'full-review'`
   * only — the auto and manual paths do not dispatch an LLM. When set, the
   * tier is translated to a native model id via the review worker's Provider
   * tier map (`PROVIDER_MODELS[provider][tier]`). Verification judgment should
   * stay on `'flagship'` unless explicitly downgraded; omitting this field
   * inherits the worker's pinned default.
   */
  modelTier?: ProviderModelTier
}

/**
 * Structured outcome for a single verify gate step, recorded in the
 * `=== gate outcomes ===` JSON block of `capturedVerifyOutput`. Includes
 * the raw exit code and the full command line so failure diagnostics and
 * recovery prompts can show the exact command that ran without parsing the
 * free-form step output.
 *
 * Used by both the task-tier `review` primitive and the merge-time
 * integration-gate runner.
 */
export interface VerifyGateOutcome {
  name: string
  tier: 'task' | 'integration'
  passed: boolean
  duration?: number
  /** Raw subprocess exit code. Absent on built-in gates that do not shell out. */
  exitCode?: number | null
  /** Full command line as a single string (`cmd args…`). Absent on built-in gates. */
  commandLine?: string
}

export interface ReviewResult {
  verified: true
}

/**
 * Full-workspace review of the worktree's committed changes. Formerly named
 * `verify`. Two review types:
 *
 *   - `reviewType:'auto'` (default) — runs every configured typecheck/test/lint gate:
 *     - `kind:'diagnose'` short-circuits (no artefact to verify),
 *     - non-fix tasks run the verify-time dirty-main check and, if the
 *       integration branch is dirty, park behind a `main-commiter` recovery and
 *       throw the `verify:main-dirty` sentinel,
 *     - selects root gates plus path-covered scoped gates from the task's actual diff
 *       (a main-commiter recovery skips all test/typecheck/lint steps),
 *     - runs the gates through the Verifier Port (the has-diff / commits-ahead
 *       gate always runs),
 *     - on failure stamps the task, spawns the recovery fix-task through `store`,
 *       and throws.
 *   - `reviewType:'manual'` — boots the stack and parks for human QA via `awaitHuman`.
 *
 * Returns `{ verified: true }` on success. The throw model means reaching the
 * caller's merge step always implies review passed.
 *
 * Usage from a scaffolded workflow:
 * ```js
 * await ctx.step('review', () => review(ctx, { reviewType: 'auto' }))
 * ```
 */
export const review = async (
  ctx: MarsCtx,
  opts: ReviewOpts = {},
): Promise<ReviewResult> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'review',
      mode: opts.reviewType ?? 'auto',
      guide: opts.guide ?? null,
    })
    return { verified: true }
  }

  // Full-review type: spawn a review agent and produce a ReviewPacket.
  if (opts.reviewType === 'full-review') {
    const frTaskId = resolveTaskId(ctx, opts.taskId)
    const frStore: TaskStore = ctx.services.store
    const frWorktree = await resolveWorktree(ctx, frTaskId, frStore, opts.worktree)
    const frBranch = frWorktree.branch
    const frIntegrationBranch =
      opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'

    const reviewPrompt = [
      `You are a code reviewer. Review the changes on branch "${frBranch}" against "${frIntegrationBranch}".`,
      `Run: git diff ${frIntegrationBranch}...${frBranch} --stat`,
      `Then: git diff ${frIntegrationBranch}...${frBranch}`,
      '',
      'Produce a JSON object (and nothing else) matching this schema:',
      '{ "type": "full-review", "findings": [{ "category": "correctness"|"security"|"style"|"test-coverage", "severity": "info"|"warn"|"error", "message": "<description>", "file": "<path>", "line": <number> }], "generatedAt": "<ISO timestamp>" }',
      '',
      'Review for correctness bugs, security issues, style violations, and missing test coverage.',
      'Output ONLY the JSON object.',
    ].join('\n')

    // Apply modelTier for the review worker: translate tier to native model id
    // so verify-judgment (full-review) can be routed at 'flagship' without
    // editing Worker configs. Falls back to the Coder's pinned default when
    // modelTier is absent.
    const _frBaseWorker = Workers.Coder
    const _frTierModel =
      opts.modelTier !== undefined
        ? PROVIDER_MODELS[_frBaseWorker.config.provider][opts.modelTier]
        : undefined
    const worker =
      _frTierModel !== undefined && _frTierModel !== _frBaseWorker.config.model
        ? createWorker({ ..._frBaseWorker.config, model: _frTierModel, modelTier: opts.modelTier })
        : _frBaseWorker
    const sessionKey = buildSessionKey(frTaskId)
    const trace = await resolveTrace(ctx, frTaskId)

    const r = await runWorkerWithSpan({
      worker,
      prompt: reviewPrompt,
      runOptions: {
        cwd: frWorktree.path,
        sessionId: sessionKey,
        onEvent: async () => {},
        onPid: ctx.services.onPid,
      },
      traceStore: spanStore(trace),
      stepName: 'full-review',
      workflowInstanceId: trace.workflowInstanceId,
      originId: trace.originId,
      taskId: frTaskId,
      phase: 'verify',
      // Verify-judgment always runs on flagship: review reasoning is the
      // highest-risk step and must not be degraded by a Worker's default tier.
      modelTier: 'flagship',
    })

    const rawOutput =
      extractLastStreamText(r.conversation) ??
      readWorkerOutputText(worker.config.provider, r.stdout) ??
      ''
    let packet: ReviewPacket
    try {
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/)
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawOutput)
      packet = ReviewPacketSchema.parse(parsed)
    } catch {
      packet = {
        type: 'full-review',
        findings: [{
          category: 'correctness',
          severity: 'warn',
          message: 'Review agent output could not be parsed into a ReviewPacket.',
        }],
        generatedAt: new Date().toISOString(),
      }
    }

    await frStore.setReviewPacket(frTaskId, packet)
    return { verified: true }
  }

  // Manual review type: boot the stack and park for human QA.
  if (opts.reviewType === 'manual') {
    const manualTaskId = resolveTaskId(ctx, opts.taskId)
    const manualStore: TaskStore = ctx.services.store
    const manualWorktree = await resolveWorktree(ctx, manualTaskId, manualStore, opts.worktree)
    const cwd = manualWorktree.path

    // ── Remote deployment gate ─────────────────────────────────────────────
    // When .mars/deploy.config.json exists in stateDir, delegate QA hosting
    // to the configured provider.  The task parks in awaiting-validation in
    // both the success and failure paths — it must never fall through and
    // silently merge.
    const _stateDir = getStateDir()
    let _deployConfig: Awaited<ReturnType<typeof loadDeployConfig>> | null = null
    try {
      _deployConfig = await loadDeployConfig(_stateDir)
    } catch (err) {
      if (!(err instanceof DeployConfigError)) throw err
      // No deploy.config.json — fall through to local dev server.
    }

    if (_deployConfig !== null) {
      const provider = getProvider(_deployConfig.provider)
      if (!provider) {
        throw new Error(
          `preview-gate: deployment provider '${_deployConfig.provider}' is not registered`,
        )
      }
      const worktreeBranch = manualWorktree.branch

      let deployResult: DeployResult | null = null
      let deployErrMsg: string | null = null
      try {
        deployResult = await provider.deploy({
          taskId: manualTaskId,
          worktreePath: cwd,
          branch: worktreeBranch,
          env: _deployConfig.env,
        })
      } catch (err) {
        deployErrMsg = err instanceof Error ? err.message : String(err)
      }

      if (deployResult !== null) {
        // Success: write a ready deployment row and park for human validation.
        await manualStore.writeDeployment({
          taskId: manualTaskId,
          provider: _deployConfig.provider,
          deploymentId: deployResult.deploymentId,
          url: deployResult.url,
          status: 'ready',
        })
        await manualStore.updateTask(manualTaskId, {
          status: 'awaiting-validation',
          devServerUrl: deployResult.url,
          devServerPid: null,
        })
        raiseActionQueueItem({
          kind: 'awaiting-validation',
          category: 'task',
          priority: 'normal',
          title: `Validate ${manualTaskId}`,
          body: `Remote deployment ready${deployResult.url ? `: ${deployResult.url}` : ''}.`,
          payload: {
            taskId: manualTaskId,
            devServerUrl: deployResult.url,
            remoteUrl: deployResult.url,
            branch: worktreeBranch,
          },
          context: { taskId: manualTaskId },
          raisedBy: 'primitive:preview-gate',
          signature: manualTaskId,
          originTaskId: manualTaskId,
        }).catch((err) => {
          console.error(`[preview-gate] task ${manualTaskId} action-queue raise errored:`, err)
        })
      } else {
        // Failure: persist the error and notify the operator.
        const errMsg = deployErrMsg ?? 'deploy returned no result'
        const deploymentId = `deploy-fail-${manualTaskId}`
        const row = await manualStore.writeDeployment({
          taskId: manualTaskId,
          provider: _deployConfig.provider,
          deploymentId,
          url: null,
          status: 'failed',
        })
        await manualStore.updateDeploymentStatus(row.deploymentId, {
          status: 'failed',
          error: errMsg,
        })
        raiseActionQueueItem({
          kind: 'awaiting-validation',
          category: 'task',
          priority: 'normal',
          title: `Validate ${manualTaskId}: remote deploy failed`,
          body: errMsg,
          payload: { remoteUrl: null, branch: worktreeBranch },
          context: { taskId: manualTaskId },
          raisedBy: 'primitive:preview-gate',
          signature: `${manualTaskId}:deploy-failed`,
          originTaskId: manualTaskId,
        }).catch((err) => {
          console.error(`[preview-gate] task ${manualTaskId} action-queue raise errored:`, err)
        })
      }

      // In both cases, park the task — never fall through to local dev server.
      throw new WorkflowTerminalError(
        'preview-gate',
        deployErrMsg !== null
          ? `remote deploy failed for ${manualTaskId}: ${deployErrMsg}`
          : `remote deployment ready for ${manualTaskId}, awaiting validation`,
        { stepName: ctx.currentStep?.name ?? 'preview-gate' },
      )
    }
    // ── End remote deployment gate ──────────────────────────────────────────

    // Resolve boot command: task-spec previewCmd → package.json scripts.dev → error.
    let cmd: string | null = input(ctx).spec?.previewCmd ?? null
    if (!cmd) {
      try {
        const pkgRaw = await readFile(join(cwd, 'package.json'), 'utf8')
        const pkg = JSON.parse(pkgRaw) as Record<string, unknown>
        const scripts = pkg.scripts
        if (
          scripts !== null &&
          typeof scripts === 'object' &&
          'dev' in scripts &&
          typeof (scripts as Record<string, unknown>).dev === 'string'
        ) {
          cmd = (scripts as Record<string, string>).dev
        }
      } catch {
        // no package.json or parse error — fall through to the error below
      }
    }
    if (!cmd) {
      throw new Error(
        `manual review: no preview command found for task ${manualTaskId}. ` +
          `Set \`previewCmd\` on the task spec or add a "dev" script to ` +
          `package.json in the worktree (${cwd}).`,
      )
    }

    // Spawn the preview via the daemon-injected previewSpawn service.
    const { previewSpawn } = ctx.services
    if (!previewSpawn) {
      throw new Error(
        `manual review: previewSpawn service not available for task ${manualTaskId}. ` +
          `The daemon must inject MarsServices.previewSpawn.`,
      )
    }
    const { logPath, url: previewUrl } = await previewSpawn({
      taskId: manualTaskId,
      cmd,
      cwd,
    })

    // Park via awaitHuman with the preview info embedded in the payload.
    const guide = [
      `Test the app and run \`mars step done ${manualTaskId}\` to pass or ` +
        `\`mars release --abort ${manualTaskId} --note '<qa note>'\` to fail.`,
      previewUrl ? `Preview URL: ${previewUrl}` : null,
      `Logs: ${logPath}`,
    ]
      .filter(Boolean)
      .join('\n')

    await awaitHuman(ctx, {
      note: guide,
      taskId: manualTaskId,
      previewUrl: previewUrl ?? null,
      logPath,
    })
    // awaitHuman suspends until the operator runs `mars step done`. Reaching
    // here means they passed the QA gate (an abort releases the lease and
    // terminates the run instead), so the manual review verified.
    return { verified: true }
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const recoveryPayload =
    opts.recoveryPayload ?? input(ctx).recoveryPayload ?? null
  const spec = opts.spec ?? input(ctx).spec ?? null
  const store: TaskStore = ctx.services.store
  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)

  const worktreePath = worktree.path
  const branch = worktree.branch

  if (kind === 'diagnose') {
    return { verified: true }
  }

  let capturedVerifyOutput: string | undefined
  return await runNonLlmStepWithSpan({
    stepName: 'verify',
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    taskId: taskId,
    phase: 'verify',
    traceStore: spanStore(trace),
    getCommandOutput: () => capturedVerifyOutput,
    fn: async (): Promise<ReviewResult> => {
      // ── Worktree preflight: verify is a RESUME ENTRY POINT ────────────────
      // On a checkpoint-resume both `setup` and `code` short-circuit (their
      // records are 'completed'), so verify is the first step that actually
      // executes — and NOTHING before it revalidates the worktree. `runAgent`
      // has `restoreWorktreeIfMissing` for exactly this, but it lives inside
      // the `code` step, which is precisely the step that gets skipped.
      //
      // Observed live on mars-a13334fd (and 3 others): its recovery merged and
      // cleaned up the shared worktree + branch, after which every re-dispatch
      // skipped setup and code, ran verify against a deleted directory, and
      // failed. Because `verifyChanges` reports a hygiene throw under the step
      // name `has-diff`, this surfaced as `verify:has-diff failed` — on a diff
      // that was never examined — and the task re-queued forever (attempts
      // 4 → 10 in under a minute).
      //
      // Re-attach from the branch when the committed work still exists; when
      // the branch is gone too there is genuinely nothing to verify, so fail
      // ONCE with a named, orchestration-classified signature instead of
      // looping on a misleading one.
      try {
        const restored = await restoreWorktreeIfMissing({
          taskId,
          ref: { path: worktreePath, branch },
          traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
        })
        if (restored === 'rebuilt') {
          console.log(
            `[verify] task ${taskId}: worktree ${worktreePath} was missing on resume; ` +
              `re-attached from branch ${branch}`,
          )
        }
      } catch (err) {
        if (!(err instanceof ResumeWorktreeUnrecoverable)) throw err
        const summary = err.message
        const signature = computeFailureSignature('verify:worktree-missing', summary)
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: summary,
            failedPhase: 'verify',
            failureReason: 'verify:worktree-missing',
            failureSignature: signature,
            failureReasonCode: signature,
          },
          store,
        )
        throw new WorkflowTerminalError('resume-worktree-missing', summary)
      }

      // Verify-time dirty-main check (non-fix only).
      if (kind !== 'fix') {
        try {
          const {
            checkIntegrationBranchDirty,
            MAIN_COMMITER_RECIPE,
            spawnOrAttachMainCommitter,
          } = await import('../../core/lib/main-dirty')
          const { loadRecipeCatalog } = await import('../../core/lib/recipes')
          const verifyTopCtx = resolveContext()
          const detection = await checkIntegrationBranchDirty({
            repoRoot: verifyTopCtx.repoRoot,
            integrationBranch,
            traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
          })
          if (detection.dirty) {
            const catalog = await loadRecipeCatalog(verifyTopCtx.stateDir)
            const recipe = catalog.get(MAIN_COMMITER_RECIPE)
            if (recipe) {
              const resolution = await spawnOrAttachMainCommitter({
                sourceTaskId: taskId,
                detection,
                integrationBranch,
                dispatchPhase: 'verify',
                recipePrompt: recipe.prompt,
                sourceOriginId: trace.originId,
                store,
              })
              console.log(
                `[main-dirty] verify-time: task ${taskId} parked blocked on main-commiter ${resolution.fixTaskId} (${
                  resolution.spawned
                    ? resolution.reapedZombieCommitterId
                      ? `spawned fresh, replacing zombie committer ${resolution.reapedZombieCommitterId}`
                      : 'spawned fresh'
                    : `attached to live committer in status=${resolution.attachedToStatus}`
                })`,
              )
              throw new WorkflowTerminalError(
                'main-dirty-verify',
                `task ${taskId} verify:main-dirty: ${MAIN_DIRTY_VERIFY_MESSAGE}`,
              )
            } else {
              console.log(
                `[main-dirty] verify-time: integration branch is dirty but recipe '${MAIN_COMMITER_RECIPE}' is missing from the catalog; falling through to standard verify`,
              )
            }
          }
        } catch (err) {
          if (err instanceof WorkflowTerminalError && err.kind === 'main-dirty-verify') {
            throw err
          }
          console.warn(
            `[main-dirty] verify-time check threw, continuing with verify: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }

      // Branch-contamination guard (best-effort, non-fatal on git errors):
      // A task branch that was repointed onto the integration main line from
      // outside the normal workflow (e.g. by a concurrent restart/recovery
      // race rewriting the branch ref) would otherwise cause verify to run
      // against mismatched code and produce misleading errors like "Conflicting
      // declarations" when multiple tasks' commits are combined on one branch.
      // Catch it early with a clear `verify:branch-contaminated` signal.
      //
      // Three shapes are distinguished:
      //   1. Zero commits ahead (`integrationBranch..HEAD` == 0): the agent
      //      legitimately produced no commits, or its commits were already
      //      fast-forwarded into integration via another path. Both sub-shapes
      //      are benign — fall through to verifyChanges, which accepts them as
      //      "no-op accepted" or "work already merged" (checkBranchHasDiff).
      //   2. Positive commits AND HEAD is an ancestor of integrationBranch:
      //      the branch was externally repointed onto the integration timeline
      //      (parallel recovery/restart race). Hard-fail.
      //
      // Not applied to fix tasks (they run on the origin's branch, which is
      // expected to start on the integration timeline and then add commits).
      if (kind !== 'fix') {
        try {
          // Count task-specific commits first. A zero-ahead count means there
          // is no un-integrated work — verifyChanges handles both the
          // "no-op" and "already merged" sub-shapes correctly. Only when the
          // branch has commits that are NOT yet on integration can --is-ancestor
          // returning 0 indicate a genuine external repoint.
          const countResult = await runTool(
            {
              tool: 'git',
              argv: ['rev-list', '--count', `${integrationBranch}..HEAD`],
              cwd: worktreePath,
              expectsFailure: true,
              taskId,
              originId: trace.originId,
              phase: 'verify',
            },
            trace.traceStore,
          )
          const aheadCount = Number.parseInt(countResult.stdout.trim(), 10)
          if (Number.isInteger(aheadCount) && aheadCount > 0) {
            // Task produced commits not yet on integration; check if HEAD was
            // externally repointed onto the integration timeline.
            const ancestorResult = await runTool(
              {
                tool: 'git',
                argv: ['merge-base', '--is-ancestor', 'HEAD', integrationBranch],
                cwd: worktreePath,
                expectsFailure: true,
                taskId,
                originId: trace.originId,
                phase: 'verify',
              },
              trace.traceStore,
            )
            if (ancestorResult.exitCode === 0) {
              // HEAD is on the integration timeline — branch was contaminated.
              const headShortResult = await runTool(
                {
                  tool: 'git',
                  argv: ['rev-parse', '--short', 'HEAD'],
                  cwd: worktreePath,
                  expectsFailure: true,
                  taskId,
                  originId: trace.originId,
                  phase: 'verify',
                },
                trace.traceStore,
              )
              const headShort = headShortResult.stdout.trim() || 'unknown'
              const contamMsg = `branch HEAD ${headShort} is already an ancestor of ${integrationBranch} — task branch was repointed onto the integration timeline (parallel recovery/restart race)`
              const contamSignature = computeFailureSignature(
                'verify:branch-contaminated',
                contamMsg,
              )
              await updateTask(
                taskId,
                {
                  status: 'failed',
                  error: contamMsg,
                  failedPhase: 'verify',
                  failureReason: 'verify:branch-contaminated',
                  failureSignature: contamSignature,
                  failureReasonCode: contamSignature,
                },
                store,
              )
              throw new Error(
                `task ${taskId} verify:branch-contaminated: ${contamMsg}`,
              )
            }
          }
          // aheadCount == 0 (or unparseable): fall through to verifyChanges.
        } catch (guardErr) {
          // Re-throw contamination sentinel so it stops the pipeline.
          if (
            guardErr instanceof Error &&
            guardErr.message.includes('verify:branch-contaminated')
          ) {
            throw guardErr
          }
          // Other git failures (e.g. timeout, git not found) are non-fatal;
          // fall through to the standard verify steps.
          console.warn(
            `[verify] task ${taskId} branch-contamination guard threw, continuing:`,
            guardErr instanceof Error ? guardErr.message : guardErr,
          )
        }
      }

      await updateTask(
        taskId,
        { status: 'verifying', failedPhase: null, activityDetail: 'verify' },
        store,
      )

      // Acquire the daemon-level verify semaphore (MARS_MAX_VERIFY) before
      // running the CPU-intensive test suite. This releases the implement slot
      // first (see dispatchImplement) so other tasks can keep coding while this
      // one waits for a free verify slot. When absent (scaffolded workflows,
      // test contexts without the daemon plumbing), verify runs uncapped.
      await ctx.services.acquireVerifySlot?.()

      // Wrap the verify body: any unexpected throw (e.g. verifyChanges rejects,
      // lock acquisition fails) must transition the task to 'failed' before
      // rethrowing, so the row never stays pinned in 'verifying' until the
      // phantom-task watchdog ceiling (mars-42b5bfec).
      let _verifyFailedRecorded = false
      try {
      // Verify step dirs are repo-root-relative supervisor scopes (for example
      // `ui` or `orchestrator`). Anchor them at the worktree root so each
      // scoped command runs in `<worktree>/<scope>`, not beneath whichever
      // subproject happens to be selected by the legacy repro heuristic.
      const verifyCwd = worktreePath
      const verifyCtx = resolveContext()
      const { loadVerifyGates } = await import('../../core/verify-gates')
      const recipeScopes = await loadVerifyGates(store)
      // Gate-enrichment merge (PRD 745f33e0): human-approved shadow/enforcing
      // checks from the signature-keyed registry are appended BEHIND
      // loadVerifyGates and flow through the same changed-path selection below
      // — no recipe schema change,
      // and the seam survives the manifest.json→verify.json migration.
      // `appendEnrichmentScopes` never throws (registry failure → recipe
      // scopes untouched).
      const scopes = await appendEnrichmentScopes(store, recipeScopes)
      const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE, checkIntegrationBranchDirty } = await import(
        '../../core/lib/main-dirty'
      )
      const commiterPayload =
        recoveryPayload != null
          ? parseMainCommiterPayload(recoveryPayload)
          : null
      const isMainCommitter = commiterPayload?.recipe === MAIN_COMMITER_RECIPE
      const changedFiles = await getChangedFiles(
        worktreePath,
        integrationBranch,
        branch,
        buildPhaseCtx(trace, taskId, 'verify'),
      )
      const gateSteps = isMainCommitter ? [] : selectVerifySteps(scopes, changedFiles)
      // Append the operator-declared acceptance command as a required task-tier
      // step so it runs verbatim with its true exit code.  bash -o pipefail
      // propagates the leftmost non-zero exit from any pipeline in the command.
      // Main-committer recoveries skip all gate steps (including this one).
      const specVerifyCmdRaw = !isMainCommitter ? (spec?.verifyCmd?.trim() ?? '') : ''
      // Safety: rewrite any absolute repo-root path in verifyCmd to the task
      // worktree path so the acceptance command always runs against the task
      // branch, not main's tree. This guards against absolute-path specs that
      // slipped through the CLI validation gate (e.g. in tests or via the daemon
      // RPC directly).
      const specVerifyCmd =
        specVerifyCmdRaw && verifyCtx.repoRoot
          ? specVerifyCmdRaw.replaceAll(verifyCtx.repoRoot, worktreePath)
          : specVerifyCmdRaw
      const specVerifyStep: VerifyStepSpec | null = specVerifyCmd
        ? {
            name: SPEC_VERIFY_CMD_STEP,
            required: true,
            tier: 'task',
            cmd: 'bash',
            args: ['-o', 'pipefail', '-c', specVerifyCmd],
          }
        : null
      const steps = specVerifyStep ? [...gateSteps, specVerifyStep] : gateSteps

      // The serializable half of the request (ADR-0097): everything a remote
      // Verifier implementation would receive over the wire.
      const verifierRunArgs: VerifierRunArgs = {
        cwd: verifyCwd,
        steps,
        branch,
        integrationBranch,
        changedFiles: isMainCommitter ? [] : changedFiles,
      }
      // The in-process-only half: trace emission, PID tracking and the gate
      // abort signal, passed out of band so `verifierRunArgs` stays
      // wire-crossable. The `local` implementation honours all three.
      const verifierRunCtx: VerifierRunContext = {
        traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
        onChildPid: ctx.services.onVerifyChildPid,
        signal: ctx.services.verifyGateSignal,
      }
      const verifier = resolveVerifier()

      let r = await verifier.run(verifierRunArgs, verifierRunCtx)

      // Infra-failure retry (once only): if any failed step output matches an
      // infrastructure-failure pattern (embedded-PG shutdown mid-suite, Spring
      // context init error), retry the full suite once before counting the
      // failures as real regressions.  Genuine assertion failures still surface
      // because the retry runs on a clean, serially-acquired DB — the retry
      // just removes phantom failures caused by concurrent infra contention.
      if (!r.passed) {
        const failedSteps = r.steps.filter((s) => !s.passed)
        if (failedSteps.some((s) => isInfraFailure(s.output))) {
          console.log(
            `[verify] task ${taskId}: infra failure detected in ${failedSteps.length} step(s) ` +
              `(embedded-PG shutdown or Spring context init); retrying once`,
          )
          r = await verifier.run(verifierRunArgs, verifierRunCtx)
        }
      }

      // Shadow burn-in accounting for enriched checks (PRD 745f33e0): each
      // enrich:<signature> step that ran in shadow status records one clean
      // parse against its per-check gate_burn_in row; the parse that crosses
      // SHADOW_BURN_IN_COUNT auto-promotes the record shadow → enforcing.
      // Best-effort — never breaks the verify path.
      await recordEnrichmentShadowRuns(store, r.steps).catch(() => {})

      // Main-committer invariant: the integration checkout must be clean after
      // the committer ran. A committer task may only succeed if
      // `git status --porcelain` on the integration branch's primary checkout
      // (repoRoot, not the committer worktree) is empty. If the checkout is
      // still dirty — e.g. because ignored files remain (a checkpoint never
      // captures those), or the committer exited without committing anything
      // meaningful — the
      // verify step must fail so the task escalates to the action queue for
      // operator review (non-recoverable per ADR-0040).
      //
      // Only fires when `verifyChanges` already passed: no point stacking a
      // second failure message on top of an already-failed verify run.
      if (r.passed && commiterPayload?.recipe === MAIN_COMMITER_RECIPE) {
        const postClean = await checkIntegrationBranchDirty({
          repoRoot: verifyCtx.repoRoot,
          integrationBranch,
          traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
        })
        if (postClean.dirty) {
          // Orchestration invariant: the integration checkout must be clean after
          // the committer ran. However, we scope this to paths the committer was
          // explicitly checkpointed to clean — dirt that appeared AFTER the
          // checkpoint was captured is normal concurrent work and already handled
          // by the dispatch-time dirty-main check that will spawn a fresh
          // committer on the next cycle. Failing the committer on post-checkpoint
          // dirt would incorrectly penalise it for work it never saw.
          const { handleCommitterStillDirty } = await import(
            '../../core/daemon/main-dirty-action-queue'
          )
          const allDirtyPaths = postClean.statusOutput
            .split('\n')
            .map((l) => l.slice(3).trim())
            .filter(Boolean)
          const checkpointedPaths = commiterPayload.checkpointedPaths
          if (checkpointedPaths !== undefined && checkpointedPaths.length > 0) {
            const checkpointedSet = new Set(checkpointedPaths)
            const stillDirty = allDirtyPaths.filter((p) => checkpointedSet.has(p))
            if (stillDirty.length > 0) {
              // Checkpointed paths still dirty → genuine committer failure.
              // The _verifyFailedRecorded flag prevents the outer catch from
              // double-stamping.
              await handleCommitterStillDirty(taskId, integrationBranch, stillDirty, store)
              _verifyFailedRecorded = true
              throw new WorkflowTerminalError(
                'committer-still-dirty',
                `task ${taskId} orchestration:main-committer-still-dirty: integration branch ${integrationBranch} still dirty after committer ran`,
              )
            }
            // All checkpointed paths were cleaned; new dirt appeared post-checkpoint.
            // Let the committer succeed; the dispatch-time check will spawn a fresh
            // committer for the new dirt on the next cycle.
            console.log(
              `[main-dirty] verify-time: ${allDirtyPaths.length} new dirty path(s) appeared after ` +
                `checkpoint; a fresh committer cycle will handle them`,
            )
          } else {
            // Legacy row (no checkpointedPaths recorded): keep the original strict
            // behaviour so pre-existing rows don't silently pass a dirty tree.
            await handleCommitterStillDirty(taskId, integrationBranch, allDirtyPaths, store)
            _verifyFailedRecorded = true
            throw new WorkflowTerminalError(
              'committer-still-dirty',
              `task ${taskId} orchestration:main-committer-still-dirty: integration branch ${integrationBranch} still dirty after committer ran`,
            )
          }
        }
      }

      // Enrich each step header with tier, duration, exit code, and invocation
      // for the run-timeline view. Operators and coders reading verifyOutput
      // can tell which command failed, its true exit code, and the exact
      // invocation to re-run to reproduce — without correlating back to the
      // original recipe.
      const verifyOutput = r.steps
        .map((s) => {
          const tierBadge =
            s.tier === 'integration'
              ? ' [integration:deferred]'
              : s.tier === 'task'
                ? ' [task]'
                : ''
          const durationBadge =
            s.duration !== undefined ? ` ${s.duration}ms` : ''
          // exitCode is present (number or null) when a subprocess actually ran.
          // null means the abort signal killed the process before it could exit.
          const exitBadge =
            s.exitCode !== undefined ? ` exit=${s.exitCode ?? 'killed'}` : ''
          // Show the raw invocation so the reader can reproduce locally.
          const cmdLine =
            s.cmd !== undefined
              ? `$ ${s.cmd}${s.args?.length ? ' ' + s.args.join(' ') : ''}\n`
              : ''
          return `=== ${s.name} (${s.passed ? 'pass' : 'fail'})${tierBadge}${durationBadge}${exitBadge} ===\n${cmdLine}${s.output}`
        })
        .join('\n\n')
      // Append a structured gate-outcomes block so the run-timeline view can
      // surface per-gate metrics (name, tier, passed, duration) without parsing
      // free-form step output.
      // Note: `has-diff` is included in r.steps when it passes (it is a real
      // gate that ran). A non-empty gateOutcomes means at least one gate ran;
      // a no-coverage task now contributes the explicit
      // `cant-verify:no-gate-coverage` outcome rather than a silent empty list.
      const gateOutcomes = r.steps.map((s) => ({
        name: s.name,
        tier: s.tier ?? 'task',
        passed: s.passed,
        exitCode: s.exitCode ?? null,
        ...(s.duration !== undefined ? { duration: s.duration } : {}),
      }))
      const gateOutcomesBlock =
        gateOutcomes.length === 0
          ? '(no gates ran)\n[]'
          : JSON.stringify(gateOutcomes, null, 2)
      capturedVerifyOutput =
        verifyOutput +
        '\n\n=== gate outcomes ===\n' +
        gateOutcomesBlock

      // Registry-backed task gates are observed before ordinary failure
      // handling. A systemic threshold crossing quarantines only that gate,
      // turning its result into a passing CAN'T-VERIFY diagnostic; any other
      // active gate failure remains a normal task failure.
      if (!r.passed) {
        for (const step of r.steps) {
          if (step.passed || step.tier !== 'task' || step.gateId === undefined) continue
          const failureSignature = computeFailureSignature(
            `verify:${step.name}`,
            step.output,
          )
          try {
            const quarantined = await store.atomic(async (tx) => {
              const observed = await observeVerifyGateFailure(tx, {
                gateId: step.gateId!,
                originId: trace.originId,
                failureSignature,
                failedAt: Date.now(),
              })
              if (!observed.thresholdCrossed) return false
              const transitioned = await quarantineVerifyGate(
                tx,
                step.gateId!,
                failureSignature,
                trace.originId,
              )
              if (transitioned) {
                await tx.execute(
                  buildEventInsert('verify-gate.quarantined', {
                    gateId: step.gateId!,
                    originId: trace.originId,
                    failureSignature,
                    failureEvidence: step.output,
                  }),
                )
              }
              return transitioned
            })
            if (quarantined) {
              step.passed = true
              step.output = `CAN'T-VERIFY: registry gate ${step.name} was quarantined after systemic failures\n${step.output}`
            }
          } catch (error) {
            console.error(
              `[verify] task ${taskId}: could not observe registry gate ${step.gateId}:`,
              error,
            )
          }
        }
        const stillHasRequiredFailure = r.steps.some((step) => {
          if (step.passed) return false
          if (step.gateId === undefined) return true
          return steps.find((spec) => spec.gateId === step.gateId)?.required ?? true
        })
        if (!stillHasRequiredFailure) {
          r.passed = true
          r.verdict = "CAN'T-VERIFY"
        }
      }

      if (!r.passed) {
        const failed = r.steps.filter((s) => !s.passed)
        const summary = failed
          .map((s) => `${s.name}:\n${failureExcerpt(s.output)}`)
          .join('\n\n')

        // Child-vanished abort: the daemon heartbeat detected the verify child
        // pid has been dead longer than the grace window and fired the abort
        // signal. Classify immediately as 'verify:child-vanished' rather than
        // deriving a generic gate signature from whatever step happened to be
        // running. Skip recovery-fix dispatch — a vanished child is an
        // infrastructure event (process killed externally), not a code defect.
        // The semaphore is released via the finally block below.
        if (
          ctx.services.verifyGateSignal?.aborted &&
          ctx.services.verifyGateSignal.reason === 'verify:child-vanished'
        ) {
          const sig = 'verify:child-vanished'
          const vanishedOutput = summary || 'verify child pid vanished mid-verify'
          capturedVerifyOutput = capturedVerifyOutput ?? `${sig}\n${vanishedOutput}`
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: vanishedOutput,
              failedPhase: 'verify',
              failureReason: sig,
              failureReasonCode: sig,
              failureSignature: sig,
              verifyOutput: capturedVerifyOutput,
            },
            store,
          )
          _verifyFailedRecorded = true
          throw new Error(`task ${taskId} ${sig}`)
        }

        const firstFailedName = failed[0]?.name ?? 'verify'
        // Build a structured diagnostics block for each failed gate so
        // post-mortems and recovery prompts can see the actual command, cwd,
        // exit code, stdout, and stderr rather than just the merged output.
        // Synthetic steps (integration-clean, has-diff) lack cmd/stepDir —
        // fall back to the step's combined output for those.
        const gateFailureDiags = failed
          .map((s) => {
            if (s.cmd !== undefined && s.stepDir !== undefined) {
              const cmdPart = `${s.cmd}${s.args?.length ? ' ' + s.args.join(' ') : ''}`
              const stdoutPart = s.stdout ? `\nstdout:\n${failureExcerpt(s.stdout)}` : ''
              const stderrPart = s.stderr ? `\nstderr:\n${failureExcerpt(s.stderr)}` : ''
              return (
                `--- diagnostics: ${s.name} ---\n` +
                `cmd: ${cmdPart}\n` +
                `cwd: ${s.stepDir}\n` +
                `exitCode: ${s.exitCode ?? 'null'}` +
                stdoutPart +
                stderrPart
              )
            }
            return `--- diagnostics: ${s.name} ---\n${failureExcerpt(s.output)}`
          })
          .join('\n\n')
        // Re-assign capturedVerifyOutput to include the diagnostics block
        // BEFORE the gate-outcomes JSON so the run-timeline view and recovery
        // prompts both see the structured failure detail.
        capturedVerifyOutput =
          verifyOutput +
          '\n\n=== gate failure diagnostics ===\n' +
          gateFailureDiags +
          '\n\n=== gate outcomes ===\n' +
          gateOutcomesBlock
        // Build firstFailedOutput with the gate identity, exit code, and
        // stderr excerpt so the Fixer prompt shows the real failure context.
        const firstFailed = failed[0]
        // A conventional 128+N exit means the child died from signal N, not
        // that its verify command reported a defect. Keep the signal separate
        // from the gate that happened to be running: otherwise a SIGTERM while
        // typecheck runs is incorrectly recorded as `verify:typecheck`.
        const killedBy =
          firstFailed?.exitCode === 143
            ? 'sigterm'
            : firstFailed?.exitCode === 137
              ? 'sigkill'
              : null
        const failingStep = killedBy === null ? `verify:${firstFailedName}` : 'verify:killed'
        const firstFailedOutputBody = firstFailed
          ? firstFailed.cmd !== undefined
            ? failureExcerpt(
                [
                  firstFailed.name,
                  `cmd: ${firstFailed.cmd}${firstFailed.args?.length ? ' ' + firstFailed.args.join(' ') : ''}`,
                  `cwd: ${firstFailed.stepDir ?? ''}  exitCode: ${firstFailed.exitCode ?? 'null'}`,
                  ...(firstFailed.stderr
                    ? [`stderr:\n${failureExcerpt(firstFailed.stderr)}`]
                    : []),
                  ...(firstFailed.stdout
                    ? [`stdout:\n${failureExcerpt(firstFailed.stdout)}`]
                    : []),
                ].join('\n'),
              )
            : failureExcerpt(firstFailed.output)
          : summary
        // A per-step wall-clock timeout prefixes the step's `output` field
        // with VERIFY_TIMEOUT_MARKER (runVerifyStep, git/verify.ts) — but
        // that prefix never reaches `stdout`/`stderr`, which is what
        // firstFailedOutputBody is built from above. Recover the marker line
        // here so computeFailureSignature's timeout override still fires
        // (`verify:timeout/<step>`) instead of falling through to a generic
        // classification of whatever partial stdout/stderr was captured.
        const timeoutMarkerLine =
          firstFailed?.output !== undefined && firstFailed.output.startsWith(VERIFY_TIMEOUT_MARKER)
            ? firstFailed.output.split('\n', 1)[0]
            : null
        // `computeFailureSignature` preserves an explicit signature at the
        // start of the output. This lets the downstream failure handler derive
        // the same infrastructure signature instead of reclassifying an empty
        // killed child as an unclassified typecheck failure.
        const firstFailedOutput =
          timeoutMarkerLine !== null
            ? `${timeoutMarkerLine}\n${firstFailedOutputBody}`
            : killedBy === null
              ? firstFailedOutputBody
              : `${failingStep}/${killedBy}\n${firstFailedOutputBody}`
        const ranVerifySteps: RanVerifyStep[] = r.steps
          .filter(
            (s): s is typeof s & { cmd: string; stepDir: string } =>
              s.cmd !== undefined && s.stepDir !== undefined,
          )
          .map((s) => ({
            name: s.name,
            cmd: s.cmd,
            args: s.args ?? [],
            stepDir: s.stepDir,
            passed: s.passed,
            exitCode: s.exitCode ?? null,
          }))
        const verifySignature = computeFailureSignature(
          failingStep,
          firstFailedOutput,
        )
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: summary,
            failedPhase: 'verify',
            failureReason: failingStep,
            failureSignature: verifySignature,
            failureReasonCode: verifySignature,
          },
          store,
        )
        _verifyFailedRecorded = true
        await runNonLlmStepWithSpan({
          stepName: 'recovery-dispatch',
          workflowInstanceId: trace.workflowInstanceId,
          originId: trace.originId,
          taskId: taskId,
          phase: 'verify',
          traceStore: spanStore(trace),
          fn: () =>
            handleTaskFailureWithFixTask({
              taskId,
              failingStep,
              errorOutput: firstFailedOutput,
              branch,
              ranVerifySteps,
              store,
              recipeContext: {
                targetPath: worktreePath,
                statusOutput: firstFailedOutput,
                targetBranch: branch,
                integrationBranch,
                originalPrompt: '',
              },
            }),
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${taskId} verify failure handling errored:`,
            err,
          )
        })
        throw new Error(`task ${taskId} verify:${firstFailedName} failed`)
      }

      return { verified: true }
      } catch (err) {
        // Only stamp if the deliberate !r.passed path has not already recorded
        // a failure. Best-effort write (mirrors phantom-task-watchdog pattern):
        // if the status write itself throws, swallow it so the original error
        // propagates unchanged.
        if (!_verifyFailedRecorded) {
          // Populate capturedVerifyOutput so getCommandOutput returns non-empty
          // for the step_ended trace event, and persist it on the task record
          // so structural crashes don't surface as 'none recorded'.
          capturedVerifyOutput =
            capturedVerifyOutput ??
            'verify:step-threw\n' +
              (err instanceof Error ? (err.stack ?? err.message) : String(err))
          await updateTask(
            taskId,
            {
              status: 'failed',
              failedPhase: 'verify',
              failureReason: err instanceof Error ? err.message : String(err),
              failureReasonCode: 'verify:step-threw',
              verifyOutput: capturedVerifyOutput,
            },
            store,
          ).catch(() => {})
        }
        throw err
      } finally {
        // Release the daemon-level verify semaphore slot unconditionally so the
        // next queued verify step can proceed regardless of pass/fail/throw.
        ctx.services.releaseVerifySlot?.()
      }
    },
  })
}
