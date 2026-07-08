import type { Client } from '@libsql/client'
import { createHash, randomUUID } from 'node:crypto'
import { resolveStateClient } from '../store/state-client'
import { buildEventInsert } from './outbox'
import type { EventName, EventPayload } from './outbox'
import { resolveOriginIdForTask } from './origin'

/**
 * Emit an actionQueue lifecycle event to the queue.db events outbox.
 *
 * action_queue_items live in state.db; the events outbox lives in queue.db.
 * Cross-DB atomicity is not available via libsql transactions, so this
 * emits in a separate write transaction on queue.db after the state.db
 * write has committed. Emission failures are non-fatal: the actionQueue
 * operation succeeds regardless.
 */
async function emitActionQueueBusEvent<T extends EventName>(
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  try {
    const { getDefaultTaskStore } = await import('../store/task-store')
    const store = await getDefaultTaskStore()
    await store.atomic(async (scope) => {
      await scope.execute(buildEventInsert(type, payload))
    })
  } catch {
    // Non-fatal: actionQueue state change already committed in state.db.
  }
}

export type ActionQueueCategory = 'orchestrator' | 'reflector' | 'daemon' | 'user'
export type ActionQueuePriority = 'urgent' | 'high' | 'normal' | 'low'
export type ActionQueueState = 'open' | 'resolved'

export const ACTION_QUEUE_KINDS = [
  'failed',
  'cancelled-blocker-cascade',
  'diagnose-inconclusive',
  'daemon-killed',
  'stale-worktree',
  'worktree-ahead',
  'prerequisite-failed',
  'draft-proposal',
  'slices-dropped',
  'hitl-slice-needs-operator',
  // A task finished verify cleanly and carries a preview command: a live dev
  // server is running off its worktree and the task is parked in
  // 'awaiting-validation' until the operator clicks Validate (→ merge) or
  // Reject (→ failed). The row carries the dev-server URL in its payload.
  'awaiting-validation',
  // A task has been parked in 'awaiting-human': an operator holds a worktree
  // lease and is working interactively in the task's worktree. The row carries
  // the lease owner, timestamp, and optional note in its payload. Raised on
  // park and again (level-triggered, ADR-0048) if the lease expires without
  // activity.
  'awaiting-human',
  // The behaviour-verify step could not exercise the task's Definition-of-Done
  // criteria against a live surface (no preview command, dev server would not
  // boot/health-check, Playwright MCP unavailable, DoD absent, or the Worker's
  // verdict JSON was unparseable). The merge proceeded — un-verifiability is
  // never a hard fail — but it must never be silent either: this level-
  // triggered row (deduped per origin task; seen_count bumps on re-detection,
  // ADR-0048) links the task to the fingerprinted draft proposal that
  // describes the concrete unblock.
  'behaviour-unverified',
  // A durable Subscriber's handler has thrown on the same event K times in
  // a row; its cursor is blocked (ADR-0032). The operator surface for an
  // otherwise-silent stall — there is no DLQ.
  'subscriber-stalled',
  // The observability store (observability.duckdb) has exceeded 500 MB.
  // Raised by the daemon's periodic size watchdog; never triggers pruning.
  'observability-store-oversize',
  // A blocked dependent's origin_id pointed at a task that no longer exists
  // in the tasks table (deleted/purged). The dependent is failed rather than
  // re-dispatched against a vanished target.
  'orphaned-origin',
  // A task was stuck in 'running' or 'verifying' with no live subprocess:
  // its recorded PID was dead, or its updatedAt exceeded the wall-clock ceiling.
  // The daemon auto-failed the task and freed its in-flight slot.
  'phantom-task',
  // Outbox events table lag (MAX(id) - MIN(cursor)) exceeded
  // MARS_OUTBOX_LAG_WARN_THRESHOLD; a subscriber is wedged and blocking
  // retention pruning.
  'outbox-lag',
  // The reflect-worthiness detector has identified signals that make reflection
  // valuable right now (KPI drift, failure signature cluster, or token spike),
  // but selfEvolve.autoTrigger is off so the operator must act manually.
  // Level-triggered (ADR-0048): exists while the condition holds and no
  // reflection run covers the window. Cleared when a reflect run lands,
  // the operator enables auto-trigger, or the signal window ages out.
  'reflect-recommended',
  // A proposal has been sliced but its tasks have NOT been enqueued yet —
  // the operator must review the slice graph and either approve (enqueue all
  // slices) or reslice (discard and re-run the Slicer with feedback).
  // Level-triggered (ADR-0048): present while the proposal is 'sliced' and
  // approval is pending; clears on approve or reslice. Only raised when
  // autoApprovePlans is false (the default).
  'plan-approval',
  // A done transition was intercepted because the task's branch still had
  // commits ahead of the integration branch — the merge step never completed.
  // The task is failed with failure_reason_code='done-with-unmerged-commits'
  // and this action-queue row is raised at the same choke point so the operator
  // can investigate and re-merge or restart. This catches the false-done class
  // (ADR-0052 done-implies-merged invariant).
  'done-with-unmerged-commits',
  // The Anthropic API circuit breaker tripped — multiple parallel tasks failed
  // with a ConnectionRefused cascade (environmental outage). Exactly one row per
  // open→close cycle, keyed on `api-outage:<openedAt>`. Subsequent failures
  // during the same cycle bump seen_count and append to payload.occurrences
  // rather than creating per-task siblings. Cleared automatically once the
  // breaker closes and all affected tasks are no longer in 'failed' state.
  'api-outage',
  // The daemon is running source code from an older commit while the git HEAD
  // has since advanced (dev-install only). Raised by the periodic dev-staleness
  // check whenever drift is detected. Level-triggered (ADR-0048): exists while
  // the daemon is stale; cleared automatically when the daemon restarts (the new
  // daemon runs current code). One row per daemon lifetime — idempotent raises
  // bump seen_count rather than inserting siblings.
  'daemon-code-drift',
  // The provider (Claude API) rejected dispatched runs due to rate or spend
  // limits. Level-triggered (ADR-0048): exactly one row per rate-limit episode;
  // idempotent raises bump seen_count. Cleared when the operator acknowledges
  // or when dispatch auto-resumes after resetsAt. The payload carries the
  // resetsAt Unix-second timestamp and the ISO string of the earliest reset.
  'provider-rate-limited',
  // A verify gate has produced the same failure verdict on K consecutive
  // DIFFERENT tasks — the signature of a gate whose input pipeline has
  // silently starved (incident 2026-07-03T08:15Z) rather than a real per-task
  // regression. Level-triggered (ADR-0048): exactly one row per episode, keyed
  // on the verdict; idempotent raises bump seen_count. Recovery-task spawns for
  // that verdict are suppressed while the row is open; the affected origins are
  // failed but restartable (no recovery slot consumed). Cleared when the
  // operator fixes/disables the gate and clears the suppression.
  'gate-broken',
  // A self-authored workflow (ADR-0068) landed via `mars workflow author` and
  // sits on disk as an agent draft: lint-clean and dry-run-validated, but NOT
  // dispatch-eligible until the operator approves it. Level-triggered
  // (ADR-0048): one row per workflow name (signature-keyed; idempotent
  // re-raises bump seen_count); superseded when `mars workflow approve <name>`
  // privileges the file. The row body carries the rendered runbook plus the
  // raw JS so the review happens entirely from the queue.
  'workflow-draft-pending',
  // A new statically-encodable failure signature was observed and claimed as
  // a gate-enrichment candidate (PRD 745f33e0): a detached Writer task is
  // drafting ONE candidate check, and a human must approve it into SHADOW
  // mode (`mars enrich approve`) or retire the signature (`mars enrich
  // retire`) before it can ever run. Level-triggered (ADR-0048): exactly one
  // row per signature, keyed `gate-enrichment:<signature>`; repeat failures
  // bump seen_count on the registry row, never raise siblings. The row is
  // superseded when the approve/retire verb mutates the enrichment record —
  // no separate close gesture.
  'gate-enrichment',
  // Spend meter (observe-and-warn, ADR-0048 level-triggered projection):
  // the rolling wall-clock window's cache-weighted token spend crossed the
  // configured window-tokens threshold. Singleton row (signature
  // 'budget-window'); the daemon spend sweep is both raiser and resolver —
  // it auto-resolves the row once spend drops below ~90% of the threshold
  // (hysteresis). Never pauses dispatch or suppresses recoveries.
  'budget-window',
  // Spend meter: a single live (non-terminal) arc's lifetime cache-weighted
  // spend crossed the configured per-arc ceiling. One row per offending arc
  // (signature 'budget-arc:<arcId>'); the spend sweep auto-resolves the row
  // when the arc reaches terminal status (lifetime spend never decreases,
  // so live-ness is the falsifiable half of the level condition).
  'budget-arc',
] as const

