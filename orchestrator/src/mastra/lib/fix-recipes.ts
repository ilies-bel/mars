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

export const recipes: Record<string, FixRecipe> = {
  [dirtyMergeTargetRecipe.signature]: dirtyMergeTargetRecipe,
}

export const getRecipe = (signature: string): FixRecipe => {
  const recipe = recipes[signature]
  if (!recipe) {
    throw new Error(`Unknown fix recipe signature: ${signature}`)
  }
  return recipe
}
