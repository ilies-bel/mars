import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  GateDefinitionSchema,
  renderGateFixStewardBrief,
  type GateDefinition,
  type GateSystemicFailureEvent,
} from './agents/steward.js'
import { withTransaction } from './lib/db.js'
import { ensureSchema } from './lib/pg-schema.js'
import { raiseActionQueueItem } from './lib/action-queue.js'
import { resolveStateClient } from './store/state-client.js'

/** The only response shape accepted from a quarantined-gate diagnosis. */
export const GateFixStewardResultSchema = GateDefinitionSchema.extend({
  rationale: z.string().trim().min(1),
}).strict()

export type GateFixStewardResult = z.infer<typeof GateFixStewardResultSchema>

export interface GateFixProposal {
  id: string
  gateId: string
  gateScope: string
  gateName: string
  quarantineSignature: string
  failureEvidence: string
  currentDefinition: GateDefinition
  proposedDefinition: GateDefinition
  rationale: string
  status: 'awaiting-human' | 'approved' | 'rejected'
  createdAt: number
}

export interface GateFixProposalResult {
  proposalId: string
  /** Present only when this call created the proposal and validation message. */
  threadId?: string
  created: boolean
}

/**
 * Persist a proposed repair and its validation message as one transaction.
 * This is deliberately an insert-only lifecycle seam: no gate registry row is
 * changed here, and no approval can activate a gate through this module.
 */
export const stewardProposeGateFix = async (input: {
  event: GateSystemicFailureEvent
  proposedDefinition: GateDefinition
  rationale: string
}): Promise<GateFixProposalResult> => {
  const client = resolveStateClient()
  await ensureSchema(client)
  const now = Date.now()
  const proposalId = randomUUID()
  const threadId = randomUUID()
  const { event, proposedDefinition, rationale } = input

  return withTransaction(client, async (tx) => {
    const inserted = await tx.execute({
      sql: `INSERT INTO gate_fix_proposals (
              id, gate_id, gate_scope, gate_name, quarantine_signature, failure_evidence,
              current_cmd, current_args_json, current_required, current_tier,
              proposed_cmd, proposed_args_json, proposed_required, proposed_tier,
              rationale, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (gate_id, quarantine_signature) DO NOTHING
            RETURNING id`,
      args: [
        proposalId,
        event.gate.id,
        event.gate.scope,
        event.gate.name,
        event.quarantineSignature,
        event.failureEvidence,
        event.currentDefinition.cmd,
        JSON.stringify(event.currentDefinition.args),
        event.currentDefinition.required,
        event.currentDefinition.tier,
        proposedDefinition.cmd,
        JSON.stringify(proposedDefinition.args),
        proposedDefinition.required,
        proposedDefinition.tier,
        rationale,
        now,
      ],
    })
    if (inserted.rows.length === 0) {
      const existing = await tx.execute({
        sql: `SELECT id FROM gate_fix_proposals
               WHERE gate_id = ? AND quarantine_signature = ?`,
        args: [event.gate.id, event.quarantineSignature],
      })
      return {
        proposalId: (existing.rows[0] as { id: string }).id,
        created: false,
      }
    }

    const title = `Verify gate repair: ${event.gate.scope}/${event.gate.name}`
    const body = [
      `The Steward proposes a replacement for quarantined gate \`${event.gate.scope}/${event.gate.name}\`.`,
      '',
      '```json',
      JSON.stringify(proposedDefinition, null, 2),
      '```',
      '',
      rationale,
      '',
      'This is awaiting human validation. The gate remains quarantined until an operator acts.',
    ].join('\n')
    await tx.execute({
      sql: `INSERT INTO chat_threads (id, title, status, posture, created_at, updated_at)
            VALUES (?, ?, 'idle', 'triage', ?, ?)`,
      args: [threadId, title, now, now],
    })
    await tx.execute({
      sql: `INSERT INTO chat_messages
              (id, thread_id, role, content, created_at, context_scope, kind, backing_entity_id)
            VALUES (?, ?, 'assistant', ?, ?, 'subthread', 'validation', ?)`,
      args: [randomUUID(), threadId, body, now, proposalId],
    })
    return { proposalId, threadId, created: true }
  })
}

