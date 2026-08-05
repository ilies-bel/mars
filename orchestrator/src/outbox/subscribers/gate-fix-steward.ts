/** Durable hand-off from a quarantined verify gate to the read-only Steward. */

import type { DbClient } from '../../core/lib/db.js'
import { postConversationNotice } from '../../core/lib/conversation-delivery.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import {
  StewardEventSchema,
  type GateSystemicFailureEvent,
} from '../../core/agents/steward.js'
import { registerSubscriberName } from '../registry.js'

export const GATE_FIX_STEWARD_SUBSCRIBER = 'gate-fix-steward'
registerSubscriberName(GATE_FIX_STEWARD_SUBSCRIBER)

export type GateFixStewardDispatch = (event: GateSystemicFailureEvent) => Promise<unknown>
export type GateFixQuarantineNotice = (body: string) => Promise<void>

export async function ensureGateFixStewardSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, GATE_FIX_STEWARD_SUBSCRIBER, { replay: false })
}

/**
 * Read the immutable quarantine episode out of the registry and dispatch one
 * diagnosis. `drainWithStall` claims the event before calling this handler;
 * the unique proposal key is a second guard if a process dies mid-dispatch.
 */
export async function drainGateFixSteward(
  client: DbClient,
  dispatch: GateFixStewardDispatch,
  postQuarantineNotice: GateFixQuarantineNotice = async (body) => {
    await postConversationNotice({ body, priority: 'urgent' })
  },
  log?: (message: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: GATE_FIX_STEWARD_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'verify-gate.quarantined') return false
      const payload = event.payload as {
        gateId: string
        failureSignature: string
        failureEvidence?: string
      }
      const gateResult = await client.execute({
        sql: `SELECT id, scope, name, cmd, args_json, required, tier,
                      state, quarantine_signature
                FROM verify_gates WHERE id = ?`,
        args: [payload.gateId],
      })
      if (gateResult.rows.length === 0) return false
      const gate = gateResult.rows[0] as Record<string, unknown>
      // An operator can reactivate or remove a gate before a delayed outbox
      // drain. Do not diagnose a gate that is no longer quarantined.
      if (gate.state !== 'quarantined' || typeof gate.quarantine_signature !== 'string') return false

      const stewardEvent = StewardEventSchema.parse({
        kind: 'gate-systemic-failure',
        gate: {
          id: gate.id as string,
          scope: gate.scope as string,
          name: gate.name as string,
        },
        currentDefinition: {
          cmd: gate.cmd as string,
          args: JSON.parse(gate.args_json as string) as string[],
          required: Boolean(gate.required),
          tier: gate.tier as 'task' | 'integration',
        },
        quarantineSignature: gate.quarantine_signature,
        failureEvidence: payload.failureEvidence ?? 'No captured gate output was available.',
      })
      if (stewardEvent.kind !== 'gate-systemic-failure') return false

      await postQuarantineNotice(
        `Verify gate \`${stewardEvent.gate.scope}/${stewardEvent.gate.name}\` remains quarantined after systemic failures. A separate Steward repair proposal will require human validation before anything changes.`,
      )
      await dispatch(stewardEvent)
      return true
    },
  })
}
