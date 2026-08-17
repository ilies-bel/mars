/**
 * Compact structured checkpoint for resumed coder sessions.
 *
 * This module is the **shared contract** between two consumer slices:
 *
 *   1. **"Inject restart checkpoint into resumed coder brief"** — builds a
 *      {@link RestartCheckpoint} from live worktree state (git log, changed
 *      files, acceptance status, last verify output) and injects the rendered
 *      form into the resume banner so the coder sees prior progress in a
 *      structured, scannable form instead of having to parse `git log -p`.
 *
 *   2. **"Trace restart-checkpoint payload for operator observability"** —
 *      emits a {@link RESTART_CHECKPOINT_KIND} trace event with the same
 *      payload so operators can inspect what context a resumed coder received.
 *
 * Both consumers import types and helpers from this module; this module has
 * no imports from consumer modules to avoid circular dependencies.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One commit that the coder already made on the task branch. */
export interface CommitSummary {
  /** Short (7–12 char) commit SHA. */
  sha: string
  /** First line of the commit message (subject). */
  subject: string
}

/**
 * Compact structured checkpoint passed to a resumed coder session.
 *
 * Populated by the "inject" consumer from live worktree state just before
 * the coder is launched; emitted as a trace event payload by the "trace"
 * consumer for operator observability.
 */
export interface RestartCheckpoint {
  /**
   * Commits already made on this branch since the integration HEAD,
   * oldest-first.
   */
  commits: CommitSummary[]
  /**
   * Repository-relative paths of files changed across all commits on the
   * branch (de-duplicated, sorted).
   */
  changedPaths: string[]
  /**
   * Done-criteria strings that are still `pending` or `not-met`.
   * Empty when no spec is present or all criteria are met.
   */
  remainingCriteria: string[]
  /**
   * Distilled output from the last failing verify run, or `null` if the
   * coder is resuming after a non-verify failure (e.g. a watchdog kill).
   */
  lastVerifyOutput: string | null
}

// ---------------------------------------------------------------------------
// Zod schemas (validation + serialisation)
// ---------------------------------------------------------------------------

export const commitSummarySchema = z.object({
  sha: z.string(),
  subject: z.string(),
})

/**
 * Zod schema for {@link RestartCheckpoint}. Used by both consumers: the
 * inject consumer validates the payload before embedding it in the brief;
 * the trace consumer validates before recording the event.
 */
export const restartCheckpointSchema = z.object({
  commits: z.array(commitSummarySchema),
  changedPaths: z.array(z.string()),
  remainingCriteria: z.array(z.string()),
  lastVerifyOutput: z.string().nullable(),
})

// ---------------------------------------------------------------------------
// Trace event kind
// ---------------------------------------------------------------------------

/**
 * Trace event kind emitted when a restart checkpoint is attached to a
 * resumed coder session.
 *
 * Add this literal to `TRACE_EVENT_KINDS` in `trace-events-store.ts` and
 * use this constant at the emit call site — avoid duplicating the string
 * to keep both sides in sync without a bidirectional import.
 */
export const RESTART_CHECKPOINT_KIND = 'restart-checkpoint' as const

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a {@link RestartCheckpoint} into Markdown suitable for embedding
 * in the coder's resume banner.
 *
 * The rendered block is injected between the "Prior progress is already in
 * this worktree" header and the verify-failure block (if any). It gives the
 * coder a structured, scannable summary of what was already done.
 *
 * Returns an empty string when all three collections are empty (no commits,
 * no changed paths, no remaining criteria) — callers can skip injection in
 * that case.
 */
export function renderRestartCheckpoint(cp: RestartCheckpoint): string {
  const parts: string[] = []

  if (cp.commits.length > 0) {
    const lines = cp.commits.map((c) => `  - \`${c.sha}\` ${c.subject}`).join('\n')
    parts.push(`### Commits already on this branch\n\n${lines}`)
  }

  if (cp.changedPaths.length > 0) {
    const lines = cp.changedPaths.map((p) => `  - ${p}`).join('\n')
    parts.push(`### Files already changed\n\n${lines}`)
  }

  if (cp.remainingCriteria.length > 0) {
    const lines = cp.remainingCriteria.map((c) => `  - [ ] ${c}`).join('\n')
    parts.push(`### Remaining acceptance criteria\n\n${lines}`)
  }

  return parts.join('\n\n')
}
