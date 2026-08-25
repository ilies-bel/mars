/**
 * QA step-list capability flag helpers.
 *
 * Reads and persists the `qaStepList.enabled` boolean from `.mars/daemon.json`.
 * Provides the `suggestQaStepListCapability` helper that raises a
 * `draft-proposal` action-queue item exactly once per project (deduped by the
 * fixed signature `qa-step-list-capability-suggestion`).
 *
 * The flag is `false` by default — the step-list walk is opt-in.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { raiseActionQueueItem } from './action-queue.js'
import { shortId } from './short-id.js'

/** Dedup signature for the one-per-project enable-capability suggestion. */
export const QA_STEP_LIST_CAPABILITY_SUGGESTION_SIGNATURE = 'qa-step-list-capability-suggestion'

/**
 * Read the `qaStepList.enabled` flag from `<marsStateDir>/daemon.json`.
 *
 * Returns `false` when:
 *  - the file is absent or unreadable,
 *  - the JSON is malformed,
 *  - the `qaStepList` key is missing, or
 *  - `qaStepList.enabled` is not a boolean.
 *
 * The `marsStateDir` parameter makes the function testable without touching
 * the global `resolveContext()` path.
 */
export function readQaStepListFlag(marsStateDir: string): boolean {
  try {
    const raw = readFileSync(join(marsStateDir, 'daemon.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const qaStepList = (parsed as Record<string, unknown>).qaStepList
      if (
        qaStepList !== null &&
        typeof qaStepList === 'object' &&
        !Array.isArray(qaStepList)
      ) {
        const enabled = (qaStepList as Record<string, unknown>).enabled
        if (typeof enabled === 'boolean') return enabled
      }
    }
  } catch {
    // File missing or invalid JSON — default to false.
  }
  return false
}

/**
 * Raise a `draft-proposal` action-queue item offering to enable the QA
 * step-list walk for this project.
 *
 * Deduped globally by the fixed signature
 * `qa-step-list-capability-suggestion` — only one suggestion row exists at
 * any time regardless of how many arcs trigger this call. Best-effort:
 * the caller is expected to swallow any errors so the arc is never blocked.
 */
export async function suggestQaStepListCapability(originId: string): Promise<void> {
  await raiseActionQueueItem({
    kind: 'draft-proposal',
    category: 'orchestrator',
    priority: 'normal',
    title: 'Enable QA step-list walk for this project',
    body: [
      `Arc \`${shortId(originId)}\` completed verification without a QA step-list`,
      'walk because the capability is off by default.',
      '',
      'The QA step-list walk generates a step-by-step guide for each done criterion',
      'and captures a screenshot at each step, producing a durable QA manifest under',
      '`.mars/qa-passes/`. Run:',
      '',
      '```',
      'mars operator set qa-step-list on',
      '```',
      '',
      'to enable it for this project. The walk will run automatically on the next',
      'arc that completes verification.',
    ].join('\n'),
    payload: { originId },
    context: {},
    raisedBy: 'arc-verifier',
    signature: QA_STEP_LIST_CAPABILITY_SUGGESTION_SIGNATURE,
  })
}
