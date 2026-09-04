/**
 * Re-export of the typed errors the `local-git` `Vcs` implementation throws,
 * so callers can `instanceof`-check them without importing
 * `../../lib/git/worktree` directly (PRD ae17340a slice 37: no module
 * outside `core/ports/vcs/` imports that module). The classes themselves
 * still live in `../../lib/git/worktree.ts` next to the logic that throws
 * them — this module only re-exports the names for the port's consumers.
 */
export {
  OriginWorktreeMissingError,
  WorktreeRebaseConflictError,
  ResumeWorktreeUnrecoverable,
} from '../../lib/git/worktree'

/**
 * Merge error classes and constants re-exported here so port consumers can
 * import them from a single, stable location (PRD aed916c8 slice 7).
 *
 * `MergeAbortedError`, `MergeHardTimeoutError`, and `MERGE_HARD_TIMEOUT_MS`
 * are declared in `./types` (alongside `MergeResult`) to keep the Vcs
 * contract self-contained. `DEFAULT_WATCHDOG_MS` originates in `lib/git/merge`
 * and is re-exported here for the same reason: all merge-related port symbols
 * come from `core/ports/vcs/`.
 */
export { MergeAbortedError, MergeHardTimeoutError, MERGE_HARD_TIMEOUT_MS } from './types'
export { DEFAULT_WATCHDOG_MS } from '../../lib/git/merge'
