import { type Client } from '@libsql/client'
import { createHash, randomUUID } from 'node:crypto'
import { resolveContext } from '../context'
import { openLibsql } from './libsql'
import { publishWithRetry } from './outbox'
import type { EventName, EventPayload } from './outbox'

/**
 * Emit an inbox lifecycle event to the queue.db events outbox.
 *
 * inbox_items live in state.db; the events outbox lives in queue.db.
 * Cross-DB atomicity is not available via libsql transactions, so this
 * emits in a separate write transaction on queue.db after the state.db
 * write has committed. Emission failures are non-fatal: the inbox
 * operation succeeds regardless.
 */
async function emitInboxBusEvent<T extends EventName>(
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  try {
    const { initQueue, getClient: getQueueClient } = await import('../queue')
    await initQueue()
    await publishWithRetry(getQueueClient(), type, payload)
  } catch {
    // Non-fatal: inbox state change already committed in state.db.
  }
}

export type InboxCategory = 'orchestrator' | 'reflector' | 'daemon' | 'user'
export type InboxPriority = 'urgent' | 'high' | 'normal' | 'low'
export type InboxState = 'open' | 'acknowledged' | 'resolved' | 'dismissed'

export const INBOX_KINDS = [
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
  // A durable Subscriber's handler has thrown on the same event K times in
  // a row; its cursor is blocked (ADR-0032). The operator surface for an
  // otherwise-silent stall — there is no DLQ.
  'subscriber-stalled',
] as const

export type InboxKind = (typeof INBOX_KINDS)[number]

export const isInboxKind = (s: unknown): s is InboxKind =>
  INBOX_KINDS.includes(s as InboxKind)

/**
 * Callback used by `getInboxItem` to fetch the current state of the origin
 * task at the moment the inbox item is opened. Returning `null` means the
 * task was not found (deleted or DB unavailable); `liveTaskStatus` will be
 * `null` in that case.
 *
 * The default implementation calls `getTask` from `../queue`. Pass your own
 * implementation in tests or any context where the queue DB is unavailable.
 */
export type LiveTaskLookup = (
  taskId: string,
) => Promise<{ status: string } | null>

export interface RaiseInboxItem {
  kind: InboxKind
  category: InboxCategory | string
  priority: InboxPriority
  title: string
  body: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  raisedBy: string
  signature: string
  occurrence?: Record<string, unknown>
  /**
   * When set, the inbox row is deduped on this origin task id alone —
   * kind- and signature-agnostic. Any failure on a recovery descendant
   * (or repeated failures on the origin) collapses into the SAME row.
   * Yields exactly one inbox_items row per stuck origin task regardless
   * of how many recovery attempts have failed against it.
   */
  originTaskId?: string
}

export interface InboxResolution {
  state: 'resolved' | 'dismissed'
  note: string | null
  rootCause: string | null
  resolvedBy: string | null
  resolvedAt: string
}

export interface InboxHistoryEntry {
  at: string
  fromState: InboxState | null
  toState: InboxState
  by: string | null
  note: string | null
}

export interface InboxItem {
  id: string
  kind: InboxKind
  category: string
  priority: InboxPriority
  state: InboxState
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
  resolutionDetails: InboxResolution | null
  resolutionNote: string | null
  rootCause: string | null
  history: InboxHistoryEntry[]
  /**
   * The task id this inbox item was raised for (origin-keyed items only).
   * Stored in the DB at raise time; `null` for signature-keyed items.
   */
  originTaskId: string | null
  /**
   * Live status of the origin task, fetched from the queue at the moment
   * `getInboxItem` is called. Always reflects current state — never a
   * snapshot from raise time. `null` when `originTaskId` is absent, the
   * task was not found, or the queue DB is unavailable.
   */
  liveTaskStatus: string | null
}

export interface SetInboxStateOptions {
  resolution?: string
  note?: string
  rootCause?: string
  by?: string
}