export type ActionQueueKind = (typeof ACTION_QUEUE_KINDS)[number]

export const isActionQueueKind = (s: unknown): s is ActionQueueKind =>
  ACTION_QUEUE_KINDS.includes(s as ActionQueueKind)

/**
 * Callback used by `getActionQueueItem` to fetch the current state of the origin
 * task at the moment the actionQueue item is opened. Returning `null` means the
 * task was not found (deleted or DB unavailable); `liveTaskStatus` will be
 * `null` in that case.
 *
 * The default implementation calls `getTask` from `../queue`. Pass your own
 * implementation in tests or any context where the queue DB is unavailable.
 */
export type LiveTaskLookup = (
  taskId: string,
) => Promise<{ status: string } | null>

export interface RaiseActionQueueItem {
  kind: ActionQueueKind
  category: ActionQueueCategory | string
  priority: ActionQueuePriority
  title: string
  body: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  raisedBy: string
  signature: string
  occurrence?: Record<string, unknown>
  /**
   * When set, the actionQueue row is deduped on this origin task id alone —
   * kind- and signature-agnostic. Any failure on a recovery descendant
   * (or repeated failures on the origin) collapses into the SAME row.
   * Yields exactly one action_queue_items row per stuck origin task regardless
   * of how many recovery attempts have failed against it.
   */
  originTaskId?: string
}

export interface ActionQueueResolution {
  state: 'resolved'
  note: string | null
  rootCause: string | null
  resolvedBy: string | null
  resolvedAt: string
}

export interface ActionQueueHistoryEntry {
  at: string
  fromState: ActionQueueState | null
  toState: ActionQueueState
  by: string | null
  note: string | null
}

export interface ActionQueueItem {
  id: string
  kind: ActionQueueKind
  category: string
  priority: ActionQueuePriority
  state: ActionQueueState
  title: string
  body: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  raisedBy: string
  raisedAt: string
  lastSeenAt: string
  seenCount: number
  fingerprint: string
  signature: string | null
  resolvedAt: string | null
  resolution: string | null
  resolutionDetails: ActionQueueResolution | null
  resolutionNote: string | null
  rootCause: string | null
  history: ActionQueueHistoryEntry[]
  /**
   * The task id this actionQueue item was raised for (origin-keyed items only).
   * Stored in the DB at raise time; `null` for signature-keyed items.
   */
  originTaskId: string | null
  /**
   * Live status of the origin task, fetched from the queue at the moment
   * `getActionQueueItem` is called. Always reflects current state — never a
   * snapshot from raise time. `null` when `originTaskId` is absent, the
   * task was not found, or the queue DB is unavailable.
   */
  liveTaskStatus: string | null
}

export interface SetActionQueueStateOptions {
  resolution?: string
  note?: string
  rootCause?: string
  by?: string
}

let initialised = false

// Shared state.db client (collapsed from the former private singleton); same
// `mars.db` file as the TaskStore (ADR-0034), resolved through the seam.
const stateClient = resolveStateClient

const sha1Hex = (input: string): string =>
  createHash('sha1').update(input).digest('hex')

const computeFingerprint = (kind: string, signature: string): string =>
  sha1Hex(`${kind}:${signature}`)

const generateActionQueueId = (): string => randomUUID().slice(0, 8)

