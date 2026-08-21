/**
 * Verify-vocabulary re-exports — the non-`Verifier`-contract half of
 * `core/lib/git/verify.ts` that callers outside the port still need: the
 * spec-verify-cmd step name constant, worktree cleanup between coder
 * retries, and manifest scope loading/selection for the task verify phase.
 * None of these describe "run the verify gates and report a verdict" (that
 * is `Verifier.run`, resolved via `./registry.ts`) — they build or select
 * the `VerifyStepSpec[]`/`VerifyScope[]` a caller then hands to a
 * `Verifier`. Re-exported here, rather than left as direct
 * `core/lib/git/verify` imports, so the `verifier-port-only` arch-guard
 * rule holds: every outside caller reaches `verify.ts` through this port
 * directory, never around it (ADR-0097).
 */
export {
  SPEC_VERIFY_CMD_STEP,
  cleanWorktreeIfNoCommitsAhead,
  getChangedFiles,
  loadVerifyScopes,
  selectVerifySteps,
} from '../../lib/git/verify'
