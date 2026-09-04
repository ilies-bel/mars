/**
 * Derived condition items — computes action-queue synthetic rows from live
 * system state on every read.  No stored rows are written or read for these
 * kinds: a stale alert is unrepresentable because the row only exists while the
 * underlying condition holds.
 *
 * Each `derive*` function returns zero or more `PersistedActionQueueRow`-shaped
 * objects.  The stable IDs are computed from the kind and entity key so the same
 * condition always produces the same id (required for snoozability).
 *
 * ADR-0057: An action-queue row may exist only when it carries operator-authored
 * content that cannot be recomputed from live state.  These 10 condition kinds
 * are pure functions of state the system already holds.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { PersistedActionQueueRow, ConditionItemsSource } from './action-queue'
import type { DispatchPauseState } from '../pause-state'
import type { DbClient } from '../../lib/db'
import { RECOVERY_EXHAUSTED_PREFIX, classifyError, isSameFailureFamily } from '../../lib/failure-signature'
import { findBaselineCaughtTaskIds } from '../../lib/baseline-attribution'
import { readBudgetConfig } from '../../lib/spend-meter'
import type { BudgetArcPayload } from '../../lib/payload-contracts/spend'
import { isDiagnosticSignature, SIGNATURE_STORM_TRIP_THRESHOLD } from '../../lib/signature-storm-monitor'
import { integrationBranchName } from '../../lib/blocker-resolution-primitives.js'

// ── Stable ID helper ─────────────────────────────────────────────────────────

/**
 * Produce a stable 8-char hex id for a derived row.  The id is deterministic
 * (same kind + entityKey → same id) so callers and the UI can anchor to it.
 */
const deriveId = (kind: string, entityKey: string): string =>
  createHash('sha1').update(`derived:${kind}:${entityKey}`).digest('hex').slice(0, 8)

// ── Derivation deps ───────────────────────────────────────────────────────────

interface DaemonCodeDriftState {
  sourceSha: string | null
  currentSha: string | null
  dependencyDrift: boolean
  /** Commit distance sourceSha..currentSha, or null when it couldn't be computed. */
  behindBy?: number | null
  /**
   * Unix-ms timestamp of when drift was first detected in this daemon session.
   * Used as `raisedAt` so the card age reflects the detection event, not the
   * derivation query time (which would always be "0s ago").
   */
  detectedAt?: number | null
}

export interface ConditionsDeps {
  /** Returns a live DB client for state queries. */
  getClient: () => DbClient
  /** Returns current dispatch pause state — for signature-storm derivation. */
  getPauseState?: () => DispatchPauseState | null
  /** Path to the daemon crash marker file — for daemon-died derivation. */
  crashMarkerPath?: string | null
  /** Returns the current code-drift state — for daemon-code-drift derivation. */
  getCodeDrift?: () => DaemonCodeDriftState | null
  /** Whether the integration baseline currently fails a required gate. */
  isBaselinePoisoned?: () => boolean
  /** Baseline detection detail for the current poison state. */
  baselineDetail?: () => { failingGateName?: string; output?: string } | null
  /** Absolute repo root path — for stale-worktree derivation. */
  repoRoot?: string
  /** Returns active worker count — used by stale-queued to suppress alerts when pool is full. */
  getActiveWorkerCount?: () => number
  /** Returns implement semaphore cap — used by stale-queued. */
  getImplementCap?: () => number
  /** Unix ms timestamp of last dispatch resume — resets the staleness clock. */
  dispatchResumedAt?: number
  /** Override for "now" timestamp (testing). */
  nowMs?: number
}

// ── Per-kind derivation functions ─────────────────────────────────────────────

/**
 * Derive `failed` rows from `tasks WHERE status='failed'`.
 * The payload carries every key the `failed` recipe reads, so the row renders
 * with the same detail the stored raiser used to supply; `getActionQueueEntityId`
 * works unchanged off `payload.taskId`.
 *
 * Recovery tasks (fix_for_task_id IS NOT NULL) whose origin is currently
 * non-terminal (i.e. the origin is queued/running/verifying/merging/blocked)
 * are silently suppressed: the operator cannot act on such a row (a fix task
 * is a non-recoverable leaf), and the origin's own lifecycle is the real
 * surface.  We keep the row when the origin is itself `failed` — that is the
 * actionable case where recovery has been exhausted — or when the fix task has
 * no live origin.
 *
 * Also suppressed: an origin that has reached `done`. A recovery task is not
 * independently meaningful — it exists only to finish its origin's work
 * (`fix_for_task_id` records that relationship) — so once the origin
 * succeeds, a `failed` row for its (necessarily earlier, now-moot) recovery
 * attempt is pure noise: the work it existed to unblock is already finished.
 * Without this, an origin that succeeds after its first recovery attempt
 * failed leaves a permanent high-priority `failed` alert for a task nobody
 * can or needs to act on (2026-08-20 incident: four such rows in one day,
 * each requiring a manual `mars drop --force`).
 *
 * A task whose id is in `baselineCaughtTaskIds` (see baseline-attribution.ts)
 * is ALSO suppressed here: its failure is already accounted for by the
 * `baseline-broken` row (deriveBaselineBrokenConditions below), which names
 * the count and lists the ids. Without this, the same failure would render as
 * both one `baseline-broken` alert AND N independent `failed` alerts — the
 * exact "N unrelated-looking failures" shape the 2026-08-18 incident produced.
 */
/** Max chars of `tasks.error` carried into the alert's `errorExcerpt`. */
const ERROR_EXCERPT_MAX = 600

/**
 * Max chars of gate probe output carried into the payload's `gateOutput` key.
 *
 * Tail-trimmed (not head): the vitest summary and failing-test lines appear at
 * the END of the output, so taking the last N chars keeps the actionable lines
 * while discarding verbose early output.  The full (head-trimmed) output also
 * lives in the row's `body` field for `mars action-queue show`.
 *
 * Trade-off: this excerpt is included in the payload of every action-queue
 * read, not only behind `mars action-queue show`.  That is acceptable because
 * (a) `baseline-broken` is at most one row at a time, so the overhead is a
 * bounded ~2 KB per read, (b) the action-queue list is not a hot path, and
 * (c) the operator benefit — actionable context without a terminal drop — is
 * significant.
 */
const GATE_OUTPUT_EXCERPT_MAX = 2000

const trimGateOutput = (output: string): string => {
  const trimmed = output.trim()
  return trimmed.length > GATE_OUTPUT_EXCERPT_MAX
    ? `…${trimmed.slice(-GATE_OUTPUT_EXCERPT_MAX)}`
    : trimmed
}

/** Newest-first cap on how many failed rows get a live dirty-worktree probe. */
const MAX_DIRTY_PROBES = 40

/** Git subprocesses the dirty-worktree probe may have in flight at once. */
const DIRTY_PROBE_CONCURRENCY = 8

/**
 * Reduce a stored `tasks.error` blob to something an operator can read in a
 * queue row. The column holds whole captured step output (one row currently
 * carries a 2000-char truncated vitest dump), which is a transcript concern —
 * the alert only needs the head of it to say what went wrong.
 */
