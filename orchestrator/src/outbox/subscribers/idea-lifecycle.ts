import type { Client } from '@libsql/client'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../mastra/daemon/subscriber-drain.js'

export const IDEA_LIFECYCLE_SUBSCRIBER = 'idea-lifecycle'

/**
 * Proposal lifecycle event types that flow through the Outbox.
 * Maps to: created, promoted, rejected, deleted — the four idea lifecycle
 * transitions the PRD targets.
 */
const LIFECYCLE_TYPES = new Set<string>([
  'proposal.added',
  'proposal.promoted',
  'proposal.dismissed',
  'proposal.deleted',
])

/**
 * Register the idea-lifecycle subscriber. Idempotent — re-registering an
 * existing subscriber preserves its cursor position so events published
 * while the daemon was offline are replayed on the next drain.
 *
 * `replay: false` places the cursor at the current outbox head on first
 * registration; subsequent registrations are no-ops.
 */
export async function ensureIdeaLifecycleSubscriber(client: Client): Promise<void> {
  await registerSubscriber(client, IDEA_LIFECYCLE_SUBSCRIBER, { replay: false })
}

/**
 * Drain pending idea lifecycle events from the Outbox.
 *
 * Reacts to proposal state changes (created, promoted, rejected, deleted)
 * that have been durably recorded in the events outbox. Each event is
 * consumed exactly once — the subscriber cursor (persisted in the
 * `subscribers` table) guarantees at-least-once delivery across daemon
 * restarts, and the {@link drainWithStall} dedup guard (via
 * `subscriber_processed_events`) prevents duplicate side effects.
 *
 * Implements the ADR-0032 stall contract: a handler failure blocks the
 * cursor on the failing event and raises a `subscriber-stalled` action-queue
 * item after K consecutive failures. The cursor does not advance past a
 * poison event — causally dependent later events wait behind it.
 *
 * @returns The number of lifecycle events consumed in this drain.
 */
export async function drainIdeaLifecycle(
  client: Client,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: IDEA_LIFECYCLE_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (!LIFECYCLE_TYPES.has(event.type)) return false

      const payload = event.payload as { proposalId: string }
      log?.(`[idea-lifecycle] ${event.type} for proposal ${payload.proposalId}`)
      // Subscribers for specific reactions (cross-references, draft surfacing,
      // etc.) are added in later slices. This handler establishes the durable
      // cursor-based delivery contract for all idea lifecycle transitions.
      return true
    },
  })
}
