/**
 * Scorer entity module — the SUGGESTION half of the per-Workflow quality
 * evaluator (PRD 6988ed3b).
 *
 * A Scorer is a durable per-Workflow quality rubric suggested by per-arc
 * reflection when it finds a MEASUREMENT GAP: the verify gate passed (or
 * vacuously passed) while transcript analysis exposed a quality dimension no
 * gate grades. It is NOT a proposal (no promote→slice lifecycle) and NOT a
 * KPI (never fleet-wide). Lifecycle: suggested → accepted | dismissed.
 *
 * Accepting a Scorer produces a durable accepted record and nothing more —
 * running scorers against Workflow instances, per-instance score storage, and
 * the optimization fold-in belong to the dependent draft 6cf85bc9.
 *
 * Storage: the `scorers` table in `.mars/mars.db` (same state client seam as
 * proposals, ADR-0034). Dedup: a fingerprint over (workflow, quality
 * dimension) mirrors the proposals fingerprint pattern — a re-derived
 * suggestion accrues evidence on the existing suggested row instead of
 * inserting a duplicate.
 */

import { type Client } from '@libsql/client'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { resolveStateClient } from './store/state-client'
import { buildEventInsert } from './lib/outbox'
import type { EventName, EventPayload } from '../bus/events.js'

/** Lifecycle states of a Scorer record. */
export const ScorerStatusSchema = z.enum(['suggested', 'accepted', 'dismissed'])
export type ScorerStatus = z.infer<typeof ScorerStatusSchema>

/**
 * The output contract every Scorer declares: a normalized continuous score in
 * 0..1 plus a mandatory one-line rationale. Pass/fail is a derived view via an
 * operator threshold at integration time (6cf85bc9) — never stored here.
 */
export const SCORER_OUTPUT_CONTRACT = 'continuous-0-1-with-one-line-rationale' as const

/**
 * The full Scorer record schema. `parse`d on every read path so a hand-edited
 * or corrupted row surfaces loudly instead of leaking `unknown` shapes.
 */
