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
