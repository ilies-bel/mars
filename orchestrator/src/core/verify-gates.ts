/**
 * verify_gates — DB-backed verify step registry.
 *
 * Stores the canonical set of per-scope verify steps that the orchestrator
 * runs during the `verify` phase of each task. This is the database-driven
 * replacement for `loadVerifyScopes(manifestPath)`: instead of reading a
 * supervisors manifest from disk, the orchestrator loads steps from this
 * table, which the operator manages via `mars verify-gate add/remove/list`.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveStateClient } from './store/state-client.js'
import type { DbTx } from './lib/db.js'
import type { VerifyScope, VerifyStepSpec } from './lib/git/verify.js'

// The specific DDL for this table — kept here so callers can ensure just this
// table without pulling in the full canonical schema.
const VERIFY_GATES_DDL = `CREATE TABLE IF NOT EXISTS verify_gates (
  id         text PRIMARY KEY,
  scope      text NOT NULL DEFAULT '.',
  name       text NOT NULL,
  cmd        text NOT NULL,
  args_json  text NOT NULL DEFAULT '[]',
  required   INTEGER NOT NULL DEFAULT 1,
  tier       text NOT NULL DEFAULT 'task',
  source     text NOT NULL DEFAULT 'human',
  created_at bigint NOT NULL,
  state      text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'quarantined')),
  quarantined_at bigint,
  quarantine_signature text,
  last_failure_signature text,
  last_failure_at bigint,
  last_failure_origin_id text,
  UNIQUE(scope, name)
)`

/** Idempotent CREATE TABLE for the verify_gates table. */
export const ensureVerifyGatesSchema = async (client: DbTx): Promise<void> => {
  await client.execute(VERIFY_GATES_DDL)
  await client.execute(
    `ALTER TABLE verify_gates ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active'
       CHECK (state IN ('active', 'quarantined'))`,
  )
  await client.execute(`ALTER TABLE verify_gates ADD COLUMN IF NOT EXISTS quarantined_at bigint`)
  await client.execute(`ALTER TABLE verify_gates ADD COLUMN IF NOT EXISTS quarantine_signature text`)
  await client.execute(`ALTER TABLE verify_gates ADD COLUMN IF NOT EXISTS last_failure_signature text`)
  await client.execute(`ALTER TABLE verify_gates ADD COLUMN IF NOT EXISTS last_failure_at bigint`)
  await client.execute(`ALTER TABLE verify_gates ADD COLUMN IF NOT EXISTS last_failure_origin_id text`)
  await client.execute(`UPDATE verify_gates SET state = 'active' WHERE state IS NULL`)
}

/** Runtime validation shared by gate creation, onboarding, and workflow input. */
export const VerifyGateInputSchema = z.object({
  /** Repo-relative scope directory. '.' means the repo root. Defaults to '.'. */
  scope: z.string().trim().min(1).optional(),
  /** Human-readable step name, unique within a scope. */
  name: z.string().trim().min(1),
  /** Executable to run (e.g. 'npx', 'npm', 'bash'). */
  cmd: z.string().trim().min(1),
  /** Positional arguments passed to `cmd`. */
  args: z.array(z.string()).optional(),
  /** Whether a non-zero exit fails the verify phase. Defaults to true. */
  required: z.boolean().optional(),
  /** 'task' (default): run per-task; 'integration': deferred to integration boundary. */
  tier: z.enum(['task', 'integration']).optional(),
  /** Who added this gate ('human', 'operator', …). Defaults to 'human'. */
  source: z.string().trim().min(1).optional(),
})

/** Input accepted by {@link addVerifyGate}. */
export type VerifyGateInput = z.infer<typeof VerifyGateInputSchema>

/** A verify gate row as returned by {@link listVerifyGates}. */
export interface VerifyGate {
  id: string
  scope: string
  name: string
  cmd: string
  args: string[]
  required: boolean
  tier: 'task' | 'integration'
  source: string
  createdAt: number
  state: 'active' | 'quarantined'
  quarantinedAt: number | null
  quarantineSignature: string | null
  lastFailureSignature: string | null
  lastFailureAt: number | null
  lastFailureOriginId: string | null
}