const excerptError = (error: string | null): string => {
  if (!error) return ''
  const trimmed = error.trim()
  return trimmed.length > ERROR_EXCERPT_MAX
    ? `${trimmed.slice(0, ERROR_EXCERPT_MAX)}…`
    : trimmed
}

async function deriveFailedConditions(
  client: DbClient,
  nowMs: number,
  baselineCaughtTaskIds: ReadonlySet<string>,
  waveCaughtTaskIds: ReadonlySet<string>,
): Promise<PersistedActionQueueRow[]> {
  const result = await client.execute(
    `SELECT t.id, t.failure_signature, t.prompt, t.updated_at, t.failure_reason_code,
            t.failure_reason, t.stall_diagnostics, t.branch, t.worktree_path, t.error
       FROM tasks t
      WHERE t.status = 'failed'
        AND (
          t.fix_for_task_id IS NULL
          OR (
            -- Settlement rule (CLAUDE.md): emit only when the origin is itself
            -- 'failed' (recovery exhausted, the actionable case) or when the
            -- origin row is missing entirely. Both 'done' and 'dropped' settle
            -- the origin: the recovery's failure is moot once the origin has
            -- finished or been explicitly cancelled. A missing row (hard-deleted)
            -- is an orphaned-origin situation; keep emitting here so it stays
            -- visible until that kind resolves it.
            NOT EXISTS (
              SELECT 1 FROM tasks origin
               WHERE origin.id = t.fix_for_task_id
                 AND origin.status NOT IN ('done', 'failed', 'dropped')
            )
            AND NOT EXISTS (
              SELECT 1 FROM tasks origin
               WHERE origin.id = t.fix_for_task_id
                 AND origin.status IN ('done', 'dropped')
            )
          )
        )
      ORDER BY t.updated_at DESC`,
  )
  const rows = result.rows
    .filter((r) => {
      const id = (r as { id: string }).id
      return !baselineCaughtTaskIds.has(id) && !waveCaughtTaskIds.has(id)
    })
    .map((r) => {
    const row = r as {
      id: string
      failure_signature: string | null
      prompt: string
      updated_at: string
      failure_reason_code: string | null
      failure_reason: string | null
      stall_diagnostics: string | null
      branch: string | null
      worktree_path: string | null
      error: string | null
    }
    const entityKey = row.id
    const raisedAt = row.updated_at ? Date.parse(row.updated_at) : nowMs
    let stallDiagnostics: unknown = null
    if (row.stall_diagnostics) {
      try { stallDiagnostics = JSON.parse(row.stall_diagnostics) } catch { /* ignore */ }
    }
    return {
      id: deriveId('failed', entityKey),
      kind: 'failed',
      priority: 'high',
      title: `Task ${row.id} failed`,
      body: '',
      // Keys here MUST match what the `failed` recipe in action-queue-recipes.ts
      // reads. They drifted once already: this row emitted `signature` while the
      // recipe read `failureSignature`, so every failed alert rendered an empty
      // `humanDetail` — no cause, no branch, no error excerpt — even though the
      // task row held all three. The operator got a red row saying only that
      // something failed, and `deriveCause` had nothing to derive from.
      payload: {
        taskId: row.id,
        failureSignature: row.failure_signature,
        failureReasonCode: row.failure_reason_code,
        stallDiagnostics,
        branch: row.branch,
        worktree: row.worktree_path,
        errorExcerpt: excerptError(row.error),
        // Decided here, not by the client. The `recovery_exhausted:` prefix is
        // written onto `failure_reason` (see queue-fix-tasks.ts) and read off
        // `failure_reason` by the guard that matters — continue-task.ts, which
        // refuses non-zero on it. The UI was re-implementing the prefix test
        // against `failureReasonCode`, a DIFFERENT column that never carries
        // it, so the check silently never fired: the one row where Restart
        // discards salvageable commits was also the row offering Restart, and
        // Continue beside it could only error.
        recoveryExhausted: (row.failure_reason ?? '').startsWith(RECOVERY_EXHAUSTED_PREFIX),
        // Filled in by the live probe below. Absent/null means "not looked at",
        // which the recipe renders as nothing rather than as "clean".
        worktreeDirtyCount: null as number | null,
        // Filled by the recovery-in-flight check below. True when a fix/recovery
        // task is currently live for this failed task (queued/running/verifying/merging).
        // The view layer uses this to classify the row as 'notice' instead of 'alert'.
        recoveryInFlight: false as boolean,
      },
      context: { taskId: row.id },
      raisedAt,
      lastSeenAt: nowMs,
      signature: `failed:${row.id}`,
    }
  })

  // ── Recovery-in-flight check ──────────────────────────────────────────────
  // For each derived 'failed' row, determine whether a live fix/recovery task
  // is currently running against it. When one is live (queued/running/
  // verifying/merging), the operator cannot act — Mars is still trying.
  // Mark the row recoveryInFlight:true so the view layer can classify it as
  // 'notice' instead of 'alert', and update the title to reflect that.
  //
  // A single IN query covers the whole batch. Guarded against empty batch
  // (an empty IN clause is invalid SQL).
  if (rows.length > 0) {
    const failedTaskIds = rows.map((r) => r.payload.taskId as string)
    const placeholders = failedTaskIds.map(() => '?').join(', ')
    const recoveryQueryResult = await client.execute({
      sql: `SELECT fix_for_task_id
              FROM tasks
             WHERE fix_for_task_id IN (${placeholders})
               AND status IN ('queued', 'running', 'verifying', 'merging')`,
      args: failedTaskIds,
    })
    const inFlightOriginIds = new Set<string>(
      recoveryQueryResult.rows.map(
        (r) => (r as { fix_for_task_id: string }).fix_for_task_id,
      ),
    )
    for (const queueRow of rows) {
      const taskId = queueRow.payload.taskId as string
      if (inFlightOriginIds.has(taskId)) {
        queueRow.payload.recoveryInFlight = true
        queueRow.title = `Mars is attempting to fix task ${taskId} — no action needed yet`
      }
    }
  }

  // Whether the worktree holds uncommitted work is the single fact that
  // decides between `mars continue` and the destructive `mars restart` /
  // `mars drop`, and until now the row said nothing about it — an operator
  // reading this alert had to go run `git status` in the worktree by hand to
  // find out what a one-word verb was about to delete.
  //
  // Probed live rather than stored, because the answer changes underneath a
  // stored row: the operator commits the work, or `mars continue` checkpoints
  // it, and a stored "holds uncommitted work" would keep saying so forever.
  // That is the ADR-0057 rule — a row carries only what cannot be recomputed.
  //
  // Bounded, because each probe is a git subprocess and this runs on every
  // action-queue read. Rows are ordered newest-first, so the cap keeps the
  // freshest failures — the ones an operator is actually about to act on.
  const { resolveVcs } = await import('../../ports/vcs/registry')
  const vcs = resolveVcs()
  const probeTargets = rows.slice(0, MAX_DIRTY_PROBES)
  for (let i = 0; i < probeTargets.length; i += DIRTY_PROBE_CONCURRENCY) {
    const batch = probeTargets.slice(i, i + DIRTY_PROBE_CONCURRENCY)
    await Promise.all(
      batch.map(async (queueRow) => {
        const paths = await vcs.listUncommittedPaths(
          typeof queueRow.payload.worktree === 'string' ? queueRow.payload.worktree : null,
        ).catch(() => null)
        if (paths !== null) queueRow.payload.worktreeDirtyCount = paths.length
      }),
    )
  }
  if (rows.length > MAX_DIRTY_PROBES) {
    console.warn(
      `[action-queue] ${rows.length - MAX_DIRTY_PROBES} failed row(s) beyond the newest ` +
        `${MAX_DIRTY_PROBES} were not probed for uncommitted work; their rows omit it rather than claim clean`,
    )
  }

  // DEC-8: a recovery task IS an automated move — suppress the failed-row
  // entirely while Mars is still trying. The condition doesn't hold, so the
  // row should not exist. If the recovery itself fails, recoveryInFlight
  // becomes false again and the row re-surfaces for the operator.
  return rows.filter((r) => !r.payload.recoveryInFlight)
}

