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

/**
 * Trailer identifying an orchestrator-authored salvage checkpoint commit,
 * written as `Mars-Checkpoint: salvage`.
 *
 * Structural, not a subject grep: a human commit whose subject happens to
 * start with `wip(checkpoint):` carries no trailer and must NOT be treated as
 * an orchestrator salvage snapshot.
 *
 * These live here rather than in `lib/git/checkpoint.ts` so the `local-git`
 * Vcs implementation can read them without importing `checkpoint.ts` — that
 * import was the `local-git → checkpoint → vcs/registry → local-git` cycle
 * which forced `registerVcs(localGitVcs)` out of the registry and made
 * built-in registration depend on who imported what first. `checkpoint.ts`
 * re-exports both, so existing import paths are unchanged.
 */
export const SALVAGE_CHECKPOINT_TRAILER_KEY = 'Mars-Checkpoint'
export const SALVAGE_CHECKPOINT_TRAILER_VALUE = 'salvage'
