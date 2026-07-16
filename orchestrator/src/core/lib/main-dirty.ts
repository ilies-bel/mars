/**
 * Slice F.2: dirty-main detection helper.
 *
 * Both detection points (dispatch-time before worktree spawn, and verify-time
 * at the top of the verify step) share this helper. It probes the integration
 * branch's working tree with `git status --porcelain`. When the branch is
 * dirty, active-committer dedup is keyed on the integration branch name:
 * parallel integration branches each get their own independent committer,
 * and all tasks on the same branch share one committer regardless of which
 * files are dirty or where HEAD is.
 *
 * All git calls go through `runTool` so they emit `tool_invoked` trace events
 * (slice C). The single source of truth for "dirty" is the porcelain output —
 * non-empty ⇒ dirty.
 *
 * The helper is best-effort against transient git failures: if `git status`
 * itself errors, it returns `{ dirty: false }` and the caller proceeds as if
 * the branch is clean. The legacy `checkSetupPreflight` backstop that used to
 * catch transient git failures was retired in slice K; pessimistically
 * reporting clean here is the documented fallback now.
 */
import { runTool, type TraceCtx } from './run-tool'
import { attachToExistingFixTask } from '../queue-fix-tasks'
import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from '../store/task-store'
import { Arc } from '../arc'
import type { TraceEventStore } from './trace-events-store'

export interface CheckIntegrationBranchDirtyInput {
  /** Repo root where the integration branch is checked out (NOT a worktree). */
  repoRoot: string
  /**
   * Integration branch name (e.g. 'main'). Used to guard against stranded
   * checkouts: if repoRoot HEAD is on a different branch (e.g. a task branch
   * left behind by a crashed merge step), the probe returns dirty:false and
   * emits a warning rather than misreading that branch's state as dirty main.
   */
  integrationBranch: string
  /** Trace context; phase is left to the caller's run (setup or verify). */
  traceCtx: TraceCtx
}

export interface IntegrationBranchDirtyResult {
  dirty: boolean
  /**
   * Raw `git status --porcelain` output (untracked included). Empty string
   * when clean. Surfaced for log lines and the aggregated actionQueue row.
   */
  statusOutput: string
}

/**
 * Probe the integration branch's working tree.
 *
 * Failure-mode contract:
 *  - Non-zero exit from `git rev-parse --abbrev-ref HEAD` ⇒ skip the
 *    stranded-checkout guard and proceed to the status check (best-effort).
 *  - Non-zero exit from `git status` ⇒ treat as clean (return dirty:false).
 *    Pessimistically reporting clean here is safer than throwing, which
 *    would crash the dispatch loop on a transient git hiccup. (The legacy
 *    setup-time preflight that doubled as a backstop was retired in
 *    slice K.)
 */