const STALE_QUEUED_THRESHOLD_MS = (() => {
  const raw = process.env.MARS_STALE_QUEUED_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60_000
})()

const MAX_STALE_QUEUED_ROWS = 20

/**
 * DB statuses that represent a task actively occupying an implement-worker
 * slot. Mirrors `phantom-in-flight-sweep`'s `IN_FLIGHT_STATUSES` in
 * reconcilers.ts — kept as a separate literal here since importing across the
 * daemon/view boundary would pull in the reconciler module's dependencies.
 */
const IN_FLIGHT_STATUSES_SQL = `'running', 'verifying', 'merging', 'vega-reconciling'`

/**
 * Derive `stale-queued` rows from queued tasks that have waited past the
 * configured threshold.  Suppressed entirely when dispatch is deliberately
 * paused or the implement pool is saturated.
 *
 * Misattribution guard (incident 2026-08-17): when a prior daemon is hard-
 * stopped, rows can be left behind in an in-flight status (`running`,
 * `verifying`, `merging`, `vega-reconciling`) with no live job — the tracker's
 * `getActiveWorkerCount()` reports 0 while the DB still shows the pool as
 * occupied. Plain queued-age math then blames the queued tasks for sitting
 * idle, when the real cause is those phantom rows. The boot reconcile clears
 * them under normal operation, but this derivation still checks for the
 * condition so a stale-queued alert names the phantom rows instead of
 * pointing at innocent queued tasks whenever it observes it.
 *
 * Two complementary counts land in the row's payload, and both are read
 * downstream:
 *
 * - `inFlightStatusCount` — the raw DB count of tasks in an in-flight status,
 *   mirroring the `phantomInFlightCount` computed for `mars daemon status`
 *   (server.ts's `handleStatus`). The `stale-queued` recipe compares it
 *   against `activeWorkerCount` and `implementCap` to pick its `humanSummary`
 *   copy, so an agent reading the item is pointed at `mars sync` rather than
 *   at the queued task.
 * - `phantomInFlightCount` — that count minus the live tracker's, i.e. the
 *   rows the DB believes are in flight that no live job backs. It is the
 *   sharper signal (it catches a partial mismatch, not just a saturated cap)
 *   and drives this row's own title/body.
 */
async function deriveStaleQueuedConditions(
  client: DbClient,
  deps: Pick<ConditionsDeps, 'getPauseState' | 'getActiveWorkerCount' | 'getImplementCap' | 'dispatchResumedAt' | 'nowMs'>,
): Promise<PersistedActionQueueRow[]> {
  if (deps.getPauseState?.()?.paused) return []
  const cap = deps.getImplementCap?.() ?? Infinity
  const active = deps.getActiveWorkerCount?.() ?? 0
  if (active >= cap) return []

  const now = deps.nowMs ?? Date.now()
  const [result, inFlightStatusResult] = await Promise.all([
    client.execute(
      `SELECT id, updated_at, prompt FROM tasks WHERE status = 'queued' ORDER BY updated_at ASC`,
    ),
    client.execute(`SELECT COUNT(*) AS n FROM tasks WHERE status IN (${IN_FLIGHT_STATUSES_SQL})`),
  ])
  // Raw DB count — what the recipe weighs against activeWorkerCount/implementCap.
  const inFlightStatusCount = Number(
    (inFlightStatusResult.rows[0] as { n?: unknown } | undefined)?.n ?? 0,
  )
  // Rows the DB counts as in-flight that the live tracker doesn't know about.
  const phantomInFlightCount = Math.max(0, inFlightStatusCount - active)

  const stale = result.rows
    .map((r) => {
      const row = r as { id: string; updated_at: string; prompt: string }
      const updatedMs = row.updated_at ? Date.parse(row.updated_at) : now
      const effectiveStart =
        deps.dispatchResumedAt !== undefined
          ? Math.max(updatedMs, deps.dispatchResumedAt)
          : updatedMs
      return { row, updatedMs, effectiveStart }
    })
    .filter(({ updatedMs, effectiveStart }) => Number.isFinite(updatedMs) && now - effectiveStart > STALE_QUEUED_THRESHOLD_MS)
    .slice(0, MAX_STALE_QUEUED_ROWS)

  return stale.map(({ row, effectiveStart }) => {
    const queuedAgeMs = now - effectiveStart
    const ageMinutes = Math.round(queuedAgeMs / 60_000)
    const shortGoal =
      row.prompt?.split('\n')[0]?.trim().replace(/[.,:;!?]+$/, '').slice(0, 60) || `task ${row.id}`
    const title =
      phantomInFlightCount > 0
        ? `Stale-queued ${ageMinutes} min — ${phantomInFlightCount} phantom in-flight row(s) holding the cap: ${shortGoal}`
        : `Stale-queued ${ageMinutes} min: ${shortGoal}`
    const body =
      phantomInFlightCount > 0
        ? `"${shortGoal}" has been waiting ${ageMinutes} min, but this task is not at fault: ${phantomInFlightCount} task(s) are stuck in an in-flight DB status (running/verifying/merging/vega-reconciling) with no live job behind them — phantom rows most likely left by a prior daemon restart. Run \`mars sync\` to re-queue them.`
        : `"${shortGoal}" has been waiting in the dispatch queue for ${ageMinutes} min (threshold: ${Math.round(STALE_QUEUED_THRESHOLD_MS / 60_000)} min).`
    return {
      id: deriveId('stale-queued', row.id),
      kind: 'stale-queued',
      priority: 'normal',
      title,
      body,
      payload: {
        taskId: row.id,
        queuedAgeMs,
        activeWorkerCount: active,
        implementCap: cap,
        inFlightStatusCount,
        queueDepth: result.rows.length,
        dispatchDecisionSummary: [],
        phantomInFlightCount,
      },
      context: { taskId: row.id },
      raisedAt: effectiveStart,
      lastSeenAt: now,
      signature: `stale-queued:${row.id}`,
    }
  })
}

