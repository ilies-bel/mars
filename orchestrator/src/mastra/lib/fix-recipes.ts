export interface FixRecipeContext {
  targetPath: string
  statusOutput: string
  targetBranch: string
}

export interface FixRecipe {
  signature: string
  title: (ctx: FixRecipeContext) => string
  buildPrompt: (ctx: FixRecipeContext) => string
}

const dirtyMergeTargetRecipe: FixRecipe = {
  signature: 'dirty_merge_target',
  title: (ctx) =>
    `Resolve dirty changes blocking merge into ${ctx.targetBranch}`,
  buildPrompt: (ctx) => {
    const status = ctx.statusOutput.length > 0 ? ctx.statusOutput : '(empty)'
    return [
      `The merge target at ${ctx.targetPath} has uncommitted changes that block a fast-forward merge. Inspect each modified or untracked file:`,
      ` (a) commit files that represent intentional work with a meaningful commit message that describes the actual changes;`,
      ` (b) discard files that are clearly transient (build artifacts, .DS_Store, editor swap files, anything in .gitignore that slipped in via \`git add -f\` etc.);`,
      ` (c) for anything ambiguous, do NOT guess — emit a high-priority inbox notification listing the file(s) and what's unclear, and exit.`,
      '',
      `Do not push. Save your work.`,
      '',
      `Merge target path: ${ctx.targetPath}`,
      `Merge target branch: ${ctx.targetBranch}`,
      '',
      '`git status --porcelain` output:',
      '```',
      status,
      '```',
      '',
      `If you need to file an inbox notification, create a row in .mars/queue.db inbox_items table with priority='high' and a clear message describing the ambiguous file(s).`,
    ].join('\n')
  },
}

const worktreeInstallFailedRecipe: FixRecipe = {
  signature: 'worktree_install_failed',
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

export const recipes: Record<string, FixRecipe> = {
  [dirtyMergeTargetRecipe.signature]: dirtyMergeTargetRecipe,
  [worktreeInstallFailedRecipe.signature]: worktreeInstallFailedRecipe,
}

export const getRecipe = (signature: string): FixRecipe => {
  const recipe = recipes[signature]
  if (!recipe) {
    throw new Error(`Unknown fix recipe signature: ${signature}`)
  }
  return recipe
}
