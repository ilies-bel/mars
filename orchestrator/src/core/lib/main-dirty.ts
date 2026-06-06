/**
 * Slice F.2: dirty-main detection helper.
 *
 * Both detection points (dispatch-time before worktree spawn, and verify-time
 * at the top of the verify step) share this helper. It probes the integration
 * branch's working tree with `git status --porcelain`. When the branch is
 * dirty, it computes a stable identity so the spawn path can dedup — every
 * task that hits the same (HEAD sha, dirty-file-set) snapshot attaches to one
 * `main-commiter` recovery instead of fanning out.
 *
 * The dedup key is `sha256(headSha + '\n' + statusOutput)` where `statusOutput`
 * is the full `git status --porcelain --untracked-files=all` output. This
 * covers tracked AND untracked changes; using `git diff HEAD` alone was
 * insufficient because untracked-only states all hashed to the same empty-diff
 * string.
 *
 * All git calls go through `runTool` so they emit `tool_invoked` trace events
 * (slice C). The single source of truth for "dirty" is the porcelain output —
 * non-empty ⇒ dirty.
 *
 * The helper is best-effort against transient git failures: if `git status`
 * itself errors, it returns `{ dirty: false, hash: null }` and the caller
 * proceeds as if the branch is clean. The legacy `checkSetupPreflight`
 * backstop that used to catch transient git failures was retired in
 * slice K; pessimistically reporting clean here is the documented
 * fallback now.
 */