/**
 * Derive `gate-broken` rows from `verify_gates WHERE state='quarantined'`.
 */
async function deriveGateBrokenConditions(
  client: DbClient,
  nowMs: number,
): Promise<PersistedActionQueueRow[]> {
  // The LEFT JOIN is what keeps this row from outliving its subject. A gate's
  // `last_failure_origin_id` is plain history: it is never cleared when the
  // task it names is purged, so it routinely points at a task that no longer
  // exists. Rendering that as a task link gave the operator a row whose
  // "details" resolved to nothing. Resolve the reference here instead, and
  // emit `originTaskId: null` when the task is gone — the gate's own identity
  // (scope/name) is the stable subject of this row, not the failure that
  // happened to trip it.
  //
  // Dropped tasks are also excluded: a task that was intentionally abandoned
  // is not useful context for a live gate condition. Surfacing a dropped task
  // as "last tripped by" would mislead the operator into inspecting work that
  // no longer exists as an active concern.
  const result = await client.execute(
    `SELECT g.id, g.scope, g.name, g.required, g.quarantine_signature, g.last_failure_at,
            t.id AS origin_task_id
       FROM verify_gates g
       LEFT JOIN tasks t ON t.id = g.last_failure_origin_id AND t.status NOT IN ('dropped')
      WHERE g.state = 'quarantined'`,
  )
  return result.rows.map((r) => {
    const row = r as {
      id: string
      scope: string | null
      name: string | null
      required: number | boolean | null
      quarantine_signature: string | null
      last_failure_at: number | null
      origin_task_id: string | null
    }
    const verdict = row.quarantine_signature ?? row.id
    const raisedAt = row.last_failure_at ?? nowMs
    const scope = row.scope ?? '.'
    const name = row.name ?? row.id
    const identity = row.name === null ? row.id : `${scope}/${name}`
    // INTEGER 1/0 in SQLite, boolean in Postgres — normalise to boolean.
    const required = row.required !== 0 && row.required !== false && row.required != null
    return {
      id: deriveId('gate-broken', row.id),
      kind: 'gate-broken',
      priority: 'high',
      title: `Gate ${identity} is broken`,
      body: '',
      payload: {
        gate: row.id,
        scope,
        name,
        required,
        verdict,
        originTaskId: row.origin_task_id,
        streak: null,
      },
      context: {},
      raisedAt,
      lastSeenAt: nowMs,
      signature: `gate-broken:${verdict}`,
    }
  })
}

/**
 * Derive `subscriber-stalled` rows from the `subscriber_stalls` table.
 */
async function deriveSubscriberStalledConditions(
  client: DbClient,
  nowMs: number,
): Promise<PersistedActionQueueRow[]> {
  const result = await client.execute(
    `SELECT subscriber_id, event_id, last_error, fail_count, raised_at FROM subscriber_stalls`,
  )
  return result.rows.map((r) => {
    const row = r as {
      subscriber_id: string
      event_id: string | number
      last_error: string
      fail_count: string | number
      raised_at: number
    }
    const key = `${row.subscriber_id}:${row.event_id}`
    return {
      id: deriveId('subscriber-stalled', key),
      kind: 'subscriber-stalled',
      priority: 'high',
      title: `Subscriber ${row.subscriber_id} is stalled`,
      body: row.last_error,
      // Keys here MUST match what the `subscriber-stalled` recipe in
      // action-queue-recipes.ts reads. They drifted once already: this row
      // emitted `subscriberId`/`lastError` (no `failCount` at all) while the
      // recipe read `subscriberName`/`errorExcerpt`/`failCount`, so the
      // alert's detail panel always rendered empty.
      payload: {
        subscriberId: row.subscriber_id,
        eventId: row.event_id,
        errorExcerpt: row.last_error,
        failCount: Number(row.fail_count),
      },
      context: {},
      raisedAt: typeof row.raised_at === 'number' ? row.raised_at : nowMs,
      lastSeenAt: nowMs,
      signature: `subscriber-stalled:${key}`,
    }
  })
}

/**
 * Derive `signature-storm` rows from the dispatch pause state.
 * One row when the storm breaker is armed (reason='storm').
 */
function deriveSignatureStormConditions(
  getPauseState: (() => DispatchPauseState | null) | undefined,
  nowMs: number,
): PersistedActionQueueRow[] {
  const pauseState = getPauseState?.()
  if (!pauseState?.paused || pauseState.reason !== 'storm') return []

  // Parse the signature from the detail field: 'signature storm: <sig> x<count>'
  const detail = pauseState.detail ?? ''
  const match = detail.match(/^signature storm: (.+?) x(\d+)$/)
  const signature = match?.[1] ?? 'unknown'
  const streak = match ? Number(match[2]) : 1

  const since = pauseState.since ? Date.parse(pauseState.since) : nowMs
  return [
    {
      id: deriveId('signature-storm', signature),
      kind: 'signature-storm',
      priority: 'urgent',
      title: `${streak} tasks failed with \`${signature}\`; dispatch is paused`,
      body: '',
      payload: { signature, streak },
      context: {},
      raisedAt: since,
      lastSeenAt: nowMs,
      signature: `signature-storm:${signature}`,
    },
  ]
}

/**
 * Derive a `daemon-died` row when a crash marker file is present.
 * The crash marker is written by the daemon on an unclean exit and removed
 * on clean shutdown — its presence unambiguously means the previous daemon
 * process died unexpectedly.
 */
function deriveDaemonDiedConditions(
  crashMarkerPath: string | null | undefined,
  nowMs: number,
): PersistedActionQueueRow[] {
  if (!crashMarkerPath || !existsSync(crashMarkerPath)) return []

  let pid = 0
  let startedAt = ''
  let crashDetectedAt = new Date(nowMs).toISOString()
  try {
    const parsed = JSON.parse(readFileSync(crashMarkerPath, 'utf8')) as Record<string, unknown>
    if (typeof parsed.pid === 'number') pid = parsed.pid
    if (typeof parsed.startedAt === 'string') startedAt = parsed.startedAt
    if (typeof parsed.crashDetectedAt === 'string') crashDetectedAt = parsed.crashDetectedAt
  } catch {
    // If we can't read the marker, still show the row — presence alone is enough
  }

  const raisedAt = crashDetectedAt ? Date.parse(crashDetectedAt) : nowMs
  return [
    {
      id: deriveId('daemon-died', crashDetectedAt || 'unknown'),
      kind: 'daemon-died',
      priority: 'high',
      title: 'Daemon exited unexpectedly',
      body: [
        `The daemon (pid ${pid || 'unknown'}) exited without a clean shutdown.`,
        startedAt ? `Started:         ${startedAt}` : '',
        `Crash detected:  ${crashDetectedAt}`,
        '',
        'Recovery:',
        '  • Daemon has already restarted — check `.mars/watch.log` for errors',
        '  • Run `mars list` to review any tasks that may need attention',
        '  • Run `mars restart <id>` to re-run any tasks that were interrupted',
      ].filter((l, i) => i === 0 || l !== '').join('\n'),
      payload: { pid, startedAt, crashDetectedAt },
      context: {},
      raisedAt: Number.isFinite(raisedAt) ? raisedAt : nowMs,
      lastSeenAt: nowMs,
      signature: 'daemon-died',
    },
  ]
}

