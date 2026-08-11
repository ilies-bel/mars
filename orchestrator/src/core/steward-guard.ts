import { listStewardLedgerFor } from './steward-ledger'

export interface StewardTarget {
  kind: string
  id: string
  version: string
}

export interface StewardFireDecision {
  fire: boolean
  reason: string
}

/**
 * Decide whether Steward may intervene for this exact version of a target.
 * A changed failure signature/content version is a new target and remains
 * eligible; an earlier intervention for this version requires an operator.
 */
export const shouldStewardFire = async (
  target: StewardTarget,
): Promise<StewardFireDecision> => {
  const prior = await listStewardLedgerFor(target.kind, target.id)
  const matching = prior.find((entry) => entry.targetVersion === target.version)
  if (matching) {
    return {
      fire: false,
      reason: `Steward already intervened for ${target.kind} ${target.id} at version ${target.version}.`,
    }
  }
  return { fire: true, reason: 'No prior Steward intervention exists for this target version.' }
}

/**
 * No-op: `steward-repeat` rows are now a derived kind (ADR-0057).  The
 * condition — steward already intervened on this target version — is visible
 * via the steward ledger and the arc's current status without a stored row.
 * Kept as a stub so callers compile without change.
 */
export const raiseStewardRepeatActionQueueItem = async (
  _target: StewardTarget,
  _reason: string,
): Promise<string> => ''
