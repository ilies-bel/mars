import type { DbClient } from './db.js'
import { createHash, randomUUID } from 'node:crypto'
import { resolveStateClient } from '../store/state-client'
import { buildEventInsert } from './outbox'
import type { EventName, EventPayload } from './outbox'
import { resolveOriginIdForTask } from './origin'
import { derivedRowActions } from './derived-row-actions'
import { lookupRecipe, getRecipeVerbs } from './action-queue-recipes'
import { classifyMarsVerb } from './chat-mars-verbs'
import { isActionQueueKind, type ActionQueueKind } from './action-queue-kinds'

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initActionQueue = async (): Promise<void> => {
  const { ensureSchema } = await import('./pg-schema.js')
  await ensureSchema(resolveStateClient())
}

/**
 * Emit an actionQueue lifecycle event to the events outbox.
 *
 * Both action_queue_items and the events outbox live in the same Mars
 * database (consolidated per ADR-0034). This emits in a separate write
 * transaction after the action-queue write has committed. Emission failures
 * are non-fatal: the actionQueue operation succeeds regardless.
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
    // Non-fatal: actionQueue state change already committed.
  }
}

export type ActionQueueCategory = 'orchestrator' | 'reflector' | 'daemon' | 'user'
export type ActionQueuePriority = 'urgent' | 'high' | 'normal' | 'low'
export type ActionQueueState = 'open' | 'resolved'


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
  resolvedAt: number
}

export interface ActionQueueHistoryEntry {
  at: number
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
  raisedAt: number
  lastSeenAt: number
  seenCount: number
  fingerprint: string
  signature: string | null
  resolvedAt: number | null
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
  /**
   * Epoch-millisecond timestamp until which this item is snoozed. While snoozed,
   * the item is excluded from the open view and chat. `null` means not
   * snoozed. Once the timestamp is in the past the item reappears.
   */
  snoozedUntil: number | null
}

export interface SetActionQueueStateOptions {
  resolution?: string
  note?: string
  rootCause?: string
  by?: string
}

// Shared state-domain client (collapsed from the former private singleton);
// same database as the TaskStore (ADR-0034), resolved through the seam.
// Schema ownership: `action_queue_items` / `action_queue_history` are created
// by `ensureSchema` in core/lib/pg-schema.ts (migration 0002) — the SQLite-era
// init/ALTER/data-fix machinery is gone; the one-time importer carries legacy
// rows across.
const stateClient = resolveStateClient

const sha1Hex = (input: string): string =>
  createHash('sha1').update(input).digest('hex')

const computeFingerprint = (kind: string, signature: string): string =>
  sha1Hex(`${kind}:${signature}`)