export const checkIntegrationBranchDirty = async (
  input: CheckIntegrationBranchDirtyInput,
): Promise<IntegrationBranchDirtyResult> => {
  const { repoRoot, traceCtx, integrationBranch } = input

  // Guard: verify repoRoot is actually on the integration branch. If the
  // primary checkout is stranded on a task branch after a crashed merge step,
  // `git status` reads that branch's state as "dirty main" and drives a
  // false-positive committer loop. Returning dirty:false here is safe —
  // pessimistically reporting clean prevents the loop without losing work.
  const branchProbe = await runTool(
    {
      tool: 'git',
      argv: ['rev-parse', '--abbrev-ref', 'HEAD'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch(() => null)

  if (branchProbe !== null && branchProbe.exitCode === 0) {
    const currentBranch = branchProbe.stdout.trim()
    if (currentBranch !== integrationBranch) {
      let strandedCheckout = true
      if (currentBranch === 'HEAD') {
        // Detached HEAD is OK when it points to the integration branch tip.
        const headShaProbe = await runTool(
          {
            tool: 'git',
            argv: ['rev-parse', 'HEAD'],
            cwd: repoRoot,
            taskId: traceCtx.taskId ?? null,
            originId: traceCtx.originId ?? null,
            phase: traceCtx.phase ?? null,
            expectsFailure: true,
          },
          traceCtx.store,
        ).catch(() => null)
        const integShaProbe = await runTool(
          {
            tool: 'git',
            argv: ['rev-parse', integrationBranch],
            cwd: repoRoot,
            taskId: traceCtx.taskId ?? null,
            originId: traceCtx.originId ?? null,
            phase: traceCtx.phase ?? null,
            expectsFailure: true,
          },
          traceCtx.store,
        ).catch(() => null)
        if (
          headShaProbe?.exitCode === 0 &&
          integShaProbe?.exitCode === 0 &&
          headShaProbe.stdout.trim() === integShaProbe.stdout.trim()
        ) {
          strandedCheckout = false // Detached at integration branch tip — OK.
        }
      }
      if (strandedCheckout) {
        console.warn(
          `[main-dirty] integration branch repoRoot is checked out on ${currentBranch}, expected ${integrationBranch}; skipping dirty-main probe`,
        )
        return { dirty: false, statusOutput: '' }
      }
    }
  }

  // `--untracked-files=all` so a wholly-new directory shows up file-by-file
  // — the same convention as the post-coder porcelain parse. The committer
  // recipe operator will read these paths verbatim.
  const status = await runTool(
    {
      tool: 'git',
      argv: ['status', '--porcelain', '--untracked-files=all'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      // Non-zero exit on `git status` here is a real error (e.g. repoRoot is
      // not a git repo), but we still want the trace classed as `warn` since
      // we recover by treating the branch as clean.
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch((err: unknown) => {
    // Spawn-time errors fall through as "treat as clean" too.
    return {
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: 0,
      traceEventId: '',
    }
  })

  if (status.exitCode !== 0) {
    return { dirty: false, statusOutput: '' }
  }
  const statusOutput = status.stdout
  if (statusOutput.length === 0) {
    return { dirty: false, statusOutput: '' }
  }

  return { dirty: true, statusOutput }
}

/**
 * Failure code emitted whenever dirty-main detection parks a task. Aligns
 * with the failure-reason catalog entry in `failure-reasons/built-in.ts`.
 * Kept as a module constant so the dispatch-time and verify-time call sites
 * cannot drift.
 */
export const VERIFY_MAIN_DIRTY_CODE = 'verify:main-dirty'

/**
 * Recipe name that resolves the committer agent (see
 * `recipes/built-in/main-commiter.md`). Stored on the recovery task's
 * `recovery_payload` so future actionQueue / UI code can render which recipe a
 * given recovery is running.
 */
export const MAIN_COMMITER_RECIPE = 'main-commiter'

/**
 * Shape of the JSON blob persisted on `tasks.recovery_payload` for a
 * `main-commiter` recovery. Other recipes that adopt the same column will
 * use their own shape; the column is opaque at the persistence layer.
 */
export interface MainCommiterPayload {
  recipe: typeof MAIN_COMMITER_RECIPE
  /**
   * Integration branch the committer is parked on. This is the active-committer
   * dedup key: parallel integration branches each get their own independent
   * committer, and all tasks on the same branch share one committer regardless
   * of what files are dirty or where HEAD is.
   */
  integrationBranch: string
}

/**
 * Parse a recovery_payload string into a typed MainCommiterPayload, returning
 * null when the payload is missing, malformed, or for a different recipe.
 * Used by the catalog auto-resolve and aggregated-actionQueue-row paths.
 */
export const parseMainCommiterPayload = (
  raw: string | null,
): MainCommiterPayload | null => {
  if (raw === null || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<MainCommiterPayload>
    if (parsed.recipe !== MAIN_COMMITER_RECIPE) return null
    if (typeof parsed.integrationBranch !== 'string') return null
    return {
      recipe: MAIN_COMMITER_RECIPE,
      integrationBranch: parsed.integrationBranch,
    }
  } catch {
    return null
  }
}

/** Serialise a payload for the `recovery_payload` column. */
export const serialiseMainCommiterPayload = (
  payload: MainCommiterPayload,
): string => JSON.stringify(payload)

/**
 * Status set `findActiveMainCommitter` uses to locate a committer that can
 * still accept new sources (i.e. an in-flight committer). 'done' is NOT
 * included here — a done committer can no longer unblock dependents (done
 * tasks do not transition back), so attaching a new source to one would
 * create a phantom blocker that can never resolve.
 *
 * 'failed' is NOT included: a failed committer is a dead-end that can never
 * unblock its dependents, so attaching new tasks to it would wedge them
 * permanently. The on-failure handler in server.ts releases blocked
 * dependents of a failed committer back to 'queued' and raises an
 * action-queue item for the operator. A fresh committer is spawned when the
 * branch is still dirty after a failure.
 */
const ACTIVE_COMMITTER_STATUSES = [
  'queued',
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
  'blocked',
] as const

/**
 * Look up the most recently created `main-commiter` recovery task whose
 * `integrationBranch` matches. Dedup is branch-keyed: parallel integration
 * branches each get their own committer, and all tasks on the same branch
 * share one active committer.
 *
 * Done committers are NOT included — a done task cannot be reactivated, so
 * attaching a new source to it would create a phantom blocker. A new dirty
 * episode on the same branch always spawns a fresh committer.
 * Failed committers are excluded — see ACTIVE_COMMITTER_STATUSES.
 */
export const findActiveMainCommitter = async (
  integrationBranch: string,
  store: TaskStore,
): Promise<{ id: string; status: string } | null> => {
  const placeholders = ACTIVE_COMMITTER_STATUSES.map(() => '?').join(',')
  const r = await store.query({
    sql: `SELECT id, status FROM tasks
           WHERE kind = 'fix'
             AND status IN (${placeholders})
             AND json_extract(recovery_payload, '$.recipe') = ?
             AND json_extract(recovery_payload, '$.integrationBranch') = ?
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [...ACTIVE_COMMITTER_STATUSES, MAIN_COMMITER_RECIPE, integrationBranch],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { id: string; status: string }
  return { id: row.id, status: row.status }
}

/**
 * Title surfaced on the `tasks.error` column of the source task when it
 * parks on a `main-commiter`. Kept short — the bulk of the context is on
 * the recovery task itself.
 */
export const SOURCE_ERROR_SUMMARY = (
  integrationBranch: string,
  dispatchPhase: 'dispatch' | 'verify' | 'merge',
): string =>
  `dirty integration branch (${integrationBranch}) detected at ${dispatchPhase}; parked behind main-commiter recovery`

export interface MainCommitterResolution {
  /** The recovery task id the source is now blocked on. */
  fixTaskId: string
  /** `true` when a brand-new committer row was inserted; `false` when the source attached to an existing one. */
  spawned: boolean
  /** Status of the existing committer when attaching ('failed' is also possible per dedup rules). */
  attachedToStatus: string | null
}

export interface SpawnOrAttachInput {
  /** The task that hit dirty-main and must be parked. Must NOT itself be a recovery (kind !== 'fix'). */
  sourceTaskId: string
  /** Result of `checkIntegrationBranchDirty`. Must be `dirty: true`. */
  detection: IntegrationBranchDirtyResult
  /** Integration branch label captured at detection time. */
  integrationBranch: string
  /** Which phase tripped detection — drives the recorded `failure_reason`. */
  dispatchPhase: 'dispatch' | 'verify' | 'merge'
  /** Pre-rendered recipe body. */
  recipePrompt: string
  /** Origin id of the source, so the recovery row inherits it. */
  sourceOriginId: string
  /** Trace event store for the `recovery_spawned` emit. */
  traceStore: TraceEventStore
  store?: TaskStore
}

/**
 * Dedup-aware spawn for `main-commiter`. Either inserts a fresh recovery
 * task and parks the source behind it, or — when an active committer for the
 * same integration branch already exists — attaches the source to the existing
 * recovery via `attachToExistingFixTask`.
 *
 * Dedup is branch-keyed: parallel integration branches each get their own
 * independent committer, and all tasks on the same branch share one active
 * committer regardless of which files are dirty or where HEAD is. A done or
 * failed committer is never reused — done means the work was completed (a new
 * dirty episode requires a fresh committer), and failed is a dead-end.
 *
 * The new fix-task row is inserted directly (not via `upsertFixTask`)
 * because the catalog-driven recipe path is signature-agnostic — there is
 * no entry for `verify:main-dirty` in the legacy `recipes` map in
 * `fix-recipes.ts`. The two writes (fix-task INSERT + task_blockers INSERT
 * + source UPDATE) share one batch so a crash leaves no orphan row.
 *
 * This function is ALSO the legitimate exemption from the F.1 ADR-0040
 * leaf-node guard: the fresh-spawn branch inserts an origin → recovery
 * `task_blockers` edge directly, mirroring `upsertFixTask`'s exemption.
 * The attach branch goes through `attachToExistingFixTask`, which carries
 * the same exemption (and documents it in the SQL site comment).
 */
export const spawnOrAttachMainCommitter = async (
  input: SpawnOrAttachInput,
): Promise<MainCommitterResolution> => {
  if (input.detection.dirty !== true) {
    throw new Error(
      'spawnOrAttachMainCommitter called with a clean detection result',
    )
  }

  const s = input.store ?? (await getDefaultTaskStore())

  // Look for an ACTIVE (non-done, non-failed) committer for this integration
  // branch. Branch-keyed dedup means: one active committer per branch at a
  // time, shared by all tasks that hit dirty-main on that branch.
  const existing = await findActiveMainCommitter(input.integrationBranch, s)
  if (existing) {
    await attachToExistingFixTask({
      sourceTaskId: input.sourceTaskId,
      fixTaskId: existing.id,
      failureReasonCode: VERIFY_MAIN_DIRTY_CODE,
      failureReason: VERIFY_MAIN_DIRTY_CODE,
      errorSummary: SOURCE_ERROR_SUMMARY(
        input.integrationBranch,
        input.dispatchPhase,
      ),
      store: s,
    })
    return {
      fixTaskId: existing.id,
      spawned: false,
      attachedToStatus: existing.status,
    }
  }

  // No active committer for this branch — spawn fresh. Done committers are
  // intentionally NOT reused: a done committer proves main was clean when it
  // verified, but re-detecting dirt means a genuinely new dirty episode that
  // needs a fresh committer.
  const arc = Arc.load(input.sourceOriginId, s)
  const { fixTaskId } = await arc.spawnMainCommitterRecovery({
    sourceTaskId: input.sourceTaskId,
    integrationBranch: input.integrationBranch,
    dispatchPhase: input.dispatchPhase,
    recipePrompt: input.recipePrompt,
    sourceOriginId: input.sourceOriginId,
    traceStore: input.traceStore,
  })
  await Arc.reparentStrandedDependentsOntoNewCommitter(
    fixTaskId,
    input.integrationBranch,
  )
  return { fixTaskId, spawned: true, attachedToStatus: null }
}
