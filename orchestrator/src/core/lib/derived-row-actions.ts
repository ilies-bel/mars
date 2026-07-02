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
        id: 'attach',
        label: 'Attach',
        op: 'copy',
        hint: entityId ? `mars attach ${entityId}` : 'mars attach <id>',
      },
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
  return []
}