/**
 * Derive a `daemon-code-drift` row when the daemon's source SHA differs from
 * the current HEAD.  The drift state is captured at daemon startup and updated
 * by the periodic dev-staleness check interval.
 */
function deriveDaemonCodeDriftConditions(
  getCodeDrift: (() => DaemonCodeDriftState | null) | undefined,
  nowMs: number,
): PersistedActionQueueRow[] {
  const codeDrift = getCodeDrift?.()
  if (!codeDrift) return []
  const { sourceSha, currentSha, dependencyDrift, behindBy = null, detectedAt } = codeDrift
  if (!sourceSha || !currentSha || sourceSha === currentSha) return []

  const shortSrc = sourceSha.slice(0, 7)
  const shortHead = currentSha.slice(0, 7)
  // Use the detection timestamp as raisedAt so the card shows when the drift
  // was first detected rather than always claiming "0s ago" (derived items
  // are regenerated on every read, so nowMs would always be current time).
  const driftRaisedAt = typeof detectedAt === 'number' && Number.isFinite(detectedAt) ? detectedAt : nowMs
  return [
    {
      id: deriveId('daemon-code-drift', `${sourceSha}:${currentSha}`),
      kind: 'daemon-code-drift',
      priority: 'high',
      title: `Update available for the background engine — ${shortSrc} → ${shortHead}`,
      body: dependencyDrift
        ? `daemon running ${shortSrc}, main is at ${shortHead}; dependencies changed — run your package install, then \`mars daemon restart\``
        : `daemon running ${shortSrc}, main is at ${shortHead} — run \`mars daemon restart\` to load current verify/dispatch code`,
      // Keys here MUST match what the `daemon-code-drift` recipe in
      // action-queue-recipes.ts reads. They drifted once already: this row
      // emitted `sourceSha`/`currentSha` while the recipe read
      // `runningCommit`/`headCommit`, so the drift alert's detail panel
      // always rendered empty even though the daemon held all three values.
      payload: { runningCommit: sourceSha, headCommit: currentSha, behindBy, dependencyDrift },
      context: {},
      raisedAt: driftRaisedAt,
      lastSeenAt: nowMs,
      signature: 'daemon-code-drift',
    },
  ]
}

/**
 * Derive a `baseline-broken` row when the integration branch is poisoned.
 * The checker runs the required gates on a schedule; we read the synchronous
 * in-memory flag, not re-run the gates on every action-queue list.
 *
 * Carries `caughtTaskIds`/`caughtTaskCount` — the same set that
 * {@link deriveFailedConditions} suppresses its own `failed` rows for — so the
 * one row names how many task failures it is standing in for (the 2026-08-18
 * incident's "N unrelated-looking failures" shape, collapsed to one row that
 * says why). `installSignature` mirrors the per-task `setup:install/<class>`
 * failure-signature family (see failure-signature.ts) for the one failing-gate
 * case (`'dependency install'`) that maps onto it, computed from the same
 * probe output via {@link classifyError} rather than re-deriving it from
 * scratch — so the alert and the per-task signature the incident actually
 * produced read as the same defect.
 */
function deriveBaselineBrokenConditions(
  isBaselinePoisoned: (() => boolean) | undefined,
  baselineDetail: (() => { failingGateName?: string; output?: string } | null) | undefined,
  baselineCaughtTaskIds: ReadonlySet<string>,
  nowMs: number,
): PersistedActionQueueRow[] {
  if (!isBaselinePoisoned?.()) return []
  // Belt-and-suspenders: when the checker cleared _lastDetection on recovery
  // (baselineDetail returns null) while _poisoned is stale (true from a
  // concurrent check race that finished after the clearing probe), do not
  // derive the row. Stale captured gate output must not outlive the verdict
  // that produced it. Only applies when a baselineDetail provider was wired
  // (undefined means no checker is connected — fall through to empty payload).
  const detail = baselineDetail !== undefined ? (baselineDetail() ?? null) : null
  if (baselineDetail !== undefined && detail === null) return []
  const failingGateName = detail?.failingGateName ?? null
  const output = detail?.output ?? ''
  const installSignature =
    failingGateName === 'dependency install' && output.length > 0
      ? `setup:install/${classifyError(output)}`
      : null
  // Tail-trimmed excerpt for the card payload.  The full output lives in
  // `body` for `mars action-queue show`; the payload carries only enough
  // to render a VerifyExcerpt on the triage card.
  const gateOutput = trimGateOutput(output)
  const caughtTaskIds = Array.from(baselineCaughtTaskIds).sort()
  const title =
    caughtTaskIds.length > 0
      ? `Integration branch fails required gate: ${failingGateName ?? 'unknown gate'} — caught ${caughtTaskIds.length} task failure${caughtTaskIds.length === 1 ? '' : 's'}`
      : `Integration branch fails required gate: ${failingGateName ?? 'unknown gate'}`
  return [
    {
      id: deriveId('baseline-broken', 'baseline-broken'),
      kind: 'baseline-broken',
      priority: 'urgent',
      title,
      body: output,
      payload: {
        failingGateName,
        gateOutput,
        installSignature,
        caughtTaskCount: caughtTaskIds.length,
        caughtTaskIds,
      },
      context: {},
      raisedAt: nowMs,
      lastSeenAt: nowMs,
      signature: 'baseline-broken',
    },
  ]
}

/**
 * Derive `stale-worktree` rows by probing the filesystem for worktrees whose
 * last-modified time exceeds the configured threshold.  Only non-terminal tasks
 * that have a worktree directory are checked.
 */
async function deriveStaleWorktreeConditions(
  client: DbClient,
  repoRoot: string,
  nowMs: number,
): Promise<PersistedActionQueueRow[]> {
  const thresholdHours = (() => {
    const raw = process.env.MARS_STALE_WORKTREE_HOURS
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 24
  })()
  const thresholdMs = thresholdHours * 3_600_000

  const result = await client.execute(
    `SELECT id, status, prompt, branch, updated_at FROM tasks
       WHERE status NOT IN ('done', 'failed', 'dropped')
       ORDER BY updated_at ASC`,
  )

  const rows: PersistedActionQueueRow[] = []
  for (const r of result.rows) {
    const task = r as {
      id: string
      status: string
      prompt: string
      branch: string | null
      updated_at: string
    }
    const worktreePath = join(repoRoot, '.mars', 'worktrees', task.id)
    if (!existsSync(worktreePath)) continue
    let mtimeMs: number
    try {
      mtimeMs = statSync(worktreePath).mtimeMs
    } catch {
      continue
    }
    if (nowMs - mtimeMs <= thresholdMs) continue
    const ageHours = Math.round((nowMs - mtimeMs) / 3_600_000)
    rows.push({
      id: deriveId('stale-worktree', task.id),
      kind: 'stale-worktree',
      priority: 'normal',
      title: `Task ${task.id} has a stale worktree (${ageHours}h)`,
      body: `Task ${task.id} has a stale worktree (status: ${task.status}, last updated ${ageHours}h ago).`,
      // Keys here MUST match what the `stale-worktree` recipe in
      // action-queue-recipes.ts reads. This kind's payload used to be `{}`
      // while the recipe read `worktree`/`branch`/`uncommittedFiles` — none
      // of which this age-based derivation ever computed (that recipe copy
      // described a different, dirty-tree condition entirely). The recipe
      // was rewritten to match what this derivation actually knows: task
      // status/prompt/branch plus the computed age. `uncommittedFiles` is
      // deliberately dropped, not computed — populating it would mean a
      // `git status` probe per candidate worktree on every action-queue
      // read, which is new I/O on a read path and a separate design call
      // (see the row-level `empty` git probe in view/action-queue.ts, which
      // already does this per-row at render time instead of in bulk here).
      payload: {
        status: task.status,
        prompt: task.prompt,
        branch: task.branch,
        ageHours,
        updatedAt: task.updated_at,
      },
      context: { taskId: task.id },
      raisedAt: mtimeMs,
      lastSeenAt: nowMs,
      signature: `stale-worktree:${task.id}`,
    })
  }
  return rows
}