interface VerifyGateRow {
  id: string
  scope: string
  name: string
  cmd: string
  args_json: string
  required: number
  tier: string
  source: string
  created_at: number
  state: string
  quarantined_at: number | null
  quarantine_signature: string | null
  last_failure_signature: string | null
  last_failure_at: number | null
  last_failure_origin_id: string | null
}

const rowToGate = (row: VerifyGateRow): VerifyGate => ({
  id: row.id,
  scope: row.scope,
  name: row.name,
  cmd: row.cmd,
  args: JSON.parse(row.args_json) as string[],
  required: row.required !== 0,
  tier: row.tier as 'task' | 'integration',
  source: row.source,
  createdAt: row.created_at,
  state: row.state as 'active' | 'quarantined',
  quarantinedAt: row.quarantined_at,
  quarantineSignature: row.quarantine_signature,
  lastFailureSignature: row.last_failure_signature,
  lastFailureAt: row.last_failure_at,
  lastFailureOriginId: row.last_failure_origin_id,
})

/**
 * Resolve open CAN'T-VERIFY coverage gaps that a gate at `scope` now covers.
 *
 * A root gate covers every changed path. A nested gate only resolves a gap
 * when every path recorded on that gap falls beneath the gate's scope, so a
 * mixed-scope change remains visible until all of its missing coverage exists.
 * The action queue is intentionally read and updated directly here: this is
 * the entity mutation that makes the Alert projection disappear.
 */
export const resolveCoveredVerifyAlerts = async (scope: string): Promise<void> => {
  const c = resolveStateClient()
  try {
    const open = await c.execute({
      sql: `SELECT id, payload
              FROM action_queue_items
             WHERE kind = 'verify-uncovered' AND state = 'open'`,
      args: [],
    })
    for (const row of open.rows) {
      const record = row as unknown as { id: string; payload: string | null }
      let payload: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(record.payload ?? '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>
        }
      } catch {
        continue
      }
      const changedPaths = Array.isArray(payload.changedPaths)
        ? payload.changedPaths.filter((path): path is string => typeof path === 'string')
        : []
      const uncoveredScope = typeof payload.scope === 'string' ? payload.scope : null
      const covered =
        scope === '.' ||
        (changedPaths.length > 0
          ? changedPaths.every((path) => path === scope || path.startsWith(`${scope}/`))
          : uncoveredScope === scope || uncoveredScope?.startsWith(`${scope}/`) === true)
      if (!covered) continue
      await c.execute({
        sql: `UPDATE action_queue_items
                 SET state = 'resolved', resolved_at = ?, resolution_note = ?
               WHERE id = ? AND state = 'open'`,
        args: [Date.now(), `covered by verify gate for ${scope}`, record.id],
      })
    }
  } catch {
    // A freshly initialized repository can register its first gate before the
    // action-queue schema exists; there is no alert projection to resolve yet.
  }
}

/**
 * Insert a new verify gate. Returns the generated id.
 *
 * Throws if a gate with the same (scope, name) already exists (UNIQUE
 * constraint violation).
 */
