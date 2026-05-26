/**
 * Idea store.
 *
 * Ideas are stored with a bare hex primary key (8 chars, 4 random bytes)
 * and a slug column (derived from the idea text). All user-facing output
 * renders through the MarsId value object, so the 'mars-idea-' prefix is
 * never constructed by string concatenation in this module.
 *
 * DB table (in state.db):
 *   ideas(id TEXT PK, slug TEXT, text TEXT, created_at INTEGER)
 *
 * The id column stores the bare 8-char hex; the slug column stores the
 * slugified text. Together they form the rendered id:
 *   MarsId.create('idea', id, slug).toString()  →  mars-idea-<hex>-<slug>
 */
import { randomBytes } from 'node:crypto'
import { type Client } from '@libsql/client'
import { resolveContext } from '../mastra/context.js'
import { openLibsql } from '../mastra/lib/libsql.js'
import { MarsId, parseMarsId } from '../mars-id/index.js'

export interface Idea {
  /** Rendered id: mars-idea-<hex>-<slug> */
  id: string
  text: string
  createdAt: number
}

let clientSingleton: Client | null = null

const getClient = (): Client => {
  if (clientSingleton) return clientSingleton
  const { stateDbPath } = resolveContext()
  clientSingleton = openLibsql({ url: `file:${stateDbPath}` })
  return clientSingleton
}

let initialised = false

export const initIdeas = async (): Promise<void> => {
  if (initialised) return
  const c = getClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS ideas (
      id         TEXT    NOT NULL PRIMARY KEY,
      slug       TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  initialised = true
}

const slugify = (text: string): string => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'idea'
}

type IdeaRow = { id: string; slug: string; text: string; created_at: number }

const rowToIdea = (row: IdeaRow): Idea => ({
  id: MarsId.create('idea', row.id, row.slug).toString(),
  text: row.text,
  createdAt: Number(row.created_at),
})

export const addIdea = async (text: string): Promise<Idea> => {
  await initIdeas()
  const c = getClient()
  const hex = randomBytes(4).toString('hex')
  const slug = slugify(text)
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO ideas (id, slug, text, created_at) VALUES (?, ?, ?, ?)`,
    args: [hex, slug, text, now],
  })
  return rowToIdea({ id: hex, slug, text, created_at: now })
}

export const listIdeas = async (): Promise<Idea[]> => {
  await initIdeas()
  const c = getClient()
  // Tie-break on the implicit rowid so two ideas added within the same
  // millisecond still sort deterministically newest-first (higher rowid =
  // inserted later). Without this, ties fall back to ascending rowid order
  // and the older idea surfaces first.
  const r = await c.execute(
    `SELECT id, slug, text, created_at FROM ideas ORDER BY created_at DESC, rowid DESC`,
  )
  return r.rows.map((row) => rowToIdea(row as unknown as IdeaRow))
}

/**
 * Resolve an idea by any of the four user-facing input shapes:
 *   1. Full rendered form   — mars-idea-<hex>-<slug>
 *   2. Prefix without slug  — mars-idea-<hex>
 *   3. Bare hex             — <hex> (8 chars)
 *   4. Hex prefix           — <hex-prefix> (1–7 chars)
 *
 * Resolution is against the bare-hex `id` column. Exact match is tried
 * first; a LIKE prefix match is used when the hex is shorter than 8 chars.
 * Returns null when no unique match is found.
 */
export const getIdea = async (input: string): Promise<Idea | null> => {
  await initIdeas()
  const c = getClient()

  const parsed = parseMarsId(input)
  if (!parsed.ok) return null

  const hexQuery = parsed.value.hex

  const exact = await c.execute({
    sql: `SELECT id, slug, text, created_at FROM ideas WHERE id = ?`,
    args: [hexQuery],
  })
  if (exact.rows.length === 1) {
    return rowToIdea(exact.rows[0] as unknown as IdeaRow)
  }

  // Prefix match for partial hex (shapes 3 and 4 when hex < 8 chars, or
  // whenever the exact lookup found nothing — e.g. a full 8-char prefix
  // that is itself a leading segment of some hex).
  const prefix = await c.execute({
    sql: `SELECT id, slug, text, created_at FROM ideas WHERE id LIKE ? || '%' LIMIT 2`,
    args: [hexQuery],
  })
  if (prefix.rows.length === 1) {
    return rowToIdea(prefix.rows[0] as unknown as IdeaRow)
  }

  return null
}