export const initActionQueue = async (): Promise<void> => {
  if (initialised) return
  const c = stateClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS action_queue_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      category TEXT NOT NULL,
      priority TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      context TEXT NOT NULL DEFAULT '{}',
      raised_by TEXT NOT NULL,
      raised_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT,
      resolution_note TEXT,
      root_cause TEXT
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS action_queue_history (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      at TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      by TEXT,
      note TEXT,
      FOREIGN KEY (item_id) REFERENCES action_queue_items(id)
    )
  `)
  const cols = await c.execute(`PRAGMA table_info(action_queue_items)`)
  const colNames = new Set(
    cols.rows.map((r) => (r as unknown as { name: string }).name),
  )
  if (!colNames.has('fingerprint')) {
    await c.execute(`ALTER TABLE action_queue_items ADD COLUMN fingerprint TEXT`)
  }
  if (!colNames.has('signature')) {
    await c.execute(`ALTER TABLE action_queue_items ADD COLUMN signature TEXT`)
  }
  if (!colNames.has('seen_count')) {
    await c.execute(
      `ALTER TABLE action_queue_items ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1`,
    )
  }
  if (!colNames.has('last_seen_at')) {
    await c.execute(`ALTER TABLE action_queue_items ADD COLUMN last_seen_at TEXT`)
  }
  if (!colNames.has('resolved_by')) {
    await c.execute(`ALTER TABLE action_queue_items ADD COLUMN resolved_by TEXT`)
  }
  if (!colNames.has('origin_task_id')) {
    await c.execute(`ALTER TABLE action_queue_items ADD COLUMN origin_task_id TEXT`)
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_action_queue_fingerprint_state
       ON action_queue_items(fingerprint, state)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_action_queue_state ON action_queue_items(state)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_action_queue_history_item ON action_queue_history(item_id, at)`,
  )
  // One-time rename: retry_budget_exhausted → recovery_exhausted in action_queue_items
  // payload and body. Idempotent: WHERE guards against rows already migrated.
  await c.execute(
    `UPDATE action_queue_items
        SET payload = replace(payload, 'retry_budget_exhausted', 'recovery_exhausted')
      WHERE payload LIKE '%retry_budget_exhausted%'`,
  )
  await c.execute(
    `UPDATE action_queue_items
        SET body = replace(body, 'retry_budget_exhausted', 'recovery_exhausted')
      WHERE body LIKE '%retry_budget_exhausted%'`,
  )
  // Drop legacy inbox_* tables left behind by the inbox→action_queue rename.
  // Sanity-assert action_queue_items exists first so we never drop before the
  // rename has run. DROP TABLE IF EXISTS is idempotent on subsequent inits.
  const aqCheck = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='action_queue_items'`,
  )
  if (aqCheck.rows.length > 0) {
    // Drop children before the parent so PRAGMA foreign_keys=ON never sees a
    // parent-first teardown.  inbox_history.item_id → inbox_items(id); dropping
    // inbox_items first with rows present throws SQLITE_CONSTRAINT (FK violated).
    await c.execute(`DROP TABLE IF EXISTS inbox_history`)
    await c.execute(`DROP TABLE IF EXISTS inbox_dismissals`)
    await c.execute(`DROP TABLE IF EXISTS inbox_items`)
  }
  initialised = true
}

const parseJsonObject = (
  raw: string | null | undefined,
): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

const toKind = (raw: unknown): ActionQueueKind =>
  isActionQueueKind(raw) ? raw : 'failed'

const toPriority = (raw: unknown): ActionQueuePriority => {
  if (raw === 'urgent' || raw === 'high' || raw === 'normal' || raw === 'low') {
    return raw
  }
  return 'normal'
}

const toState = (raw: unknown): ActionQueueState => {
  if (raw === 'open') return 'open'
  if (raw === 'resolved' || raw === 'acknowledged' || raw === 'dismissed') return 'resolved'
  return 'open'
}

const loadHistory = async (
  c: Client,
  itemId: string,
): Promise<ActionQueueHistoryEntry[]> => {
  const r = await c.execute({
    sql: `SELECT at, from_state, to_state, by, note
            FROM action_queue_history
           WHERE item_id = ?
           ORDER BY at ASC`,
    args: [itemId],
  })
  return r.rows.map((row) => {
    const r2 = row as unknown as Record<string, unknown>
    const fromRaw = (r2.from_state as string | null) ?? null
    const fromState: ActionQueueState | null =
      fromRaw === 'open'
        ? 'open'
        : fromRaw === 'resolved' || fromRaw === 'acknowledged' || fromRaw === 'dismissed'
          ? 'resolved'
          : null
    return {
      at: (r2.at as string | null) ?? '',
      fromState,
      toState: toState(r2.to_state),
      by: (r2.by as string | null) ?? null,
      note: (r2.note as string | null) ?? null,
    }
  })
}

const insertHistory = async (
  c: Client,
  itemId: string,
  fromState: ActionQueueState | null,
  toStateValue: ActionQueueState,
  by: string | null,
  note: string | null,
): Promise<void> => {
  await c.execute({
    sql: `INSERT INTO action_queue_history (id, item_id, at, from_state, to_state, by, note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      itemId,
      new Date().toISOString(),
      fromState,
      toStateValue,
      by,
      note,
    ],
  })
}

