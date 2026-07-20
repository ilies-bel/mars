/**
 * Proposal scratchpad store.
 *
 * Scratchpad proposals are stored with a bare hex primary key (8 chars,
 * 4 random bytes) and a slug column (derived from the text). All
 * user-facing output renders through the MarsId value object, so the
 * 'mars-proposal-' prefix is never constructed by string concatenation
 * in this module.
 *
 * DB table:
 *   proposal_notes(id text PK, slug text, text text, created_at bigint)
 * Schema ownership: `ensureSchema` in core/lib/pg-schema.ts (migration
 * 0002) — this module carries no DDL.
 *
 * The id column stores the bare 8-char hex; the slug column stores the
 * slugified text. Together they form the rendered id:
 *   MarsId.create('proposal', id, slug).toString()  →  mars-proposal-<hex>-<slug>
 */
import { randomBytes } from 'node:crypto'
import { resolveStateClient } from '../core/store/state-client.js'
import { MarsId, parseMarsId } from '../mars-id/index.js'

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initProposalNotes = async (): Promise<void> => {
  const { ensureSchema } = await import('../core/lib/pg-schema.js')
  await ensureSchema(resolveStateClient())
}

export interface ProposalNote {
  /** Rendered id: mars-proposal-<hex>-<slug> */
  id: string
  text: string
  createdAt: number
}

// Shared state-domain client (collapsed from the former private singleton);
// same database as the TaskStore (ADR-0034), resolved through the seam.
const stateClient = resolveStateClient

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
  const c = stateClient()
  // Tie-break on the primary key so two notes added within the same
  // millisecond still sort deterministically (id is random hex, so ties
  // are stable rather than insertion-ordered — created_at carries the
  // real ordering).
  const r = await c.execute(
    `SELECT id, slug, text, created_at FROM proposal_notes ORDER BY created_at DESC, id DESC`,
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
