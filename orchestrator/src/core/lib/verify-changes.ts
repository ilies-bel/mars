/**
 * Scope-aware verify step selection.
 *
 * Verify routing uses path-containment against a scopes table loaded from
 * the repo's manifest.json:
 *
 *   - The root scope ('.') is an always-on floor — its steps always run.
 *   - A narrower scope (e.g. 'apps/web') contributes its steps only when at
 *     least one changed file falls inside that subtree.
 *   - Root steps appear first; matched narrower scopes follow in declared order.
 *
 * Public API:
 *   selectVerifySteps  — pick steps for a given diff from a recipe
 *   loadVerifyScopes   — parse a manifest.json into a VerifyScope[]
 *   getChangedFiles    — list repo-relative paths changed by a branch
 *   verifyChanges      — run the selected steps and collect results
 *   checkBranchHasDiff — gate: assert the branch has at least one commit
 */
export type {
  VerifyScope,
  VerifyStepSpec,
  VerifyStep,
  VerifyArgs,
} from './git'

export {
  selectVerifySteps,
  loadVerifyScopes,
  getChangedFiles,
  verifyChanges,
  checkBranchHasDiff,
  DEFAULT_VERIFY_STEPS_FALLBACK,
} from './git'
