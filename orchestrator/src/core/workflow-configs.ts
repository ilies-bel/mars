/**
 * Workflow config entity module — versioned workflow configuration records for
 * the chip-style scoring auto-learning system (PRD 5b73d277).
 *
 * Each row captures a snapshot of the prompt/runbook that drove a workflow
 * kind at a point in time: a stable id, the workflow kind, a monotonic version
 * number, a SHA-1 hash of the prompt/runbook that produced the version, a
 * status enum (baseline|trial|promoted|retired), and timestamps.
 *
 * The UNIQUE(workflow, version) constraint prevents accidental double-inserts
 * of the same version; the `getActiveWorkflowConfig` helper returns the single
 * row in 'promoted' or 'baseline' status that the scoring system treats as the
 * current reference point.
 *
 * Storage: the `workflow_configs` table in the embedded PostgreSQL database
 * via the same state-client seam as scorers.ts (ADR-0034).
 */

import { z } from 'zod'
import type { DbClient } from './lib/db'
import { ensureSchema } from './lib/pg-schema'
import { resolveStateClient } from './store/state-client'

/** Lifecycle states of a WorkflowConfig record. */
export const WorkflowConfigStatusSchema = z.enum([
  'baseline',
  'trial',
  'promoted',
  'retired',
])
export type WorkflowConfigStatus = z.infer<typeof WorkflowConfigStatusSchema>

/** Full persisted row. `parse`d on every read path. */
export const WorkflowConfigSchema = z.object({
  id: z.string().min(1),
  /** Target workflow kind (e.g. 'task', 'fix'). */
  workflow: z.string().min(1),
  /** Monotonic version number within the workflow kind. */
  version: z.number().int().nonnegative(),
  /** SHA-1 hash of the prompt/runbook that produced this version. */
  configHash: z.string().min(1),
  status: WorkflowConfigStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>

export interface InsertWorkflowConfigInput {
  id: string
  workflow: string
  version: number
  configHash: string
  status: WorkflowConfigStatus
}

const stateClient = (): DbClient => resolveStateClient()

let initialised = false

export const initWorkflowConfigs = async (): Promise<void> => {
  if (initialised) return
  // DDL lives in core/lib/pg-schema.ts (migration 0002); this just guarantees
  // the canonical schema exists before the first read/write.
  await ensureSchema(stateClient())
  initialised = true
}

/** Test-only: forget the init latch so a fresh temp DB re-runs the DDL. */
export const __resetWorkflowConfigsForTests = (): void => {
  initialised = false
}

const rowToConfig = (row: Record<string, unknown>): WorkflowConfig =>
  WorkflowConfigSchema.parse({
    id: row.id,
    workflow: row.workflow,
    version: Number(row.version ?? 0),
    configHash: row.config_hash,
    status: row.status,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  })

/**
 * Insert a new workflow config record. Throws on UNIQUE(workflow, version)
 * violation — callers must ensure monotonicity before inserting.
 */
export const insertWorkflowConfig = async (
  client: DbClient,
  input: InsertWorkflowConfigInput,
): Promise<WorkflowConfig> => {
  await initWorkflowConfigs()
  const now = Date.now()
  await client.execute({
    sql: `INSERT INTO workflow_configs
            (id, workflow, version, config_hash, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [input.id, input.workflow, input.version, input.configHash, input.status, now, now],
  })
  const r = await client.execute({
    sql: `SELECT * FROM workflow_configs WHERE id = ?`,
    args: [input.id],
  })
  return rowToConfig(r.rows[0] as unknown as Record<string, unknown>)
}

/**
 * Return all config rows for a given workflow kind, ordered newest version
 * first.
 */
export const listWorkflowConfigs = async (
  client: DbClient,
  workflow: string,
): Promise<WorkflowConfig[]> => {
  await initWorkflowConfigs()
  const r = await client.execute({
    sql: `SELECT * FROM workflow_configs WHERE workflow = ? ORDER BY version DESC`,
    args: [workflow],
  })
  return r.rows.map((row) => rowToConfig(row as unknown as Record<string, unknown>))
}

/**
 * Return the single active config row for a workflow kind — the row whose
 * status is 'promoted' (preferred) or 'baseline' (fallback when nothing has
 * been promoted yet). Returns null when no row in either status exists.
 *
 * Promotion takes precedence over baseline: if both statuses are present
 * (which should not happen in a well-managed table but can arise during
 * migration), the promoted row is returned.
 */
export const getActiveWorkflowConfig = async (
  client: DbClient,
  workflow: string,
): Promise<WorkflowConfig | null> => {
  await initWorkflowConfigs()
  const r = await client.execute({
    sql: `SELECT * FROM workflow_configs
           WHERE workflow = ? AND status IN ('promoted', 'baseline')
           ORDER BY CASE status WHEN 'promoted' THEN 0 ELSE 1 END, version DESC
           LIMIT 1`,
    args: [workflow],
  })
  if (r.rows.length === 0) return null
  return rowToConfig(r.rows[0] as unknown as Record<string, unknown>)
}

/**
 * Return the single trial config row for a workflow kind. Returns null when no
 * row with status='trial' exists.
 */
export const getTrialWorkflowConfig = async (
  client: DbClient,
  workflow: string,
): Promise<WorkflowConfig | null> => {
  await initWorkflowConfigs()
  const r = await client.execute({
    sql: `SELECT * FROM workflow_configs
           WHERE workflow = ? AND status = 'trial'
           ORDER BY version DESC
           LIMIT 1`,
    args: [workflow],
  })
  if (r.rows.length === 0) return null
  return rowToConfig(r.rows[0] as unknown as Record<string, unknown>)
}
