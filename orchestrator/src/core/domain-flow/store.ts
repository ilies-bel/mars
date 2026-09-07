/**
 * Domain Flow persistence store (PRD cd54a867, slice 2).
 *
 * Provides CRUD operations for `domain_flows` rows. Every function accepts a
 * {@link DbClient} as its first argument so callers control the connection —
 * the same pattern used by `core/lib/usage-snapshot-store.ts` and others.
 *
 * The `domain_flows` table (DDL in core/lib/pg-schema.ts) carries one row per
 * Arc, enforced by the unique index on `arc_id`. A NULL `frozen_at` means the
 * flow is still a draft; a non-NULL value means it has been accepted by the
 * operator and is immutable.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DbClient } from '../lib/db.js'
import { domainFlowNodeSchema } from './types.js'
import type { DomainFlow, DomainFlowNode } from './types.js'

const nodesSchema = z.array(domainFlowNodeSchema)

function rowToDomainFlow(row: Record<string, unknown>): DomainFlow {
  const rawNodes = row['nodes']
  const nodes: DomainFlowNode[] =
    typeof rawNodes === 'string'
      ? (JSON.parse(rawNodes) as DomainFlowNode[])
      : (rawNodes as DomainFlowNode[])
  return {
    id: row['id'] as string,
    arcId: row['arc_id'] as string,
    name: row['name'] as string,
    nodes,
    frozenAt: row['frozen_at'] != null ? String(row['frozen_at']) : null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  }
}

/**
 * Insert or replace the Domain Flow for `arcId`.
 *
 * Uses `INSERT … ON CONFLICT (arc_id) DO UPDATE … WHERE frozen_at IS NULL` so
 * a write that races with a freeze is detected: if the UPDATE clause's WHERE
 * condition is false (the flow is already frozen) Postgres skips both the
 * INSERT and the UPDATE and RETURNING produces zero rows — we surface that as
 * an error.
 *
 * `nodes` is validated against {@link domainFlowNodeSchema} before any DB
 * write; a validation failure throws a Zod error and touches nothing.
 *
 * @throws {z.ZodError} When `nodes` fails schema validation.
 * @throws {Error} When the flow for `arcId` is frozen (immutable).
 */
export async function upsertFlow(
  client: DbClient,
  arcId: string,
  name: string,
  nodes: DomainFlowNode[],
): Promise<DomainFlow> {
  nodesSchema.parse(nodes)

  const id = randomUUID()
  const rs = await client.execute({
    sql: `INSERT INTO domain_flows (id, arc_id, name, nodes)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (arc_id) DO UPDATE
            SET name       = EXCLUDED.name,
                nodes      = EXCLUDED.nodes,
                updated_at = now()
          WHERE domain_flows.frozen_at IS NULL
          RETURNING *`,
    args: [id, arcId, name, JSON.stringify(nodes)],
  })

  if (rs.rows.length === 0) {
    throw new Error(`domain flow for arc ${arcId} is frozen and cannot be updated`)
  }

  return rowToDomainFlow(rs.rows[0] as Record<string, unknown>)
}

/**
 * Return the Domain Flow for `arcId`, or `null` when no row exists.
 */
export async function getFlowByArcId(
  client: DbClient,
  arcId: string,
): Promise<DomainFlow | null> {
  const rs = await client.execute({
    sql: `SELECT * FROM domain_flows WHERE arc_id = $1`,
    args: [arcId],
  })
  if (rs.rows.length === 0) return null
  return rowToDomainFlow(rs.rows[0] as Record<string, unknown>)
}

/**
 * Set `frozen_at = now()` on the flow for `arcId`.
 *
 * If the flow is already frozen this is a no-op (the WHERE guards it). The
 * updated row is always returned; the function throws when no row exists for
 * `arcId` at all.
 *
 * @throws {Error} When no domain flow exists for `arcId`.
 */
export async function freezeFlow(
  client: DbClient,
  arcId: string,
): Promise<DomainFlow> {
  await client.execute({
    sql: `UPDATE domain_flows
             SET frozen_at  = now(),
                 updated_at = now()
           WHERE arc_id = $1
             AND frozen_at IS NULL`,
    args: [arcId],
  })
  const flow = await getFlowByArcId(client, arcId)
  if (flow === null) {
    throw new Error(`domain flow for arc ${arcId} not found`)
  }
  return flow
}

/**
 * Delete the Domain Flow for `arcId`. A no-op when no row exists.
 */
export async function deleteFlow(
  client: DbClient,
  arcId: string,
): Promise<void> {
  await client.execute({
    sql: `DELETE FROM domain_flows WHERE arc_id = $1`,
    args: [arcId],
  })
}
