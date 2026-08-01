/**
 * Propose archival of a Subthread whose reason to exist has gone away.
 *
 * Two things can make a Subthread archivable, and the operator asked for both:
 *
 *   - an alert-origin Subthread whose backing action-queue item MUTATED. The
 *     Subthread exists to resolve that alert; once the alert resolves, the
 *     objective is met by definition and there is nothing to judge.
 *   - any Subthread whose objective the operator considers met. That judgement
 *     is not made here — `proposeArchive` is the seam the chat runner calls
 *     when it reads the objective as satisfied.
 *
 * The prompt is a Notice: zero-token, spoken into the main thread, never takes
 * the floor. It carries two preloaded-response chips (Archive / Keep open) so
 * answering it costs the operator one click and no provider turn.
 *
 * Nothing here archives on its own. A Subthread is filed away only by an
 * explicit operator gesture — the alert mutating is grounds to ask, not to act.
 */

import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { registerSubscriberName } from '../registry.js'
import { postConversationNotice } from '../../core/lib/conversation-delivery.js'

/** Durable cursor that observes alert mutations to prompt Subthread archival. */
export const ARCHIVE_PROMPTER_SUBSCRIBER = 'archive-prompter'
registerSubscriberName(ARCHIVE_PROMPTER_SUBSCRIBER)

/** Register the durable cursor before alert-mutation events are published. */
export async function ensureArchivePrompter(client: DbClient): Promise<void> {
  await registerSubscriber(client, ARCHIVE_PROMPTER_SUBSCRIBER, { replay: false })
}

/**
 * Event types that count as "the alert mutated". `action-queue.resolved` is the
 * direct signal; the task-terminal events are included because an alert row is
 * usually keyed on the task that raised it, and the task reaching a terminal
 * state is the same news arriving one layer down.
 */
const ALERT_MUTATION_EVENTS: ReadonlySet<string> = new Set([
  'action-queue.resolved',
  'task.terminal',
  'task.completed',
  'task.dropped',
])

/** One Subthread eligible for an archive prompt. */
interface ArchiveCandidate {
  id: string
  title: string
  objective: string | null
}

/**
 * Ask the operator whether to archive one Subthread.
 *
 * `promptedFor` is the entity whose mutation triggered the ask; it is stored as
 * the Notice's backing entity so the chips disable themselves once that entity
 * resolves, exactly like every other entity-backed Notice.
 *
 * Exported because the objective-met path (operator-created Subthreads) reaches
 * the same prompt without going through an outbox event.
 */
export async function proposeArchive(
  subthread: ArchiveCandidate,
  reason: 'alert-mutated' | 'objective-met',
  promptedFor?: string,
): Promise<void> {
  const goal = subthread.objective ?? subthread.title
  const body = reason === 'alert-mutated'
    ? `The alert behind "${subthread.title}" changed, so "${goal}" is settled. Archive this subthread?`
    : `"${goal}" reads as done to me. Archive this subthread?`
  await postConversationNotice({
    body,
    // Routine: an archive prompt is housekeeping and must never cut into a
    // live turn. It waits for the conversation to pause.
    priority: 'routine',
    ...(promptedFor !== undefined ? { backingEntityId: promptedFor } : {}),
    segments: [
      { type: 'text', text: body },
      {
        type: 'preloaded_responses',
        responses: [
          {
            id: `archive-${subthread.id}`,
            label: 'Archive',
            target: { type: 'verb', op: 'archive-subthread', entityId: subthread.id },
          },
          {
            id: `keep-${subthread.id}`,
            label: 'Keep open',
            // No verb: declining the prompt is the absence of an action. The
            // chip records the operator's answer in the transcript and leaves
            // the Subthread exactly as it was.
            target: { type: 'verb', op: 'unarchive-subthread', entityId: subthread.id },
          },
        ],
      },
    ],
  })
}

/**
 * Prompt for every open, unarchived, alert-origin Subthread whose backing
 * action-queue item is named by one durable Outbox event.
 *
 * Re-delivery is harmless: `archived_at IS NULL` stops re-prompting a Subthread
 * the operator already filed, and a duplicate prompt on a Subthread they chose
 * to keep is the same question asked twice, not a state change.
 */
export async function drainArchivePrompter(
  client: DbClient,
  log?: (message: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: ARCHIVE_PROMPTER_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (!ALERT_MUTATION_EVENTS.has(event.type)) return false
      const payload = event.payload as Record<string, unknown>
      const entityId =
        (typeof payload.itemId === 'string' && payload.itemId) ||
        (typeof payload.taskId === 'string' && payload.taskId)
      if (!entityId) return false

      const result = await client.execute({
        sql: `SELECT id, title, objective
                FROM chat_threads
               WHERE origin = 'alert'
                 AND alert_item_id = ?
                 AND archived_at IS NULL`,
        args: [entityId],
      })
      const candidates = result.rows as unknown as ArchiveCandidate[]
      for (const candidate of candidates) {
        await proposeArchive(candidate, 'alert-mutated', entityId)
      }
      return candidates.length > 0
    },
  })
}
