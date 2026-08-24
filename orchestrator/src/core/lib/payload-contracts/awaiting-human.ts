/**
 * Payload contract for the `awaiting-human` action-queue kind.
 */

import type { OccurrenceTrail } from './shared'

/**
 * `awaiting-human` is raised for three structurally different situations. The
 * recipe used to assume the first one unconditionally, so a row raised for
 * either of the other two rendered a summary that contradicted its own title.
 * Discriminate on `situation` instead of guessing.
 */
export type AwaitingHumanSituation = 'lease-park' | 'lease-expired' | 'escalation'

/** A task parked at a manual step; a human holds the lease and is expected to work. */
export interface LeaseParkPayload extends OccurrenceTrail {
  situation: 'lease-park'
  taskId: string
  leaseOwner: string
  leasedAt: string
  leaseNote: string | null
  /** Manual step the task parked at. Absent on the interactive-park path. */
  stepName?: string
  previewUrl?: string
  logPath?: string
}

/** A lease nobody released; the watchdog noticed it has gone stale. */
export interface LeaseExpiredPayload extends OccurrenceTrail {
  situation: 'lease-expired'
  taskId: string
  leaseOwner: string | null
  leasedAt: string | null
  leaseNote: string | null
  /** Minutes the lease has been held past its expiry. */
  ageMinutes: number
}

/**
 * An agent stopped and escalated to a human rather than bailing silently —
 * e.g. a recovery that found its arc already done. Raised through
 * `mars action-queue raise`, so the payload is agent-authored free-form
 * content; the recipe renders whatever scalar fields it carries rather than
 * looking for fixed key names.
 *
 * `situation` is **required** so a built-in raiser cannot land here by
 * accident: falling into the open branch has to be a deliberate declaration.
 */
interface HumanEscalationPayload {
  situation: 'escalation'
  [key: string]: unknown
}

export type AwaitingHumanPayload =
  | LeaseParkPayload
  | LeaseExpiredPayload
  | HumanEscalationPayload

/**
 * Recover the situation for a row whose payload predates the `situation`
 * discriminator, or that was authored by an agent through the CLI.
 *
 * Structural, not nominal: rows already in the database carry no `situation`
 * key at all, and they must still render the right summary.
 */
export const awaitingHumanSituation = (
  payload: AwaitingHumanPayload,
): AwaitingHumanSituation => {
  const declared = (payload as { situation?: unknown }).situation
  if (declared === 'lease-park' || declared === 'lease-expired' || declared === 'escalation') {
    return declared
  }
  // Legacy rows: infer from the keys the historical raisers emitted.
  if ('ageMinutes' in payload && payload.ageMinutes != null) return 'lease-expired'
  if ('leaseOwner' in payload && payload.leaseOwner) return 'lease-park'
  return 'escalation'
}

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface AwaitingHumanContracts {
  'awaiting-human': AwaitingHumanPayload
}

/** Representative fixture for the contract test. */
export const REPRESENTATIVE_PAYLOADS: Record<'awaiting-human', Record<string, unknown>> = {
  'awaiting-human': {
    situation: 'lease-park',
    taskId: 'mars-1',
    leaseOwner: 'alice',
    leasedAt: '2026-08-20T09:00:00.000Z',
    leaseNote: 'note',
    stepName: 'code',
  },
}
