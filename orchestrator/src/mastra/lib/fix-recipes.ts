/**
 * Recovery recipes are keyed by failure signature (the technical-key form
 * produced by `computeFailureSignature` — e.g.
 * `merge:preflight/uncommitted-changes`). Each recipe owns the prompt the
 * orchestrator hands to the recovery agent for that exact signature.
 *
 * See docs/adr/0002-recipe-per-failure-signature.md for the contract:
 * a signature without a registered recipe does NOT fall back to a generic
 * prompt — it raises a `no-recipe` inbox item and dispatches the
 * Investigator agent.
 */

export interface FixRecipeContext {
  /** Absolute path of the artifact involved in the failure (worktree, merge target, etc.). */
  targetPath: string
  /** Raw context output captured at failure time (e.g. `git status --porcelain`, install error). */
  statusOutput: string
  /** Branch the failure occurred on (or the merge target branch, depending on recipe). */
  targetBranch: string
}

export interface FixRecipe {
  /** The failure signature this recipe handles (technical key). */
  signature: string
  title: (ctx: FixRecipeContext) => string
  buildPrompt: (ctx: FixRecipeContext) => string
}

const dirtyMergeTargetRecipe: FixRecipe = {
  signature: 'merge:preflight/uncommitted-changes',
  title: (ctx) =>
    `Resolve dirty changes blocking merge into ${ctx.targetBranch}`,
  buildPrompt: (ctx) => {
    const status = ctx.statusOutput.length > 0 ? ctx.statusOutput : '(empty)'
    return [
      `The merge target at ${ctx.targetPath} appeared dirty when merge pre-flight ran, blocking a fast-forward merge into ${ctx.targetBranch}. By the time you read this another task may already have cleaned it up.`,
      '',
      `STEP 1 — re-check first. Run \`git -C ${ctx.targetPath} status --porcelain\` right now.`,
      ` - If the output is empty, the tree is already clean: do NOT touch any file, do NOT commit, do NOT emit an inbox notification. Exit successfully — the original task can be retried as-is.`,
      ` - If the output is non-empty, proceed to STEP 2 with the CURRENT status, not the snapshot below.`,
      '',
      `STEP 2 — only if STEP 1 still shows a dirty tree. Inspect each modified or untracked file:`,
      ` (a) commit files that represent intentional work with a meaningful commit message that describes the actual changes;`,
      ` (b) discard files that are clearly transient (build artifacts, .DS_Store, editor swap files, anything in .gitignore that slipped in via \`git add -f\` etc.);`,
      ` (c) for anything ambiguous, do NOT guess — emit a high-priority inbox notification listing the file(s) and what's unclear, and exit.`,
      '',
      `Do not push. Save your work.`,
      '',
      `Merge target path: ${ctx.targetPath}`,
      `Merge target branch: ${ctx.targetBranch}`,
      '',
      'Original `git status --porcelain` output captured at failure time (may be stale — re-check before acting):',
      '```',
      status,
      '```',
      '',
      `If you need to file an inbox notification, use \`mars inbox raise --from -\` with priority='high' and a clear message describing the ambiguous file(s).`,
    ].join('\n')
  },
}

const worktreeInstallFrozenLockfileRecipe: FixRecipe = {
  signature: 'setup:install/install-frozen-lockfile',
  title: () => `Resolve dependency install failure in worktree setup`,
  buildPrompt: (ctx) => {
    const status = ctx.statusOutput.length > 0 ? ctx.statusOutput : '(empty)'
    return [
      `The orchestrator's worktree setup ran the package manager install (pnpm/npm/yarn/bun) and it failed before any code step ran. Without node_modules the verify step cannot resolve types — that is exactly the TS2688 class of error this recipe addresses.`,
      '',
      `Diagnose and fix the underlying drift. Common causes, in order of likelihood:`,
      ` (a) lockfile drift: \`package.json\` was edited without regenerating the lockfile — regenerate it (e.g. \`pnpm install\` without --frozen-lockfile, or \`npm install\`) and commit both \`package.json\` and the lockfile;`,
      ` (b) missing peer dep declared by a recently bumped package — add the missing peer to \`package.json\` and regenerate the lockfile;`,
      ` (c) registry / network blip: re-run the failing install once before assuming it's a code issue.`,
      '',
      `Do NOT edit \`node_modules\` directly. Do NOT bypass the failure with \`--no-frozen-lockfile\` permanently — the orchestrator runs frozen by design so concurrent worktrees stay reproducible.`,
      '',
      `Failing install directory: ${ctx.targetPath}`,
      `Branch: ${ctx.targetBranch}`,
      '',
      'Install error (truncated):',
      '```',
      status,
      '```',
      '',
      `After fixing, verify locally by deleting \`node_modules\` in that directory and re-running the same install command (\`pnpm install --frozen-lockfile\`, \`npm ci\`, \`yarn install --frozen-lockfile\`, or \`bun install --frozen-lockfile\`) — it must succeed cleanly.`,
      '',
      `Save your work: stage \`package.json\` and the lockfile, then commit with a message describing the dependency change.`,
    ].join('\n')
  },
}

const noCommitsAheadRecipe: FixRecipe = {
  signature: 'verify:has-diff/no-commits-ahead',
  title: (ctx) =>
    `Re-do the original task and commit your work (branch ${ctx.targetBranch})`,
  buildPrompt: (ctx) => {
    return [
      `The previous attempt on branch ${ctx.targetBranch} ended with zero commits ahead of the integration branch — i.e., the agent did the analysis but exited without staging or committing. Verify cannot land work that doesn't exist on the branch.`,
      '',
      `STEP 1 — sanity-check first. Run \`git -C ${ctx.targetPath} log ${ctx.targetBranch} ^${ctx.targetBranch}~ 2>/dev/null || git -C ${ctx.targetPath} log -n 5 --oneline ${ctx.targetBranch}\` to confirm the branch tip really is at the integration branch (no hidden amends).`,
      ` - If commits are present, this recovery is a false positive: do NOT modify files, exit successfully so the original task is retried as-is.`,
      ` - If the branch is genuinely empty, proceed to STEP 2.`,
      '',
      `STEP 2 — RE-DO the original task on this branch. Read the task's prompt from .mars/queue.db (or from the original task row referenced in fix_for_task_id). Apply the changes the original task asked for. **Stage and commit** every file you intend to land, with a clear commit message. Do NOT skip the commit step — that is the entire reason this recovery exists.`,
      '',
      `Branch: ${ctx.targetBranch}`,
      `Worktree: ${ctx.targetPath}`,
      '',
      `Save your work. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const recipeList: readonly FixRecipe[] = [
  dirtyMergeTargetRecipe,
  worktreeInstallFrozenLockfileRecipe,
  noCommitsAheadRecipe,
]

/**
 * Registry keyed by the technical-key signature. The empty registry is
 * legal — the failure handler will treat every observed signature as
 * unrecognized and dispatch the Investigator.
 */
export const recipes: Record<string, FixRecipe> = Object.fromEntries(
  recipeList.map((r) => [r.signature, r]),
)

export const hasRecipe = (signature: string): boolean =>
  Object.prototype.hasOwnProperty.call(recipes, signature)

export const getRecipe = (signature: string): FixRecipe => {
  const recipe = recipes[signature]
  if (!recipe) {
    throw new Error(`Unknown fix recipe signature: ${signature}`)
  }
  return recipe
}

export const listRecipes = (): readonly FixRecipe[] => recipeList
