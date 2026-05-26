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

const dirtyMainAtSetupRecipe: FixRecipe = {
  signature: 'setup:preflight/dirty-main',
  shared: true,
  title: (ctx) =>
    `Auto-commit dirty changes on ${ctx.targetBranch} blocking task setup`,
  buildPrompt: (ctx) => {
    const status = ctx.statusOutput.length > 0 ? ctx.statusOutput : '(empty)'
    return [
      `The merge target ${ctx.targetBranch} (checked out at ${ctx.targetPath}) had uncommitted changes when the orchestrator's setup pre-flight ran, so one or more queued tasks could not start. Your job is to commit those changes on ${ctx.targetBranch} so the blocked tasks can proceed. By the time you read this another recovery may already have cleaned it up.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `Operate on the merge target directly with \`git -C ${ctx.targetPath} ...\`. Do NOT \`cd\` into ${ctx.targetPath} — the orchestrator's "never cd" rule applies, and \`git -C\` keeps every command bound to the right tree.`,
      '',
      `STEP 1 — re-check first. Run \`git -C ${ctx.targetPath} status --porcelain\` right now.`,
      ` - If the output is empty, the tree is already clean: do NOT touch any file, do NOT commit. Exit successfully — the blocked tasks will be released as soon as this recovery is marked done.`,
      ` - If the output is non-empty, proceed to STEP 2 with the CURRENT status, not the snapshot below.`,
      '',
      `STEP 2 — commit everything on ${ctx.targetBranch}. This recovery auto-commits without judgement (per the dirty-main policy): the operator deliberately chose auto-commit over stash/triage.`,
      ` 1. Stage every change, tracked and untracked: \`git -C ${ctx.targetPath} add -A\`.`,
      ` 2. Inspect what you are about to commit so the message is accurate: \`git -C ${ctx.targetPath} diff --cached --stat\`.`,
      ` 3. Commit on ${ctx.targetBranch} with a message that names the touched files/areas, e.g.:`,
      '    ```',
      `    git -C ${ctx.targetPath} commit -m "chore: auto-commit dirty merge target before task setup" \\`,
      `      -m "<one line listing the files/areas committed>"`,
      '    ```',
      ` 4. Confirm the tree is clean: \`git -C ${ctx.targetPath} status --porcelain\` must now print nothing.`,
      '',
      `Do NOT push. Do NOT create or switch branches — the commit lands on ${ctx.targetBranch} exactly where the dirty files were. Do NOT edit files in this recovery worktree; the work to commit is in ${ctx.targetPath}, not here.`,
      '',
      `Merge target path: ${ctx.targetPath}`,
      `Merge target branch: ${ctx.targetBranch}`,
      '',
      'Dirty files captured at pre-flight time (may be stale — re-check before committing):',
      '```',
      status,
      '```',
      '',
      `Save your work. The orchestrator does not commit on your behalf — the \`git commit\` above IS your deliverable. Once it lands and the tree is clean, exit successfully so every task blocked on this recovery is released.`,
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
      ` 1. **Placeholder commit first — before any Read, Grep, or Bash command.** Do NOT run any Read, Grep, or Bash call between the false-positive check above and this step. Run immediately:`,
      `    \`git commit --allow-empty -m "recover: placeholder for ${ctx.targetBranch}"\``,
      `    This guarantees your recovery branch has at least one commit before any exploration begins — verify cannot reject with \`verify:has-diff/no-commits-ahead\` once this commit exists.`,
      '',
      ` 2. Re-run \`${countCmd}\` immediately after the placeholder commit. It MUST now print a non-zero integer. If it still prints \`0\`, the placeholder did not land on your branch — fix that before anything else.`,
      '',
      ...sourcePromptSection,
      ` 3. Read the **Original task prompt** above. It is already inlined — do NOT \`grep\` for it, do NOT open \`.mars/queue.db\`.`,
      ` 4. Identify the smallest viable edit that satisfies the prompt's acceptance criteria. If the prompt names a chokepoint file/symbol/line, edit THAT file and only that file. If you're choosing between two edits, pick the smaller one.`,
      ` 5. Apply that edit IN YOUR CURRENT WORKTREE. A stub plus a TODO test is acceptable — a parked, partly-correct commit is strictly better than no commit at all.`,
      ` 6. Commit your real work: either amend the placeholder commit (\`git add -A && git commit --amend -m "recover: <one-line summary>"\`) or add a follow-up commit (\`git add -A && git commit -m "recover: <one-line summary>"\`). Do this BEFORE running tests, BEFORE refactoring, BEFORE refining.`,
      ` 7. Only after step 6 is done may you iterate.`,
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

const typecheckPropertyNotExistRecipe: FixRecipe = {
  signature: 'verify:typecheck/typecheck-property-not-exist',
  title: () =>
    `Fix property-does-not-exist error(s) to resolve TS2339/TS2353 typecheck failure`,
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
      `TypeScript reported TS2339 ("Property 'X' does not exist on type 'Y'") or TS2353 ("Object literal may only specify known properties, and 'X' does not exist in type 'Y'") during the typecheck step. Both errors mean code is accessing or declaring a field that has been removed from (or was never added to) a type definition.`,
      '',
      `The most common cause in this codebase is an **incomplete refactoring**: a task removed a field from a type (e.g. \`removedField\` from \`SomeType\`) but did not update every call site that reads, writes, or spreads that field. The failing task's original prompt (inlined below) describes what was being changed — use it to determine whether the fix is to complete the deletion or to add the missing field.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `## How to fix`,
      '',
      `STEP 1 — Identify every TS2339 and TS2353 error. From your current working directory, run:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit 2>&1 | grep -E "TS2339|TS2353"`,
      '```',
      '',
      `Each error line has the form:`,
      `  <file>(<line>,<col>): error TS2339: Property '<field>' does not exist on type '<TypeName>'.`,
      `  <file>(<line>,<col>): error TS2353: Object literal may only specify known properties, and '<field>' does not exist in type '<TypeName>'.`,
      '',
      `STEP 2 — For each missing property '<field>', determine the correct fix by consulting the original task prompt below:`,
      '',
      ` **(a) Intentional deletion — the field was removed from the type as part of the task.** Distinguishing signal: the original task prompt says to remove, drop, or delete '<field>'.`,
      `     Fix: complete the deletion. Remove every remaining reference to '<field>' at the call sites named in the errors. Common patterns to handle:`,
      `     • Property access: \`obj.field\` → remove the access or the surrounding expression.`,
      `     • Spread mapping: \`{ ...rest, field: s.field }\` → remove the \`field\` key from the object.`,
      `     • Accumulator in reduce: \`acc.field + s.field\` → remove the field key from the accumulator initializer and from the reduce body.`,
      `     • Object literal: \`{ field: value, ... }\` → remove the key from the literal.`,
      `     Re-run the typecheck after each file edit; additional TS2339/TS2353 errors for the same field in other files resolve once all references are cleaned up.`,
      '',
      ` **(b) Missing implementation — the field was supposed to be added to the type but was not.** Distinguishing signal: the original task prompt says to add or introduce '<field>'.`,
      `     Fix: add the field to the type definition and ensure all read/write sites are consistent.`,
      '',
      ` **(c) Missing import or wrong type used.** If the field exists on a related type but the wrong type was imported, add or correct the import.`,
      '',
      `STEP 3 — After each fix, re-run the full typecheck to confirm the error count drops:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit`,
      '```',
      '',
      ` - Fix TS2339/TS2353 errors one field at a time. Multiple errors for the same missing field (across different call sites or files) resolve with a single fix to the origin.`,
      ` - If fresh, unrelated TS errors appear after your fix, fix them too — they are in scope.`,
      '',
      `## Important constraints`,
      ` - Do NOT add \`// @ts-ignore\` or cast to \`any\` to silence the error — fix the actual code.`,
      ` - Do NOT re-add a field that the original task explicitly removed — complete the deletion instead.`,
      ` - If fixing the error requires a new DB column, new table, or other schema change, STOP: raise a high-priority inbox item via \`mars inbox raise --from -\` explaining the blocker, then exit. Do not silently expand scope.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only): ${ctx.targetPath}`,
      '',
      `Save your work: stage all changed files and commit. The orchestrator does not commit on your behalf.`,
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

const typecheckExcessPropertyRecipe: FixRecipe = {
  signature: 'verify:typecheck/typecheck-excess-property',
  title: () =>
    `Remove excess property(ies) from object literals to resolve TS2353 typecheck failure`,
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
      `TypeScript reported TS2353 ("Object literal may only specify known properties, and 'X' does not exist in type 'Y'") during the typecheck step. This is TypeScript's excess-property check: an object literal includes a field that no longer exists in the type it is being assigned to.`,
      '',
      `The canonical cause in this codebase is a **partial type cleanup**: the original task updated a type to remove a field (for example, removing \`removedField\` from \`SomeType\`), but one or more object literals that construct that type (often in test fixtures) were not updated to match. The type change is correct and intentional — do NOT revert it.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `## How to fix`,
      '',
      `STEP 1 — Identify every TS2353 error. From your current working directory, run:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit 2>&1 | grep "TS2353"`,
      '```',
      '',
      `Each error line has the form:`,
      `  <file>(<line>,<col>): error TS2353: Object literal may only specify known properties, and '<prop>' does not exist in type '<Type>'.`,
      '',
      `STEP 2 — For each TS2353 error, remove the excess property from the object literal:`,
      '',
      ` (a) Open <file> at <line> and locate the object literal at <col>.`,
      ` (b) Remove the property named '<prop>' from that object literal — just the one key-value pair. Do NOT touch the surrounding properties.`,
      ` (c) If the same property appears in other object literals in the same or other files (for example, a shared \`emptySummary\` fixture, a \`const\` default object, or another test fixture), remove it from ALL of them — TypeScript will surface one TS2353 per offending object literal, but often the same property appears in multiple places.`,
      '',
      `## Important constraints`,
      ` - Do NOT revert the type change. The type was updated intentionally — it is the object literals that need to catch up.`,
      ` - Do NOT add \`// @ts-ignore\` or \`as any\` casts to silence the error.`,
      ` - Do NOT add the excess property back to the type definition to make the object literal compile — that undoes the original task's intent.`,
      ` - After removing the property, check whether any other code in the same file still references the removed property name (e.g., a \`console.log\`, a return value, an assertion). If so, update those references too.`,
      ` - If removing the property reveals that other code (e.g. a function body) still computes or returns the removed field, remove those computations as well — they are dead code under the new type.`,
      '',
      `STEP 3 — Re-run the full typecheck to confirm all TS2353 errors are gone:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit`,
      '```',
      '',
      ` - If fresh TS errors appear after the removal (e.g. TS2339 "Property does not exist" elsewhere), those are cascade errors caused by code that read the now-removed field — fix them by removing or updating those read sites.`,
      ` - If the typecheck is fully clean, run the test suite to confirm no test assertions rely on the removed field: \`cd orchestrator && npx vitest run\`.`,
      '',
      `## If the property appears in a fixture shared by multiple test cases`,
      '',
      `Shared test fixtures (e.g. \`const emptySummary = { ..., removedField: 0, ... }\`) are common in this codebase. Remove the excess property from the fixture constant and from every spread or direct usage of that constant that TypeScript flags.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only): ${ctx.targetPath}`,
      '',
      `Save your work: stage all changed files and commit. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const typecheckCannotFindNameRecipe: FixRecipe = {
  signature: 'verify:typecheck/typecheck-cannot-find-name',
  title: () =>
    `Fix cannot-find-name error(s) to resolve TS2304 typecheck failure`,
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
      `TypeScript reported TS2304 ("Cannot find name 'X'") during the typecheck step. This means code references a name — a constant, function, type, or variable — that does not exist in scope.`,
      '',
      `The most common cause in this codebase is a **partial deletion**: a task deleted a constant or function declaration but left behind call sites that reference it, or removed an import that is still used elsewhere. Less commonly, the name was never implemented by the original task.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `## How to fix`,
      '',
      `STEP 1 — Identify every TS2304 error. From your current working directory, run:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit 2>&1 | grep "TS2304"`,
      '```',
      '',
      `Each error line has the form:`,
      `  <file>(<line>,<col>): error TS2304: Cannot find name '<name>'.`,
      '',
      `STEP 2 — For each missing name '<name>', determine the correct fix by consulting the original task prompt at the bottom of this message:`,
      '',
      ` **(a) Partial deletion — the name was removed by the original task but its call sites were not updated.** Distinguishing signal: the original task prompt says to delete, remove, or drop '<name>'.`,
      `     Fix: complete the deletion. Remove every remaining call site that references '<name>'. If '<name>' is used inside a larger block (a function body, an if-branch, a field in a union type, a JSDoc bullet, an outcome string literal), remove the entire block — do not leave orphaned code or stubs. Then re-run the typecheck; additional TS2304 errors for the same name (in other files) resolve automatically once all usages are gone.`,
      '',
      ` **(b) Missing implementation — the original task was supposed to define '<name>' but did not.** Distinguishing signal: the original task prompt says to add, implement, or introduce something named '<name>'.`,
      `     Fix: implement the missing name in the location the original prompt specifies. Mirror the style and structure of nearby declarations.`,
      '',
      ` **(c) Missing import — '<name>' is defined elsewhere but never imported in the file.** Check whether a nearby module exports it.`,
      `     Fix: add the import statement.`,
      '',
      `STEP 3 — After each fix, re-run the full typecheck to confirm the error count drops:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit`,
      '```',
      '',
      ` - Fix TS2304 errors one name at a time. Multiple errors for the same missing name (across different call sites or files) resolve with a single fix to the origin.`,
      ` - If fresh unrelated TS errors appear after your fix, fix them too — they are cascade errors that TypeScript could not surface before the missing name was resolved.`,
      '',
      `## Important constraints`,
      ` - Do NOT add \`// @ts-ignore\` or \`declare const <name>: any\` to silence the error — fix the actual code.`,
      ` - Do NOT re-introduce a name that the original task explicitly removed — complete the deletion instead.`,
      ` - If fixing the error requires a new DB column, new table, or other schema change, STOP: raise a high-priority inbox item via \`mars inbox raise --from -\` explaining the blocker, then exit.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only): ${ctx.targetPath}`,
      '',
      `Save your work: stage all changed files and commit. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const testLibsqlNoSuchTableRecipe: FixRecipe = {
  signature: 'verify:test/test-libsql-no-such-table',
  title: () =>
    `Fix libsql concurrent-transaction test failure (no such table — switch to file-based DB)`,
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
      `The previous attempt on branch ${ctx.targetBranch} failed the verify:test step with a "no such table" SQLite error. The root cause is a known incompatibility between \`@libsql/client\`'s in-memory URL (\`':memory:'\`) and concurrent write transactions.`,
      '',
      `## Root cause`,
      '',
      `When \`client.transaction('write')\` is called on a libsql client backed by \`:memory:\`, the implementation detaches the current connection (\`this.#db = null\`) and lazily creates a NEW empty in-memory SQLite database the next time a connection is needed. Two concurrent calls to \`client.transaction('write')\` therefore each get a different in-memory database — the second one has no schema (no tables), producing "no such table: <name>" even though \`beforeEach\` correctly created the table on the first connection.`,
      '',
      `## Fix`,
      '',
      `Replace the in-memory URL with a temp file-based URL so that all connections (direct \`execute\` calls AND transaction connections) share the same on-disk SQLite database. A temp directory is created per test, cleaned up in \`afterEach\`, and behaves identically to an in-memory database from a test-isolation perspective.`,
      '',
      `Pattern to change in the failing test file:`,
      '',
      '```typescript',
      `// BEFORE (broken for concurrent transactions)`,
      `const client = createClient({ url: ':memory:' })`,
      '',
      `// AFTER — use a temp file so all connections share the same database`,
      `import { mkdtempSync, rmSync } from 'node:fs'`,
      `import { tmpdir } from 'node:os'`,
      `import { join } from 'node:path'`,
      '',
      `const dir = mkdtempSync(join(tmpdir(), 'test-'))`,
      `const dbPath = join(dir, 'events.db')`,
      `const client = createClient({ url: \`file:\${dbPath}\` })`,
      '```',
      '',
      `Also update the \`afterEach\` / cleanup to remove the temp directory:`,
      '',
      '```typescript',
      `afterEach(() => {`,
      `  client.close()`,
      `  rmSync(dir, { recursive: true, force: true })`,
      `})`,
      '```',
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
      `STEP 3 — Apply the fix. Find every test file in the lifted diff that opens a libsql client with \`url: ':memory:'\` and replace each with a temp file URL as shown in the ## Fix section above. The fix is typically a one-file change to the test helper or \`beforeEach\` setup. Also add \`rmSync(dir, { recursive: true, force: true })\` to the \`afterEach\` cleanup.`,
      '',
      `STEP 4 — Run the failing test(s) to confirm they now pass:`,
      '',
      '```',
      `cd orchestrator && npm test`,
      '```',
      '',
      `STEP 5 — Commit the fix: \`git add -A && git commit -m "fix: use temp file-based DB in tests to fix concurrent libsql transaction failures"\``,
      '',
      `## Important constraints`,
      ` - The in-memory URL (\`:memory:\`) must be replaced with a file URL — do NOT add WAL PRAGMA calls or other workarounds.`,
      ` - Make sure the temp directory is removed in \`afterEach\` / \`after\` to avoid leaving garbage in \`/tmp\`.`,
      ` - Do NOT change production code (e.g. \`publisher.ts\` or any non-test file) — the bug is in the test setup only.`,
      ` - If the diff is empty or the root cause is not an in-memory libsql client, raise a high-priority inbox item via \`mars inbox raise --from -\` explaining what you found, then exit.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (for context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only — \`git -C ${ctx.targetPath} ...\` for inspection only, never edit there): ${ctx.targetPath}`,
      `Integration branch: ${integration}`,
      '',
      'Captured test failure output (use this to identify the exact test file):',
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
// • merge:preflight/template-leakage/template-paths-detected
// • merge:preflight/template-leakage/unclassified  (stale: pre-9ed0041 daemon)
//     The merge preflight blocks any task branch that touches paths under
//     orchestrator/src/init/templates/ (TEMPLATE_LEAKAGE_PREFIX in git.ts).
//     Humans edit this subtree directly on main; the orchestrator has a
//     categorical block because CLAUDE.md is inlined into every coder brief,
//     meaning a bypassPermissions coder reconciles the brief back to the
//     template, causing regressions. A recipe is wrong for two compounding
//     reasons:
//     (a) any recovery agent that tries to apply the template edit hits the
//         same preflight block on its own merge step;
//     (b) a recovery that skips the template edit fails the original task's
//         verify criteria (the verify command always references the template
//         path explicitly, because the task was specifically asked to change it).
//     The /unclassified suffix appears on failures recorded BEFORE commit
//     9ed0041 added the 'template-paths-detected' classifier rule — the
//     signature is frozen on the DB row and is not recomputed. Investigated:
//       2026-05-18 (mars-77844c1f, 9ed0041 — CLAUDE.md edit)
//       2026-05-19 (mars-5989999f — mars:inbox SKILL.md YAML frontmatter fix)
//       2026-05-19 (mars-9dce6ff6 — CLAUDE.md false SessionStart claim)
//       2026-05-19 (mars-2c6dd178 — zombie kind removal from template files)
//       2026-05-20 (mars-af0d8023 — mars:inbox skill head-20 listing limit)
//     Operator fix: apply the desired template edit directly on main, then drop
//     or close the original task. Repro: git diff --name-only main..task/<id>
//                                        | grep 'orchestrator/src/init/templates/'
//
// • merge:crashed/index-lock-contention
//     git checkout <integration> failed because .git/index.lock already exists
//     (another git process was running, or a previous process crashed and left
//     a stale lock). The task's coding work may or may not have been committed
//     before the crash — only the merge checkout step itself failed. This is
//     environmental and transient; the lock is typically gone by the time the
//     investigator runs. A recipe that blindly deletes index.lock is dangerous
//     (it may be held by an active process). Operator fix: confirm no active
//     git process holds the lock, then `mars restart <task-id>` to re-run the
//     merge step. If the task had 0 commits ahead of integration at crash time,
//     the retry will fail with verify:has-diff/no-commits-ahead and route to
//     the no-commits-ahead recipe automatically.
//     Investigated 2026-05-19 (task 708a0e1b, origin dafb5b90 which had
//     committed recipe 4ce1608 on task/dafb5b90; lock was already gone at
//     investigation time).
//     Re-confirmed 2026-05-20 (task mars-f0b3da78, origin
//     82f2b926-taskstore-seam-slice-3-migrate-the-7-lib). In this occurrence
//     the branch had 0 commits ahead of main (the queue-fix-tasks migration
//     work was never committed before the crash). The lock was already gone at
//     investigation time, confirming the transient nature. Operator fix:
//     mars restart mars-f0b3da78 — the retry will route through
//     verify:has-diff/no-commits-ahead and the existing recipe handles it.
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
//
// • merge:vcs-supervisor-aborted/unclassified
//     Historical-only. The post-supervisor `git merge --ff-only <branch>` failed
//     with `fatal: Not possible to fast-forward` because integration advanced in
//     the window between the supervisor's rebase and the orchestrator's ff
//     attempt. This is the exact error shape commit cab1551 added a classifier
//     rule for (`matchFull: /Not possible to fast-forward/i`) and a recipe for
//     (`merge:vcs-supervisor-aborted/not-fast-forward`, see
//     `vcsAbortedNotFastForwardRecipe` above). A failure whose signature is
//     still `merge:vcs-supervisor-aborted/unclassified` for this error body was
//     recorded BEFORE cab1551 landed — the signature is frozen on the failed row
//     and isn't recomputed. There is no live failure mode here to write a recipe
//     for: any fresh occurrence of this race classifies as `not-fast-forward`
//     and routes to the existing recipe. Investigated 2026-05-19 (task
//     ba603773, origin mars-e2587d97 / f1dd72b3). Operator fix: `mars restart
//     mars-e2587d97` so the merge step retries against the current integration
//     branch; the new failure (if any) will be classified correctly.
//
//     Diagnose discipline — ranked hypotheses considered:
//       (1) [WINNER] Stale unclassified signature: the failure was recorded
//           before cab1551 added the classifier rule, so the row carries
//           `/unclassified` even though the same error body now classifies as
//           `/not-fast-forward`. Verified by reading `errorClassRules` in
//           failure-signature.ts (matchFull rule present) and the existing
//           test at failure-signature.test.ts:166-189 which exercises the
//           exact JSON+hint+fatal shape this failure exhibits.
//       (2) Falsified — race between supervisor and ff that the existing rule
//           misses: would require the body NOT to contain "Not possible to
//           fast-forward", but the captured `m.output` tail shows that exact
//           string. classifyError's matchFull would fire.
//       (3) Falsified — supervisor returning aborted=true with a different
//           error shape: would require sup.exitCode !== 0 or
//           stillInProgress=true, but the captured supervisor output ends in
//           `STATUS: completed` and `COMMIT: rebase complete`. The aborted
//           path here is git.ts:1596 (ff failure after successful rebase), not
//           git.ts:1567 (supervisor failure).
//     Repro: not deterministically reproducible — the underlying race
//     condition is reproducible (rebase then advance main concurrently then
//     ff), but the failing task's stored signature can only be changed by
//     re-running it. cab1551's test
//     (`computeFailureSignature produces merge:vcs-supervisor-aborted/not-fast-forward
//     for the git merge --ff-only error shape`) is the deterministic check
//     that the live classifier handles this body correctly.

const recipeList: readonly FixRecipe[] = [
  dirtyMergeTargetRecipe,
  dirtyMainAtSetupRecipe,
  worktreeInstallFrozenLockfileRecipe,
  worktreeInstallTimeoutRecipe,
  noCommitsAheadRecipe,
  vcsAbortedNotFastForwardRecipe,
  typecheckPropertyNotExistRecipe,
  typecheckMissingExportRecipe,
  typecheckArgTypeMismatchRecipe,
  typecheckExcessPropertyRecipe,
  typecheckCannotFindNameRecipe,
  testAssertionErrorRecipe,
  testLibsqlNoSuchTableRecipe,
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
