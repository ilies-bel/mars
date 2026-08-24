/**
 * Pure string constants that identify salvage-checkpoint commit subjects.
 *
 * This module deliberately lives OUTSIDE `lib/git/` so domain code (e.g.
 * `core/context-exhausted-supersede.ts`) can import the subject-prefix string
 * without triggering the `vcs-port-only` architectural boundary (ADR-0097).
 *
 * `lib/git/checkpoint.ts` re-exports these constants so its existing callers
 * do not need to change their import paths.
 */

/**
 * Subject prefix of every orchestrator-authored salvage checkpoint commit.
 *
 * Written by `tools/coder/coder-exit.ts` when a coder is killed mid-run:
 *   `wip(checkpoint): <kill-cause> (exit <N>) with <M> uncommitted path(s) — do not merge as-is`
 *
 * Reuse this constant wherever the subject is read back so the two sites
 * cannot drift apart.
 */
export const SALVAGE_CHECKPOINT_SUBJECT_PREFIX = 'wip(checkpoint):'