export const getGateFixProposal = async (proposalId: string): Promise<GateFixProposal | null> => {
  const client = resolveStateClient()
  await ensureSchema(client)
  const result = await client.execute({
    sql: `SELECT * FROM gate_fix_proposals WHERE id = ?`,
    args: [proposalId],
  })
  if (result.rows.length === 0) return null
  const row = result.rows[0] as Record<string, unknown>
  return {
    id: row.id as string,
    gateId: row.gate_id as string,
    gateScope: row.gate_scope as string,
    gateName: row.gate_name as string,
    quarantineSignature: row.quarantine_signature as string,
    failureEvidence: row.failure_evidence as string,
    currentDefinition: {
      cmd: row.current_cmd as string,
      args: JSON.parse(row.current_args_json as string) as string[],
      required: Boolean(row.current_required),
      tier: row.current_tier as GateDefinition['tier'],
    },
    proposedDefinition: {
      cmd: row.proposed_cmd as string,
      args: JSON.parse(row.proposed_args_json as string) as string[],
      required: Boolean(row.proposed_required),
      tier: row.proposed_tier as GateDefinition['tier'],
    },
    rationale: row.rationale as string,
    status: row.status as GateFixProposal['status'],
    createdAt: Number(row.created_at),
  }
}

export interface GateFixStewardDiagnostic {
  gateId: string
  quarantineSignature: string
  reason: string
}

export const raiseGateFixStewardDiagnostic = async ({
  gateId,
  quarantineSignature,
  reason,
}: GateFixStewardDiagnostic): Promise<void> => {
  await raiseActionQueueItem({
    kind: 'gate-broken',
    category: 'verify',
    priority: 'high',
    title: `Steward could not propose a repair for quarantined gate ${gateId}`,
    body: `${reason} The gate remains quarantined; inspect its captured evidence and submit a replacement definition for operator validation.`,
    payload: { gateId, quarantineSignature, reason },
    context: {},
    raisedBy: 'gate-fix-steward',
    signature: `gate-fix-steward:${gateId}:${quarantineSignature}`,
  })
}

export type GateFixStewardOutcome =
  | { outcome: 'proposed'; proposalId: string }
  | { outcome: 'duplicate'; proposalId: string }
  | { outcome: 'empty' | 'invalid' | 'unchanged'; reason: string }

/** A deliberately small seam around the provider invocation for testability. */
export type GateFixStewardWorker = (prompt: string) => Promise<string>

/**
 * Run a repository-read Steward diagnosis and turn only a changed, valid JSON
 * definition into a proposal. The runner has no registry mutation authority.
 */
export const runGateFixSteward = async (
  event: GateSystemicFailureEvent,
  deps: {
    worker: GateFixStewardWorker
    proposeGateFix?: typeof stewardProposeGateFix
    raiseDiagnostic?: (diagnostic: GateFixStewardDiagnostic) => Promise<void>
  },
): Promise<GateFixStewardOutcome> => {
  const output = (await deps.worker(renderGateFixStewardBrief(event))).trim()
  const diagnostic = deps.raiseDiagnostic ?? raiseGateFixStewardDiagnostic
  if (output.length === 0) {
    const reason = 'The Steward returned no repair definition.'
    await diagnostic({ gateId: event.gate.id, quarantineSignature: event.quarantineSignature, reason })
    return { outcome: 'empty', reason }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    const reason = 'The Steward response was not valid JSON matching the required gate definition contract.'
    await diagnostic({ gateId: event.gate.id, quarantineSignature: event.quarantineSignature, reason })
    return { outcome: 'invalid', reason }
  }
  const candidate = GateFixStewardResultSchema.safeParse(parsed)
  if (!candidate.success) {
    const reason = 'The Steward response omitted or invalidated a required gate definition field.'
    await diagnostic({ gateId: event.gate.id, quarantineSignature: event.quarantineSignature, reason })
    return { outcome: 'invalid', reason }
  }
  const { rationale, ...proposedDefinition } = candidate.data
  if (
    event.currentDefinition.cmd === proposedDefinition.cmd &&
    event.currentDefinition.required === proposedDefinition.required &&
    event.currentDefinition.tier === proposedDefinition.tier &&
    event.currentDefinition.args.length === proposedDefinition.args.length &&
    event.currentDefinition.args.every((arg, index) => arg === proposedDefinition.args[index])
  ) {
    const reason = 'The Steward proposed the unchanged quarantined definition.'
    await diagnostic({ gateId: event.gate.id, quarantineSignature: event.quarantineSignature, reason })
    return { outcome: 'unchanged', reason }
  }
  const proposed = await (deps.proposeGateFix ?? stewardProposeGateFix)({
    event,
    proposedDefinition,
    rationale,
  })
  return proposed.created
    ? { outcome: 'proposed', proposalId: proposed.proposalId }
    : { outcome: 'duplicate', proposalId: proposed.proposalId }
}