export const ScorerRecordSchema = z.object({
  id: z.string().min(1),
  /** Target Workflow kind the rubric applies to (matches the task workflow kind, e.g. 'task', 'fix'). */
  workflow: z.string().min(1),
  /** Short human label for the quality dimension graded. */
  title: z.string().min(1),
  /**
   * Self-contained scoring prompt an evaluator LLM applies to a completed
   * Workflow instance's artifacts (diff, verify output, transcript digest).
   * Must generalize — no arc-specific references.
   */
  rubric: z.string().min(1),
  /** Declared output contract (fixed for this slice). */
  outputContract: z.literal(SCORER_OUTPUT_CONTRACT),
  status: ScorerStatusSchema,
  /** Provenance: the reflected arc's originId. */
  originArcId: z.string().min(1),
  /** Provenance: path of the persisted .mars/deep-reflections report, when known. */
  reportPath: z.string().nullable(),
  /** Provenance: concrete dissonant calls / verify mismatches that motivated the suggestion. */
  evidence: z.array(z.string()),
  /** Analyst confidence, 0..1 (same semantics as a reflection suggestion's confidence). */
  confidence: z.number().min(0).max(1),
  /** Dedup fingerprint over (workflow, quality dimension). */
  fingerprint: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Scorer = z.infer<typeof ScorerRecordSchema>

/** Outcome of a `suggestScorer` call. */
export type SuggestScorerOutcome =
  /** No fingerprint match — a fresh suggested row was inserted. */
  | 'created'
  /** Fingerprint matched a row still in 'suggested' — evidence accrued, no new row. */
  | 'absorbed'
  /** Fingerprint matched an accepted/dismissed row — the dimension is already triaged; no-op. */
  | 'already-triaged'

export interface SuggestScorerInput {
  workflow: string
  title: string
  rubric: string
  originArcId: string
  reportPath: string | null
  evidence: readonly string[]
  confidence: number
}

export interface SuggestScorerResult {
  scorer: Scorer
  outcome: SuggestScorerOutcome
}

const stateClient = (): Client => resolveStateClient()

/**
 * Emit a scorer lifecycle event to the events outbox. Mirrors
 * `emitProposalBusEvent` in proposals.ts: the scorers write has already
 * committed on the state client; the outbox write runs in its own
 * transaction via the TaskStore seam and is non-fatal on failure.
 */
async function emitScorerBusEvent<T extends EventName>(
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  try {
    const { getDefaultTaskStore } = await import('./store/task-store')
    const store = await getDefaultTaskStore()
    await store.atomic(async (scope) => {
      await scope.execute(buildEventInsert(type, payload))
    })
  } catch {
    // Non-fatal: scorer state change already committed in state.db.
  }
}

let initialised = false

export const initScorers = async (): Promise<void> => {
  if (initialised) return
  const c = stateClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS scorers (
      id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      title TEXT NOT NULL,
      rubric TEXT NOT NULL,
      output_contract TEXT NOT NULL DEFAULT '${SCORER_OUTPUT_CONTRACT}',
      status TEXT NOT NULL DEFAULT 'suggested',
      origin_arc_id TEXT NOT NULL,
      report_path TEXT,
      evidence TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  // Mirrors idx_proposals_fingerprint: fast dedup lookup at suggest time.
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_scorers_fingerprint ON scorers(fingerprint)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_scorers_status ON scorers(status)`,
  )
  initialised = true
}

/** Test-only: forget the init latch so a fresh temp DB re-runs the DDL. */
export const __resetScorersForTests = (): void => {
  initialised = false
}

const sha1Hex = (input: string): string =>
  createHash('sha1').update(input).digest('hex')

/**
 * Normalise a quality-dimension title for fingerprinting: lowercase,
 * collapse every non-alphanumeric run to a single space, trim. 'Diff
 * Minimality' and 'diff-minimality' hash identically.
 */
const normaliseDimension = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** The (workflow, quality dimension) dedup fingerprint. */
export const computeScorerFingerprint = (
  workflow: string,
  title: string,
): string => sha1Hex(`${workflow.trim().toLowerCase()}:${normaliseDimension(title)}`)

const slugify = (text: string): string => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'scorer'
}

export const generateScorerId = (workflow: string, title: string): string => {
  const prefix = randomBytes(4).toString('hex')
  return `${prefix}-${slugify(`${workflow}-${title}`)}`
}

const parseEvidence = (raw: unknown): string[] => {
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is string => typeof e === 'string')
  } catch {
    return []
  }
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

const rowToScorer = (row: Record<string, unknown>): Scorer =>
  ScorerRecordSchema.parse({
    id: row.id,
    workflow: row.workflow,
    title: row.title,
    rubric: row.rubric,
    outputContract: row.output_contract,
    status: row.status,
    originArcId: row.origin_arc_id,
    reportPath: (row.report_path as string | null) ?? null,
    evidence: parseEvidence(row.evidence),
    confidence: clamp01(Number(row.confidence ?? 0)),
    fingerprint: row.fingerprint,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  })

const fetchByFingerprint = async (
  c: Client,
  fingerprint: string,
): Promise<Scorer | null> => {
  const r = await c.execute({
    sql: `SELECT * FROM scorers WHERE fingerprint = ? ORDER BY created_at ASC LIMIT 1`,
    args: [fingerprint],
  })
  if (r.rows.length === 0) return null
  return rowToScorer(r.rows[0] as unknown as Record<string, unknown>)
}

const fetchScorerById = async (c: Client, id: string): Promise<Scorer | null> => {
  const r = await c.execute({
    sql: `SELECT * FROM scorers WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  return rowToScorer(r.rows[0] as unknown as Record<string, unknown>)
}

/**
 * Land a scorer suggestion from reflection.
 *
 * Dedup contract (user story 4): when the (workflow, dimension) fingerprint
 * matches an existing row —
 *   - still 'suggested' → the row accrues the new evidence (deduped verbatim
 *     strings), keeps the max confidence, bumps updated_at. NO new row and NO
 *     new `scorer.suggested` event, so the open action-queue row stays single.
 *   - 'accepted' / 'dismissed' → the dimension has already been triaged;
 *     nothing is written and no event is emitted.
 *
 * A fresh insert lands with status='suggested' and emits `scorer.suggested`,
 * which the action-queue-repopulator projects into a 'scorer-suggested' row.
 */
export const suggestScorer = async (
  input: SuggestScorerInput,
): Promise<SuggestScorerResult> => {
  await initScorers()
  const c = stateClient()
  const fingerprint = computeScorerFingerprint(input.workflow, input.title)
  const existing = await fetchByFingerprint(c, fingerprint)
  const now = Date.now()

  if (existing !== null) {
    if (existing.status !== 'suggested') {
      return { scorer: existing, outcome: 'already-triaged' }
    }
    const mergedEvidence = [...existing.evidence]
    for (const e of input.evidence) {
      if (!mergedEvidence.includes(e)) mergedEvidence.push(e)
    }
    const mergedConfidence = clamp01(
      Math.max(existing.confidence, input.confidence),
    )
    await c.execute({
      sql: `UPDATE scorers SET evidence = ?, confidence = ?, updated_at = ? WHERE id = ?`,
      args: [JSON.stringify(mergedEvidence), mergedConfidence, now, existing.id],
    })
    const updated = await fetchScorerById(c, existing.id)
    if (!updated) throw new Error(`scorer ${existing.id} disappeared during absorb`)
    return { scorer: updated, outcome: 'absorbed' }
  }

  const id = generateScorerId(input.workflow, input.title)
  const scorer: Scorer = ScorerRecordSchema.parse({
    id,
    workflow: input.workflow,
    title: input.title,
    rubric: input.rubric,
    outputContract: SCORER_OUTPUT_CONTRACT,
    status: 'suggested',
    originArcId: input.originArcId,
    reportPath: input.reportPath,
    evidence: [...input.evidence],
    confidence: clamp01(input.confidence),
    fingerprint,
    createdAt: now,
    updatedAt: now,
  })
  await c.execute({
    sql: `INSERT INTO scorers (
            id, workflow, title, rubric, output_contract, status,
            origin_arc_id, report_path, evidence, confidence,
            fingerprint, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'suggested', ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      scorer.id,
      scorer.workflow,
      scorer.title,
      scorer.rubric,
      scorer.outputContract,
      scorer.originArcId,
      scorer.reportPath,
      JSON.stringify(scorer.evidence),
      scorer.confidence,
      scorer.fingerprint,
      scorer.createdAt,
      scorer.updatedAt,
    ],
  })
  await emitScorerBusEvent('scorer.suggested', {
    scorerId: scorer.id,
    workflow: scorer.workflow,
    title: scorer.title,
  })
  return { scorer, outcome: 'created' }
}

export type ScorerIdResolution =
  | { kind: 'unique'; id: string }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' }

const MIN_PREFIX_LENGTH = 4

export const resolveScorerId = async (
  idOrPrefix: string,
): Promise<ScorerIdResolution> => {
  await initScorers()
  const c = stateClient()
  const exact = await c.execute({
    sql: `SELECT id FROM scorers WHERE id = ?`,
    args: [idOrPrefix],
  })
  if (exact.rows.length === 1) {
    return { kind: 'unique', id: (exact.rows[0] as unknown as { id: string }).id }
  }
  if (idOrPrefix.length < MIN_PREFIX_LENGTH) return { kind: 'none' }
  const prefixMatch = await c.execute({
    sql: `SELECT id FROM scorers WHERE id LIKE ? || '%' LIMIT 2`,
    args: [idOrPrefix],
  })
  if (prefixMatch.rows.length === 0) return { kind: 'none' }
  if (prefixMatch.rows.length === 1) {
    return {
      kind: 'unique',
      id: (prefixMatch.rows[0] as unknown as { id: string }).id,
    }
  }
  const total = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM scorers WHERE id LIKE ? || '%'`,
    args: [idOrPrefix],
  })
  const count = Number(
    (total.rows[0] as unknown as { n: number | bigint }).n ?? 2,
  )
  return { kind: 'ambiguous', count }
}

export const getScorer = async (idOrPrefix: string): Promise<Scorer | null> => {
  const resolved = await resolveScorerId(idOrPrefix)
  if (resolved.kind !== 'unique') return null
  return fetchScorerById(stateClient(), resolved.id)
}

export interface ListScorersFilter {
  status?: ScorerStatus
  workflow?: string
}

export const listScorers = async (
  filter?: ListScorersFilter,
): Promise<Scorer[]> => {
  await initScorers()
  const c = stateClient()
  const where: string[] = []
  const args: string[] = []
  if (filter?.status) {
    where.push('status = ?')
    args.push(filter.status)
  }
  if (filter?.workflow) {
    where.push('workflow = ?')
    args.push(filter.workflow)
  }
  const sql = `SELECT * FROM scorers${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at DESC`
  const r = args.length > 0 ? await c.execute({ sql, args }) : await c.execute(sql)
  return r.rows.map((row) => rowToScorer(row as unknown as Record<string, unknown>))
}

const resolveOrThrow = async (idOrPrefix: string): Promise<string> => {
  const resolved = await resolveScorerId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} scorers`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`scorer ${idOrPrefix} not found`)
  }
  return resolved.id
}

/**
 * Flip a suggested Scorer to a terminal triage status. The conditional
 * UPDATE (status='suggested') makes accept/dismiss race-safe: a second call
 * (or a call on an already-triaged row) matches zero rows and errors with
 * the row's current status.
 */
const transitionScorer = async (
  idOrPrefix: string,
  to: 'accepted' | 'dismissed',
): Promise<Scorer> => {
  await initScorers()
  const id = await resolveOrThrow(idOrPrefix)
  const c = stateClient()
  const r = await c.execute({
    sql: `UPDATE scorers SET status = ?, updated_at = ? WHERE id = ? AND status = 'suggested'`,
    args: [to, Date.now(), id],
  })
  if (r.rowsAffected === 0) {
    const current = await fetchScorerById(c, id)
    if (!current) throw new Error(`scorer ${id} not found`)
    throw new Error(
      `scorer ${id} is '${current.status}'; only suggested scorers can be ${to}`,
    )
  }
  await emitScorerBusEvent(
    to === 'accepted' ? 'scorer.accepted' : 'scorer.dismissed',
    { scorerId: id },
  )
  const updated = await fetchScorerById(c, id)
  if (!updated) throw new Error(`scorer ${id} disappeared after transition`)
  return updated
}

/**
 * Accept a suggested Scorer. The accepted row is the durable handoff
 * artifact for the integration draft (6cf85bc9) — nothing runs here.
 */
export const acceptScorer = async (idOrPrefix: string): Promise<Scorer> =>
  transitionScorer(idOrPrefix, 'accepted')

/** Dismiss a suggested Scorer. */
export const dismissScorer = async (idOrPrefix: string): Promise<Scorer> =>
  transitionScorer(idOrPrefix, 'dismissed')

/**
 * Append evidence to the existing SUGGESTED scorer matching the
 * (workflow, title) fingerprint — the 'absorb' verdict path. Returns the
 * updated scorer, or null when no suggested row matches (nothing to fold
 * into; the finding is simply counted by the caller).
 */
export const absorbScorerEvidence = async (
  workflow: string,
  title: string,
  evidence: readonly string[],
  confidence: number,
): Promise<Scorer | null> => {
  await initScorers()
  const c = stateClient()
  const fingerprint = computeScorerFingerprint(workflow, title)
  const existing = await fetchByFingerprint(c, fingerprint)
  if (existing === null || existing.status !== 'suggested') return null
  const mergedEvidence = [...existing.evidence]
  for (const e of evidence) {
    if (!mergedEvidence.includes(e)) mergedEvidence.push(e)
  }
  const mergedConfidence = clamp01(Math.max(existing.confidence, confidence))
  await c.execute({
    sql: `UPDATE scorers SET evidence = ?, confidence = ?, updated_at = ? WHERE id = ?`,
    args: [JSON.stringify(mergedEvidence), mergedConfidence, Date.now(), existing.id],
  })
  return fetchScorerById(c, existing.id)
}
