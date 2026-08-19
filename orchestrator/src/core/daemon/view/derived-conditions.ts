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
import type { PersistedActionQueueRow, ConditionItemsSource } from './action-queue'
import type { DispatchPauseState } from '../pause-state'
import type { DbClient } from '../../lib/db'
import { RECOVERY_EXHAUSTED_PREFIX } from '../../lib/failure-signature'

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
 */
/** Max chars of `tasks.error` carried into the alert's `errorExcerpt`. */
const ERROR_EXCERPT_MAX = 600

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
): Promise<PersistedActionQueueRow[]> {
  const result = await client.execute(
    `SELECT t.id, t.failure_signature, t.prompt, t.updated_at, t.failure_reason_code,
            t.failure_reason, t.stall_diagnostics, t.branch, t.worktree_path, t.error
       FROM tasks t
      WHERE t.status = 'failed'
        AND (
          t.fix_for_task_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM tasks origin
             WHERE origin.id = t.fix_for_task_id
               AND origin.status NOT IN ('done', 'failed', 'dropped')
          )
        )
      ORDER BY t.updated_at DESC`,
  )
  return result.rows.map((r) => {
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
      },
      context: { taskId: row.id },
      raisedAt,
      lastSeenAt: nowMs,
      signature: `failed:${row.id}`,
    }
  })
}

const STALE_QUEUED_THRESHOLD_MS = (() => {
  const raw = process.env.MARS_STALE_QUEUED_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60_000
})()

const MAX_STALE_QUEUED_ROWS = 20

/**
 * Derive `stale-queued` rows from queued tasks that have waited past the
 * configured threshold.  Suppressed entirely when dispatch is deliberately
 * paused or the implement pool is saturated.
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
  const result = await client.execute(
    `SELECT id, updated_at, prompt FROM tasks WHERE status = 'queued' ORDER BY updated_at ASC`,
  )

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
    return {
      id: deriveId('stale-queued', row.id),
      kind: 'stale-queued',
      priority: 'normal',
      title: `Stale-queued ${ageMinutes} min: ${shortGoal}`,
      body: `"${shortGoal}" has been waiting in the dispatch queue for ${ageMinutes} min (threshold: ${Math.round(STALE_QUEUED_THRESHOLD_MS / 60_000)} min).`,
      payload: {
        taskId: row.id,
        queuedAgeMs,
        activeWorkerCount: active,
        implementCap: cap,
        queueDepth: result.rows.length,
        dispatchDecisionSummary: [],
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
  const result = await client.execute(
    `SELECT id, quarantine_signature, last_failure_at, last_failure_origin_id
       FROM verify_gates WHERE state = 'quarantined'`,
  )
  return result.rows.map((r) => {
    const row = r as {
      id: string
      quarantine_signature: string | null
      last_failure_at: number | null
      last_failure_origin_id: string | null
    }
    const verdict = row.quarantine_signature ?? row.id
    const raisedAt = row.last_failure_at ?? nowMs
    return {
      id: deriveId('gate-broken', row.id),
      kind: 'gate-broken',
      priority: 'high',
      title: `Gate ${row.id} is broken`,
      body: '',
      payload: {
        gate: row.id,
        verdict,
        originTaskId: row.last_failure_origin_id,
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
    `SELECT subscriber_id, event_id, last_error, raised_at FROM subscriber_stalls`,
  )
  return result.rows.map((r) => {
    const row = r as {
      subscriber_id: string
      event_id: string | number
      last_error: string
      raised_at: number
    }
    const key = `${row.subscriber_id}:${row.event_id}`
    return {
      id: deriveId('subscriber-stalled', key),
      kind: 'subscriber-stalled',
      priority: 'high',
      title: `Subscriber ${row.subscriber_id} is stalled`,
      body: row.last_error,
      payload: {
        subscriberId: row.subscriber_id,
        eventId: row.event_id,
        lastError: row.last_error,
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
  const { sourceSha, currentSha, dependencyDrift } = codeDrift
  if (!sourceSha || !currentSha || sourceSha === currentSha) return []

  const shortSrc = sourceSha.slice(0, 7)
  const shortHead = currentSha.slice(0, 7)
  return [
    {
      id: deriveId('daemon-code-drift', `${sourceSha}:${currentSha}`),
      kind: 'daemon-code-drift',
      priority: 'high',
      title: `Daemon running stale code — ${shortSrc} → ${shortHead}`,
      body: dependencyDrift
        ? `daemon running ${shortSrc}, main is at ${shortHead}; dependencies changed — run your package install, then \`mars daemon restart\``
        : `daemon running ${shortSrc}, main is at ${shortHead} — run \`mars daemon restart\` to load current verify/dispatch code`,
      payload: { sourceSha, currentSha },
      context: {},
      raisedAt: nowMs,
      lastSeenAt: nowMs,
      signature: 'daemon-code-drift',
    },
  ]
}

/**
 * Derive a `baseline-broken` row when the integration branch is poisoned.
 * The checker runs the required gates on a schedule; we read the synchronous
 * in-memory flag, not re-run the gates on every action-queue list.
 */
function deriveBaselineBrokenConditions(
  isBaselinePoisoned: (() => boolean) | undefined,
  baselineDetail: (() => { failingGateName?: string; output?: string } | null) | undefined,
  nowMs: number,
): PersistedActionQueueRow[] {
  if (!isBaselinePoisoned?.()) return []
  const detail = baselineDetail?.() ?? {}
  return [
    {
      id: deriveId('baseline-broken', 'baseline-broken'),
      kind: 'baseline-broken',
      priority: 'urgent',
      title: `Integration branch fails required gate: ${detail.failingGateName ?? 'unknown gate'}`,
      body: detail.output ?? '',
      payload: { failingGateName: detail.failingGateName ?? null, output: detail.output ?? '' },
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
    `SELECT id, status, prompt, updated_at FROM tasks
       WHERE status NOT IN ('done', 'failed', 'dropped')
       ORDER BY updated_at ASC`,
  )

  const rows: PersistedActionQueueRow[] = []
  for (const r of result.rows) {
    const task = r as { id: string; status: string; prompt: string; updated_at: string }
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
      payload: {},
      context: { taskId: task.id },
      raisedAt: mtimeMs,
      lastSeenAt: nowMs,
      signature: `stale-worktree:${task.id}`,
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

    const results = await Promise.all([
      wants('failed') ? deriveFailedConditions(client, nowMs) : [],
      wants('stale-queued') ? deriveStaleQueuedConditions(client, deps) : [],
      wants('gate-broken') ? deriveGateBrokenConditions(client, nowMs) : [],
      wants('subscriber-stalled') ? deriveSubscriberStalledConditions(client, nowMs) : [],
      wants('signature-storm') ? deriveSignatureStormConditions(deps.getPauseState, nowMs) : [],
      wants('daemon-died') ? deriveDaemonDiedConditions(deps.crashMarkerPath, nowMs) : [],
      wants('daemon-code-drift') ? deriveDaemonCodeDriftConditions(deps.getCodeDrift, nowMs) : [],
      wants('baseline-broken')
        ? deriveBaselineBrokenConditions(deps.isBaselinePoisoned, deps.baselineDetail, nowMs)
        : [],
      wants('stale-worktree') && deps.repoRoot
        ? deriveStaleWorktreeConditions(client, deps.repoRoot, nowMs)
        : [],
    ])

    const all = results.flat()
    // Safety-net filter: ensure only requested kinds are returned.
    return kinds && kinds.size > 0 ? all.filter((r) => kinds.has(r.kind)) : all
  },
})
