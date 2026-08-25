/**
 * Aggregates representative payloads from every kind-family module.
 *
 * Import `ALL_REPRESENTATIVE_PAYLOADS` in the contract test to get a
 * self-maintaining registry: adding a new typed family only requires adding
 * its `REPRESENTATIVE_PAYLOADS` spread here.
 */

import type { ActionQueueKind } from '../action-queue-kinds'
import { REPRESENTATIVE_PAYLOADS as awaitingHuman } from './awaiting-human'
import { REPRESENTATIVE_PAYLOADS as daemonHealth } from './daemon-health'
import { REPRESENTATIVE_PAYLOADS as gateEnrichment } from './gate-enrichment'
import { REPRESENTATIVE_PAYLOADS as lifecycle } from './lifecycle'
import { REPRESENTATIVE_PAYLOADS as proposals } from './proposals'
import { REPRESENTATIVE_PAYLOADS as scheduling } from './scheduling'
import { REPRESENTATIVE_PAYLOADS as sliceWorkflow } from './slice-workflow'
import { REPRESENTATIVE_PAYLOADS as spend } from './spend'
import { REPRESENTATIVE_PAYLOADS as validationQa } from './validation-qa'
import { REPRESENTATIVE_PAYLOADS as verify } from './verify'

/**
 * One representative payload per typed action-queue kind.
 *
 * Typed as `Partial` because not every `ActionQueueKind` is typed yet — only
 * those with a family module entry are covered. The contract test asserts that
 * every kind marked `'typed'` in `ACTION_QUEUE_PAYLOAD_AUDIT` appears here.
 */
export const ALL_REPRESENTATIVE_PAYLOADS: Partial<Record<ActionQueueKind, Record<string, unknown>>> = {
  ...awaitingHuman,
  ...daemonHealth,
  ...gateEnrichment,
  ...lifecycle,
  ...proposals,
  ...scheduling,
  ...sliceWorkflow,
  ...spend,
  ...validationQa,
  ...verify,
}
