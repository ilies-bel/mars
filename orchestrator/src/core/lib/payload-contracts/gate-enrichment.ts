/**
 * Payload contract for the `gate-enrichment` action-queue kind.
 */

import type { VerifyStepSpec } from '../../ports/verifier/types'
import type { OccurrenceTrail } from './shared'

/**
 * The operator is asked to approve or retire a candidate verify check.
 *
 * The candidate check lives in `stepSpec` — an **object**, which is why the
 * recipe's old `candidateCheck` string read rendered empty even once the key
 * name was right. Recipes must format it, not stringify it.
 */
export interface GateEnrichmentPayload extends OccurrenceTrail {
  /** Failure signature the candidate check would guard against. */
  signature: string
  /** Static-encodability family, e.g. `'command'`. Null when unclassified. */
  encodableFamily: string | null
  /** Task whose failure produced this candidate. */
  originTaskId: string | null
  /** Verify step that failed, e.g. `verify:build`. */
  failingStep: string
  /** Task that authored the candidate check, if one was spawned. */
  writerTaskId: string | null
  /** The candidate check itself. `null` when no runnable spec was encodable. */
  stepSpec: VerifyStepSpec | null
}

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface GateEnrichmentContracts {
  'gate-enrichment': GateEnrichmentPayload
}

/** Representative fixture for the contract test. */
export const REPRESENTATIVE_PAYLOADS: Record<'gate-enrichment', Record<string, unknown>> = {
  'gate-enrichment': {
    signature: 'sig',
    encodableFamily: 'command',
    originTaskId: 'mars-2',
    failingStep: 'verify:build',
    writerTaskId: 'mars-3',
    stepSpec: { name: 'n', cmd: 'npm', args: ['test'], required: true },
  },
}
