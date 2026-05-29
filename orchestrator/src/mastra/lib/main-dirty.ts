/**
 * Slice F.2: dirty-main detection helper.
 *
 * Both detection points (dispatch-time before worktree spawn, and verify-time
 * at the top of the verify step) share this helper. It probes the integration
 * branch's working tree with `git status --porcelain`. When the branch is
 * dirty, it computes a stable identity (`sha256(git diff HEAD)`) so the
 * spawn path can dedup — every task that hits the same diff snapshot attaches
 * to one `main-commiter` recovery instead of fanning out.
 *
 * Both `git status` and `git diff` calls go through `runTool` so they emit
 * `tool_invoked` trace events (slice C). The single source of truth for
 * "dirty" is the porcelain output — non-empty ⇒ dirty.
 *
 * The helper is best-effort against transient git failures: if `git status`
 * itself errors, it returns `{ dirty: false, hash: null }` and the caller
 * proceeds as if the branch is clean. The legacy `checkSetupPreflight`
 * backstop that used to catch transient git failures was retired in
 * slice K; pessimistically reporting clean here is the documented
 * fallback now.
 */
import { createHash, randomUUID } from 'node:crypto'
import { runTool, type TraceCtx } from './run-tool'
import { attachToExistingFixTask } from '../queue-fix-tasks'
import { getDefaultTaskStore, type TaskStore } from './task-store'
import { internalBus } from '../../internal-bus'
import type { TraceEventStore } from './trace-events-store'

export interface CheckIntegrationBranchDirtyInput {
  /** Repo root where the integration branch is checked out (NOT a worktree). */
  repoRoot: string
  /** Trace context; phase is left to the caller's run (setup or verify). */
  traceCtx: TraceCtx
}

export interface IntegrationBranchDirtyResult {
  dirty: boolean
  /** SHA-256 of `git diff HEAD` on the integration branch when dirty; null otherwise. */
  hash: string | null
  /**
   * Raw `git status --porcelain` output (untracked included). Empty string
   * when clean. Surfaced for log lines and the aggregated inbox row.
   */
  statusOutput: string
}

/**
 * Probe the integration branch's working tree.
 *
 * Failure-mode contract:
 *  - Non-zero exit from `git status` ⇒ treat as clean (return dirty:false).
 *    Pessimistically reporting clean here is safer than throwing, which
 *    would crash the dispatch loop on a transient git hiccup. (The legacy
 *    setup-time preflight that doubled as a backstop was retired in
 *    slice K.)
 *  - `git status` succeeds, `git diff` fails ⇒ return dirty:true with
 *    hash:null. The committer will still spawn; it just won't dedup against
 *    other dirty-main hits in the same window.
 */
export const checkIntegrationBranchDirty = async (
  input: CheckIntegrationBranchDirtyInput,
): Promise<IntegrationBranchDirtyResult> => {
  const { repoRoot, traceCtx } = input
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

  // Dirty branch: compute the diff hash for dedup. `git diff HEAD` covers
  // tracked changes (staged + unstaged) but not untracked files; SHA-256 of
  // that output is a stable identity for "what tracked mess is on main".
  // Untracked-only changes can dedup loosely via an empty-diff hash, which
  // is fine — every untracked-only state hashes the same and shares one
  // recovery.
  const diff = await runTool(
    {
      tool: 'git',
      argv: ['diff', 'HEAD'],
      cwd: repoRoot,
      taskId: traceCtx.taskId ?? null,
      originId: traceCtx.originId ?? null,
      phase: traceCtx.phase ?? null,
      expectsFailure: true,
    },
    traceCtx.store,
  ).catch(() => null)

  if (diff === null || diff.exitCode !== 0) {
    return { dirty: true, hash: null, statusOutput }
  }
  const hash = createHash('sha256').update(diff.stdout).digest('hex')
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
 * `recovery_payload` so future inbox / UI code can render which recipe a
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
  /** SHA-256 of `git diff HEAD` on the integration branch at spawn time. */
  dirtyMainHash: string
  /** Integration branch the committer is parked on. */
  integrationBranch: string
}

/**
 * Parse a recovery_payload string into a typed MainCommiterPayload, returning
 * null when the payload is missing, malformed, or for a different recipe.
 * Used by the catalog auto-resolve and aggregated-inbox-row paths.
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
 * Status set the dedup query considers "still relevant". Done committers are
 * NOT included — a done committer cleared the integration branch, so its
 * hash is no longer relevant; if the branch is dirty again now, we spawn
 * a fresh recovery. Failed committers ARE included so new dirty-main hits
 * with the same diff hash join the existing cohort rather than thrashing.
 */
