import type { SpendControlDecision } from '../core/daemon/spend-control/decide.js'
import { raiseActionQueueItem, supersedeActionQueueItemsBySignature } from '../core/lib/action-queue.js'

export interface SpendControlTransitionDeps {
  log?: (msg: string) => void
}

/**
 * Emit an action-queue notice when the spend controller transitions between
 * paused and allowed states. Skips emission when the state has not changed
 * (dedup via prev/next comparison in-memory — no DB query needed).
 *
 * Call this from the dispatcher tick immediately after computing the decision,
 * passing the previous decision (or null on the first tick).
 */
export async function emitSpendControlTransition(
  prev: SpendControlDecision | null,
  next: SpendControlDecision,
  deps?: SpendControlTransitionDeps,
): Promise<void> {
  const log = deps?.log ?? console.error

  // First tick — no prior state to compare against. Cache and return.
  if (prev === null) return

  // No transition — skip emission.
  if (prev.paused === next.paused) return

  if (!prev.paused && next.paused) {
    // allow → pause transition
    log(`[spend-control] dispatch paused: ${next.reason}`)
    await raiseActionQueueItem({
      kind: 'spend-control-notice',
      category: 'orchestrator',
      priority: 'high',
      title: 'Dispatch paused by spend controller',
      body: next.reason,
      payload: {
        direction: 'paused',
        reason: next.reason,
        rampBackFactor: next.rampBackFactor,
        suppressRecovery: next.suppressRecovery,
      },
      context: {},
      raisedBy: 'dispatcher:spend-control',
      signature: 'spend-control:paused',
    })
  } else if (prev.paused && !next.paused) {
    // pause → allow (ramp-back) transition: supersede the pause notice
    log(`[spend-control] dispatch resumed: ${next.reason}`)
    await supersedeActionQueueItemsBySignature(
      'spend-control-notice',
      'spend-control:paused',
      'status-changed',
      'dispatcher:spend-control',
    )
    await raiseActionQueueItem({
      kind: 'spend-control-notice',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Dispatch resumed by spend controller',
      body: next.reason,
      payload: {
        direction: 'resumed',
        reason: next.reason,
        rampBackFactor: next.rampBackFactor,
        suppressRecovery: next.suppressRecovery,
      },
      context: {},
      raisedBy: 'dispatcher:spend-control',
      signature: 'spend-control:resumed',
    })
  }
}