/**
 * Derive `budget-arc` rows for live arcs whose weighted token spend meets or
 * exceeds the configured per-arc ceiling (`budget.arcTokens`).
 *
 * Derived on every read — no stored row. The condition disappears the moment
 * the arc settles (all tasks terminal) or the ceiling is raised above current
 * spend.  Only arcs with at least one non-terminal task are considered live;
 * settled arcs are excluded by the `live_arcs` CTE so their row disappears on
 * the next read without operator action.
 *
 * The weighted-token formula mirrors `computeBudgetStatus` in spend-meter.ts:
 *   inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens × 0.1
 */
async function deriveBudgetArcConditions(
  client: DbClient,
  nowMs: number,
): Promise<PersistedActionQueueRow[]> {
  const config = readBudgetConfig()
  if (config === null || config.arcTokens === null) return []
  const ceilingTokens = config.arcTokens

  const result = await client.execute(`
    WITH live_arcs AS (
      SELECT arc_id FROM (
        SELECT COALESCE(origin_id, id) AS arc_id,
               MAX(CASE WHEN status NOT IN ('done', 'failed', 'dropped') THEN 1 ELSE 0 END) AS is_live
        FROM tasks
        GROUP BY COALESCE(origin_id, id)
      ) arcs WHERE is_live = 1
    )
    SELECT la.arc_id,
           COALESCE(SUM(
             CAST(te.payload::jsonb #>> '{usageSignals,inputTokens}' AS double precision) +
             CAST(te.payload::jsonb #>> '{usageSignals,outputTokens}' AS double precision) +
             CAST(te.payload::jsonb #>> '{usageSignals,cacheCreateTokens}' AS double precision) +
             CAST(te.payload::jsonb #>> '{usageSignals,cacheReadTokens}' AS double precision) * 0.1
           ), 0) AS weighted_tokens
    FROM live_arcs la
    JOIN tasks t ON COALESCE(t.origin_id, t.id) = la.arc_id
    JOIN trace_events te ON te.task_id = t.id
      AND te.kind = 'step_ended'
      AND te.payload::jsonb ->> 'usageSignals' IS NOT NULL
    GROUP BY la.arc_id
    ORDER BY weighted_tokens DESC
    LIMIT 10
  `)

  return result.rows
    .map((r) => {
      const row = r as { arc_id: string; weighted_tokens: number }
      return { arcId: row.arc_id, spendTokens: Number(row.weighted_tokens) }
    })
    .filter(({ spendTokens }) => spendTokens >= ceilingTokens)
    .map(({ arcId, spendTokens }): PersistedActionQueueRow => {
      const payload: BudgetArcPayload = {
        arcId,
        spentTokens: spendTokens,
        ceilingTokens,
      }
      return {
        id: deriveId('budget-arc', arcId),
        kind: 'budget-arc',
        priority: 'high',
        title: `Arc ${arcId} exceeded token ceiling (${Math.round(spendTokens).toLocaleString()} / ${ceilingTokens.toLocaleString()})`,
        body: '',
        payload: payload as unknown as Record<string, unknown>,
        context: { taskId: arcId },
        raisedAt: nowMs,
        lastSeenAt: nowMs,
        signature: `budget-arc:${arcId}`,
      }
    })
}

// ── Signature-wave condition ──────────────────────────────────────────────────

/**
 * Wave threshold: same number as the storm-breaker so the operator sees a
 * consistent model — "3 distinct failures" means systemic in both surfaces.
 */
const SIGNATURE_WAVE_THRESHOLD = SIGNATURE_STORM_TRIP_THRESHOLD

interface SignatureWaveResult {
  rows: PersistedActionQueueRow[]
  /** Task IDs that belong to a wave group — suppressed from individual `failed` rows. */
  caughtTaskIds: ReadonlySet<string>
}

/**
 * Derive `signature-wave` rows from currently-failed tasks.
 *
 * When N ≥ {@link SIGNATURE_WAVE_THRESHOLD} distinct failed tasks share the
 * same failure family (same {@link isSameFailureFamily} bucket), one wave row
 * is raised in place of the N individual `failed` rows.  The wave row states
 * the shared-cause implication plainly; its `caughtTaskIds` payload lets the
 * operator see which tasks are affected without having to read N identical
 * alerts.
 *
 * The result also carries `caughtTaskIds` as a set so
 * {@link deriveFailedConditions} can suppress the individual rows — exactly the
 * shape `baseline-broken` / `baselineCaughtTaskIds` uses.
 *
 * Only diagnostic signatures ({@link isDiagnosticSignature}) are eligible for
 * grouping: generic buckets like `code/unclassified` must not accidentally fold
 * unrelated failures.
 */