const rowToActionQueueItem = (
  row: Record<string, unknown>,
  history: ActionQueueHistoryEntry[],
): ActionQueueItem => {
  const state = toState(row.state)
  const resolvedAt = (row.resolved_at as string | null) ?? null
  const resolution = (row.resolution as string | null) ?? null
  const resolutionNote = (row.resolution_note as string | null) ?? null
  const rootCause = (row.root_cause as string | null) ?? null
  const resolvedBy = (row.resolved_by as string | null) ?? null
  const resolutionDetails: ActionQueueResolution | null =
    state === 'resolved'
      ? {
          state,
          note: resolutionNote,
          rootCause,
          resolvedBy,
          resolvedAt: resolvedAt ?? '',
        }
      : null
  return {
    id: row.id as string,
    kind: toKind(row.kind),
    category: (row.category as string | null) ?? '',
    priority: toPriority(row.priority),
    state,
    title: (row.title as string | null) ?? '',
    body: (row.body as string | null) ?? '',
    payload: parseJsonObject(row.payload as string | null),
    context: parseJsonObject(row.context as string | null),
    raisedBy: row.raised_by as string,
    raisedAt: row.raised_at as string,
    lastSeenAt:
      (row.last_seen_at as string | null) ?? (row.raised_at as string),
    seenCount: Number(row.seen_count ?? 1),
    fingerprint: (row.fingerprint as string | null) ?? '',
    signature: (row.signature as string | null) ?? null,
    resolvedAt,
    resolution,
    resolutionDetails,
    resolutionNote,
    rootCause,
    history,
    originTaskId: (row.origin_task_id as string | null) ?? null,
    liveTaskStatus: null,
  }
}

/**
 * Origin-keyed fingerprint: independent of kind/signature, so any
 * failure path that names the same origin upserts the same row.
 */
const computeOriginFingerprint = (originTaskId: string): string =>
  sha1Hex(`origin:${originTaskId}`)

/**
 * Arc-resolved origin fingerprint. Resolves `originId` to its arc root via
 * `resolveOriginIdForTask` before hashing, so sliced tasks (whose `origin_id`
 * differs from their own id) produce the SAME fingerprint as a direct lookup
 * on the arc root. Falls back to the raw id on any DB error.
 *
 * Use this everywhere an `originId` that may belong to a sliced task is
 * turned into a fingerprint for lookup or eviction. This is the single source
 * of truth for raise–lookup agreement.
 */
const resolvedOriginFingerprint = async (originId: string): Promise<string> =>
  computeOriginFingerprint(
    await resolveOriginIdForTask(originId).catch(() => originId),
  )