const generateActionQueueId = (): string => randomUUID().slice(0, 8)

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
  c: DbClient,
  itemId: string,
): Promise<ActionQueueHistoryEntry[]> => {
  const r = await c.execute({
    sql: `SELECT at, from_state, to_state, "by", note
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
      at: Number(r2.at ?? 0),
      fromState,
      toState: toState(r2.to_state),
      by: (r2.by as string | null) ?? null,
      note: (r2.note as string | null) ?? null,
    }
  })
}

const insertHistory = async (
  c: DbClient,
  itemId: string,
  fromState: ActionQueueState | null,
  toStateValue: ActionQueueState,
  by: string | null,
  note: string | null,
): Promise<void> => {
  await c.execute({
    sql: `INSERT INTO action_queue_history (id, item_id, at, from_state, to_state, "by", note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      itemId,
      Date.now(),
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
  const resolvedAt = row.resolved_at == null ? null : Number(row.resolved_at)
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
          resolvedAt: resolvedAt ?? 0,
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
    raisedAt: Number(row.raised_at),
    lastSeenAt: Number(row.last_seen_at ?? row.raised_at),
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
    snoozedUntil: row.snoozed_until == null ? null : Number(row.snoozed_until),
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

// ── Alert-thread helpers ──────────────────────────────────────────────────────

/** Map an action op to its button style on the alert card. */
const alertActionStyle = (op: string): 'primary' | 'destructive' | 'default' => {
  const classification = classifyMarsVerb(op)
  if (classification === 'safe') return 'primary'
  if (classification === 'destructive') return 'destructive'
  return 'default'
}

/** Derive the entity-id from an action-queue raise item (mirrors extractEntityId in view/action-queue.ts). */
const deriveEntityId = (item: RaiseActionQueueItem, fallbackId: string): string => {
  if (item.originTaskId) return item.originTaskId
  if (typeof item.payload.taskId === 'string') return item.payload.taskId
  if (typeof item.payload.proposalId === 'string') return item.payload.proposalId
  if (typeof item.payload.scorerId === 'string') return item.payload.scorerId
  if (typeof item.payload.workflowName === 'string') return item.payload.workflowName
  if (item.signature) return item.signature
  return fallbackId
}

/** Map ActionQueueKind to the errorKind string used by derivedRowActions. */
const toErrorKind = (kind: string): string => (kind === 'failed' ? 'failed-task' : kind)

/**
 * Build the alert segment for a newly-raised action-queue item.
 * For registered kinds the action buttons come from the recipe registry so
 * that each kind expresses its own verbs (e.g. daemon-died → restart-daemon).
 * For unregistered kinds (legacy / unknown) the non-failure derivedRowActions
 * registry is tried first, falling back to a generic restart/dismiss pair.
 */
export const buildAlertSegment = (
  item: RaiseActionQueueItem,
  itemId: string,
): import('./chat-store').AlertSegment => {
  const entityId = deriveEntityId(item, itemId)
  const priority = item.priority === 'urgent' || item.priority === 'high' ? 'high' : item.priority

  let actions: import('./chat-store').AlertSegmentAction[]
  let humanSummary: string | undefined

  if (isActionQueueKind(item.kind)) {
    // Registered kind: derive both humanSummary and actions from the recipe.
    // RecipeVerb.style uses 'danger' where AlertSegmentAction uses 'destructive'.
    const recipe = lookupRecipe(item.kind)
    const ctx = {
      kind: item.kind,
      entityId,
      payload: item.payload,
      context: item.context ?? {},
      title: item.title,
      body: item.body,
      raisedAt: new Date().toISOString(),
    }
    humanSummary = recipe.humanSummary(ctx)
    actions = getRecipeVerbs(recipe, ctx).map((v) => ({
      op: v.op,
      label: v.label,
      style: (v.style === 'danger' ? 'destructive' : v.style) as 'primary' | 'destructive' | 'default',
    }))
  } else {
    // Unregistered kind: fall back to derivedRowActions or generic restart/dismiss.
    const errorKind = toErrorKind(item.kind)
    const rawActions = derivedRowActions(errorKind, entityId)
    actions =
      rawActions.length > 0
        ? rawActions.map((a) => ({
            op: a.op,
            label: a.label,
            style: alertActionStyle(a.op),
          }))
        : [
            { op: 'restart', label: 'Restart', style: 'primary' as const },
            { op: 'dismiss', label: 'Dismiss', style: 'default' as const },
          ]
  }

  // Derive goal from the payload for items that carry it (e.g. arc-failed items
  // store the origin task's intent in payload.goal). Undefined for all other kinds.
  const goal = typeof item.payload.goal === 'string' ? item.payload.goal : undefined

  return {
    type: 'alert',
    kind: item.kind,
    entityId,
    priority,
    title: item.title,
    whyNow: item.body,
    actions,
    resolved: false,
    humanSummary,
    goal,
  }
}

export const raiseActionQueueItem = async (
  item: RaiseActionQueueItem,
): Promise<string> => {
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
  const now = Date.now()

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
 * Keep an awaiting-validation decision visible after its preview has died,
 * without leaving a high-priority "ready" row in front of live alerts.
 */
export const demoteAwaitingValidationAction = async (
  taskId: string,
  previewUrl: string | null,
  detectedAtMs: number,
): Promise<string | null> => {
  const c = stateClient()
  const fingerprint = await resolvedOriginFingerprint(taskId)
  const existing = await c.execute({
    sql: `SELECT id, kind, payload FROM action_queue_items
           WHERE fingerprint = ?
             AND state = 'open'
             AND kind IN ('awaiting-validation', 'awaiting-validation-preview-gone')
           ORDER BY raised_at ASC
           LIMIT 1`,
    args: [fingerprint],
  })
  if (existing.rows.length === 0) return null
  const row = existing.rows[0] as unknown as {
    id: string
    kind: ActionQueueKind
    payload: string | null
  }
  // The first sweep turns the high-priority "ready" action into the normal
  // priority "preview gone" action. Later sweeps must not make the same
  // condition look newly detected, nor churn its timestamp.
  if (row.kind === 'awaiting-validation-preview-gone') return null
  const payload = {
    ...parseJsonObject(row.payload),
    previewUnavailableAt: new Date(detectedAtMs).toISOString(),
    ...(previewUrl === null ? {} : { devServerUrl: previewUrl }),
  }
  await c.execute({
    sql: `UPDATE action_queue_items
             SET kind = ?, priority = ?, title = ?, body = ?, payload = ?, last_seen_at = ?
           WHERE id = ?`,
    args: [
      'awaiting-validation-preview-gone',
      'normal',
      `Preview unavailable for ${taskId}`,
      previewUrl === null
        ? 'The preview URL is missing or no longer available. Decide whether to validate from prior evidence or reject the task.'
        : `The preview at ${previewUrl} is unreachable. Decide whether to validate from prior evidence or reject the task.`,
      JSON.stringify(payload),
      detectedAtMs,
      row.id,
    ],
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
 * Resolve the id of the single OPEN row for a (kind, signature) pair, or null
 * when none is open. Signature-keyed rows are level-triggered singletons — a
 * repeat raise bumps `seen_count` on the same row — so callers that need to
 * annotate or close "the row I raised earlier" must address it BY ID rather
 * than raising again, which would only bump the counter and leave the payload
 * stale. Used by the signature-storm handler to patch and resolve its own row.
 */
export const findOpenActionQueueItemIdBySignature = async (
  kind: ActionQueueKind,
  signature: string,
): Promise<string | null> => {
  const c = stateClient()
  const r = await c.execute({
    sql: `SELECT id FROM action_queue_items
           WHERE kind = ? AND signature = ? AND state = 'open'
           ORDER BY raised_at ASC
           LIMIT 1`,
    args: [kind, signature],
  })
  if (r.rows.length === 0) return null
  return (r.rows[0] as unknown as { id: string }).id
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
  c: DbClient,
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

/**
 * Read the rows an operator can act on without loading resolution history.
 *
 * The action-queue view only needs the current projection, so joining each
 * row to `action_queue_history` would turn a small visible list into an N+1
 * scan over every historical item. History has its own paged reader.
 */
export const listVisibleActionQueueItems = async (): Promise<ActionQueueItem[]> => {
  const c = stateClient()
  const r = await c.execute(`SELECT * FROM action_queue_items
    WHERE state = 'open'
      AND (snoozed_until IS NULL OR snoozed_until <= ?)
    ORDER BY raised_at DESC`, [Date.now()])
  return r.rows.map((row) =>
    rowToActionQueueItem(row as unknown as Record<string, unknown>, []),
  )
}

const isTerminal = (state: ActionQueueState): boolean =>
  state === 'resolved'

export const setActionQueueState = async (
  idOrPrefix: string,
  state: ActionQueueState,
  opts?: SetActionQueueStateOptions,
): Promise<void> => {
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
  const now = Date.now()

  const sets: string[] = ['state = ?']
  const args: Array<string | number | null> = [state]

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
  /** workflow-install-drift row cleared because every bundled Workflow is installed. */
  | 'workflow-install-restored'
  /** workflow-draft-pending row cleared because the operator approved the draft. */
  | 'workflow-approved'
  /** gate-enrichment row cleared because the operator approved or retired the candidate (ADR-0048 entity mutation). */
  | 'enrichment-decided'
  /** tool-promotion row cleared because the operator approved or rejected the helper (ADR-0048 entity mutation). */
  | 'tool-promotion-decided'
  /** awaiting-human row cleared because the operator signalled mars step done, advancing the task past the manual step. */
  | 'step-done'
  /** level-triggered condition that raised the row is no longer present. */
  | 'condition-cleared'

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
  const c = stateClient()
  // The legacy strings can appear in any of three places:
  //  - `payload` (JSON blob) → matches the failure-signature or wrapped
  //    `recovery_exhausted:setup:preflight/...` form;
  //  - `body` (rendered markdown) → matches the actionQueue row's own description
  //    of the failure mode.
  // ILIKE substring match (preserving SQLite LIKE's case-insensitivity) is
  // enough here because the legacy strings are distinctive enough not to
  // collide with live wording.
  const rows = await c.execute({
    sql: `SELECT id FROM action_queue_items
           WHERE state = 'open'
             AND (
               payload ILIKE '%setup:preflight/dirty-main%'
               OR payload ILIKE '%recovery_exhausted:setup:preflight%'
               OR payload ILIKE '%retry_budget_exhausted:setup:preflight%'
               OR body ILIKE '%setup:preflight/dirty-main%'
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
  const c = stateClient()
  // Fetch all open hitl-slice-needs-operator rows. Both action_queue_items
  // and tasks live in the same database (ADR-0034), so we can JOIN them.
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
const encodeHistoryCursor = (resolvedAt: number, id: string): string =>
  Buffer.from(JSON.stringify({ resolvedAt, id }), 'utf8').toString('base64url')

/** Decode a cursor token; returns null for malformed input. */
const decodeHistoryCursor = (
  cursor: string,
): { resolvedAt: number; id: string } | null => {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'resolvedAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).resolvedAt === 'number' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      return parsed as { resolvedAt: number; id: string }
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
          Number(lastRow.resolved_at),
          lastRow.id as string,
        )
      : null

  return { items, nextCursor }
}

/**
 * Snooze an action-queue item until `until` (ISO-8601 timestamp).
 *
 * While snoozed the row is excluded from the open view and chat segments.
 * Once `until` is in the past the row reappears automatically — there is no
 * wake-up mechanism; the filter in listActionQueueItems / app-services simply
 * includes the row again on the next poll.
 *
 * Presets (e.g. "1 hour", "tomorrow") are handled client-side — the API
 * accepts only an absolute ISO-8601 timestamp.
 *
 * No-op when the item does not exist (prefix-match fallback as per
 * `setActionQueueState`). Throws if `until` is not a valid ISO-8601 string.
 */
export const snoozeActionQueueItem = async (
  idOrPrefix: string,
  until: string,
): Promise<void> => {
  // Validate: must be a parse-able date that is in the future.
  const untilDate = new Date(until)
  if (isNaN(untilDate.getTime())) {
    throw new Error(`Invalid snooze timestamp: ${until}`)
  }
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

  await c.execute({
    sql: `UPDATE action_queue_items SET snoozed_until = ? WHERE id = ?`,
    args: [untilDate.getTime(), resolvedId],
  })
}

/**
 * Resolve every open Action-queue row whose task id matches `taskId`,
 * regardless of kind. Used by the Invalidator on `task.completed` and
 * `task.dropped` to ensure no orphaned row survives after a task ends
 * cleanly (ADR-0028/0030).
 *
 * Three predicates cover the known row shapes:
 *   - `origin_task_id = :taskId` — the normal path (task is its own arc root)
 *   - `payload::jsonb ->> 'taskId' = :taskId` — the arc-resolved path
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
  const c = stateClient()
  await c.execute({
    sql: `UPDATE action_queue_items
             SET state = 'resolved',
                 resolved_at = ?
           WHERE (origin_task_id = ?
                  OR payload::jsonb ->> 'taskId' = ?
                  OR (kind IN ('failed', 'diagnose-inconclusive')
                      AND signature = ?
                      AND origin_task_id IS NULL))
             AND state = 'open'`,
    args: [Date.now(), taskId, taskId, taskId],
  })
}