async function deriveSignatureWaveConditions(
  client: DbClient,
  nowMs: number,
): Promise<SignatureWaveResult> {
  const result = await client.execute(
    `SELECT id, failure_signature, updated_at
       FROM tasks
      WHERE status = 'failed'
        AND failure_signature IS NOT NULL`,
  )

  // Group tasks by failure family using isSameFailureFamily semantics.
  // A family is seeded by the first signature seen; subsequent tasks are
  // folded in if isSameFailureFamily matches any existing family's canonical.
  // O(n * m) where m = distinct families; acceptable because failed-task count
  // is bounded in practice (action-queue reads are not hot paths).
  const families: { canonical: string; taskIds: string[]; latestMs: number }[] = []

  for (const r of result.rows) {
    const row = r as { id: string; failure_signature: string; updated_at: string | null }
    const sig = row.failure_signature
    if (!isDiagnosticSignature(sig)) continue

    const existing = families.find((f) => isSameFailureFamily(f.canonical, sig))
    const taskMs = row.updated_at ? Date.parse(row.updated_at) : nowMs
    if (existing) {
      existing.taskIds.push(row.id)
      if (taskMs > existing.latestMs) existing.latestMs = taskMs
    } else {
      families.push({ canonical: sig, taskIds: [row.id], latestMs: taskMs })
    }
  }

  const waveGroups = families.filter((f) => f.taskIds.length >= SIGNATURE_WAVE_THRESHOLD)

  const caughtTaskIds = new Set<string>(waveGroups.flatMap((g) => g.taskIds))

  const rows: PersistedActionQueueRow[] = waveGroups.map((group) => {
    const count = group.taskIds.length
    const sortedIds = group.taskIds.slice().sort()
    return {
      id: deriveId('signature-wave', group.canonical),
      kind: 'signature-wave',
      priority: 'high',
      // Cold-reader headline (DEC-18: signature is an internal — disclosed in body, not subject).
      title: `${count} tasks failed for the same reason — one fix likely unblocks all`,
      body: [
        `${count} tasks all failed with the same failure pattern. This is the shape of an`,
        `environmental or systemic failure, not a per-task regression.`,
        ``,
        `Shared failure pattern: ${group.canonical}`,
        `Affected tasks (${count}): ${sortedIds.join(', ')}`,
        ``,
        `Fix the root cause, then \`mars continue\` or \`mars restart\` each affected task.`,
      ].join('\n'),
      payload: {
        signature: group.canonical,
        caughtTaskCount: count,
        caughtTaskIds: sortedIds,
      },
      context: {},
      raisedAt: group.latestMs,
      lastSeenAt: nowMs,
      signature: `signature-wave:${group.canonical}`,
    }
  })

  return { rows, caughtTaskIds }
}

// ── Phantom-merge condition ───────────────────────────────────────────────────

/**
 * Derive `phantom-merge` rows by scanning tombstone files for done tasks where
 * `reason === 'merged'` and `mergeCommitSha` is null.
 *
 * A tombstone with `{reason: 'merged', mergeCommitSha: null}` means the merge
 * step called `removeWorktree` with reason='merged' but no fast-forward SHA was
 * captured — the integration branch was not actually advanced. This is the P3
 * bug (mars-59c9fdb0): stale-merging-sweep eviction reset the branch, the old
 * queued merge job ran on the reset branch (zero commits), and the merge step
 * silently marked the task done with null SHA.
 *
 * The phantom-merge guard in merge.ts now catches this case inline; this
 * derived condition surfaces any pre-existing tombstones that slipped through.
 *
 * Before raising, the predicate checks whether the task's surviving evidence
 * (its branch or checkpoint refs) is reachable from the integration branch.
 * If the work has already landed, no alert is raised. If no evidence survives
 * at all, a lower-priority `phantom-merge-unknown` is raised instead of
 * asserting the work is missing when that cannot be determined.
 *
 * Results are cached per-taskId keyed on the current integration branch SHA so
 * the git probes only re-run when main advances.
 */

// Cache: taskId → { mainSha: string; outcome }
// Recomputed per task only when the integration branch SHA changes.
const _phantomMergeOutcomeCache = new Map<
  string,
  { mainSha: string; outcome: 'landed' | 'missing' | 'unknown' }
>()

