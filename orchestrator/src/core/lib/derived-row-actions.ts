/**
 * Recovery action menus for the non-failure derived action-queue row kinds.
 *
 * ADR-0042 collapses the *failure* classification into the signature-keyed
 * `FailureKind` record (`failure-kinds.ts`). But two derived action-queue row
 * kinds are not failures and have no `<failingStep>/<error-class>` signature:
 *
 *   - `stale-worktree`  — a leftover `.mars/worktrees/<id>` directory whose
 *                         task is terminal/absent.
 *   - `draft-proposal`  — a proposal sitting in `draft`, awaiting shaping.
 *
 * These keep an explicit, row-kind-keyed action menu here. The menus are the
 * same declarative `ActionDescriptor` data the failure layer uses (data, never
 * functions, so they serialise to the browser over the daemon HTTP layer).
 *
 * This is deliberately tiny and frozen — the bulk of "what can I do about
 * this?" now lives on the FailureKind record; this module covers only the
 * handful of derived rows that are not failures.
 */

import type { ActionDescriptor } from './failure-kinds'

/** The non-failure derived action-queue row kinds. */
export type DerivedRowKind =
  | 'stale-worktree'
  | 'draft-proposal'
  | 'awaiting-validation'
  | 'awaiting-human'
  | 'reflect-recommended'
  | 'workflow-draft-pending'
  | 'scorer-suggested'
  | 'signature-storm'
  | 'worktree-ahead'

/**
 * Resolve the recovery menu for a non-failure derived row kind. Returns an
 * empty list for any other kind (failed-task rows derive their menu from the
 * FailureKind registry instead).
 *
 * For draft-proposal rows the `entityId` is interpolated into the copy-action
 * hint so the UI can copy a fully-qualified runnable command (e.g.
 * `/mars:grill <proposalId>`).
 */
export const derivedRowActions = (rowKind: string, entityId?: string): ActionDescriptor[] => {
  if (rowKind === 'stale-worktree') {
    return [
      { id: 'investigate', label: 'Investigate', op: 'investigate' },
      {
        id: 'prune',
        label: 'Prune worktree',
        op: 'prune-worktree',
        needsConfirm: true,
      },
    ]
  }
  if (rowKind === 'draft-proposal') {
    return [
      {
        id: 'move-forward',
        label: 'Move forward',
        op: 'copy',
        hint: entityId ? `/mars:grill ${entityId}` : '/mars:grill',
      },
      { id: 'dismiss', label: 'Dismiss', op: 'dismiss', needsConfirm: true },
    ]
  }
  if (rowKind === 'awaiting-validation') {
    return [
      { id: 'validate', label: 'Validate', op: 'validate' },
      { id: 'reject', label: 'Reject', op: 'reject', needsConfirm: true },
    ]
  }
  if (rowKind === 'awaiting-human') {
    return [
      {
        id: 'release',
        label: 'Release',
        op: 'copy',
        hint: entityId ? `mars release ${entityId}` : 'mars release <id>',
      },
      {
        id: 'abort',
        label: 'Abort',
        op: 'copy',
        hint: entityId ? `mars release --abort ${entityId}` : 'mars release --abort <id>',
        needsConfirm: true,
      },
    ]
  }
  if (rowKind === 'reflect-recommended') {
    return [
      { id: 'run-reflect', label: 'Run reflect', op: 'run-reflect' },
      { id: 'enable-auto', label: 'Enable auto', op: 'enable-auto-reflect' },
    ]
  }
  if (rowKind === 'workflow-draft-pending') {
    // Approval is a deliberate operator gesture at the CLI (ADR-0068): the
    // menu copies the review + approve commands rather than mutating anything
    // from the browser.
    return [
      {
        id: 'review',
        label: 'Review runbook',
        op: 'copy',
        hint: entityId ? `mars workflow show ${entityId}` : 'mars workflow show <name>',
      },
      {
        id: 'approve',
        label: 'Approve',
        op: 'copy',
        hint: entityId ? `mars workflow approve ${entityId}` : 'mars workflow approve <name>',
      },
    ]
  }
  if (rowKind === 'scorer-suggested') {
    // Entity verbs only (ADR-0048 pure projection): the row leaves when the
    // scorer leaves status='suggested'. Copy-actions hand the operator the
    // runnable CLI verbs rather than adding a queue-side close op.
    return [
      {
        id: 'accept',
        label: 'Accept',
        op: 'copy',
        hint: entityId ? `mars scorer accept ${entityId}` : 'mars scorer accept',
      },
      {
        id: 'dismiss',
        label: 'Dismiss',
        op: 'copy',
        hint: entityId ? `mars scorer dismiss ${entityId}` : 'mars scorer dismiss',
        needsConfirm: true,
      },
    ]
  }
  if (rowKind === 'worktree-ahead') {
    return [
      { id: 'land-work', label: 'Land work', op: 'land-work' },
      { id: 'prune-worktree', label: 'Discard unmerged work', op: 'prune-worktree', needsConfirm: true },
    ]
  }
  if (rowKind === 'signature-storm') {
    // Signature storm: queue is paused; operator must fix the environment
    // and manually resume dispatch. Copy-action hands the operator the
    // resume command rather than adding a server-side close op.
    return [
      {
        id: 'resume',
        label: 'Resume queue',
        op: 'copy',
        hint: 'mars operator',
      },
    ]
  }
  return []
}
