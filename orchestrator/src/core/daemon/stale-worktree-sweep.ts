/**
 * Stale-worktree detection — formerly raised stored action-queue rows; now
 * the condition is derived on read from the filesystem by `derived-conditions.ts`
 * (`deriveStaleWorktreeConditions`).  This module is kept as a stub so call
 * sites in `server.ts` compile without change.
 *
 * ADR-0057: `stale-worktree` is a derived kind; no stored rows are written.
 */

/** @deprecated Derived kind (ADR-0057); body text kept for test compatibility. */
export const buildNextActionBody = (
  taskId: string,
  ageHours: number,
  status: string,
): string =>
  `Task ${taskId} has a stale worktree (status: ${status}, last updated ${ageHours}h ago).`

/**
 * No-op stub: `stale-worktree` rows are derived on read from the filesystem by
 * `createConditionItemsSource`; no stored row is written here.  Kept so call
 * sites in `server.ts` compile without change.
 */
export const detectAndRaiseStaleWorktrees = async (
  _repoRoot: string,
): Promise<string[]> => []
