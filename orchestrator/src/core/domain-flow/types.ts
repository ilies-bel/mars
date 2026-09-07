/**
 * Domain Flow types and Zod schemas (PRD cd54a867, slice 1).
 *
 * A Domain Flow is the ordered sequence of Domain Events and Domain Policies
 * that a change touches, captured during Arc planning so the operator can
 * steer domain impact before looking at the diff.
 *
 * Timestamp convention: `frozenAt`, `createdAt`, and `updatedAt` are ISO-8601
 * strings (the DB columns are TIMESTAMPTZ, matching the `tasks` table
 * convention — not epoch-millisecond bigints).
 */

import { z } from 'zod'

// ── node schemas ──────────────────────────────────────────────────────────────

export const domainEventSchema = z.object({
  kind: z.literal('event'),
  name: z.string().min(1),
  description: z.string(),
  pivotal: z.boolean().default(false),
})

export const domainPolicySchema = z.object({
  kind: z.literal('policy'),
  name: z.string().min(1),
  description: z.string(),
})

export const hotspotSchema = z.object({
  kind: z.literal('hotspot'),
  name: z.string().min(1),
  question: z.string().min(1),
})

/** Discriminated union covering every node variant in a Domain Flow. */
export const domainFlowNodeSchema = z.discriminatedUnion('kind', [
  domainEventSchema,
  domainPolicySchema,
  hotspotSchema,
])

/** The content fields shared between a draft and a persisted Domain Flow. */
export const domainFlowContentSchema = z.object({
  name: z.string().min(1),
  nodes: z.array(domainFlowNodeSchema),
})

// ── inferred types ────────────────────────────────────────────────────────────

export type DomainEvent = z.infer<typeof domainEventSchema>
export type DomainPolicy = z.infer<typeof domainPolicySchema>
export type Hotspot = z.infer<typeof hotspotSchema>
export type DomainFlowNode = z.infer<typeof domainFlowNodeSchema>
export type DomainFlowContent = z.infer<typeof domainFlowContentSchema>

// ── persisted record type ─────────────────────────────────────────────────────

/**
 * A Domain Flow row as returned from the `domain_flows` table.
 * Timestamp columns match the `tasks` table convention (ISO-8601 strings,
 * backed by TIMESTAMPTZ in the DB).
 */
export interface DomainFlow {
  /** Stable UUID for this flow row. */
  id: string
  /** The Arc (task) this flow belongs to. Foreign key to `tasks.id`. */
  arcId: string
  /** Short human-readable name for the flow (e.g. "Billing cycle change"). */
  name: string
  /** Ordered list of events, policies, and hotspots. */
  nodes: DomainFlowNode[]
  /**
   * Set once the operator accepts the flow. NULL while the flow is still a
   * draft. ISO-8601 string (TIMESTAMPTZ column).
   */
  frozenAt: string | null
  /** ISO-8601 string (TIMESTAMPTZ column). */
  createdAt: string
  /** ISO-8601 string (TIMESTAMPTZ column). */
  updatedAt: string
}