export const addVerifyGate = async (input: VerifyGateInput): Promise<string> => {
  const c = resolveStateClient()
  const id = randomUUID()
  const {
    scope = '.',
    name,
    cmd,
    args = [],
    required = true,
    tier = 'task',
    source = 'human',
  } = input
  const createdAt = Date.now()
  await c.execute(
    `INSERT INTO verify_gates (id, scope, name, cmd, args_json, required, tier, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, scope, name, cmd, JSON.stringify(args), required ? 1 : 0, tier, source, createdAt],
  )
  await resolveCoveredVerifyAlerts(scope)
  return id
}

/**
 * Delete a verify gate. Accepts either:
 * - a gate `id` string, or
 * - a `{ scope, name }` object to delete by the unique (scope, name) pair.
 *
 * Silently does nothing if no matching gate exists.
 */
export const removeVerifyGate = async (
  idOrRef: string | { scope: string; name: string },
): Promise<void> => {
  const c = resolveStateClient()
  if (typeof idOrRef === 'string') {
    await c.execute(`DELETE FROM verify_gates WHERE id = ?`, [idOrRef])
  } else {
    await c.execute(`DELETE FROM verify_gates WHERE scope = ? AND name = ?`, [
      idOrRef.scope,
      idOrRef.name,
    ])
  }
}

/**
 * Quarantine a gate after a systemic failure, retaining the first quarantine
 * evidence and updating the gate's latest observed failure on every call.
 */
export const quarantineVerifyGate = async (
  client: DbTx,
  id: string,
  signature: string,
  originId: string,
): Promise<boolean> => {
  const now = Date.now()
  const result = await client.execute(
    `UPDATE verify_gates
        SET state = 'quarantined',
            quarantined_at = CASE WHEN state = 'active' THEN ? ELSE quarantined_at END,
            quarantine_signature = CASE WHEN state = 'active' THEN ? ELSE quarantine_signature END,
            last_failure_signature = ?,
            last_failure_at = ?,
            last_failure_origin_id = ?
      WHERE id = ? AND state = 'active'`,
    [now, signature, signature, now, originId, id],
  )
  return result.rowsAffected > 0
}

/**
 * Return a quarantined gate to execution without erasing its latest failure.
 */
export const activateVerifyGate = async (id: string): Promise<void> => {
  const c = resolveStateClient()
  await c.execute(
    `UPDATE verify_gates
        SET state = 'active', quarantined_at = NULL, quarantine_signature = NULL
      WHERE id = ?`,
    [id],
  )
}

/**
 * Return all verify gates ordered by scope then creation time.
 */
export const listVerifyGates = async (): Promise<VerifyGate[]> => {
  const c = resolveStateClient()
  const r = await c.execute(
    `SELECT id, scope, name, cmd, args_json, required, tier, source, created_at,
            state, quarantined_at, quarantine_signature, last_failure_signature,
            last_failure_at, last_failure_origin_id
     FROM verify_gates ORDER BY scope, created_at`,
  )
  return (r.rows as unknown as VerifyGateRow[]).map(rowToGate)
}

/**
 * Load all verify gates from `client` and return them as {@link VerifyScope}[],
 * the same shape that {@link selectVerifySteps} in `lib/git/verify.ts` expects.
 *
 * This is the database-driven drop-in replacement for `loadVerifyScopes(manifestPath)`.
 * Each returned step has `dir` set to its scope so the verify runner knows
 * which subdirectory to execute it from.
 */
export const loadVerifyGates = async (client: DbTx): Promise<VerifyScope[]> => {
  const r = await client.execute(
    `SELECT id, scope, name, cmd, args_json, required, tier, source, created_at,
            state, quarantined_at, quarantine_signature, last_failure_signature,
            last_failure_at, last_failure_origin_id
       FROM verify_gates
      WHERE state = 'active'
      ORDER BY scope, created_at`,
  )
  const rows = r.rows as unknown as VerifyGateRow[]

  const byScope = new Map<string, VerifyStepSpec[]>()
  const order: string[] = []

  for (const row of rows) {
    const scope = row.scope
    if (!byScope.has(scope)) {
      byScope.set(scope, [])
      order.push(scope)
    }
    const tier: 'task' | 'integration' | undefined =
      row.tier === 'task' || row.tier === 'integration' ? row.tier : undefined
    const step: VerifyStepSpec = {
      name: row.name,
      gateId: row.id,
      cmd: row.cmd,
      args: JSON.parse(row.args_json) as string[],
      required: row.required !== 0,
      dir: scope,
      ...(tier !== undefined ? { tier } : {}),
    }
    byScope.get(scope)!.push(step)
  }

  return order.map((scope) => ({ scope, steps: byScope.get(scope)! }))
}
