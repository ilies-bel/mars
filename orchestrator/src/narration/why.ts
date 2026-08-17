/**
 * Why-narration — pure helpers that turn a machine-facing reason code into a
 * plain-English sentence an operator can read without opening logs.
 *
 * Extends the narration library (ADR-0055) rather than duplicating it: these
 * functions produce the same kind of deterministic, zero-token strings as
 * {@link import('./narrator.js').narrate}, and are meant to feed the `why`
 * field on {@link import('./types.js').NarrationEvent} at the call sites that
 * currently only have a reason *code* (task-park, verify-gate-failure,
 * merge-block) — no HTTP, DB, or UI imports; no clocks; no randomness.
 */

/** Known verify gates and what each one guards, for verify-failure narration. */
const GATE_GUARDS: Record<string, string> = {
  typecheck: 'the code compiles under the project\'s type checker',
  lint: 'the code follows the project\'s lint rules',
  test: 'the existing test suite still passes',
  build: 'the project still builds for distribution',
  screenshot: 'the changed UI still renders as expected in a browser',
  'browser-check': 'the changed UI still renders as expected in a browser',
  e2e: 'the end-to-end flows still behave as expected',
  format: 'the code is formatted per the project\'s style',
}

/** Known task-park reason codes and their plain-English explanation. */
const PARK_REASONS: Record<string, string> = {
  'live-step': 'this workflow step requires a human to look at something visual or make a judgment call the orchestrator cannot make on its own',
  'awaiting-human': 'the workflow reached a manual step and is waiting on operator input before it can continue',
  'action-required': 'an earlier step surfaced a decision only the operator can make',
  blocked: 'this task is waiting on one or more other tasks to finish first',
}

/** Known merge-block reason codes and their plain-English explanation. */
const MERGE_BLOCK_REASONS: Record<string, string> = {
  'verify-failed': 'the verify gate did not pass, and merging on top of a failing verify would land broken code on the integration branch',
  'dirty-main': 'the integration branch has uncommitted or conflicting changes that must be resolved before a fast-forward merge is safe',
  'lock-held': 'another task is merging right now — merges are serialized so two worktrees never race onto the integration branch at once',
  'stale-worktree': 'the worktree branched before recent changes landed on the integration branch and needs to be rebased or re-verified first',
  'blocked-task': 'this task is still waiting on a blocker task that has not settled (reached done or dropped)',
}

const humanizeCode = (code: string): string => code.replace(/[-_]+/g, ' ').trim()

/**
 * Plain-English reason a task parked awaiting a human, given the park's
 * reason code (e.g. 'live-step', 'awaiting-human', 'blocked'). Falls back to
 * a generic sentence built from the code itself when it is not one of the
 * known codes, so an unrecognised reason is still narrated rather than
 * silently dropped.
 */
export const explainParkReason = (reason: string | null | undefined): string => {
  if (!reason) return 'this task is parked awaiting operator input.'
  const known = PARK_REASONS[reason]
  if (known) return `Parked because ${known}.`
  return `Parked (reason: ${humanizeCode(reason)}) — awaiting operator input.`
}

/**
 * Plain-English reason a verify gate failed: names the gate and what it
 * guards, then appends the concrete failure detail (a short error tail or
 * gate output) when one is available.
 */
export const explainVerifyFailure = (
  gate: string | null | undefined,
  detail?: string | null,
): string => {
  const gateKey = (gate ?? '').toLowerCase()
  const guard = GATE_GUARDS[gateKey]
  const base =
    gate && guard
      ? `Verify failed at the '${gate}' gate — it exists to confirm ${guard}.`
      : gate
        ? `Verify failed at the '${gate}' gate.`
        : 'Verify failed at a verify gate.'
  return detail && detail.trim().length > 0 ? `${base} ${detail.trim()}` : base
}

/**
 * Plain-English reason a merge was blocked, given the merge-block reason
 * code (e.g. 'verify-failed', 'dirty-main', 'lock-held').
 */
export const explainMergeBlock = (reason: string | null | undefined): string => {
  if (!reason) return 'Merge blocked — the orchestrator did not record a specific reason.'
  const known = MERGE_BLOCK_REASONS[reason]
  if (known) return `Merge blocked because ${known}.`
  return `Merge blocked (reason: ${humanizeCode(reason)}).`
}
