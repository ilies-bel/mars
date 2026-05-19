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
  /**
   * Integration branch the task is meant to land on (the merge target —
   * usually `main`, configurable via `INTEGRATION_BRANCH`). Required by
   * recipes that need to compare the task branch against integration,
   * e.g. `verify:has-diff/no-commits-ahead`.
   */
  integrationBranch?: string
  /**
   * Optional deterministic command (with cwd hint) the recovery agent can
   * run to reproduce the failure locally. When present, recipes should
   * render it under a `## Reproduce` heading in their prompt.
   */
  reproCommand?: string | null
  /**
   * Prompt of the original (source) task this recovery is unblocking.
   * Injected by `handleTaskFailureWithFixTask` so recipes can inline it
   * verbatim — keeps the recovery agent from burning its turn budget on
   * `.mars/queue.db` exploration before making the edit. Defaults to ''
   * only when the source task genuinely has no prompt recorded.
   */
  originalPrompt: string
}

/**
 * Render an optional reproduce section under a `## Reproduce` heading.
 * Returns an empty array when no reproCommand is supplied so callers can
 * spread it into their prompt-line arrays without conditional branches.
 */
export const renderReproSection = (
  reproCommand: string | null | undefined,
): readonly string[] => {
  if (!reproCommand) return []
  return ['## Reproduce', '', '```', reproCommand, '```', '']
}

export interface FixRecipe {
  /** The failure signature this recipe handles (technical key). */
  signature: string
  title: (ctx: FixRecipeContext) => string
  buildPrompt: (ctx: FixRecipeContext) => string
  /**
   * When true, a single outstanding fix-task is shared across every
   * source task that hits this signature: subsequent failures attach
   * a new `task_blockers` edge to the existing fix-task instead of
   * spawning a duplicate. Used for repository-global remediations
   * like cleaning a dirty merge target — one commit unblocks the herd.
   */
  shared?: boolean
}