import { createHash } from 'node:crypto'
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
   * SHA-256 of `(headSha + '\n' + statusOutput)` on the integration branch
   * when dirty; null otherwise. Composing headSha ensures the key changes
   * when HEAD advances even if the dirty file set stays the same; composing
   * statusOutput (which includes untracked paths) ensures untracked-only
   * dirty states get distinct keys instead of all colliding on the
   * empty-diff hash.
   */
  hash: string | null
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
 *  - `git status` succeeds, `git rev-parse HEAD` fails ⇒ return dirty:true
 *    with hash:null. The committer will still spawn; it just won't dedup.
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
        return { dirty: false, hash: null, statusOutput: '' }
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
    return { dirty: false, hash: null, statusOutput: '' }
  }
  const statusOutput = status.stdout
  if (statusOutput.length === 0) {
    return { dirty: false, hash: null, statusOutput: '' }
  }

  // Dirty branch: compose the hash from (headSha + statusOutput) for dedup.
  // Using statusOutput instead of `git diff HEAD` ensures untracked-only
  // dirty states get distinct hashes per their file set (the old diff-based
  // hash was empty for all untracked-only states, colliding every instance
  // onto one phantom committer slot). Including headSha ensures the key
  // changes when HEAD advances even if the dirty file names don't.
  const headShaResult = await runTool(
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

  if (headShaResult === null || headShaResult.exitCode !== 0) {
    return { dirty: true, hash: null, statusOutput }
  }
  const headSha = headShaResult.stdout.trim()
  const hash = createHash('sha256').update(headSha + '\n' + statusOutput).digest('hex')
  return { dirty: true, hash, statusOutput }
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
   * SHA-256 composite dedup key: `sha256(headSha + '\n' + statusOutput)` where
   * headSha is `git rev-parse HEAD` and statusOutput is the full
   * `git status --porcelain --untracked-files=all` output at spawn time.
   * Composing both fields ensures that untracked-only dirty states and
   * HEAD-advancing merges each get distinct keys instead of all colliding
   * on the same empty-diff hash.
   */
  dirtyMainHash: string
  /** Integration branch the committer is parked on. */
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
    if (typeof parsed.dirtyMainHash !== 'string') return null
    if (typeof parsed.integrationBranch !== 'string') return null
    return {
      recipe: MAIN_COMMITER_RECIPE,
      dirtyMainHash: parsed.dirtyMainHash,
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
 * Status set the dedup query uses to find an existing committer at a given
 * hash. 'done' IS included — a done committer that handled a dirty state must
 * suppress re-spawn even after it finishes, so the same (headSha, dirtyFiles)
 * pair cannot drive an infinite spawn loop. When a done committer is found,
 * `spawnOrAttachMainCommitter` returns spawned:false without attaching the
 * source task (a done committer can no longer unblock dependents).
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
  'done',
] as const

/**
 * Look up the most recently created `main-commiter` recovery task whose
 * dirty-main hash matches `dirtyMainHash`. The recovery_payload column is
 * a TEXT JSON blob; we use sqlite's `json_extract` to filter on it without
 * pulling every row into JS. Done committers ARE included — a done committer
 * suppresses re-spawn for the same dirty state, preventing the runaway loop
 * where every dispatch tick spawns a fresh committer after the previous one
 * finished. Failed committers are excluded — see ACTIVE_COMMITTER_STATUSES.
 */
export const findActiveMainCommitter = async (
  dirtyMainHash: string,
  store: TaskStore,
): Promise<{ id: string; status: string } | null> => {
  const placeholders = ACTIVE_COMMITTER_STATUSES.map(() => '?').join(',')
  const r = await store.query({
    sql: `SELECT id, status FROM tasks
           WHERE kind = 'fix'
             AND status IN (${placeholders})
             AND json_extract(recovery_payload, '$.recipe') = ?
             AND json_extract(recovery_payload, '$.dirtyMainHash') = ?
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [...ACTIVE_COMMITTER_STATUSES, MAIN_COMMITER_RECIPE, dirtyMainHash],
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
  dispatchPhase: 'dispatch' | 'verify',
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
  dispatchPhase: 'dispatch' | 'verify'
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
 * task and parks the source behind it, or — when an active committer at the
 * same hash already exists — attaches the source to the existing recovery
 * via `attachToExistingFixTask`. The `failed` case at the same hash still
 * attaches (so the failed committer's actionQueue row aggregates the new
 * dependent); only a `done` committer or a different-hash failed committer
 * triggers a fresh spawn.
 *
 * The new fix-task row is inserted directly (not via `upsertFixTask`)
 * because the catalog-driven recipe path is signature-agnostic — there is
 * no entry for `verify:main-dirty` in the legacy `recipes` map in
 * `fix-recipes.ts`. The two writes (fix-task INSERT + task_blockers INSERT
 * + source UPDATE) share one batch so a crash leaves no orphan row.
 *
 * The recovery row's `failure_signature` carries `verify:main-dirty` so
 * the legacy fix-fail-loop and dedup queries (which key on
 * (fix_for_task_id, failure_signature)) interoperate sanely with the new
 * recipe — though F.2 itself does not rely on that dedup path; the
 * recovery_payload-hash dedup is the source of truth for committer
 * identity.
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
  if (input.detection.hash === null) {
    // Without a hash we cannot dedup; still safe to spawn a fresh committer
    // — the next task that hits the same broken state without a hash will
    // simply spawn its own (no worse than the legacy behavior).
    const arc = Arc.load(
      input.sourceOriginId,
      input.store ?? (await getDefaultTaskStore()),
    )
    const { fixTaskId } = await arc.spawnMainCommitterRecovery({
      sourceTaskId: input.sourceTaskId,
      dirtyMainHash: null,
      integrationBranch: input.integrationBranch,
      dispatchPhase: input.dispatchPhase,
      recipePrompt: input.recipePrompt,
      sourceOriginId: input.sourceOriginId,
      traceStore: input.traceStore,
    })
    return { fixTaskId, spawned: true, attachedToStatus: null }
  }

  const s = input.store ?? (await getDefaultTaskStore())
  const existing = await findActiveMainCommitter(input.detection.hash, s)
  if (existing) {
    if (existing.status === 'done') {
      // The previous committer already handled this dirty state. Do NOT
      // attach the source to a done task (done tasks can no longer unblock
      // dependents, so attaching would create a phantom blocker). The caller
      // should not dispatch the source task until the dirty state changes —
      // i.e. HEAD advances or the dirty file set differs (which produces a
      // new hash and allows a fresh spawn).
      return {
        fixTaskId: existing.id,
        spawned: false,
        attachedToStatus: 'done',
      }
    }
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

  const arc = Arc.load(input.sourceOriginId, s)
  const { fixTaskId } = await arc.spawnMainCommitterRecovery({
    sourceTaskId: input.sourceTaskId,
    dirtyMainHash: input.detection.hash,
    integrationBranch: input.integrationBranch,
    dispatchPhase: input.dispatchPhase,
    recipePrompt: input.recipePrompt,
    sourceOriginId: input.sourceOriginId,
    traceStore: input.traceStore,
  })
  return { fixTaskId, spawned: true, attachedToStatus: null }
}
