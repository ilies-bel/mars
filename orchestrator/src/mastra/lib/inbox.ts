import { createClient, type Client } from '@libsql/client'
import { createHash, randomUUID } from 'node:crypto'
import { resolveContext } from '../context'

export type InboxCategory = 'orchestrator' | 'reflector' | 'daemon' | 'user'
export type InboxPriority = 'urgent' | 'normal' | 'low'
export type InboxState = 'open' | 'acknowledged' | 'resolved' | 'dismissed'

export interface RaiseInboxItem {
  kind: string
  category: InboxCategory
  priority: InboxPriority
  title: string
  body: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  raisedBy: string
  signature: string
  occurrence?: Record<string, unknown>
}

export interface InboxItem {
  id: string
  kind: string
  category: InboxCategory
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
  resolvedAt: string | null
  resolution: string | null
  resolutionNote: string | null
  rootCause: string | null
}

export interface SetInboxStateOptions {
  resolution?: string
  note?: string
  rootCause?: string
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

const initInbox = async (): Promise<void> => {
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
  const cols = await c.execute(`PRAGMA table_info(inbox_items)`)
  const colNames = new Set(
    cols.rows.map((r) => (r as unknown as { name: string }).name),
  )
  if (!colNames.has('fingerprint')) {
    await c.execute(`ALTER TABLE inbox_items ADD COLUMN fingerprint TEXT`)
  }
  if (!colNames.has('seen_count')) {
    await c.execute(
      `ALTER TABLE inbox_items ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1`,
    )
  }
  if (!colNames.has('last_seen_at')) {
    await c.execute(`ALTER TABLE inbox_items ADD COLUMN last_seen_at TEXT`)
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_inbox_fingerprint_state
       ON inbox_items(fingerprint, state)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_inbox_state ON inbox_items(state)`,
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

const rowToInboxItem = (row: Record<string, unknown>): InboxItem => ({
  id: row.id as string,
  kind: row.kind as string,
  category: row.category as InboxCategory,
  priority: row.priority as InboxPriority,
  state: row.state as InboxState,
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
  resolvedAt: (row.resolved_at as string | null) ?? null,
  resolution: (row.resolution as string | null) ?? null,
  resolutionNote: (row.resolution_note as string | null) ?? null,
  rootCause: (row.root_cause as string | null) ?? null,
})

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
             seen_count, fingerprint
           ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
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
    ],
  })
  return id
}

export const getInboxItem = async (id: string): Promise<InboxItem | null> => {
  await initInbox()
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT * FROM inbox_items WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  return rowToInboxItem(r.rows[0] as unknown as Record<string, unknown>)
}

export const listInboxItems = async (
  state: InboxState | 'all' = 'open',
): Promise<InboxItem[]> => {
  await initInbox()
  const c = getClient()
  const r =
    state === 'all'
      ? await c.execute(
          `SELECT * FROM inbox_items ORDER BY raised_at DESC`,
        )
      : await c.execute({
          sql: `SELECT * FROM inbox_items WHERE state = ? ORDER BY raised_at DESC`,
          args: [state],
        })
  return r.rows.map((row) =>
    rowToInboxItem(row as unknown as Record<string, unknown>),
  )
}

const isTerminal = (state: InboxState): boolean =>
  state === 'resolved' || state === 'dismissed'

export const setInboxState = async (
  id: string,
  state: InboxState,
  opts?: SetInboxStateOptions,
): Promise<void> => {
  await initInbox()
  const c = getClient()
  const existing = await c.execute({
    sql: `SELECT state FROM inbox_items WHERE id = ?`,
    args: [id],
  })
  if (existing.rows.length === 0) return
  const currentState = (
    existing.rows[0] as unknown as { state: InboxState }
  ).state
  const now = new Date().toISOString()

  const sets: string[] = ['state = ?']
  const args: Array<string | null> = [state]

  if (isTerminal(state)) {
    sets.push('resolved_at = ?')
    args.push(now)
  } else if (currentState !== state) {
    sets.push('resolved_at = ?')
    args.push(null)
  }

  if (opts?.resolution !== undefined) {
    sets.push('resolution = ?')
    args.push(opts.resolution)
  }
  if (opts?.note !== undefined) {
    sets.push('resolution_note = ?')
    args.push(opts.note)
  }
  if (opts?.rootCause !== undefined) {
    sets.push('root_cause = ?')
    args.push(opts.rootCause)
  }

  args.push(id)
  await c.execute({
    sql: `UPDATE inbox_items SET ${sets.join(', ')} WHERE id = ?`,
    args,
  })
}
