import { createClient, type Client } from '@libsql/client'
import { createHash, randomUUID } from 'node:crypto'
import { resolveContext } from '../context'

export type InboxCategory = 'orchestrator' | 'reflector' | 'daemon' | 'user'
export type InboxPriority = 'urgent' | 'high' | 'normal' | 'low'
export type InboxState = 'open' | 'acknowledged' | 'resolved' | 'dismissed'

export interface RaiseInboxItem {
  kind: string
  category: InboxCategory | string
  priority: InboxPriority
  title: string
  body: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  raisedBy: string
  signature: string
  occurrence?: Record<string, unknown>
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
  kind: string
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
  clientSingleton = createClient({ url: `file:${stateDbPath}` })
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
    kind: row.kind as string,
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
  }
}

export const raiseInboxItem = async (
  item: RaiseInboxItem,
): Promise<string> => {
  await initInbox()
  const c = getClient()
  const fingerprint = computeFingerprint(item.kind, item.signature)
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
             seen_count, fingerprint, signature
           ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
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
    ],
  })
  await insertHistory(c, id, null, 'open', item.raisedBy, null)
  return id
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
): Promise<InboxItem | null> => {
  await initInbox()
  const c = getClient()
  const exact = await fetchById(c, idOrPrefix)
  if (exact) return exact
  if (idOrPrefix.length < 4) return null
  const prefixMatch = await c.execute({
    sql: `SELECT * FROM inbox_items WHERE id LIKE ? || '%' LIMIT 2`,
    args: [idOrPrefix],
  })
  if (prefixMatch.rows.length !== 1) return null
  const row = prefixMatch.rows[0] as unknown as Record<string, unknown>
  const history = await loadHistory(c, row.id as string)
  return rowToInboxItem(row, history)
}

export interface ListInboxOptions {
  /** Filter by item kind (exact match). E.g. `recovery-failed`, `no-recipe`. */
  kind?: string
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
}
