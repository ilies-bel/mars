/**
 * Factory for the `add-gate` entity handler.
 *
 * Reads the action-queue item's `proposedGate` payload field, inserts it as a
 * verify gate with `source='observation'`, then resolves the action-queue item
 * so it no longer appears in the open queue.
 *
 * The factory takes injected deps so callers (server.ts) and tests can swap
 * implementations without coupling to the DB directly.
 */

import type { VerifyGateInput } from '../verify-gates.js'
import type { ActionQueueItem } from './action-queue.js'

export interface AddGateFromItemDeps {
  /** Fetch an action-queue item by id. Returns null when not found. */
  getItem: (id: string) => Promise<ActionQueueItem | null>
  /** Insert a new verify gate. Returns the generated gate id. */
  addVerifyGate: (input: VerifyGateInput) => Promise<string>
  /** Resolve the action-queue item with the given resolution note. */
  resolveItem: (id: string, note: string) => Promise<void>
}

/**
 * Build the `add-gate` handler bound to the given deps.
 *
 * Throws a descriptive error when the item does not exist or its payload
 * carries no (or incomplete) `proposedGate` — the route layer converts those
 * throws into 4xx/5xx responses.
 */
export const createAddGateFromItem =
  (deps: AddGateFromItemDeps) =>
  async (id: string): Promise<void> => {
    const item = await deps.getItem(id)
    if (!item) {
      throw Object.assign(new Error(`Action queue item not found: ${id}`), {
        code: 'NOT_FOUND' as const,
      })
    }

    const raw = item.payload['proposedGate']
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw Object.assign(
        new Error(
          `Action queue item ${id} has no proposedGate in its payload — cannot add gate`,
        ),
        { code: 'NO_PROPOSED_GATE' as const },
      )
    }

    const proposed = raw as {
      name?: unknown
      cmd?: unknown
      args?: unknown
      scope?: unknown
      evidence?: unknown
    }

    if (typeof proposed.name !== 'string' || !proposed.name) {
      throw Object.assign(
        new Error(
          `proposedGate on item ${id} is missing required field: name`,
        ),
        { code: 'INCOMPLETE_PROPOSED_GATE' as const },
      )
    }
    if (typeof proposed.cmd !== 'string' || !proposed.cmd) {
      throw Object.assign(
        new Error(
          `proposedGate on item ${id} is missing required field: cmd`,
        ),
        { code: 'INCOMPLETE_PROPOSED_GATE' as const },
      )
    }

    const args =
      Array.isArray(proposed.args) &&
      proposed.args.every((a) => typeof a === 'string')
        ? (proposed.args as string[])
        : undefined

    await deps.addVerifyGate({
      name: proposed.name,
      cmd: proposed.cmd,
      args,
      scope: typeof proposed.scope === 'string' ? proposed.scope : undefined,
      evidence:
        typeof proposed.evidence === 'string' ? proposed.evidence : undefined,
      source: 'observation',
    })

    await deps.resolveItem(id, 'gate added by operator')
  }
