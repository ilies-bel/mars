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
export type DerivedRowKind = 'stale-worktree' | 'draft-proposal'

/** Recovery menus keyed by the non-failure derived row kind. */
export const DERIVED_ROW_ACTIONS: Readonly<
  Record<DerivedRowKind, ActionDescriptor[]>
> = Object.freeze({
  'stale-worktree': [
    { id: 'investigate', label: 'Investigate', op: 'investigate' },
    {
      id: 'prune',
      label: 'Prune worktree',
      op: 'prune-worktree',
      needsConfirm: true,
    },
  ],
  'draft-proposal': [
    { id: 'shape', label: 'Shape', op: 'shape', hint: '/mars:grill' },
  ],
})

/**
 * Resolve the recovery menu for a non-failure derived row kind. Returns an
 * empty list for any other kind (failed-task rows derive their menu from the
 * FailureKind registry instead).
 */
export const derivedRowActions = (rowKind: string): ActionDescriptor[] =>
  rowKind === 'stale-worktree' || rowKind === 'draft-proposal'
    ? DERIVED_ROW_ACTIONS[rowKind]
    : []