let clientSingleton: Client | null = null
let initialised = false

const getClient = (): Client => {
  if (clientSingleton) return clientSingleton
  const { stateDbPath } = resolveContext()
  clientSingleton = openLibsql({ url: `file:${stateDbPath}` })
  return clientSingleton
}

const sha1Hex = (input: string): string =>
  createHash('sha1').update(input).digest('hex')

const computeFingerprint = (kind: string, signature: string): string =>
  sha1Hex(`${kind}:${signature}`)

const generateInboxId = (): string => randomUUID().slice(0, 8)

export const initInbox = async (): Promise<void> => {
  if (initialised) return
  const c = getClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS inbox_items (
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
    CREATE TABLE IF NOT EXISTS inbox_history (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      at TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      by TEXT,
      note TEXT,
      FOREIGN KEY (item_id) REFERENCES inbox_items(id)
    )
  `)
  const cols = await c.execute(`PRAGMA table_info(inbox_items)`)
  const colNames = new Set(
    cols.rows.map((r) => (r as unknown as { name: string }).name),
  )
  if (!colNames.has('fingerprint')) {
    await c.execute(`ALTER TABLE inbox_items ADD COLUMN fingerprint TEXT`)
  }
  if (!colNames.has('signature')) {
    await c.execute(`ALTER TABLE inbox_items ADD COLUMN signature TEXT`)
  }
  if (!colNames.has('seen_count')) {
    await c.execute(
      `ALTER TABLE inbox_items ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1`,
    )
  }
  if (!colNames.has('last_seen_at')) {
    await c.execute(`ALTER TABLE inbox_items ADD COLUMN last_seen_at TEXT`)
  }
  if (!colNames.has('resolved_by')) {
    await c.execute(`ALTER TABLE inbox_items ADD COLUMN resolved_by TEXT`)
  }
  if (!colNames.has('origin_task_id')) {
    await c.execute(`ALTER TABLE inbox_items ADD COLUMN origin_task_id TEXT`)
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_inbox_fingerprint_state
       ON inbox_items(fingerprint, state)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_inbox_state ON inbox_items(state)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_inbox_history_item ON inbox_history(item_id, at)`,
  )
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

const toKind = (raw: unknown): InboxKind =>
  isInboxKind(raw) ? raw : 'failed'

const toPriority = (raw: unknown): InboxPriority => {
  if (raw === 'urgent' || raw === 'high' || raw === 'normal' || raw === 'low') {
    return raw
  }
  return 'normal'
}

const toState = (raw: unknown): InboxState => {
  if (
    raw === 'open' ||
    raw === 'acknowledged' ||
    raw === 'resolved' ||
    raw === 'dismissed'
  ) {
    return raw
  }
  return 'open'
}

const loadHistory = async (
  c: Client,
  itemId: string,
): Promise<InboxHistoryEntry[]> => {
  const r = await c.execute({
    sql: `SELECT at, from_state, to_state, by, note
            FROM inbox_history
           WHERE item_id = ?
           ORDER BY at ASC`,
    args: [itemId],
  })
  return r.rows.map((row) => {
    const r2 = row as unknown as Record<string, unknown>
    const fromRaw = (r2.from_state as string | null) ?? null
    const fromState =
      fromRaw === 'open' ||
      fromRaw === 'acknowledged' ||
      fromRaw === 'resolved' ||
      fromRaw === 'dismissed'
        ? (fromRaw as InboxState)
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
  fromState: InboxState | null,
  toStateValue: InboxState,
  by: string | null,
  note: string | null,
): Promise<void> => {
  await c.execute({
    sql: `INSERT INTO inbox_history (id, item_id, at, from_state, to_state, by, note)
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

const rowToInboxItem = (
  row: Record<string, unknown>,
  history: InboxHistoryEntry[],
): InboxItem => {
  const state = toState(row.state)
  const resolvedAt = (row.resolved_at as string | null) ?? null
  const resolution = (row.resolution as string | null) ?? null
  const resolutionNote = (row.resolution_note as string | null) ?? null
  const rootCause = (row.root_cause as string | null) ?? null
  const resolvedBy = (row.resolved_by as string | null) ?? null
  const resolutionDetails: InboxResolution | null =
    state === 'resolved' || state === 'dismissed'
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

export const raiseInboxItem = async (
  item: RaiseInboxItem,
): Promise<string> => {
  await initInbox()
  const c = getClient()
  const fingerprint = item.originTaskId
    ? computeOriginFingerprint(item.originTaskId)
    : computeFingerprint(item.kind, item.signature)
  const now = new Date().toISOString()

  const existing = await c.execute({
    sql: `SELECT id, payload FROM inbox_items
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
      sql: `UPDATE inbox_items
               SET seen_count = seen_count + 1,
                   last_seen_at = ?,
                   payload = ?
             WHERE id = ?`,
      args: [now, JSON.stringify(payload), row.id],
    })
    return row.id
  }

  const id = generateInboxId()
  const payload: Record<string, unknown> = { ...item.payload }
  if (item.occurrence) {
    const prior = Array.isArray(payload.occurrences)
      ? (payload.occurrences as unknown[])
      : []
    payload.occurrences = [...prior, item.occurrence]
  }
  await c.execute({
    sql: `INSERT INTO inbox_items (
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
      item.originTaskId ?? null,
    ],
  })
  await insertHistory(c, id, null, 'open', item.raisedBy, null)
  await emitInboxBusEvent('inbox.raised', {
    itemId: id,
    kind: item.kind,
    category: item.category,
    priority: item.priority,
    signature: item.signature,
  })
  return id
}

/**
 * Overwrite the "suggested next action" body on the existing open inbox
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
  await initInbox()
  const c = getClient()
  const fingerprint = computeOriginFingerprint(originTaskId)
  const existing = await c.execute({
    sql: `SELECT id FROM inbox_items
           WHERE fingerprint = ? AND state = 'open'
           ORDER BY raised_at ASC
           LIMIT 1`,
    args: [fingerprint],
  })
  if (existing.rows.length === 0) return null
  const id = (existing.rows[0] as unknown as { id: string }).id
  await c.execute({
    sql: `UPDATE inbox_items SET body = ? WHERE id = ?`,
    args: [findings, id],
  })
  return id
}

/**
 * Merge `patch` into the payload JSON of the open inbox item keyed by
 * `originTaskId`. Existing payload fields not present in `patch` are
 * preserved. No-op (returns `null`) if no open item exists for that origin —
 * the caller must raise the item first via `raiseInboxItem`. Returns the item
 * id when the patch was applied.
 */
export const patchOpenInboxPayload = async (
  originTaskId: string,
  patch: Record<string, unknown>,
): Promise<string | null> => {
  await initInbox()
  const c = getClient()
  const fingerprint = computeOriginFingerprint(originTaskId)
  const existing = await c.execute({
    sql: `SELECT id, payload FROM inbox_items
           WHERE fingerprint = ? AND state = 'open'
           ORDER BY raised_at ASC
           LIMIT 1`,
    args: [fingerprint],
  })
  if (existing.rows.length === 0) return null
  const row = existing.rows[0] as unknown as { id: string; payload: string | null }
  const merged = { ...parseJsonObject(row.payload), ...patch }
  await c.execute({
    sql: `UPDATE inbox_items SET payload = ? WHERE id = ?`,
    args: [JSON.stringify(merged), row.id],
  })
  return row.id
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
  item: InboxItem,
  liveTaskLookup: LiveTaskLookup,
): Promise<InboxItem> => {
  if (item.originTaskId === null) return item
  const result = await liveTaskLookup(item.originTaskId)
  return { ...item, liveTaskStatus: result?.status ?? null }
}

const fetchById = async (
  c: Client,
  id: string,
): Promise<InboxItem | null> => {
  const r = await c.execute({
    sql: `SELECT * FROM inbox_items WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as Record<string, unknown>
  const history = await loadHistory(c, row.id as string)
  return rowToInboxItem(row, history)
}

export const getInboxItem = async (
  idOrPrefix: string,
  liveTaskLookup: LiveTaskLookup = defaultLiveTaskLookup,
): Promise<InboxItem | null> => {
  await initInbox()
  const c = getClient()
  const exact = await fetchById(c, idOrPrefix)
  if (exact) return enrichWithLiveStatus(exact, liveTaskLookup)
  if (idOrPrefix.length < 4) return null
  const prefixMatch = await c.execute({
    sql: `SELECT * FROM inbox_items WHERE id LIKE ? || '%' LIMIT 2`,
    args: [idOrPrefix],
  })
  if (prefixMatch.rows.length !== 1) return null
  const row = prefixMatch.rows[0] as unknown as Record<string, unknown>
  const history = await loadHistory(c, row.id as string)
  return enrichWithLiveStatus(rowToInboxItem(row, history), liveTaskLookup)
}

export interface ListInboxOptions {
  /** Filter by item kind (exact match). */
  kind?: InboxKind
}

export const listInboxItems = async (
  state: InboxState | 'all' = 'open',
  opts: ListInboxOptions = {},
): Promise<InboxItem[]> => {
  await initInbox()
  const c = getClient()
  const wheres: string[] = []
  const args: Array<string> = []
  if (state !== 'all') {
    wheres.push('state = ?')
    args.push(state)
  }
  if (opts.kind !== undefined) {
    wheres.push('kind = ?')
    args.push(opts.kind)
  }
  const sql = `SELECT * FROM inbox_items${
    wheres.length > 0 ? ` WHERE ${wheres.join(' AND ')}` : ''
  } ORDER BY raised_at DESC`
  const r =
    args.length === 0 ? await c.execute(sql) : await c.execute({ sql, args })
  const items: InboxItem[] = []
  for (const row of r.rows) {
    const r2 = row as unknown as Record<string, unknown>
    const history = await loadHistory(c, r2.id as string)
    items.push(rowToInboxItem(r2, history))
  }
  return items
}

const isTerminal = (state: InboxState): boolean =>
  state === 'resolved' || state === 'dismissed'

export const setInboxState = async (
  idOrPrefix: string,
  state: InboxState,
  opts?: SetInboxStateOptions,
): Promise<void> => {
  await initInbox()
  const c = getClient()

  let resolvedId: string | null = null
  const exact = await c.execute({
    sql: `SELECT id FROM inbox_items WHERE id = ?`,
    args: [idOrPrefix],
  })
  if (exact.rows.length === 1) {
    resolvedId = (exact.rows[0] as unknown as { id: string }).id
  } else if (idOrPrefix.length >= 4) {
    const pref = await c.execute({
      sql: `SELECT id FROM inbox_items WHERE id LIKE ? || '%' LIMIT 2`,
      args: [idOrPrefix],
    })
    if (pref.rows.length === 1) {
      resolvedId = (pref.rows[0] as unknown as { id: string }).id
    }
  }
  if (!resolvedId) return

  const cur = await c.execute({
    sql: `SELECT state FROM inbox_items WHERE id = ?`,
    args: [resolvedId],
  })
  const currentState = (
    cur.rows[0] as unknown as { state: InboxState }
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
      sql: `SELECT resolution FROM inbox_items WHERE id = ?`,
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
    sql: `UPDATE inbox_items SET ${sets.join(', ')} WHERE id = ?`,
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
    await emitInboxBusEvent('inbox.resolved', {
      itemId: resolvedId,
      fromState: currentState,
      toState: state,
      by: opts?.by ?? '',
    })
  }
}

/**
 * Reason an inbox item was auto-closed because its origin task reached a
 * terminal state (or any status transition). Surfaced in the resolution note
 * so an operator reading inbox history can tell why the row vanished.
 */
export type SupersedeReason =
  | 'origin-done'
  | 'origin-dropped'
  | 'origin-purged'
  | 'status-changed'
  | 'subscriber-unstalled'

/**
 * Auto-close every open inbox item keyed to the given origin task. Called
 * by the daemon when an origin task reaches done / dropped / purged so
 * the operator does not need to ack or dismiss a row whose underlying
 * stuck task is no longer stuck. Returns the ids of the rows that were
 * superseded (possibly empty — no-op when nothing matches).
 *
 * Idempotent: rerunning against an origin whose rows are already closed
 * is a silent no-op.
 */
export const supersedeInboxItemsForOrigin = async (
  originTaskId: string,
  reason: SupersedeReason,
  by = 'daemon:auto-supersede',
): Promise<string[]> => {
  await initInbox()
  const c = getClient()
  const fingerprint = computeOriginFingerprint(originTaskId)
  const rows = await c.execute({
    sql: `SELECT id FROM inbox_items WHERE fingerprint = ? AND state = 'open'`,
    args: [fingerprint],
  })
  const ids: string[] = []
  for (const row of rows.rows) {
    const id = (row as unknown as { id: string }).id
    await setInboxState(id, 'resolved', {
      resolution: 'superseded',
      note: `superseded: ${reason}`,
      by,
    })
    ids.push(id)
  }
  return ids
}

/**
 * Close every open inbox row matching a (kind, signature) pair. Used by the
 * Subscriber stall machinery (ADR-0032): when a previously-blocked event
 * finally processes, the `subscriber-stalled` row keyed on
 * `${subscriberId}:${eventId}` is superseded. Idempotent — no open match is
 * a silent no-op.
 */
export const supersedeInboxItemsBySignature = async (
  kind: InboxKind,
  signature: string,
  reason: SupersedeReason,
  by = 'daemon:auto-supersede',
): Promise<string[]> => {
  await initInbox()
  const c = getClient()
  const rows = await c.execute({
    sql: `SELECT id FROM inbox_items WHERE kind = ? AND signature = ? AND state = 'open'`,
    args: [kind, signature],
  })
  const ids: string[] = []
  for (const row of rows.rows) {
    const id = (row as unknown as { id: string }).id
    await setInboxState(id, 'resolved', {
      resolution: 'superseded',
      note: `superseded: ${reason}`,
      by,
    })
    ids.push(id)
  }
  return ids
}

/**
 * One-time reconciliation pass: closes every open inbox item whose origin
 * task is already in a successful terminal state (done or dropped). Items
 * about tasks in `failed` or any live state are NOT included in the input,
 * so they remain open after the call.
 *
 * Idempotent — re-running when items are already closed is a silent no-op
 * because `supersedeInboxItemsForOrigin` only touches open rows.
 *
 * @param terminatedTasks  Tasks that have reached done or dropped. The
 *   caller is responsible for fetching these from the task queue.
 * @returns The number of inbox items closed by this pass.
 */
export const reconcileStaleInboxItems = async (
  terminatedTasks: ReadonlyArray<{ id: string; status: 'done' | 'dropped' }>,
): Promise<{ closed: number }> => {
  let closed = 0
  for (const task of terminatedTasks) {
    const reason: SupersedeReason =
      task.status === 'done' ? 'origin-done' : 'origin-dropped'
    const ids = await supersedeInboxItemsForOrigin(
      task.id,
      reason,
      'reconcile:one-time',
    )
    closed += ids.length
  }
  return { closed }
}

/**
 * Slice K one-shot cleanup: supersede every open inbox row whose payload or
 * body still references the retired `setup:preflight/dirty-main` failure
 * mode. F.2's `verify:main-dirty` + `main-commiter` path replaced that code
 * path entirely; rows from a pre-F.2 daemon describe a system that no longer
 * exists and can never reach a true resolution from the operator side.
 *
 * Each matching row is closed via `setInboxState` with
 * `resolution: 'superseded'`, `note: 'superseded by slice K: preflight code
 * path retired'`, and a matching `inbox_history` entry. The supersede goes
 * through the standard lifecycle (NOT a raw DELETE) so the trail is visible
 * to anyone reading `inbox_history`.
 *
 * Idempotent — rerunning matches no open rows (closed rows are excluded by
 * the WHERE clause) and produces no further writes.
 *
 * @returns The ids of the rows that were superseded.
 */
export const supersedeObsoletePreflightDirtyMainRows = async (
  by = 'daemon:slice-k-cleanup',
): Promise<string[]> => {
  await initInbox()
  const c = getClient()
  // The legacy strings can appear in any of three places:
  //  - `payload` (JSON blob) → matches the failure-signature or wrapped
  //    `retry_budget_exhausted:setup:preflight/...` form;
  //  - `body` (rendered markdown) → matches the inbox row's own description
  //    of the failure mode.
  // SQL LIKE substring match is enough here because the legacy strings are
  // distinctive enough not to collide with live wording.
  const rows = await c.execute({
    sql: `SELECT id FROM inbox_items
           WHERE state = 'open'
             AND (
               payload LIKE '%setup:preflight/dirty-main%'
               OR payload LIKE '%retry_budget_exhausted:setup:preflight%'
               OR body LIKE '%setup:preflight/dirty-main%'
             )`,
    args: [],
  })
  const ids: string[] = []
  for (const row of rows.rows) {
    const id = (row as unknown as { id: string }).id
    await setInboxState(id, 'resolved', {
      resolution: 'superseded',
      note: 'superseded by slice K: preflight code path retired',
      by,
    })
    ids.push(id)
  }
  return ids
}

/**
 * Delete the stale-worktree dismissal row for a task so a future
 * stale-worktree alert can re-fire cleanly if the task becomes stale again.
 * No-op when no row exists.
 */
export const clearStaleWorktreeDismissal = async (
  taskId: string,
): Promise<void> => {
  await initInbox()
  const c = getClient()
  // The table may not exist yet (first run before any dismissal).
  try {
    await c.execute({
      sql: `DELETE FROM stale_worktree_dismissals WHERE task_id = ?`,
      args: [taskId],
    })
  } catch {
    // Table doesn't exist yet — nothing to clear.
  }
}

/**
 * Auto-clear all open inbox alerts for a task and remove its
 * stale-worktree dismissal row whenever the task's status changes.
 * Called by `updateTask` in queue.ts on every real status transition.
 *
 * Each closed inbox item gets `resolution_note` = `"status-changed → <newStatus>"`
 * and a matching `inbox_history` row so operators can see which transition
 * triggered the dismissal.
 *
 * @param taskId    The task whose alerts should be cleared.
 * @param newStatus The status the task just transitioned to. Recorded in
 *                  `inbox_history.note` and `inbox_items.resolution_note`.
 * @returns         The ids of the inbox items that were closed.
 */
export const dismissAlertsOnStatusChange = async (
  taskId: string,
  newStatus: string,
): Promise<string[]> => {
  await initInbox()
  const c = getClient()
  const fingerprint = computeOriginFingerprint(taskId)
  const rows = await c.execute({
    sql: `SELECT id FROM inbox_items WHERE fingerprint = ? AND state = 'open'`,
    args: [fingerprint],
  })
  const ids: string[] = []
  const note = `status-changed → ${newStatus}`
  for (const row of rows.rows) {
    const id = (row as unknown as { id: string }).id
    await setInboxState(id, 'resolved', {
      resolution: 'superseded',
      note,
      by: `daemon:status-changed:${newStatus}`,
    })
    ids.push(id)
  }
  await clearStaleWorktreeDismissal(taskId)
  return ids
}
