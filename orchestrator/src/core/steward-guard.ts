import { raiseActionQueueItem } from './lib/action-queue'
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
 * Surface an exhausted Steward intervention to the operator. The signature
 * includes the complete versioned target identity, so repeated detections
 * update one row while a changed target version receives a fresh alert.
 */
export const raiseStewardRepeatActionQueueItem = async (
  target: StewardTarget,
  reason: string,
): Promise<string> =>
  raiseActionQueueItem({
    kind: 'steward-repeat',
    category: 'orchestrator',
    priority: 'high',
    title: `Steward already acted on ${target.kind} ${target.id}`,
    body: `${reason} Review the prior intervention and decide how to proceed.`,
    payload: {
      targetKind: target.kind,
      targetId: target.id,
      targetVersion: target.version,
    },
    context: { repoRoot: process.env.MARS_REPO ?? null },
    raisedBy: 'steward-guard',
    signature: `${target.kind}:${target.id}:${target.version}`,
  })