const ACTIVE_COMMITTER_STATUSES = [
  'queued',
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
  'blocked',
  'failed',
] as const

/**
 * Look up the most recently created `main-commiter` recovery task whose
 * dirty-main hash matches `dirtyMainHash`. The recovery_payload column is
 * a TEXT JSON blob; we use sqlite's `json_extract` to filter on it without
 * pulling every row into JS. Done committers are excluded — their hash is
 * historical and irrelevant to the current state of main.
 */
export const findActiveMainCommitter = async (
  dirtyMainHash: string,
  store: import('./task-store').TaskStore,
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
const SOURCE_ERROR_SUMMARY = (
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
 * attaches (so the failed committer's inbox row aggregates the new
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
    return await spawnFresh(input, null)
  }

  const s = input.store ?? (await getDefaultTaskStore())
  const existing = await findActiveMainCommitter(input.detection.hash, s)
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

  return await spawnFresh(input, input.detection.hash)
}

const spawnFresh = async (
  input: SpawnOrAttachInput,
  dirtyMainHash: string | null,
): Promise<MainCommitterResolution> => {
  const s = input.store ?? (await getDefaultTaskStore())
  const fixTaskId = randomUUID().slice(0, 8)
  const now = new Date().toISOString()
  const payload: MainCommiterPayload = {
    recipe: MAIN_COMMITER_RECIPE,
    // Empty string when hash compute failed — keeps the payload shape stable
    // and signals "no dedup possible" to anyone reading.
    dirtyMainHash: dirtyMainHash ?? '',
    integrationBranch: input.integrationBranch,
  }
  await s.batch(
    [
      {
        sql: `INSERT INTO tasks (
                id, prompt, status, kind,
                author_kind, author_name,
                fix_for_task_id, failure_signature,
                failure_reason, failure_reason_code,
                retry_count, origin_id, priority,
                recovery_payload,
                created_at, updated_at
              ) VALUES (?, ?, 'queued', 'fix', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        args: [
          fixTaskId,
          input.recipePrompt,
          'agent',
          'main-commiter-spawn',
          input.sourceTaskId,
          VERIFY_MAIN_DIRTY_CODE,
          VERIFY_MAIN_DIRTY_CODE,
          VERIFY_MAIN_DIRTY_CODE,
          input.sourceOriginId,
          // Max priority: every queued task is blocked behind this.
          3,
          serialiseMainCommiterPayload(payload),
          now,
          now,
        ],
      },
      {
        // F.1 exemption: this is the canonical origin → recovery edge
        // mirror of `upsertFixTask`. The recovery side cannot grow further
        // edges (recovery-of-recovery is rejected by
        // `handleTaskFailureWithFixTask`), so the leaf invariant holds.
        sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at)
              VALUES (?, ?, 'confirmed', ?)`,
        args: [input.sourceTaskId, fixTaskId, now],
      },
      {
        sql: `UPDATE tasks
                 SET status = 'blocked',
                     error = ?,
                     failure_reason = ?,
                     failure_reason_code = ?,
                     updated_at = ?
               WHERE id = ?`,
        args: [
          SOURCE_ERROR_SUMMARY(input.integrationBranch, input.dispatchPhase),
          VERIFY_MAIN_DIRTY_CODE,
          VERIFY_MAIN_DIRTY_CODE,
          now,
          input.sourceTaskId,
        ],
      },
    ],
    'write',
  )

  // Emit the canonical recovery_spawned trace event (kind already in the
  // vocabulary since slice B) so the trace surface reflects the new
  // recovery exactly like every other recipe-driven spawn.
  await input.traceStore
    .record({
      kind: 'recovery_spawned',
      taskId: fixTaskId,
      originId: input.sourceOriginId,
      phase: input.dispatchPhase === 'verify' ? 'verify' : 'setup',
      payload: {
        recipe: MAIN_COMMITER_RECIPE,
        sourceTaskId: input.sourceTaskId,
        dirtyMainHash,
        integrationBranch: input.integrationBranch,
        dispatchPhase: input.dispatchPhase,
      },
    })
    .catch(() => {
      // Trace emission is best-effort; never fail a recovery spawn on it.
    })

  internalBus().emit('task.blocked', {
    taskId: input.sourceTaskId,
    fixTaskId,
    failureSignature: VERIFY_MAIN_DIRTY_CODE,
    failingStep: `${input.dispatchPhase}:main-dirty`,
  })

  return { fixTaskId, spawned: true, attachedToStatus: null }
}