async function derivePhantomMergeConditions(
  client: DbClient,
  repoRoot: string,
  nowMs: number,
): Promise<PersistedActionQueueRow[]> {
  const marsWorktreesDir = join(repoRoot, '.mars', 'worktrees')
  if (!existsSync(marsWorktreesDir)) return []

  // Only check done tasks — a phantom merge only matters for tasks that the
  // system believes succeeded. Failed tasks may also have null tombstones but
  // they already have actionable failed alerts.
  const result = await client.execute(
    `SELECT id FROM tasks WHERE status = 'done' ORDER BY updated_at DESC LIMIT 200`,
  )

  // Resolve the integration branch name and its current SHA once per derivation
  // pass. The SHA is the cache key: outcomes are recomputed only when main moves.
  const intBranch = integrationBranchName()
  const intShaProbe = spawnSync('git', ['-C', repoRoot, 'rev-parse', intBranch], {
    encoding: 'utf8',
  })
  const intSha =
    intShaProbe.status === 0 && !intShaProbe.error
      ? (intShaProbe.stdout as string).trim()
      : ''

  const rows: PersistedActionQueueRow[] = []
  for (const r of result.rows) {
    const taskId = (r as { id: string }).id
    const tombstonePath = join(marsWorktreesDir, `${taskId}.removed.json`)
    if (!existsSync(tombstonePath)) continue
    let tombstone: { reason?: string; mergeCommitSha?: string | null; taskId?: string; removedAt?: string }
    try {
      tombstone = JSON.parse(readFileSync(tombstonePath, 'utf8')) as typeof tombstone
    } catch {
      continue
    }
    if (tombstone.reason !== 'merged') continue
    // null or missing mergeCommitSha with reason='merged' is the phantom-merge symptom.
    if (tombstone.mergeCommitSha) continue
    // Use the tombstone's recorded removal time as the alert's raisedAt so the
    // card shows when the merge (and the gap) actually occurred rather than
    // always saying "0s ago" (derived items are regenerated on every read).
    const tombstoneRemovedAt = typeof tombstone.removedAt === 'string'
      ? Date.parse(tombstone.removedAt)
      : NaN
    const phantomRaisedAt = Number.isFinite(tombstoneRemovedAt) ? tombstoneRemovedAt : nowMs

    // Check whether the work actually landed on the integration branch before
    // raising an alert. The outcome is cached per (taskId, intSha) so the git
    // probes only run when main advances.
    const cached = _phantomMergeOutcomeCache.get(taskId)
    let outcome: 'landed' | 'missing' | 'unknown'
    if (cached && intSha !== '' && cached.mainSha === intSha) {
      outcome = cached.outcome
    } else {
      // 1. Try the task branch via git cherry (patch-equivalence test).
      const branchName = `task/${taskId}`
      const cherryBranch = spawnSync(
        'git',
        ['-C', repoRoot, 'cherry', intBranch, branchName],
        { encoding: 'utf8', timeout: 10_000 },
      )
      if (cherryBranch.status === 0 && !cherryBranch.error) {
        const hasUnmerged = (cherryBranch.stdout as string)
          .split('\n')
          .some((l: string) => l.startsWith('+'))
        outcome = hasUnmerged ? 'missing' : 'landed'
      } else {
        // Branch absent — try checkpoint refs.
        const checkpointGlob = `refs/mars/checkpoint/${taskId}-*`
        const refsProbe = spawnSync(
          'git',
          ['-C', repoRoot, 'for-each-ref', '--format=%(objectname)', checkpointGlob],
          { encoding: 'utf8', timeout: 5_000 },
        )
        if (refsProbe.status !== 0 || refsProbe.error) {
          outcome = 'unknown'
        } else {
          const shas = (refsProbe.stdout as string)
            .trim()
            .split('\n')
            .filter((s: string) => s.length > 0)
          if (shas.length === 0) {
            // No branch, no checkpoint refs — cannot determine landing status.
            outcome = 'unknown'
          } else {
            // All checkpoint SHAs must be patch-present on the integration branch.
            let allLanded = true
            for (const sha of shas) {
              const cherryRef = spawnSync(
                'git',
                ['-C', repoRoot, 'cherry', intBranch, sha],
                { encoding: 'utf8', timeout: 5_000 },
              )
              if (
                cherryRef.status !== 0 ||
                cherryRef.error ||
                (cherryRef.stdout as string).split('\n').some((l: string) => l.startsWith('+'))
              ) {
                allLanded = false
                break
              }
            }
            outcome = allLanded ? 'landed' : 'missing'
          }
        }
      }
      if (intSha !== '') {
        _phantomMergeOutcomeCache.set(taskId, { mainSha: intSha, outcome })
      }
    }

    // Work confirmed on the integration branch — no alert needed.
    if (outcome === 'landed') continue

    if (outcome === 'unknown') {
      // No surviving evidence: cannot assert commits are missing. Raise a
      // lower-priority condition so the operator can verify and dismiss.
      rows.push({
        id: deriveId('phantom-merge-unknown', taskId),
        kind: 'phantom-merge-unknown',
        priority: 'normal',
        title: `Task ${taskId}: null merge SHA — no surviving evidence to verify landing`,
        body: [
          `Task \`${taskId}\` was marked done with tombstone \`{reason: 'merged', mergeCommitSha: null}\`.`,
          '',
          `No surviving evidence found (branch \`task/${taskId}\` is absent; no \`refs/mars/checkpoint/${taskId}-*\` refs exist).`,
          `Whether the commits landed on \`${intBranch}\` cannot be determined automatically.`,
          '',
          `**To verify:** \`git log ${intBranch} --grep ${taskId}\`. If nothing appears and the work`,
          `matters, restore it from \`git for-each-ref refs/mars/parked/${taskId}\` or treat as lost.`,
          `Dismiss this alert once you have confirmed the outcome.`,
        ].join('\n'),
        payload: { taskId, tombstonePath, reason: 'merged', mergeCommitSha: null },
        context: {},
        raisedAt: phantomRaisedAt,
        lastSeenAt: nowMs,
        signature: `phantom-merge-unknown:${taskId}`,
      })
      continue
    }

    // outcome === 'missing': surviving evidence is NOT on the integration branch.
    rows.push({
      id: deriveId('phantom-merge', taskId),
      kind: 'phantom-merge',
      priority: 'high',
      title: `Task ${taskId}: phantom merge — done but commits not on ${intBranch}`,
      body: [
        `Task \`${taskId}\` was marked done with tombstone \`{reason: 'merged', mergeCommitSha: null}\`,`,
        `and its commits are NOT reachable from \`${intBranch}\` (checked branch \`task/${taskId}\` and checkpoint refs).`,
        '',
        `A null \`mergeCommitSha\` means the fast-forward did not advance the integration branch — ` +
          `the task is "done" but its commits may not have landed. This is the P3 bug ` +
          `(mars-59c9fdb0): a stale-merging-sweep eviction reset the branch while an old ` +
          `merge job was still queued; the job ran on the reset (zero-commit) branch.`,
        '',
        `**To restore:** inspect parked refs (\`git for-each-ref refs/mars/parked/${taskId}\`)`,
        `or the task branch (\`git log task/${taskId}\`) and merge manually.`,
      ].join('\n'),
      payload: { taskId, tombstonePath, reason: 'merged', mergeCommitSha: null },
      context: {},
      raisedAt: phantomRaisedAt,
      lastSeenAt: nowMs,
      signature: `phantom-merge:${taskId}`,
    })
  }
  return rows
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a `ConditionItemsSource` that derives condition-kind rows on every
 * read from injected daemon state and live DB queries.
 *
 * Callers pass `opts.kinds` as a performance hint: when provided, only the
 * matching derivation functions are run.  The returned rows are always filtered
 * to the requested set as a safety net.
 */
export const createConditionItemsSource = (deps: ConditionsDeps): ConditionItemsSource => ({
  async derive(opts: { kinds?: ReadonlySet<string> }): Promise<PersistedActionQueueRow[]> {
    const { kinds } = opts
    const wants = (k: string) => !kinds || kinds.size === 0 || kinds.has(k)
    const nowMs = deps.nowMs ?? Date.now()
    const client = deps.getClient()

    // Both baselineCaughtTaskIds and waveResult are computed before the main
    // fan-out so that deriveFailedConditions can suppress the rows they account
    // for. They are computed in parallel to minimise wall-clock overhead.
    //
    // baselineCaughtTaskIds: shared by `failed` and `baseline-broken` — both need
    // the same answer to "which failed tasks does the poisoned baseline explain".
    //
    // waveResult: shared by `failed` (suppresses the individual rows the wave
    // accounts for) and `signature-wave` (provides the pre-built wave rows).
    // Same shape as baselineCaughtTaskIds — one query, two consumers.
    const [baselineCaughtTaskIds, waveResult] = await Promise.all([
      wants('failed') || wants('baseline-broken')
        ? findBaselineCaughtTaskIds(
            client,
            deps.isBaselinePoisoned?.() ?? false,
            deps.getPauseState?.() ?? null,
          )
        : Promise.resolve(new Set<string>()),
      wants('failed') || wants('signature-wave')
        ? deriveSignatureWaveConditions(client, nowMs)
        : Promise.resolve({ rows: [] as PersistedActionQueueRow[], caughtTaskIds: new Set<string>() }),
    ])

    const results = await Promise.all([
      wants('failed') ? deriveFailedConditions(client, nowMs, baselineCaughtTaskIds, waveResult.caughtTaskIds) : [],
      wants('stale-queued') ? deriveStaleQueuedConditions(client, deps) : [],
      wants('gate-broken') ? deriveGateBrokenConditions(client, nowMs) : [],
      wants('subscriber-stalled') ? deriveSubscriberStalledConditions(client, nowMs) : [],
      wants('signature-storm') ? deriveSignatureStormConditions(deps.getPauseState, nowMs) : [],
      wants('daemon-died') ? deriveDaemonDiedConditions(deps.crashMarkerPath, nowMs) : [],
      wants('daemon-code-drift') ? deriveDaemonCodeDriftConditions(deps.getCodeDrift, nowMs) : [],
      wants('baseline-broken')
        ? deriveBaselineBrokenConditions(
            deps.isBaselinePoisoned,
            deps.baselineDetail,
            baselineCaughtTaskIds,
            nowMs,
          )
        : [],
      wants('stale-worktree') && deps.repoRoot
        ? deriveStaleWorktreeConditions(client, deps.repoRoot, nowMs)
        : [],
      wants('budget-arc') ? deriveBudgetArcConditions(client, nowMs) : [],
      // waveResult.rows is already materialised — just include it when the kind is wanted.
      wants('signature-wave') ? waveResult.rows : [],
      (wants('phantom-merge') || wants('phantom-merge-unknown')) && deps.repoRoot
        ? derivePhantomMergeConditions(client, deps.repoRoot, nowMs)
        : [],
    ])

    const all = results.flat()
    // Safety-net filter: ensure only requested kinds are returned.
    return kinds && kinds.size > 0 ? all.filter((r) => kinds.has(r.kind)) : all
  },
})