const dirtyMergeTargetRecipe: FixRecipe = {
  signature: 'merge:preflight/uncommitted-changes',
  shared: true,
  title: (ctx) =>
    `Resolve dirty changes blocking merge into ${ctx.targetBranch}`,
  buildPrompt: (ctx) => {
    const status = ctx.statusOutput.length > 0 ? ctx.statusOutput : '(empty)'
    return [
      `The merge target at ${ctx.targetPath} appeared dirty when merge pre-flight ran, blocking a fast-forward merge into ${ctx.targetBranch}. By the time you read this another task may already have cleaned it up.`,
      '',
      ...renderReproSection(ctx.reproCommand),
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
      ...renderReproSection(ctx.reproCommand),
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

const worktreeInstallTimeoutRecipe: FixRecipe = {
  signature: 'setup:install/install-timeout',
  title: () => `Resolve wedged install (SIGKILL); check for lockfile drift or network issues`,
  buildPrompt: (ctx) => {
    const status = ctx.statusOutput.length > 0 ? ctx.statusOutput : '(empty)'
    return [
      `The orchestrator's worktree setup ran the package manager install (pnpm/npm/yarn/bun) and it was killed by the wall-clock timeout (SIGKILL, exit 137). This usually means the install wedged — either a network stall, a registry outage, or a lockfile drift that caused the solver to spin.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `Diagnose and fix the underlying cause. Common causes, in order of likelihood:`,
      ` (a) lockfile drift: \`package.json\` was edited without regenerating the lockfile — regenerate it (e.g. \`pnpm install\` without --frozen-lockfile, or \`npm install\`) and commit both \`package.json\` and the lockfile;`,
      ` (b) registry / network blip: the install wedged waiting for a package that never arrived — re-run the failing install once before assuming it's a code issue;`,
      ` (c) missing peer dep declared by a recently bumped package — add the missing peer to \`package.json\` and regenerate the lockfile.`,
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
      `After fixing, verify locally by deleting \`node_modules\` in that directory and re-running the same install command (\`pnpm install --frozen-lockfile\`, \`npm ci\`, \`yarn install --frozen-lockfile\`, or \`bun install --frozen-lockfile\`) — it must succeed cleanly within the timeout window (8 minutes).`,
      '',
      `Save your work: stage \`package.json\` and the lockfile if changed, then commit with a message describing the dependency change.`,
    ].join('\n')
  },
}

const noCommitsAheadRecipe: FixRecipe = {
  signature: 'verify:has-diff/no-commits-ahead',
  title: (ctx) =>
    `Re-do the original task and commit your work (failing branch ${ctx.targetBranch})`,
  buildPrompt: (ctx) => {
    const integration = ctx.integrationBranch ?? 'main'
    const countCmd = `git rev-list --count ${integration}..HEAD`
    const sourcePromptSection =
      ctx.originalPrompt.trim().length > 0
        ? [
            `## Original task prompt (inlined — do not re-fetch from .mars/queue.db)`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `The previous attempt on branch ${ctx.targetBranch} ended with zero commits ahead of integration branch ${integration} — i.e., the agent did real work but exited without running \`git commit\`. Verify cannot land work that doesn't exist on the branch.`,
      '',
      `You are running in a FRESH recovery worktree on a FRESH branch (not ${ctx.targetBranch}). Your job is to leave a commit HERE — in your own \`cwd\`, on your own branch. Do NOT \`cd\` into ${ctx.targetPath} and do NOT edit files there: that worktree is the failing tree, never the right merge source for this recovery.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `STEP 1 — sanity-check first. From your current working directory, run \`${countCmd}\` to count commits on your recovery branch that are not yet on integration. The output is a plain integer.`,
      ` - If it prints \`0\`, your branch is genuinely empty: proceed to STEP 2.`,
      ` - If it prints a non-zero integer (you already committed on a previous turn / out-of-band push), this recovery is a true false positive: do NOT modify files, exit successfully.`,
      '',
      `Do not use \`git log\`, \`git log -n 5\`, or any other command to make this decision — only the integer from \`rev-list --count\` is authoritative. Other commands print integration-branch commits and will mislead you into the false-positive branch.`,
      '',
      `STEP 2 — Inspect the failing worktree (read-only) and prefer lifting its diff. Only enter this step when \`${countCmd}\` printed \`0\`.`,
      '',
      `In almost every observed case of this failure, the failing worktree contains staged-but-uncommitted work — the previous agent ran \`git add\` (or made edits) and then exited without \`git commit\`. That diff is real, often complete, and is the fastest path to a green commit on your recovery branch.`,
      '',
      `Run these read-only checks against the failing worktree to see what is there:`,
      '',
      '```',
      `git -C ${ctx.targetPath} status --short`,
      `git -C ${ctx.targetPath} diff --stat HEAD`,
      `git -C ${ctx.targetPath} diff HEAD     # full diff; pipe to a file if large`,
      '```',
      '',
      `Decide between these two paths based on what you see:`,
      '',
      `**Path A — lift the existing diff (preferred when there is one).** If \`git -C ${ctx.targetPath} diff HEAD\` is non-empty and looks like a faithful attempt at the original task:`,
      ` 1. Capture the diff to a file in YOUR worktree: \`git -C ${ctx.targetPath} diff HEAD > /tmp/recover-${ctx.targetBranch.replace(/[^a-zA-Z0-9-]/g, '-')}.patch\` (and inspect any untracked files via \`git -C ${ctx.targetPath} ls-files --others --exclude-standard\`; copy them in too if relevant).`,
      ` 2. Apply it in YOUR cwd: \`git apply --3way /tmp/recover-*.patch\` (or \`git apply --reject\` and resolve any \`.rej\` files by hand).`,
      ` 3. **Commit immediately**: \`git add -A && git commit -m "recover: <one-line summary lifted from the original task>"\`. Do this BEFORE running tests, BEFORE refactoring, BEFORE refining the message.`,
      ` 4. Re-run \`${countCmd}\`. It MUST now print a non-zero integer. If it still prints \`0\`, your commit did not land — fix that before anything else.`,
      ` 5. Only after step 4 prints non-zero may you iterate: fix anything the original prompt's verify commands flag, add missing pieces, polish the commit message via \`git commit --amend\`.`,
      '',
      `**Path B — re-do from scratch (only when the failing worktree's diff is empty or unusable).** If \`git -C ${ctx.targetPath} diff HEAD\` is empty, or the diff is obviously broken/off-topic:`,
      '',
      ...sourcePromptSection,
      ` 1. Read the **Original task prompt** above. It is already inlined — do NOT \`grep\` for it, do NOT open \`.mars/queue.db\`.`,
      ` 2. Identify the smallest viable edit that satisfies the prompt's acceptance criteria. If the prompt names a chokepoint file/symbol/line, edit THAT file and only that file. If you're choosing between two edits, pick the smaller one.`,
      ` 3. Apply that edit IN YOUR CURRENT WORKTREE. A stub plus a TODO test is acceptable — a parked, partly-correct commit is strictly better than no commit at all.`,
      ` 4. **Commit immediately**: \`git add -A && git commit -m "recover: <one-line summary>"\`. Do this BEFORE running tests, BEFORE refactoring, BEFORE refining the message, BEFORE any further exploration.`,
      ` 5. Re-run \`${countCmd}\`. It MUST now print a non-zero integer. If it still prints \`0\`, your commit did not land on your current branch — fix that before anything else.`,
      ` 6. Only after step 5 prints non-zero may you iterate.`,
      '',
      `Example of an acceptable minimal first commit when the original prompt asks for a behaviour change in \`src/foo.ts\`:`,
      ` - edit \`src/foo.ts\` with the smallest stub that compiles and reflects the intended behaviour;`,
      ` - add a \`TODO\` comment naming the follow-up (e.g. \`// TODO: cover the empty-input case\`);`,
      ` - \`git add src/foo.ts && git commit -m "recover: stub <behaviour> in src/foo.ts (TODO: tests)"\`.`,
      `That commit unblocks verify. Refinement happens in subsequent commits on the same branch.`,
      '',
      `Failing task branch (for context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only — \`git -C ${ctx.targetPath} ...\` for inspection only, never edit there): ${ctx.targetPath}`,
      `Integration branch: ${integration}`,
      '',
      `Save your work. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const vcsAbortedNotFastForwardRecipe: FixRecipe = {
  signature: 'merge:vcs-supervisor-aborted/not-fast-forward',
  title: (ctx) => {
    const integration = ctx.integrationBranch ?? 'main'
    return `Re-land ${ctx.targetBranch} onto current ${integration} (diverged after VCS supervisor rebased)`
  },
  buildPrompt: (ctx) => {
    const integration = ctx.integrationBranch ?? 'main'
    const countCmd = `git rev-list --count ${integration}..HEAD`
    const sanitizedBranch = ctx.targetBranch.replace(/[^a-zA-Z0-9-]/g, '-')
    const patchFile = `/tmp/recover-${sanitizedBranch}.patch`
    const sourcePromptSection =
      ctx.originalPrompt.trim().length > 0
        ? [
            `## Original task prompt (inlined — do not re-fetch from .mars/queue.db)`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `Branch ${ctx.targetBranch} has committed work, but ${integration} advanced in the window between the VCS supervisor's rebase and the final fast-forward merge attempt. The coding work is fully committed on the branch — it just needs to be re-applied on top of the current ${integration}.`,
      '',
      `You are running in a FRESH recovery worktree on a FRESH branch (not ${ctx.targetBranch}). Your job is to re-apply the failing branch's changes HERE — in your own cwd, on your own branch. Do NOT \`cd\` into ${ctx.targetPath} and do NOT edit files there: that is the failing tree, never the right merge source for this recovery.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `STEP 1 — sanity-check first. From your current working directory, run \`${countCmd}\` to count commits on your recovery branch not yet on ${integration}. The output is a plain integer.`,
      ` - If it prints a non-zero integer, your recovery branch already has commits: this is a false positive — do NOT modify files, exit successfully.`,
      ` - If it prints \`0\`, your branch is genuinely empty: proceed to STEP 2.`,
      '',
      `Do not use \`git log\` or any other command to make this decision — only the integer from \`rev-list --count\` is authoritative.`,
      '',
      `STEP 2 — Lift the committed diff from the failing branch and apply it in YOUR worktree. Only enter this step when \`${countCmd}\` printed \`0\`.`,
      '',
      `Run these read-only checks against the failing worktree to see what was committed:`,
      '',
      '```',
      `git -C ${ctx.targetPath} log ${integration}..HEAD --oneline`,
      `git -C ${ctx.targetPath} diff ${integration}..HEAD --stat`,
      `git -C ${ctx.targetPath} diff ${integration}..HEAD   # full diff; pipe to a file if large`,
      '```',
      '',
      `Apply the diff in YOUR current worktree:`,
      '',
      ` 1. Capture: \`git -C ${ctx.targetPath} diff ${integration}..HEAD > ${patchFile}\``,
      ` 2. Apply: \`git apply --3way ${patchFile}\` (or \`git apply --reject\` and resolve any \`.rej\` files by hand if there are conflicts).`,
      ` 3. **Commit immediately**: \`git add -A && git commit -m "recover: re-land <summary> onto ${integration}"\`. Do this BEFORE running tests, BEFORE refactoring, BEFORE refining the message.`,
      ` 4. Re-run \`${countCmd}\`. It MUST now print a non-zero integer. If it still prints \`0\`, your commit did not land — fix that before anything else.`,
      ` 5. Only after step 4 prints non-zero may you iterate: run the original verify commands, fix any issues, and polish the commit message via \`git commit --amend\`.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (for context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only — \`git -C ${ctx.targetPath} ...\` for inspection only, never edit there): ${ctx.targetPath}`,
      `Integration branch: ${integration}`,
      '',
      `Save your work. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const typecheckMissingExportRecipe: FixRecipe = {
  signature: 'verify:typecheck/typecheck-missing-export',
  title: () =>
    `Implement missing exported member(s) to resolve TS2694 typecheck failure`,
  buildPrompt: (ctx) => {
    const sourcePromptSection =
      ctx.originalPrompt.trim().length > 0
        ? [
            `## Original task prompt (inlined — do not re-fetch from .mars/queue.db)`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `TypeScript reported TS2694 ("Namespace has no exported member") during the typecheck step. This means a source or test file imports a named export that does not exist in the target module.`,
      '',
      `The most common cause is TDD work where tests were written before the implementation was added — the failing task wrote tests that reference a function which was never implemented in the module.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `## How to fix`,
      '',
      `STEP 1 — Identify the missing export. From your current working directory, run the typecheck to see the TS2694 errors:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit 2>&1 | grep "TS2694"`,
      '```',
      '',
      `Each error line has the form:`,
      `  <file>(<line>,<col>): error TS2694: Namespace '<module-path>' has no exported member '<name>'.`,
      '',
      `For each missing export '<name>' in module '<module-path>':`,
      ` (a) Open the test file at <file> and read the tests that call '<name>' to understand the expected signature and behaviour.`,
      ` (b) Open the implementation file at <module-path>.ts and add the missing function/type/constant with the correct export.`,
      ` (c) If the failing task prompt (inlined below) specifies the implementation — use it verbatim. Do not guess or invent behaviour not described there.`,
      '',
      `STEP 2 — After implementing the missing export(s), re-run the typecheck:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit`,
      '```',
      '',
      ` - If TS2694 errors are gone but other errors remain (e.g. TS7006 "implicitly has any type"), those are cascade errors caused by the missing export — they will clear automatically once the export is in place and TypeScript can infer types.`,
      ` - If fresh, unrelated TS errors appear, fix them too (they are in scope — you are in a recovery worktree with no prior commits).`,
      '',
      `STEP 3 — Run any tests named in the original prompt's verify command to confirm behaviour is correct, not just type-correct.`,
      '',
      `## Important constraints`,
      ` - Do NOT delete or modify the test file. The tests describe the intended behaviour — the implementation must satisfy them.`,
      ` - Do NOT add an \`export * from\` or \`// @ts-ignore\` to paper over the error — implement the actual function.`,
      ` - If the missing export requires a new DB column, new table, or other schema change, STOP: raise a high-priority inbox item via \`mars inbox raise --from -\` explaining the blocker, then exit. Do not silently expand scope.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only): ${ctx.targetPath}`,
      '',
      `Save your work: stage all changed files and commit. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const typecheckArgTypeMismatchRecipe: FixRecipe = {
  signature: 'verify:typecheck/typecheck-arg-type-mismatch',
  title: () =>
    `Fix argument type mismatch(es) to resolve TS2345 typecheck failure`,
  buildPrompt: (ctx) => {
    const sourcePromptSection =
      ctx.originalPrompt.trim().length > 0
        ? [
            `## Original task prompt (inlined — do not re-fetch from .mars/queue.db)`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `TypeScript reported TS2345 ("Argument of type X is not assignable to parameter of type Y") during the typecheck step. This means the code is passing an argument that does not match the parameter type expected by the function being called.`,
      '',
      `The most common cause in this codebase is test code that passes a Promise \`resolve\` function directly as an error-first callback. For example:`,
      ``,
      '```typescript',
      `// WRONG — TypeScript rejects this because server.close() expects`,
      `// (err?: Error | undefined) => void, not a Promise resolver.`,
      `await new Promise<void>((resolve) => server.close(resolve))`,
      ``,
      `// CORRECT — wrap the callback to bridge the error-first signature.`,
      `await new Promise<void>((resolve, reject) =>`,
      `  server.close((err) => (err ? reject(err) : resolve()))`,
      `)`,
      '```',
      '',
      ...renderReproSection(ctx.reproCommand),
      `## How to fix`,
      '',
      `STEP 1 — Identify the TS2345 errors. From your current working directory, run:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit 2>&1 | grep "TS2345"`,
      '```',
      '',
      `Each error line has the form:`,
      `  <file>(<line>,<col>): error TS2345: Argument of type '<ActualType>' is not assignable to parameter of type '<ExpectedType>'.`,
      '',
      `For each TS2345 error:`,
      ` (a) Open <file> at <line> and read the call site.`,
      ` (b) Identify what the function expects (the "parameter of type" in the error) and what you are passing (the "argument of type" in the error).`,
      ` (c) Adapt the argument to match the expected type. Common patterns:`,
      `     • **Promise resolver passed as error-first callback**: change`,
      `       \`new Promise<void>((resolve) => fn(resolve))\``,
      `       to`,
      `       \`new Promise<void>((resolve, reject) => fn((err) => err ? reject(err) : resolve()))\``,
      `     • **Wrong object shape**: add or remove fields so the argument matches the parameter interface.`,
      `     • **Union type mismatch**: narrow the value before passing it (e.g. \`if (x instanceof Error) ...\`).`,
      '',
      `STEP 2 — Re-run the typecheck after each fix:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit`,
      '```',
      '',
      ` - Fix TS2345 errors first. Other cascading errors (e.g. TS7006) may clear automatically once argument types are correct.`,
      ` - If fresh, unrelated TS errors appear, fix them too — you are in a recovery worktree with no prior commits.`,
      '',
      `STEP 3 — Run the tests that live in the same file(s) as the fixed call sites to confirm the fix is behaviourally correct, not just type-correct.`,
      '',
      `## Important constraints`,
      ` - Do NOT add \`// @ts-ignore\` or \`as any\` casts to silence the error — fix the actual type.`,
      ` - Do NOT change the function's parameter type to accept the wrong argument — adapt the argument to match the declared parameter.`,
      ` - If fixing the argument type requires a schema change (new DB column, new table, etc.), STOP: raise a high-priority inbox item via \`mars inbox raise --from -\` explaining the blocker, then exit.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only): ${ctx.targetPath}`,
      '',
      `Save your work: stage all changed files and commit. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const testAssertionErrorRecipe: FixRecipe = {
  signature: 'verify:test/test-assertion-error',
  title: (ctx) =>
    `Fix failing test assertions in ${ctx.targetBranch}`,
  buildPrompt: (ctx) => {
    const integration = ctx.integrationBranch ?? 'main'
    const countCmd = `git rev-list --count ${integration}..HEAD`
    const sanitizedBranch = ctx.targetBranch.replace(/[^a-zA-Z0-9-]/g, '-')
    const patchFile = `/tmp/recover-${sanitizedBranch}.patch`
    const failureOutput =
      ctx.statusOutput.length > 0
        ? ctx.statusOutput
        : '(no test output captured)'
    const sourcePromptSection =
      ctx.originalPrompt.trim().length > 0
        ? [
            `## Original task prompt (inlined — do not re-fetch from .mars/queue.db)`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `The previous attempt on branch ${ctx.targetBranch} failed the verify:test step with AssertionError — the implementation does not match what the tests expect. The coding work is present in the failing worktree; it needs targeted fixes to make the failing assertions green.`,
      '',
      `You are running in a FRESH recovery worktree on a FRESH branch (not ${ctx.targetBranch}). Your job is to leave a commit HERE — in your own cwd, on your own branch. Do NOT \`cd\` into ${ctx.targetPath} and do NOT edit files there: that is the failing tree, inspect it read-only only.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `STEP 1 — sanity-check first. From your current working directory, run \`${countCmd}\` to count commits on your recovery branch not yet on ${integration}. The output is a plain integer.`,
      ` - If it prints a non-zero integer, your recovery branch already has commits: this is a false positive — do NOT modify files, exit successfully.`,
      ` - If it prints \`0\`, your branch is genuinely empty: proceed to STEP 2.`,
      '',
      `Do not use \`git log\` or any other command to make this decision — only the integer from \`rev-list --count\` is authoritative.`,
      '',
      `STEP 2 — Lift the failing worktree's diff into YOUR recovery worktree. Only enter this step when \`${countCmd}\` printed \`0\`.`,
      '',
      `Inspect what the previous agent did (read-only against the failing worktree):`,
      '',
      '```',
      `git -C ${ctx.targetPath} diff ${integration}..HEAD --stat`,
      `git -C ${ctx.targetPath} diff ${integration}..HEAD`,
      '```',
      '',
      ` 1. Capture: \`git -C ${ctx.targetPath} diff ${integration}..HEAD > ${patchFile}\``,
      ` 2. Apply: \`git apply --3way ${patchFile}\` (resolve any \`.rej\` files by hand if needed).`,
      ` 3. **Commit immediately**: \`git add -A && git commit -m "recover: lift diff from ${ctx.targetBranch}"\`. Do this BEFORE running tests or fixing anything.`,
      ` 4. Re-run \`${countCmd}\`. It MUST now print a non-zero integer. If it still prints \`0\`, fix that before anything else.`,
      '',
      `STEP 3 — Fix only the failing assertions. Use the captured test output at the bottom of this prompt to identify exactly what is wrong.`,
      '',
      `**Critical rule: do NOT modify test files.** Tests define expected behaviour. Fix the implementation files only. Each AssertionError tells you exactly what the implementation must produce — read it literally.`,
      '',
      `Common causes of assertion mismatches, in order of likelihood:`,
      ` (a) wrong string literal — the implementation prints a different message than what the test contains in \`toContain\` / \`toBe\` / \`toEqual\`;`,
      ` (b) missing \`process.exit\` call — the test wraps the call in a mock-exit helper that only records exit when \`process.exit()\` is explicitly called; if the implementation just \`return\`s, the exit code stays at the sentinel \`-1\`;`,
      ` (c) missing or incorrect side-effect — the test checks a file was created or removed, but the implementation skips that step.`,
      '',
      `After each fix, re-run the failing tests using the reproduce command above to confirm the assertions now pass. Multiple fix commits are fine.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (for context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only — \`git -C ${ctx.targetPath} ...\` for inspection only, never edit there): ${ctx.targetPath}`,
      `Integration branch: ${integration}`,
      '',
      'Captured test failure output (use this to identify the exact assertions that failed):',
      '```',
      failureOutput,
      '```',
      '',
      `Save your work. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

// NOTE — intentionally absent entries (documented so future investigators don't
// re-open these):
//
// • merge:crashed/index-lock-contention
//     git checkout <integration> failed because .git/index.lock already exists
//     (another git process was running, or a previous process crashed and left
//     a stale lock). The task's coding work is already committed on its branch
//     — only the merge step crashed. This is environmental and transient; the
//     lock is typically gone by the time the investigator runs. A recipe that
//     blindly deletes index.lock is dangerous (it may be held by an active
//     process). Operator fix: confirm no active git process holds the lock,
//     then `mars restart <task-id>` to re-run the merge step. Investigated
//     2026-05-19 (task 708a0e1b, origin dafb5b90 which had committed recipe
//     4ce1608 on task/dafb5b90; lock was already gone at investigation time).
//
// • merge:vcs-supervisor-aborted/index-lock-contention
//     The vcs-supervisor ran `git merge --ff-only <branch>` and it failed with
//     "Unable to create .git/index.lock: File exists", causing the supervisor
//     to return aborted=true. The task's coding work was already committed on
//     its branch — only the merge step failed. Root cause is identical to
//     merge:crashed/index-lock-contention: a stale lock from a crashed or
//     concurrent git process. This is environmental and transient; the lock is
//     typically gone by the time the investigator runs. Investigated 2026-05-18
//     (task mars-6348aec4, commit 31933fe on task/mars-6348aec4 confirmed
//     complete). Operator fix: confirm no active git process holds the lock,
//     then `mars restart <task-id>` to re-run the merge step.

const recipeList: readonly FixRecipe[] = [
  dirtyMergeTargetRecipe,
  worktreeInstallFrozenLockfileRecipe,
  worktreeInstallTimeoutRecipe,
  noCommitsAheadRecipe,
  vcsAbortedNotFastForwardRecipe,
  typecheckMissingExportRecipe,
  typecheckArgTypeMismatchRecipe,
  testAssertionErrorRecipe,
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
