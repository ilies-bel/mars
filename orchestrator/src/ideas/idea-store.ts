/**
 * Proposal scratchpad store.
 *
 * Scratchpad proposals are stored with a bare hex primary key (8 chars,
 * 4 random bytes) and a slug column (derived from the text). All
 * user-facing output renders through the MarsId value object, so the
 * 'mars-proposal-' prefix is never constructed by string concatenation
 * in this module.
 *
 * DB table (in mars.db):
 *   proposal_notes(id TEXT PK, slug TEXT, text TEXT, created_at INTEGER)
 *
 * The id column stores the bare 8-char hex; the slug column stores the
 * slugified text. Together they form the rendered id:
 *   MarsId.create('proposal', id, slug).toString()  →  mars-proposal-<hex>-<slug>
 */
import { randomBytes } from 'node:crypto'
import { resolveStateClient } from '../core/store/state-client.js'
import { MarsId, parseMarsId } from '../mars-id/index.js'

export interface ProposalNote {
  /** Rendered id: mars-proposal-<hex>-<slug> */
  id: string
  text: string
  createdAt: number
}

// Shared mars.db client (state domain, collapsed from the former private singleton); same
// `mars.db` file as the TaskStore (ADR-0034), resolved through the seam.
const stateClient = resolveStateClient

let initialised = false

export const initProposalNotes = async (): Promise<void> => {
  if (initialised) return
  const c = stateClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS proposal_notes (
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
  return slug || 'proposal'
}

type ProposalNoteRow = { id: string; slug: string; text: string; created_at: number }

const rowToProposalNote = (row: ProposalNoteRow): ProposalNote => ({
  id: MarsId.create('proposal', row.id, row.slug).toString(),
  text: row.text,
  createdAt: Number(row.created_at),
})

export const addProposalNote = async (text: string): Promise<ProposalNote> => {
  await initProposalNotes()
  const c = stateClient()
  const hex = randomBytes(4).toString('hex')
  const slug = slugify(text)
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO proposal_notes (id, slug, text, created_at) VALUES (?, ?, ?, ?)`,
    args: [hex, slug, text, now],
  })
  return rowToProposalNote({ id: hex, slug, text, created_at: now })
}

export const listProposalNotes = async (): Promise<ProposalNote[]> => {
  await initProposalNotes()
  const c = stateClient()
  // Tie-break on the implicit rowid so two notes added within the same
  // millisecond still sort deterministically newest-first (higher rowid =
  // inserted later). Without this, ties fall back to ascending rowid order
  // and the older note surfaces first.
  const r = await c.execute(
    `SELECT id, slug, text, created_at FROM proposal_notes ORDER BY created_at DESC, rowid DESC`,
  )
  return r.rows.map((row) => rowToProposalNote(row as unknown as ProposalNoteRow))
}

/**
 * Resolve a proposal note by any of the four user-facing input shapes:
 *   1. Full rendered form   — mars-proposal-<hex>-<slug>
 *   2. Prefix without slug  — mars-proposal-<hex>
 *   3. Bare hex             — <hex> (8 chars)
 *   4. Hex prefix           — <hex-prefix> (1–7 chars)
 *
 * Resolution is against the bare-hex `id` column. Exact match is tried
 * first; a LIKE prefix match is used when the hex is shorter than 8 chars.
 * Returns null when no unique match is found.
 */
export const getProposalNote = async (input: string): Promise<ProposalNote | null> => {
  await initProposalNotes()
  const c = stateClient()

  const parsed = parseMarsId(input)
  if (!parsed.ok) return null

  const hexQuery = parsed.value.hex

  const exact = await c.execute({
    sql: `SELECT id, slug, text, created_at FROM proposal_notes WHERE id = ?`,
    args: [hexQuery],
  })
  if (exact.rows.length === 1) {
    return rowToProposalNote(exact.rows[0] as unknown as ProposalNoteRow)
  }

  // Prefix match for partial hex (shapes 3 and 4 when hex < 8 chars, or
  // whenever the exact lookup found nothing — e.g. a full 8-char prefix
  // that is itself a leading segment of some hex).
  const prefix = await c.execute({
    sql: `SELECT id, slug, text, created_at FROM proposal_notes WHERE id LIKE ? || '%' LIMIT 2`,
    args: [hexQuery],
  })
  if (prefix.rows.length === 1) {
    return rowToProposalNote(prefix.rows[0] as unknown as ProposalNoteRow)
  }

  return null
}
