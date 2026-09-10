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

const TEACH_SECONDARY: Decision['secondary'] = {
  kind: 'teach-recipe',
  prompt: 'Apply this automatically next time?',
}

const UNTEACHABLE_FAILURE_KINDS = new Set(['unknown', 'manual-park'])

const withTeach = (d: Decision, failureKind: string): Decision =>
  UNTEACHABLE_FAILURE_KINDS.has(failureKind) ? d : { ...d, secondary: TEACH_SECONDARY }

/**
 * One name per op, matching the labels the daemon's own recipes and failure
 * kinds emit ("Restart", "Delete task") — a reader meets these buttons on the
 * same card as those, and three names for `restart` read as three operations.
 *
 * More seriously, the `coder-killed-by-restart` button READ "Continue" and
 * SENT `op: 'restart'`. Those are opposite operations: `mars continue` resumes
 * on the existing worktree and keeps every commit the worker made, while
 * `mars restart` wipes the worktree and branch and throws that work away. A
 * coder killed by a daemon restart is the textbook `continue` case — the
 * worktree is intact and the commits are good — so the one button most likely
 * to be pressed was the one that destroyed the most.
 *
 * `continue` is a first-class daemon op (`protocol.ts`), so this is a straight
 * correction, not a new capability.
 */
const DECISIONS: Record<string, Decision[]> = {
  'coder-killed-by-restart': [
    { label: 'Continue', endpoint: '/api/actions', payload: { op: 'continue' } },
    { label: 'Restart', endpoint: '/api/actions', payload: { op: 'restart' } },
    { label: 'Delete task', endpoint: '/api/actions', payload: { op: 'drop' } },
  ],
  'verify-failed': [
    // A verify failure rewinds to the coder on the SAME worktree with the
    // recorded verify output, so the worker can repair its own diff. Restart
    // discards the diff that was one fix away from passing.
    { label: 'Continue', endpoint: '/api/actions', payload: { op: 'continue' } },
    { label: 'Restart', endpoint: '/api/actions', payload: { op: 'restart' } },
    { label: 'Delete task', endpoint: '/api/actions', payload: { op: 'drop' } },
  ],
  'merge-blocked': [
    { label: 'Continue', endpoint: '/api/actions', payload: { op: 'continue' } },
    { label: 'Restart', endpoint: '/api/actions', payload: { op: 'restart' } },
    { label: 'Delete task', endpoint: '/api/actions', payload: { op: 'drop' } },
  ],
}

/**
 * Return the Decision[] for the given failure kind, or [] for unknown kinds.
 * Called in the `/api/action-queue` handler to enrich each item before it
 * is returned to the client.
 */
export const failureKindDecisions = (kind: string): Decision[] =>
  (DECISIONS[kind] ?? []).map((d) => withTeach(d, kind))
