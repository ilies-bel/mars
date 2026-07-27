/**
 * Per-failure-kind Decision buttons attached to ActionQueueItems before they
 * are sent to the UI.  Each Decision maps to exactly one button on the
 * AlertCard — the client POSTs the decision's `payload` to `endpoint` without
 * any client-side switch on failure kind.
 *
 * Endpoint: `/api/actions`  Body: `{ op, entityId }` where `entityId` is
 * merged in client-side from the item's own `entityId` field.
 */
import type { Decision } from '../src/shared/schemas.ts'

const DECISIONS: Record<string, Decision[]> = {
  'coder-killed-by-restart': [
    { label: 'Continue', endpoint: '/api/actions', payload: { op: 'restart' } },
    { label: 'Drop', endpoint: '/api/actions', payload: { op: 'drop' } },
  ],
  'verify-failed': [
    { label: 'Retry', endpoint: '/api/actions', payload: { op: 'restart' } },
    { label: 'Drop', endpoint: '/api/actions', payload: { op: 'drop' } },
  ],
  'merge-blocked': [
    { label: 'Retry Merge', endpoint: '/api/actions', payload: { op: 'restart' } },
    { label: 'Drop', endpoint: '/api/actions', payload: { op: 'drop' } },
  ],
}

/**
 * Return the Decision[] for the given failure kind, or [] for unknown kinds.
 * Called in the `/api/action-queue` handler to enrich each item before it
 * is returned to the client.
 */
export const failureKindDecisions = (kind: string): Decision[] =>
  DECISIONS[kind] ?? []
