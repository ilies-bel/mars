/**
 * Promotion ledger entity module — records the outcome of each beat-yesterday
 * promotion gate evaluation for the chip-style scoring auto-learning system
 * (PRD 5b73d277, slice 2).
 *
 * Each row captures the two workflow config versions under comparison
 * (candidate vs incumbent), the rolling scores and sample sizes each side had
 * at decision time, the decision outcome (promoted|retired|pending), and
 * timestamps. `pending` rows represent gates that have been opened but not yet
 * resolved.
 *
 * Storage: the `promotion_ledger` table in `.mars/mars.db` via the same
 * state-client seam as scorer-results.ts (ADR-0034).
 */

import { type Client } from '@libsql/client'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { resolveStateClient } from './store/state-client'

/** Decision outcome of a promotion gate evaluation. */
export const PromotionDecisionSchema = z.enum(['promoted', 'retired', 'pending'])
export type PromotionDecision = z.infer<typeof PromotionDecisionSchema>

/** Full persisted row. `parse`d on every read path. */
export const PromotionLedgerEntrySchema = z.object({
  id: z.string().min(1),
  /** Target workflow kind (e.g. 'task', 'fix'). */
  workflow: z.string().min(1),
  /** The workflow config version id being evaluated as the candidate. */
  candidateVersionId: z.string().min(1),
  /** The workflow config version id currently in production as the incumbent. */
  incumbentVersionId: z.string().min(1),
  /** Candidate's rolling score at decision time; null when not yet scored. */
  candidateScore: z.number().min(0).max(1).nullable(),
  /** Incumbent's rolling score at decision time; null when not yet scored. */
  incumbentScore: z.number().min(0).max(1).nullable(),
  /** Number of samples behind the candidate score. */
  candidateN: z.number().int().nonnegative(),
  /** Number of samples behind the incumbent score. */
  incumbentN: z.number().int().nonnegative(),
  decision: PromotionDecisionSchema,
  /** Unix ms timestamp when the gate was resolved; null for pending rows. */
  decidedAt: z.number().nullable(),
  /** Unix ms timestamp when the ledger row was created. */
  createdAt: z.number(),
})
export type PromotionLedgerEntry = z.infer<typeof PromotionLedgerEntrySchema>

export interface RecordPromotionLedgerEntryInput {
  id?: string
  workflow: string
  candidateVersionId: string
  incumbentVersionId: string
  candidateScore: number | null
  incumbentScore: number | null
  candidateN: number
  incumbentN: number
  decision: PromotionDecision
  decidedAt: number | null
}

const stateClient = (): Client => resolveStateClient()

let initialised = false

export const initPromotionLedger = async (): Promise<void> => {
  if (initialised) return
  const c = stateClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS promotion_ledger (
      id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      candidate_version_id TEXT NOT NULL,
      incumbent_version_id TEXT NOT NULL,
      candidate_score REAL,
      incumbent_score REAL,
      candidate_n INTEGER NOT NULL DEFAULT 0,
      incumbent_n INTEGER NOT NULL DEFAULT 0,
      decision TEXT NOT NULL DEFAULT 'pending'
        CHECK(decision IN ('promoted','retired','pending')),
      decided_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `)
  // List queries scan per workflow, newest first.
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_promotion_ledger_workflow
       ON promotion_ledger(workflow, created_at DESC)`,
  )
  initialised = true
}

/** Test-only: forget the init latch so a fresh temp DB re-runs the DDL. */
export const __resetPromotionLedgerForTests = (): void => {
  initialised = false
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

const rowToEntry = (row: Record<string, unknown>): PromotionLedgerEntry =>
  PromotionLedgerEntrySchema.parse({
    id: row.id,
    workflow: row.workflow,
    candidateVersionId: row.candidate_version_id,
    incumbentVersionId: row.incumbent_version_id,
    candidateScore:
      row.candidate_score === null || row.candidate_score === undefined
        ? null
        : clamp01(Number(row.candidate_score)),
    incumbentScore:
      row.incumbent_score === null || row.incumbent_score === undefined
        ? null
        : clamp01(Number(row.incumbent_score)),
    candidateN: Number(row.candidate_n ?? 0),
    incumbentN: Number(row.incumbent_n ?? 0),
    decision: row.decision,
    decidedAt:
      row.decided_at === null || row.decided_at === undefined
        ? null
        : Number(row.decided_at),
    createdAt: Number(row.created_at ?? 0),
  })

export const generateLedgerEntryId = (): string =>
  `pl-${randomBytes(6).toString('hex')}`

/**
 * Persist a new promotion gate decision row.
 */
export const recordPromotionLedgerEntry = async (
  client: Client,
  input: RecordPromotionLedgerEntryInput,
): Promise<PromotionLedgerEntry> => {
  await initPromotionLedger()
  const now = Date.now()
  const id = input.id ?? generateLedgerEntryId()
  const entry: PromotionLedgerEntry = PromotionLedgerEntrySchema.parse({
    id,
    workflow: input.workflow,
    candidateVersionId: input.candidateVersionId,
    incumbentVersionId: input.incumbentVersionId,
    candidateScore:
      input.candidateScore === null ? null : clamp01(input.candidateScore),
    incumbentScore:
      input.incumbentScore === null ? null : clamp01(input.incumbentScore),
    candidateN: input.candidateN,
    incumbentN: input.incumbentN,
    decision: input.decision,
    decidedAt: input.decidedAt,
    createdAt: now,
  })
  await client.execute({
    sql: `INSERT INTO promotion_ledger
            (id, workflow, candidate_version_id, incumbent_version_id,
             candidate_score, incumbent_score, candidate_n, incumbent_n,
             decision, decided_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      entry.id,
      entry.workflow,
      entry.candidateVersionId,
      entry.incumbentVersionId,
      entry.candidateScore,
      entry.incumbentScore,
      entry.candidateN,
      entry.incumbentN,
      entry.decision,
      entry.decidedAt,
      entry.createdAt,
    ],
  })
  return entry
}

/**
 * Return all ledger rows, optionally filtered by workflow kind, ordered
 * newest first.
 */
export const listPromotionLedgerEntries = async (
  client: Client,
  workflow?: string,
): Promise<PromotionLedgerEntry[]> => {
  await initPromotionLedger()
  const r = workflow
    ? await client.execute({
        sql: `SELECT * FROM promotion_ledger WHERE workflow = ? ORDER BY created_at DESC, id DESC`,
        args: [workflow],
      })
    : await client.execute(
        `SELECT * FROM promotion_ledger ORDER BY created_at DESC, id DESC`,
      )
  return r.rows.map((row) => rowToEntry(row as unknown as Record<string, unknown>))
}

/**
 * Return the single most-recent ledger row for a workflow kind, or null when
 * no rows exist for that workflow.
 */
export const getLatestLedgerEntry = async (
  client: Client,
  workflow: string,
): Promise<PromotionLedgerEntry | null> => {
  await initPromotionLedger()
  const r = await client.execute({
    sql: `SELECT * FROM promotion_ledger WHERE workflow = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    args: [workflow],
  })
  if (r.rows.length === 0) return null
  return rowToEntry(r.rows[0] as unknown as Record<string, unknown>)
}