export const raiseActionQueueItem = async (
  item: RaiseActionQueueItem,
): Promise<string> => {
  await initActionQueue()
  const c = stateClient()

  // Resolve through the arc root so fix-tasks and follow-up slices fold onto
  // the same row as their origin.  Non-task origins (bare proposal ids,
  // synthetic 'followup:' keys) pass through unchanged when no task row
  // matches.  DB hiccups degrade to the raw id.
  const resolvedOriginId = item.originTaskId
    ? await resolveOriginIdForTask(item.originTaskId).catch(() => item.originTaskId!)
    : null

  const fingerprint = resolvedOriginId
    ? computeOriginFingerprint(resolvedOriginId)
    : computeFingerprint(item.kind, item.signature)
  const now = new Date().toISOString()

  const existing = await c.execute({
    sql: `SELECT id, payload FROM action_queue_items
           WHERE fingerprint = ? AND state = 'open'
           ORDER BY raised_at ASC
           LIMIT 1`,
    args: [fingerprint],
  })

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as unknown as {
      id: string
      payload: string | null
    }
    const payload = parseJsonObject(row.payload)
    if (item.occurrence) {
      const prior = Array.isArray(payload.occurrences)
        ? (payload.occurrences as unknown[])
        : []
      payload.occurrences = [...prior, item.occurrence]
    }
    await c.execute({
      sql: `UPDATE action_queue_items
               SET seen_count = seen_count + 1,
                   last_seen_at = ?,
                   payload = ?
             WHERE id = ?`,
      args: [now, JSON.stringify(payload), row.id],
    })
    return row.id
  }

  const id = generateActionQueueId()
  const payload: Record<string, unknown> = { ...item.payload }
  if (item.occurrence) {
    const prior = Array.isArray(payload.occurrences)
      ? (payload.occurrences as unknown[])
      : []
    payload.occurrences = [...prior, item.occurrence]
  }
  await c.execute({
    sql: `INSERT INTO action_queue_items (
             id, kind, category, priority, state, title, body,
             payload, context, raised_by, raised_at, last_seen_at,
             seen_count, fingerprint, signature, origin_task_id
           ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [
      id,
      item.kind,
      item.category,
      item.priority,
      item.title,
      item.body,
      JSON.stringify(payload),
      JSON.stringify(item.context ?? {}),
      item.raisedBy,
      now,
      now,
      fingerprint,
      item.signature,
      resolvedOriginId ?? null,
    ],
  })
  await insertHistory(c, id, null, 'open', item.raisedBy, null)
  await emitActionQueueBusEvent('action-queue.raised', {
    itemId: id,
    kind: item.kind,
    category: item.category,
    priority: item.priority,
    signature: item.signature,
  })
  return id
}

/**
 * Overwrite the "suggested next action" body on the existing open actionQueue
 * item keyed by `originTaskId`. Used when a recovery agent produces
 * task-specific findings that are more actionable than the generic
 * kind-template. NEVER inserts a new row — if no open row exists for
 * the origin, returns `null` and the generic template stays untouched
 * elsewhere. Re-calling overwrites the body in place on the same row,
 * so the row id remains stable across recovery iterations.
 */
export const setRecoveryFindings = async (
  originTaskId: string,
  findings: string,
): Promise<string | null> => {
  await initActionQueue()
  const c = stateClient()
  const fingerprint = await resolvedOriginFingerprint(originTaskId)
  const existing = await c.execute({
    sql: `SELECT id FROM action_queue_items
           WHERE fingerprint = ? AND state = 'open'
           ORDER BY raised_at ASC
           LIMIT 1`,
    args: [fingerprint],
  })
  if (existing.rows.length === 0) return null
  const id = (existing.rows[0] as unknown as { id: string }).id
  await c.execute({
    sql: `UPDATE action_queue_items SET body = ? WHERE id = ?`,
    args: [findings, id],
  })
  return id
}

/**
 * Merge `patch` into the payload JSON of the open actionQueue item keyed by
 * `originTaskId`. Existing payload fields not present in `patch` are
 * preserved. No-op (returns `null`) if no open item exists for that origin —
 * the caller must raise the item first via `raiseActionQueueItem`. Returns the item
 * id when the patch was applied.
 */
export const patchOpenActionQueuePayload = async (
  originTaskId: string,
  patch: Record<string, unknown>,
): Promise<string | null> => {
  await initActionQueue()
  const c = stateClient()
  const fingerprint = await resolvedOriginFingerprint(originTaskId)
  const existing = await c.execute({
    sql: `SELECT id, payload FROM action_queue_items
           WHERE fingerprint = ? AND state = 'open'
           ORDER BY raised_at ASC
           LIMIT 1`,
    args: [fingerprint],
  })
  if (existing.rows.length === 0) return null
  const row = existing.rows[0] as unknown as { id: string; payload: string | null }
  const merged = { ...parseJsonObject(row.payload), ...patch }
  await c.execute({
    sql: `UPDATE action_queue_items SET payload = ? WHERE id = ?`,
    args: [JSON.stringify(merged), row.id],
  })
  return row.id
}

/**
 * Merge `patch` into the payload JSON of the actionQueue item with the given
 * id, whatever its keying scheme. Unlike {@link patchOpenActionQueuePayload}
 * (origin-fingerprint lookup) this addresses the row directly, so
 * signature-keyed rows (e.g. the spend meter's 'budget-window' /
 * 'budget-arc:<arcId>' rows) can keep their payload fresh on re-detection —
 * `raiseActionQueueItem` only bumps seen_count on an existing row and leaves
 * the stale payload in place. No-op (returns false) when the id is unknown.
 */
export const patchActionQueuePayloadById = async (
  id: string,
  patch: Record<string, unknown>,
): Promise<boolean> => {
  await initActionQueue()
  const c = stateClient()
  const existing = await c.execute({
    sql: `SELECT payload FROM action_queue_items WHERE id = ?`,
    args: [id],
  })
  if (existing.rows.length === 0) return false
  const row = existing.rows[0] as unknown as { payload: string | null }
  const merged = { ...parseJsonObject(row.payload), ...patch }
  await c.execute({
    sql: `UPDATE action_queue_items SET payload = ? WHERE id = ?`,
    args: [JSON.stringify(merged), id],
  })
  return true
}

/**
 * Default live-task lookup: dynamically imports `getTask` from the queue
 * module and returns `{ status }` for the task. Returns `null` when the task
 * is not found or when the queue DB is unavailable (non-fatal degradation).
 */
const defaultLiveTaskLookup: LiveTaskLookup = async (taskId) => {
  try {
    const { getTask } = await import('../queue')
    const task = await getTask(taskId)
    if (!task) return null
    return { status: task.status }
  } catch {
    return null
  }
}

const enrichWithLiveStatus = async (
  item: ActionQueueItem,
  liveTaskLookup: LiveTaskLookup,
): Promise<ActionQueueItem> => {
  if (item.originTaskId === null) return item
  const result = await liveTaskLookup(item.originTaskId)
  return { ...item, liveTaskStatus: result?.status ?? null }
}

const fetchById = async (
  c: Client,
  id: string,
): Promise<ActionQueueItem | null> => {
  const r = await c.execute({
    sql: `SELECT * FROM action_queue_items WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as Record<string, unknown>
  const history = await loadHistory(c, row.id as string)
  return rowToActionQueueItem(row, history)
}

export const getActionQueueItem = async (
  idOrPrefix: string,
  liveTaskLookup: LiveTaskLookup = defaultLiveTaskLookup,
): Promise<ActionQueueItem | null> => {
  await initActionQueue()
  const c = stateClient()
  const exact = await fetchById(c, idOrPrefix)
  if (exact) return enrichWithLiveStatus(exact, liveTaskLookup)
  if (idOrPrefix.length < 4) return null
  const prefixMatch = await c.execute({
    sql: `SELECT * FROM action_queue_items WHERE id LIKE ? || '%' LIMIT 2`,
    args: [idOrPrefix],
  })
  if (prefixMatch.rows.length !== 1) return null
  const row = prefixMatch.rows[0] as unknown as Record<string, unknown>
  const history = await loadHistory(c, row.id as string)
  return enrichWithLiveStatus(rowToActionQueueItem(row, history), liveTaskLookup)
}

export interface ListActionQueueOptions {
  /** Filter by item kind (exact match). */
  kind?: ActionQueueKind
}

export const listActionQueueItems = async (
  state: ActionQueueState | 'all' = 'open',
  opts: ListActionQueueOptions = {},
): Promise<ActionQueueItem[]> => {
  await initActionQueue()
  const c = stateClient()

  const fetchByState = async (s: ActionQueueState | 'all'): Promise<ActionQueueItem[]> => {
    const wheres: string[] = []
    const args: Array<string> = []
    if (s !== 'all') {
      wheres.push('state = ?')
      args.push(s)
    }
    if (opts.kind !== undefined) {
      wheres.push('kind = ?')
      args.push(opts.kind)
    }
    const sql = `SELECT * FROM action_queue_items${
      wheres.length > 0 ? ` WHERE ${wheres.join(' AND ')}` : ''
    } ORDER BY raised_at DESC`
    const r = args.length === 0 ? await c.execute(sql) : await c.execute({ sql, args })
    const items: ActionQueueItem[] = []
    for (const row of r.rows) {
      const r2 = row as unknown as Record<string, unknown>
      const history = await loadHistory(c, r2.id as string)
      items.push(rowToActionQueueItem(r2, history))
    }
    return items
  }

  return fetchByState(state)
}

const isTerminal = (state: ActionQueueState): boolean =>
  state === 'resolved'

export const setActionQueueState = async (
  idOrPrefix: string,
  state: ActionQueueState,
  opts?: SetActionQueueStateOptions,
): Promise<void> => {
  await initActionQueue()
  const c = stateClient()

  let resolvedId: string | null = null
  const exact = await c.execute({
    sql: `SELECT id FROM action_queue_items WHERE id = ?`,
    args: [idOrPrefix],
  })
  if (exact.rows.length === 1) {
    resolvedId = (exact.rows[0] as unknown as { id: string }).id
  } else if (idOrPrefix.length >= 4) {
    const pref = await c.execute({
      sql: `SELECT id FROM action_queue_items WHERE id LIKE ? || '%' LIMIT 2`,
      args: [idOrPrefix],
    })
    if (pref.rows.length === 1) {
      resolvedId = (pref.rows[0] as unknown as { id: string }).id
    }
  }
  if (!resolvedId) return

  const cur = await c.execute({
    sql: `SELECT state FROM action_queue_items WHERE id = ?`,
    args: [resolvedId],
  })
  const currentState = (
    cur.rows[0] as unknown as { state: ActionQueueState }
  ).state
  const now = new Date().toISOString()

  const sets: string[] = ['state = ?']
  const args: Array<string | null> = [state]

  if (isTerminal(state)) {
    sets.push('resolved_at = ?')
    args.push(now)
    if (opts?.by !== undefined) {
      sets.push('resolved_by = ?')
      args.push(opts.by)
    }
  } else if (currentState !== state) {
    sets.push('resolved_at = ?')
    args.push(null)
    sets.push('resolved_by = ?')
    args.push(null)
  }

  if (opts?.resolution !== undefined) {
    sets.push('resolution = ?')
    args.push(opts.resolution)
  } else if (isTerminal(state)) {
    const cur2 = await c.execute({
      sql: `SELECT resolution FROM action_queue_items WHERE id = ?`,
      args: [resolvedId],
    })
    const existingResolution = (
      cur2.rows[0] as unknown as { resolution: string | null }
    ).resolution
    if (!existingResolution) {
      sets.push('resolution = ?')
      args.push(state)
    }
  }
  if (opts?.note !== undefined) {
    sets.push('resolution_note = ?')
    args.push(opts.note)
  }
  if (opts?.rootCause !== undefined) {
    sets.push('root_cause = ?')
    args.push(opts.rootCause)
  }

  args.push(resolvedId)
  await c.execute({
    sql: `UPDATE action_queue_items SET ${sets.join(', ')} WHERE id = ?`,
    args,
  })

  await insertHistory(
    c,
    resolvedId,
    currentState,
    state,
    opts?.by ?? null,
    opts?.note ?? null,
  )

  if (isTerminal(state)) {
    await emitActionQueueBusEvent('action-queue.resolved', {
      itemId: resolvedId,
      fromState: currentState,
      toState: state,
      by: opts?.by ?? '',
    })
  }
}

/**
 * Reason an actionQueue item was auto-closed because its origin task reached a
 * terminal state (or any status transition). Surfaced in the resolution note
 * so an operator reading actionQueue history can tell why the row vanished.
 */
export type SupersedeReason =
  | 'origin-done'
  | 'origin-dropped'
  | 'origin-purged'
  | 'status-changed'
  | 'subscriber-unstalled'
  /** hitl-slice-needs-operator item has no matching HITL slice task in any state. */
  | 'hitl-orphan-no-slice-task'
  /** daemon-code-drift row cleared because the daemon restarted and is now running current code. */
  | 'daemon-restarted'
  /** workflow-draft-pending row cleared because the operator approved the draft. */
  | 'workflow-approved'
  /** gate-enrichment row cleared because the operator approved or retired the candidate (ADR-0048 entity mutation). */
  | 'enrichment-decided'

/**
 * Auto-close every open actionQueue item keyed to the given origin task. Called
 * by the daemon when an origin task reaches done / dropped / purged so
 * the operator does not need to ack or dismiss a row whose underlying
 * stuck task is no longer stuck. Returns the ids of the rows that were
 * superseded (possibly empty — no-op when nothing matches).
 *
 * Idempotent: rerunning against an origin whose rows are already closed
 * is a silent no-op.
 */
export const supersedeActionQueueItemsForOrigin = async (
  originTaskId: string,
  reason: SupersedeReason,
  by = 'daemon:auto-supersede',
): Promise<string[]> => {
  await initActionQueue()
  const c = stateClient()
  // Arc-resolve so sliced tasks (origin_id ≠ own id) produce the same
  // fingerprint as the row that was stored at raise time.
  const resolvedOriginId = await resolveOriginIdForTask(originTaskId).catch(() => originTaskId)
  const fingerprint = computeOriginFingerprint(resolvedOriginId)
  // Belt-and-suspenders: also match by origin_task_id (both the resolved arc
  // root and the raw task id) so rows are closeable even if a fingerprint
  // mismatch was baked in by a prior version of the raise path.
  const rows = await c.execute({
    sql: `SELECT id FROM action_queue_items
           WHERE state = 'open'
             AND (fingerprint = ? OR origin_task_id = ? OR origin_task_id = ?)`,
    args: [fingerprint, resolvedOriginId, originTaskId],
  })
  const ids: string[] = []
  for (const row of rows.rows) {
    const id = (row as unknown as { id: string }).id
    await setActionQueueState(id, 'resolved', {
      resolution: 'superseded',
      note: `superseded: ${reason}`,
      by,
    })
    ids.push(id)
  }
  return ids
}

/**
 * Close every open actionQueue row matching a (kind, signature) pair. Used by the
 * Subscriber stall machinery (ADR-0032): when a previously-blocked event
 * finally processes, the `subscriber-stalled` row keyed on
 * `${subscriberId}:${eventId}` is superseded. Idempotent — no open match is
 * a silent no-op.
 */
export const supersedeActionQueueItemsBySignature = async (
  kind: ActionQueueKind,
  signature: string,
  reason: SupersedeReason,
  by = 'daemon:auto-supersede',
): Promise<string[]> => {
  await initActionQueue()
  const c = stateClient()
  const rows = await c.execute({
    sql: `SELECT id FROM action_queue_items WHERE kind = ? AND signature = ? AND state = 'open'`,
    args: [kind, signature],
  })
  const ids: string[] = []
  for (const row of rows.rows) {
    const id = (row as unknown as { id: string }).id
    await setActionQueueState(id, 'resolved', {
      resolution: 'superseded',
      note: `superseded: ${reason}`,
      by,
    })
    ids.push(id)
  }
  return ids
}

/**
 * One-time reconciliation pass: closes every open actionQueue item whose origin
 * task is already in a successful terminal state (done or dropped). Items
 * about tasks in `failed` or any live state are NOT included in the input,
 * so they remain open after the call.
 *
 * Idempotent — re-running when items are already closed is a silent no-op
 * because `supersedeActionQueueItemsForOrigin` only touches open rows.
 *
 * @param terminatedTasks  Tasks that have reached done or dropped. The
 *   caller is responsible for fetching these from the task queue.
 * @returns The number of actionQueue items closed by this pass.
 */
export const reconcileStaleActionQueueItems = async (
  terminatedTasks: ReadonlyArray<{ id: string; status: 'done' | 'dropped' }>,
): Promise<{ closed: number }> => {
  let closed = 0
  for (const task of terminatedTasks) {
    const reason: SupersedeReason =
      task.status === 'done' ? 'origin-done' : 'origin-dropped'
    const ids = await supersedeActionQueueItemsForOrigin(
      task.id,
      reason,
      'reconcile:one-time',
    )
    closed += ids.length
  }
  return { closed }
}

/**
 * Slice K one-shot cleanup: supersede every open actionQueue row whose payload or
 * body still references the retired `setup:preflight/dirty-main` failure
 * mode. F.2's `verify:main-dirty` + `main-commiter` path replaced that code
 * path entirely; rows from a pre-F.2 daemon describe a system that no longer
 * exists and can never reach a true resolution from the operator side.
 *
 * Each matching row is closed via `setActionQueueState` with
 * `resolution: 'superseded'`, `note: 'superseded by slice K: preflight code
 * path retired'`, and a matching `action_queue_history` entry. The supersede goes
 * through the standard lifecycle (NOT a raw DELETE) so the trail is visible
 * to anyone reading `action_queue_history`.
 *
 * Idempotent — rerunning matches no open rows (closed rows are excluded by
 * the WHERE clause) and produces no further writes.
 *
 * @returns The ids of the rows that were superseded.
 */
export const supersedeObsoletePreflightDirtyMainRows = async (
  by = 'daemon:slice-k-cleanup',
): Promise<string[]> => {
  await initActionQueue()
  const c = stateClient()
  // The legacy strings can appear in any of three places:
  //  - `payload` (JSON blob) → matches the failure-signature or wrapped
  //    `recovery_exhausted:setup:preflight/...` form;
  //  - `body` (rendered markdown) → matches the actionQueue row's own description
  //    of the failure mode.
  // SQL LIKE substring match is enough here because the legacy strings are
  // distinctive enough not to collide with live wording.
  const rows = await c.execute({
    sql: `SELECT id FROM action_queue_items
           WHERE state = 'open'
             AND (
               payload LIKE '%setup:preflight/dirty-main%'
               OR payload LIKE '%recovery_exhausted:setup:preflight%'
               OR payload LIKE '%retry_budget_exhausted:setup:preflight%'
               OR body LIKE '%setup:preflight/dirty-main%'
             )`,
    args: [],
  })
  const ids: string[] = []
  for (const row of rows.rows) {
    const id = (row as unknown as { id: string }).id
    await setActionQueueState(id, 'resolved', {
      resolution: 'superseded',
      note: 'superseded by slice K: preflight code path retired',
      by,
    })
    ids.push(id)
  }
  return ids
}

/**
 * Boot-time orphan sweep: supersede every open `hitl-slice-needs-operator`
 * actionQueue item whose signature has NO matching HITL slice task in any
 * state. A HITL item is considered orphaned when the slicer raised the
 * actionQueue row but never persisted a task with `slice_kind='hitl'` for
 * that `origin_id` + `slice_index` combination.
 *
 * Guard: an item is only swept when it is genuinely orphaned (no matching
 * HITL task in ANY state). An item backed by a blocked or running HITL task
 * is left open.
 *
 * Idempotent — rerunning matches no open rows (closed rows are excluded by
 * the WHERE clause) and produces no further writes.
 *
 * @returns The ids of the rows that were superseded.
 */
export const supersedeOrphanedHitlActionQueueRows = async (
  by = 'daemon:hitl-orphan-sweep',
): Promise<string[]> => {
  await initActionQueue()
  const c = stateClient()
  // Fetch all open hitl-slice-needs-operator rows. Both action_queue_items
  // and tasks live in the same mars.db file (ADR-0034), so we can JOIN them.
  const openRows = await c.execute({
    sql: `SELECT id, signature FROM action_queue_items
           WHERE kind = 'hitl-slice-needs-operator' AND state = 'open'`,
    args: [],
  })
  const ids: string[] = []
  for (const row of openRows.rows) {
    const id = (row as unknown as { id: string; signature: string | null }).id
    const sig = (row as unknown as { id: string; signature: string | null }).signature
    if (!sig) continue
    // Signature format: <originId>:hitl:<sliceIndex>
    const match = sig.match(/^(.+):hitl:(\d+)$/)
    if (!match) continue
    const originId = match[1]!
    const sliceIndex = parseInt(match[2]!, 10)
    // Check whether any task with slice_kind='hitl' exists for this origin+index.
    const taskCheck = await c.execute({
      sql: `SELECT 1 FROM tasks
             WHERE origin_id = ? AND slice_index = ? AND slice_kind = 'hitl'
             LIMIT 1`,
      args: [originId, sliceIndex],
    })
    if (taskCheck.rows.length > 0) {
      // A backing HITL task exists in some state — leave the item open.
      continue
    }
    await setActionQueueState(id, 'resolved', {
      resolution: 'superseded',
      note: 'superseded: hitl-orphan-no-slice-task',
      by,
    })
    ids.push(id)
  }
  return ids
}

/**
 * Auto-clear all open actionQueue alerts for a task and remove its
 * stale-worktree dismissal row whenever the task's status changes.
 * Called by `updateTask` in queue.ts on every real status transition.
 *
 * Each closed actionQueue item gets `resolution_note` = `"status-changed → <newStatus>"`
 * and a matching `action_queue_history` row so operators can see which transition
 * triggered the dismissal.
 *
 * @param taskId    The task whose alerts should be cleared.
 * @param newStatus The status the task just transitioned to. Recorded in
 *                  `action_queue_history.note` and `action_queue_items.resolution_note`.
 * @returns         The ids of the actionQueue items that were closed.
 */
export const dismissAlertsOnStatusChange = async (
  taskId: string,
  newStatus: string,
): Promise<string[]> => {
  await initActionQueue()
  const c = stateClient()
  const fingerprint = await resolvedOriginFingerprint(taskId)
  // Two predicates cover both row shapes for this task:
  //   - fingerprint = origin-keyed hash — the normal path for rows that were
  //     raised with originTaskId (the vast majority of current rows).
  //   - kind IN ('failed','diagnose-inconclusive') AND signature = taskId
  //     AND origin_task_id IS NULL — signature-keyed rows created by pre-fix
  //     raise sites. Those sites used the task id directly as the signature
  //     value, so this predicate is safe and specific to task-owned rows.
  const rows = await c.execute({
    sql: `SELECT id FROM action_queue_items
           WHERE (fingerprint = ?
                  OR (kind IN ('failed', 'diagnose-inconclusive')
                      AND signature = ?
                      AND origin_task_id IS NULL))
             AND state = 'open'`,
    args: [fingerprint, taskId],
  })
  const ids: string[] = []
  const note = `status-changed → ${newStatus}`
  for (const row of rows.rows) {
    const id = (row as unknown as { id: string }).id
    await setActionQueueState(id, 'resolved', {
      resolution: 'superseded',
      note,
      by: `daemon:status-changed:${newStatus}`,
    })
    ids.push(id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Resolved-row paged reader
// ---------------------------------------------------------------------------

/**
 * A page of resolved action-queue items, ordered newest-first by `resolved_at`.
 * `nextCursor` is non-null only when more rows exist past the current page.
 */
export interface ResolvedActionQueuePage {
  items: ActionQueueItem[]
  nextCursor: string | null
}

/** Encode a (resolvedAt, id) pair into an opaque cursor token. */
const encodeHistoryCursor = (resolvedAt: string, id: string): string =>
  Buffer.from(JSON.stringify({ resolvedAt, id }), 'utf8').toString('base64url')

/** Decode a cursor token; returns null for malformed input. */
const decodeHistoryCursor = (
  cursor: string,
): { resolvedAt: string; id: string } | null => {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'resolvedAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).resolvedAt === 'string' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      return parsed as { resolvedAt: string; id: string }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Return a cursor-paged slice of resolved action-queue items, newest-first
 * by `resolved_at`. Rows with a null `resolved_at` are excluded (legacy
 * rows closed before the column was populated).
 *
 * Pass the returned `nextCursor` as `cursor` on the next call to page
 * forward. `nextCursor` is null when the last page has been reached.
 *
 * The cursor is a base64url-encoded (resolvedAt, id) pair — the same
 * shape used by the trace-events store — so it survives new writes
 * between pages without skipping or duplicating rows.
 */
export const listResolvedActionQueueItems = async ({
  limit = 50,
  cursor,
}: {
  limit?: number
  cursor?: string | null
} = {}): Promise<ResolvedActionQueuePage> => {
  await initActionQueue()
  const c = stateClient()

  const conditions: string[] = ["state = 'resolved'", 'resolved_at IS NOT NULL']
  const args: Array<string | number> = []

  if (cursor) {
    const decoded = decodeHistoryCursor(cursor)
    if (decoded) {
      conditions.push('(resolved_at < ? OR (resolved_at = ? AND id < ?))')
      args.push(decoded.resolvedAt, decoded.resolvedAt, decoded.id)
    }
  }

  const sql = `SELECT * FROM action_queue_items WHERE ${conditions.join(' AND ')} ORDER BY resolved_at DESC, id DESC LIMIT ?`
  args.push(limit + 1)

  const r = await c.execute({ sql, args })
  const rows = r.rows as unknown as Record<string, unknown>[]

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows

  const items: ActionQueueItem[] = []
  for (const row of pageRows) {
    const history = await loadHistory(c, row.id as string)
    items.push(rowToActionQueueItem(row, history))
  }

  const lastRow = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && lastRow
      ? encodeHistoryCursor(
          lastRow.resolved_at as string,
          lastRow.id as string,
        )
      : null

  return { items, nextCursor }
}

/**
 * Resolve every open Action-queue row whose task id matches `taskId`,
 * regardless of kind. Used by the Invalidator on `task.completed` and
 * `task.dropped` to ensure no orphaned row survives after a task ends
 * cleanly (ADR-0028/0030).
 *
 * Three predicates cover the known row shapes:
 *   - `origin_task_id = :taskId` — the normal path (task is its own arc root)
 *   - `json_extract(payload, '$.taskId') = :taskId` — the arc-resolved path
 *     (where `origin_task_id` holds the proposal/origin id while the actual
 *     task id is stored in `payload.taskId`)
 *   - `kind IN ('failed','diagnose-inconclusive') AND signature = :taskId
 *      AND origin_task_id IS NULL` — signature-keyed rows created by pre-fix
 *     raise sites that did not pass `originTaskId`. Those raise sites used the
 *     task id directly as the `signature` value, so matching on it is safe and
 *     specific. Without this arm such rows never matched either of the first two
 *     predicates and stayed open forever even after their task reached done.
 *
 * Idempotent — rows that are already resolved/dismissed are untouched.
 */
export const resolveAllRowsForTask = async (
  taskId: string,
): Promise<void> => {
  await initActionQueue()
  const c = stateClient()
  await c.execute({
    sql: `UPDATE action_queue_items
             SET state = 'resolved',
                 resolved_at = ?
           WHERE (origin_task_id = ?
                  OR json_extract(payload, '$.taskId') = ?
                  OR (kind IN ('failed', 'diagnose-inconclusive')
                      AND signature = ?
                      AND origin_task_id IS NULL))
             AND state = 'open'`,
    args: [new Date().toISOString(), taskId, taskId, taskId],
  })
}
