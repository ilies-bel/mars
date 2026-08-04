/**
 * Recovery recipes are keyed by failure signature (the technical-key form
 * produced by `computeFailureSignature` — e.g.
 * `merge:preflight/uncommitted-changes`). Each recipe owns the prompt the
 * orchestrator hands to the recovery agent for that exact signature.
 *
 * See docs/knowledge/decisions/0002-recipe-per-failure-signature.md for the contract:
 * a signature without a registered recipe does NOT fall back to a generic
 * prompt — it raises a `no-recipe` actionQueue item and dispatches the
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
   * Mars-DB exploration (psql against the daemon's published DSN) before
   * making the edit. Defaults to '' only when the source task genuinely has
   * no prompt recorded.
   */
  originalPrompt: string
  /**
   * The failure signature that triggered this recovery (e.g.
   * `'verify:typecheck/unclassified'`, `'code:step/unclassified'`).
   * Injected by `arc.ts:spawnRecovery` so the generic recipe can branch on
   * gate failures (`verify:` prefix) vs work failures without a heuristic.
   * Optional — older call sites that pre-date this field leave it absent.
   */
  failureSignature?: string
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
      ` - If the output is empty, the tree is already clean: do NOT touch any file, do NOT commit, do NOT emit an actionQueue notification. Exit successfully — the original task can be retried as-is.`,
      ` - If the output is non-empty, proceed to STEP 2 with the CURRENT status, not the snapshot below.`,
      '',
      `STEP 2 — only if STEP 1 still shows a dirty tree. Inspect each modified or untracked file:`,
      ` (a) commit files that represent intentional work with a meaningful commit message that describes the actual changes;`,
      ` (b) discard files that are clearly transient (build artifacts, .DS_Store, editor swap files, anything in .gitignore that slipped in via \`git add -f\` etc.);`,
      ` (c) for anything ambiguous, do NOT guess — emit a high-priority actionQueue notification listing the file(s) and what's unclear, and exit.`,
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
      `If you need to file an actionQueue notification, use \`mars actionQueue raise --from -\` with priority='high' and a clear message describing the ambiguous file(s).`,
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
      `NOTE: the orchestrator already attempted an automatic in-place lockfile regeneration (non-frozen install → frozen re-verify) in the origin worktree before this recovery was spawned, and it did NOT reconcile the failure. So a plain \`npm install\` / \`pnpm install\` almost certainly will NOT fix this on its own — the manifest itself is likely the problem (an unresolvable dependency, a version conflict, a missing/renamed package). Look for the REAL manifest issue, do not just re-run the install the orchestrator already ran.`,
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
      `NOTE: the orchestrator already attempted an automatic in-place lockfile regeneration in the origin worktree before this recovery was spawned, and it did NOT reconcile the failure (it likely wedged the same way). So simply re-running the install is unlikely to help — look for the REAL cause (a dependency that never resolves, a registry the runner can't reach, a manifest that makes the solver spin), do not just re-run the install the orchestrator already ran.`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
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
      ` 3. Read the **Original task prompt** above. It is already inlined — do NOT \`grep\` for it, do NOT re-query the Mars DB via \`psql "$(cat .mars/pg.dsn)"\`.`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
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
      `Your recovery worktree is on a FRESH branch based on current ${integration}. Before lifting the diff, confirm: \`git merge-base --is-ancestor ${integration} HEAD\` must exit 0. If it exits non-zero, rebase first: \`git rebase ${integration}\`.`,
      '',
      `Run these read-only checks against the failing worktree. Use the MERGE-BASE to capture only this task's own commits — not stale baseline content that would silently revert newer ${integration} commits:`,
      '',
      '```',
      `BASE=$(git -C ${ctx.targetPath} merge-base ${integration} HEAD)`,
      `git -C ${ctx.targetPath} log $BASE..HEAD --oneline`,
      `git -C ${ctx.targetPath} diff $BASE..HEAD --stat`,
      `git -C ${ctx.targetPath} diff $BASE..HEAD   # full diff; pipe to a file if large`,
      '```',
      '',
      `Apply the diff in YOUR current worktree:`,
      '',
      ` 1. Compute the merge-base: \`BASE=$(git -C ${ctx.targetPath} merge-base ${integration} HEAD)\``,
      ` 2. Capture only the task's own changes: \`git -C ${ctx.targetPath} diff $BASE..HEAD > ${patchFile}\``,
      ` 3. Apply: \`git apply --3way ${patchFile}\` (or \`git apply --reject\` and resolve any \`.rej\` files by hand if there are conflicts).`,
      ` 4. **Guard before committing**: run \`git diff ${integration}..HEAD --stat\` in YOUR recovery worktree. The stat must list ONLY files this task legitimately changed. If the diff removes or reverts files that appeared on ${integration} after this task's branch diverged — files the task never touched — **STOP: do not commit. This is a stale-baseline lift.** File a \`--blocked-by\` follow-up task or \`mars proposal add\` describing the spurious reversions, then exit.`,
      ` 5. **Commit immediately**: \`git add -A && git commit -m "recover: re-land <summary> onto ${integration}"\`. Do this BEFORE running tests, BEFORE refactoring, BEFORE refining the message.`,
      ` 6. Re-run \`${countCmd}\`. It MUST now print a non-zero integer. If it still prints \`0\`, your commit did not land — fix that before anything else.`,
      ` 7. Only after step 6 prints non-zero may you iterate: run the original verify commands, fix any issues, and polish the commit message via \`git commit --amend\`.`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
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
      ` - If fixing the error requires a new DB column, new table, or other schema change, STOP: raise a high-priority actionQueue item via \`mars actionQueue raise --from -\` explaining the blocker, then exit. Do not silently expand scope.`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
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
      ` - If the missing export requires a new DB column, new table, or other schema change, STOP: raise a high-priority actionQueue item via \`mars actionQueue raise --from -\` explaining the blocker, then exit. Do not silently expand scope.`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
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
      ` - If fixing the argument type requires a schema change (new DB column, new table, etc.), STOP: raise a high-priority actionQueue item via \`mars actionQueue raise --from -\` explaining the blocker, then exit.`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
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
      `Your recovery worktree is on a FRESH branch based on current ${integration}. Before lifting the diff, confirm: \`git merge-base --is-ancestor ${integration} HEAD\` must exit 0. If it exits non-zero, rebase first: \`git rebase ${integration}\`.`,
      '',
      `Inspect what the previous agent did (read-only against the failing worktree). Use the MERGE-BASE to capture only this task's own commits — not stale baseline content that would silently revert newer ${integration} commits:`,
      '',
      '```',
      `BASE=$(git -C ${ctx.targetPath} merge-base ${integration} HEAD)`,
      `git -C ${ctx.targetPath} diff $BASE..HEAD --stat`,
      `git -C ${ctx.targetPath} diff $BASE..HEAD`,
      '```',
      '',
      ` 1. Compute the merge-base: \`BASE=$(git -C ${ctx.targetPath} merge-base ${integration} HEAD)\``,
      ` 2. Capture only the task's own changes: \`git -C ${ctx.targetPath} diff $BASE..HEAD > ${patchFile}\``,
      ` 3. Apply: \`git apply --3way ${patchFile}\` (resolve any \`.rej\` files by hand if needed).`,
      ` 4. **Guard before committing**: run \`git diff ${integration}..HEAD --stat\` in YOUR recovery worktree. The stat must list ONLY files this task legitimately changed. If the diff removes or reverts files that appeared on ${integration} after this task's branch diverged — files the task never touched — **STOP: do not commit. This is a stale-baseline lift.** File a \`--blocked-by\` follow-up task or \`mars proposal add\` describing the spurious reversions, then exit.`,
      ` 5. **Commit immediately**: \`git add -A && git commit -m "recover: lift diff from ${ctx.targetBranch}"\`. Do this BEFORE running tests or fixing anything.`,
      ` 6. Re-run \`${countCmd}\`. It MUST now print a non-zero integer. If it still prints \`0\`, fix that before anything else.`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
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
      ` - If fixing the error requires a new DB column, new table, or other schema change, STOP: raise a high-priority actionQueue item via \`mars actionQueue raise --from -\` explaining the blocker, then exit.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only): ${ctx.targetPath}`,
      '',
      `Save your work: stage all changed files and commit. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const typecheckTypeMismatchRecipe: FixRecipe = {
  signature: 'verify:typecheck/typecheck-type-mismatch',
  title: () =>
    `Fix type-mismatch error(s) to resolve TS2322 typecheck failure`,
  buildPrompt: (ctx) => {
    const sourcePromptSection =
      ctx.originalPrompt.trim().length > 0
        ? [
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `TypeScript reported TS2322 ("Type X is not assignable to type Y") during the typecheck step. This means a value being assigned to (or returned for) a typed slot does not match the declared type — the value is outside the set the type permits.`,
      '',
      `The most common cause in this codebase is a **partial union extension**: a task added a new string literal (e.g. a new \`op\` value in a \`recoveryActions\` entry, or a new variant in a discriminated union) without adding that literal to the corresponding union type. TypeScript then rejects the new literal because it is not a member of the current union.`,
      '',
      `Example pattern that triggers this error:`,
      '',
      '```typescript',
      `// error-kinds.ts — union type was NOT updated`,
      `export type ActionOp = 'restart' | 'purge' | 'prune-worktree'  // 'investigate' missing`,
      ``,
      `// stale-worktree entry — new op added, but union not extended`,
      `recoveryActions: [`,
      `  { id: 'investigate', label: 'Investigate', op: 'investigate' }, // TS2322 here`,
      `  { id: 'prune', label: 'Prune', op: 'prune-worktree', needsConfirm: true },`,
      `],`,
      '```',
      '',
      `Fix: add \`'investigate'\` to the \`ActionOp\` union type.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `## How to fix`,
      '',
      `STEP 1 — Identify every TS2322 error. From your current working directory, run:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit 2>&1 | grep "TS2322"`,
      '```',
      '',
      `Each error line has the form:`,
      `  <file>(<line>,<col>): error TS2322: Type '<actual>' is not assignable to type '<expected>'.`,
      `  Types of property '<prop>' are incompatible.`,
      `    Type '<value>' is not assignable to type '<UnionType>'.`,
      '',
      `For each TS2322 error:`,
      ` (a) Open <file> at <line> and read the mismatched assignment.`,
      ` (b) Identify whether the value is **intentionally new** (the original task introduced it) or **accidentally wrong** (a typo or stale value).`,
      '',
      ` **(b1) Intentionally new value** — the original task added a new variant/op/case that was meant to be supported:`,
      `     Fix: extend the union type at its definition to include the new literal. Then check whether any \`switch\` statements or exhaustive checks over that union need a new branch for the added case.`,
      '',
      ` **(b2) Wrong value** — the value is a typo, or references a literal that was renamed:`,
      `     Fix: correct the value at the assignment site to match one of the existing union members.`,
      '',
      `STEP 2 — Re-run the typecheck after each fix:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit`,
      '```',
      '',
      ` - Fix TS2322 errors one at a time. Cascading errors in the same file often clear once the union is extended.`,
      ` - If new unrelated TS errors appear after your fix, fix them too — they may have been masked by the original error.`,
      '',
      `STEP 3 — After all TS2322 errors are resolved, run the full typecheck once more to confirm the output is clean:`,
      '',
      '```',
      `cd orchestrator && npx tsc --noEmit`,
      '```',
      '',
      `## Important constraints`,
      ` - Do NOT add \`// @ts-ignore\` or \`as any\` casts to silence the error — fix the actual type.`,
      ` - Do NOT narrow the assigned value to an existing union member if the new value is intentional — extend the union instead.`,
      ` - When extending a union type, check every \`switch\` or exhaustive handler over that union and add a case for the new member. Missing cases in exhaustive switches cause a separate TS error (TS2366 or similar) and will be surfaced on the next typecheck run.`,
      ` - If extending the union requires a new HTTP route or DB column, STOP: raise a high-priority actionQueue item via \`mars actionQueue raise --from -\` explaining the blocker, then exit.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only): ${ctx.targetPath}`,
      '',
      `Save your work: stage all changed files and commit. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

/**
 * `code/uncommitted-changes` — the coder exited cleanly but left real work
 * uncommitted in the worktree, AND the orchestrator's own deterministic
 * auto-commit (`autoCommitWorktreeIfDeterministic`, a plain
 * `git add -A && git commit`) was refused.
 *
 * The policy this recipe implements — and must not contradict — is a strict
 * two-stage escalation, not two competing behaviours:
 *
 *   1. The code step ALWAYS tries the deterministic auto-commit first. When it
 *      succeeds the pipeline continues to verify as if the coder had
 *      committed; no failure, no recovery, no recipe.
 *   2. Only when that commit is REFUSED does the code step fail the task with
 *      this signature. So by the time this recipe runs, `git add -A && git
 *      commit` has already been tried once and rejected — re-running it blind
 *      is the one thing guaranteed not to work.
 *
 * The recovery is therefore diagnostic: find what refused the commit, remove
 * that blocker, and land the work that is already on disk. Recovery tasks
 * attach to the ORIGIN worktree, so the uncommitted files are right there in
 * the agent's own cwd.
 */
const coderLeftUncommittedRecipe: FixRecipe = {
  signature: 'code/uncommitted-changes',
  title: (ctx) =>
    `Commit the work the coder left uncommitted on ${ctx.targetBranch || 'the task branch'}`,
  buildPrompt: (ctx) => {
    const integration = ctx.integrationBranch ?? 'main'
    const countCmd = `git rev-list --count ${integration}..HEAD`
    const evidence =
      ctx.statusOutput.length > 0
        ? ctx.statusOutput
        : '(no dirty-file list or auto-commit error captured)'
    const sourcePromptSection =
      ctx.originalPrompt.trim().length > 0
        ? [
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `# Recovery run — the coder's work was never committed`,
      '',
      `The coder for branch ${ctx.targetBranch} exited cleanly but left its changes UNCOMMITTED (dirty tree, 0 commits ahead of ${integration}). The orchestrator then ran its own deterministic \`git add -A && git commit\` on the worktree and git REFUSED it. That is why you are here.`,
      '',
      `You are attached to the origin task's worktree at ${ctx.targetPath} on branch \`${ctx.targetBranch}\` — the uncommitted work is in your own cwd. Do NOT redo the task from scratch: the change already exists on disk, it just is not committed.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `STEP 1 — re-check first. Run \`git status --porcelain\` and \`${countCmd}\`.`,
      ` - If the tree is clean AND \`${countCmd}\` prints a non-zero integer, the work already landed: do NOT touch any file, exit successfully.`,
      ` - Otherwise proceed to STEP 2 with the CURRENT state, not the snapshot below.`,
      '',
      `STEP 2 — find out what refused the commit. The orchestrator already tried the naive \`git add -A && git commit\`, so re-running it unchanged will fail the same way. Read the captured auto-commit error at the bottom of this prompt and match it to a cause:`,
      ` (a) **a pre-commit hook rejected the commit** — read \`.git/hooks/pre-commit\` (or the husky/lefthook config), run the hook's checks yourself, and FIX what it is complaining about (lint, format, typecheck). Never bypass it with \`--no-verify\`.`,
      ` (b) **nothing was stageable** — every dirty path is ignored or excluded, so \`git add -A\` staged an empty set. Decide honestly whether any of it is real work: if yes, add the path explicitly (\`git add -f <path>\` only when the ignore rule is genuinely wrong) or fix \`.gitignore\`; if it is all build output or scratch, remove those files so the tree is clean.`,
      ` (c) **git could not identify the committer** — set \`user.name\`/\`user.email\` locally for this worktree and retry.`,
      ` (d) **an index lock or interrupted operation** — resolve the stale state (no in-progress rebase/merge, no \`.git/index.lock\` held by a live process) and retry.`,
      '',
      `STEP 3 — commit the work. Use \`git add -A && git commit -m "<message naming what actually changed>"\`. Never \`git commit -am\`: it skips untracked files and silently drops new modules (the 2026-07-20 data-loss incident). Then re-run \`${countCmd}\` — it MUST print a non-zero integer before you exit.`,
      '',
      `## Never stash`,
      '',
      `\`git stash\` is BANNED in this repository. \`refs/stash\` lives in the common git dir and is shared by every linked worktree, addressed by shifting position (\`stash@{0}\`, \`stash@{1}\`), so a \`pop\` can hand you another task's uncommitted work — this caused a real data-loss incident on 2026-07-28. To park something you must not commit, restore the individual paths instead: \`git checkout ${integration} -- <paths>\` (or \`git checkout $(git merge-base HEAD ${integration}) -- <paths>\`).`,
      '',
      `If the dirty state is genuinely un-committable — it contains secrets, or it spans unrelated subsystems no single honest commit message covers — do NOT guess and do NOT delete it. Raise a high-priority item via \`mars action-queue raise --from -\` naming the paths and why, then exit.`,
      '',
      ...sourcePromptSection,
      `Task worktree (your cwd): ${ctx.targetPath}`,
      `Task branch: ${ctx.targetBranch}`,
      `Integration branch: ${integration}`,
      '',
      'Dirty paths and the auto-commit error captured at failure time (may be stale — re-check before acting):',
      '```',
      evidence,
      '```',
      '',
      `Save your work: the commit IS the deliverable. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const testNoSuiteFoundRecipe: FixRecipe = {
  signature: 'verify:test/test-no-suite-found',
  title: (ctx) =>
    `Remove or populate the empty test file blocking verify:test on ${ctx.targetBranch}`,
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
            `## Original task prompt (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `The previous attempt on branch ${ctx.targetBranch} failed the verify:test step with "No test suite found in file <path>". Vitest discovered a file that matches its test-file glob (e.g. \`**/*.test.ts\`) but contains no \`describe\`/\`it\`/\`test\` blocks — typically a comment-only placeholder left behind after the real tests were written elsewhere.`,
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
      `Your recovery worktree is on a FRESH branch based on current ${integration}. Before lifting the diff, confirm: \`git merge-base --is-ancestor ${integration} HEAD\` must exit 0. If it exits non-zero, rebase first: \`git rebase ${integration}\`.`,
      '',
      `Inspect what the previous agent did (read-only against the failing worktree). Use the MERGE-BASE to capture only this task's own commits — not stale baseline content that would silently revert newer ${integration} commits:`,
      '',
      '```',
      `BASE=$(git -C ${ctx.targetPath} merge-base ${integration} HEAD)`,
      `git -C ${ctx.targetPath} diff $BASE..HEAD --stat`,
      `git -C ${ctx.targetPath} diff $BASE..HEAD`,
      '```',
      '',
      ` 1. Compute the merge-base: \`BASE=$(git -C ${ctx.targetPath} merge-base ${integration} HEAD)\``,
      ` 2. Capture only the task's own changes: \`git -C ${ctx.targetPath} diff $BASE..HEAD > ${patchFile}\``,
      ` 3. Apply: \`git apply --3way ${patchFile}\` (resolve any \`.rej\` files by hand if needed).`,
      ` 4. **Guard before committing**: run \`git diff ${integration}..HEAD --stat\` in YOUR recovery worktree. The stat must list ONLY files this task legitimately changed. If the diff removes or reverts files that appeared on ${integration} after this task's branch diverged — files the task never touched — **STOP: do not commit. This is a stale-baseline lift.** File a \`--blocked-by\` follow-up task or \`mars proposal add\` describing the spurious reversions, then exit.`,
      ` 5. **Commit immediately**: \`git add -A && git commit -m "recover: lift diff from ${ctx.targetBranch}"\`. Do this BEFORE inspecting or fixing anything.`,
      ` 6. Re-run \`${countCmd}\`. It MUST now print a non-zero integer. If it still prints \`0\`, fix that before anything else.`,
      '',
      `STEP 3 — Identify and fix the empty test file. Use the captured test output at the bottom of this prompt to find the file path from the "No test suite found in file <path>" message.`,
      '',
      `Read that file in YOUR current worktree. It will be a file that either:`,
      ` (a) contains only comments and whitespace (a placeholder left behind by the previous agent), OR`,
      ` (b) contains import statements but no test blocks.`,
      '',
      `Now check the directory of the empty file for OTHER test files covering the same module:`,
      ` - Look for sibling \`*.test.ts\` files in the same directory or in the parent directory that test the same module.`,
      ` - If a sibling test file exists that covers the same subject: **delete the empty file**. Example: if \`__tests__/registry.test.ts\` is empty but \`registry.test.ts\` already exists in the same parent directory with real tests, delete \`__tests__/registry.test.ts\`.`,
      ` - If NO sibling test file exists: **populate the empty file** with a minimal test suite that imports and exercises the module under test. At minimum, write one test that asserts the module's public export exists and returns the expected type.`,
      '',
      `STEP 4 — Run the full test suite to confirm the error is gone:`,
      '',
      '```',
      `cd orchestrator && npm test`,
      '```',
      '',
      ` - The "No test suite found" error must no longer appear.`,
      ` - If you populated a test file, every test you wrote must pass.`,
      '',
      `STEP 5 — Commit the fix: \`git add -A && git commit -m "fix: remove/populate empty test file that caused No test suite found"\``,
      '',
      `## Important constraints`,
      ` - Do NOT delete a test file that contains real tests — only delete a file that is empty or comment-only.`,
      ` - Do NOT modify the module's implementation to make the error go away — fix the test file only.`,
      ` - If the file is a \`__tests__/\` placeholder whose comment says "tests live at <path>", check that exact path first before deciding to delete or populate.`,
      ` - If you cannot determine the right fix within two attempts, raise a high-priority actionQueue item via \`mars actionQueue raise --from -\` explaining what you found, then exit.`,
      '',
      ...sourcePromptSection,
      `Failing task branch (for context only — do not check it out): ${ctx.targetBranch}`,
      `Failing task worktree (read-only — \`git -C ${ctx.targetPath} ...\` for inspection only, never edit there): ${ctx.targetPath}`,
      `Integration branch: ${integration}`,
      '',
      'Captured test failure output (use the "No test suite found in file <path>" line to identify the empty file):',
      '```',
      failureOutput,
      '```',
      '',
      `Save your work. The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

/**
 * The previous coder committed some work but exited without committing the
 * remaining paths — the `code:commit-contract` gate detected a `dirty-with-commits`
 * worktree and stamped the failure. The fix is mechanical: commit every
 * remaining uncommitted path. No new code is needed.
 *
 * `ctx.statusOutput` contains the dirty-file list captured at failure time
 * (one relative path per line, from `postState.dirtyFiles.join('\n')`). The
 * fix agent is attached to the ORIGIN worktree so it can stage and commit
 * directly without lifting a diff.
 */
const codeCommitContractRecipe: FixRecipe = {
  signature: 'code:commit-contract/uncommitted-changes',
  title: (ctx) => {
    const count = ctx.statusOutput.trim().split('\n').filter(Boolean).length
    return `Commit ${count} path(s) the coder left uncommitted on ${ctx.targetBranch}`
  },
  buildPrompt: (ctx) => {
    const integration = ctx.integrationBranch ?? 'main'
    const dirtyFiles = ctx.statusOutput.trim().split('\n').filter(Boolean)
    const fileList =
      dirtyFiles.length > 0
        ? dirtyFiles.map((f) => `  ${f}`).join('\n')
        : '  (re-check with `git status` — the snapshot below may be stale)'
    const countCmd = `git rev-list --count ${integration}..HEAD`
    const sourcePromptSection =
      ctx.originalPrompt.trim().length > 0
        ? [
            `## Original task (inlined — do not re-query the Mars DB via psql "$(cat .mars/pg.dsn)")`,
            '',
            ctx.originalPrompt.trim(),
            '',
          ]
        : []
    return [
      `The previous coder on branch \`${ctx.targetBranch}\` committed some work but exited without committing these path(s):`,
      '',
      fileList,
      '',
      `You are attached to the origin task's worktree at ${ctx.targetPath} on branch \`${ctx.targetBranch}\`. The prior commits are already here — continue from them. Your ONLY job is to commit every remaining uncommitted path. Do NOT make any other change. Do NOT touch paths unrelated to the uncommitted files listed above.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `STEP 1 — Sanity-check. Run \`git status --porcelain\` from your working directory.`,
      ` - If the output is **empty**, the worktree is already clean: exit successfully WITHOUT committing anything.`,
      ` - If the output is **non-empty**, continue to STEP 2 with the CURRENT status (the snapshot above may be stale — trust \`git status\`, not the list above).`,
      '',
      `STEP 2 — Commit ALL uncommitted paths. Run:`,
      '',
      '```bash',
      `git add -A`,
      `git commit -m "chore: commit paths left uncommitted by prior coder turn"`,
      '```',
      '',
      `⚠️  CRITICAL: Use \`git add -A\` — stage EVERYTHING, then commit. Do NOT use \`git add <specific-file>\` unless you have a deliberate reason to exclude a path. This failure was caused by a partial commit; staging only some paths causes the EXACT SAME failure again and the task re-enters the failure loop.`,
      '',
      `STEP 3 — Verify the commit landed. Run \`${countCmd}\`. It MUST print a **non-zero integer**. If it prints \`0\`, the commit did not land on this branch — fix that before exiting.`,
      '',
      `STEP 4 — Run \`git status --porcelain\` one final time. The output MUST be empty. If any paths remain (staged, unstaged, or untracked), commit them now with \`git add -A && git commit\` before exiting.`,
      '',
      `Do NOT run tests. Do NOT refactor. Do NOT investigate the prior coder's implementation. This task's sole goal is to leave a clean worktree — every file committed, zero uncommitted paths.`,
      '',
      `If committing fails (e.g. a pre-commit hook rejects a file), emit a high-priority action-queue item via \`mars action-queue raise --from -\` explaining exactly what blocked the commit, then exit. Do NOT make workaround edits to silence a hook — that is out of scope.`,
      '',
      ...sourcePromptSection,
      `Worktree: ${ctx.targetPath}`,
      `Branch: ${ctx.targetBranch}`,
      `Integration branch: ${integration}`,
      '',
      `Save your work — the orchestrator does NOT commit on your behalf.`,
    ].join('\n')
  },
}

// NOTE — intentionally absent entries (documented so future investigators don't
// re-open these):
//
// • verify:completeness/*
//     The completeness gate (missing-report / incomplete / unsubstantiated)
//     was removed entirely (2026-07-19). A clean coder exit is now a finalized
//     task; outcome quality is verified by a separate arc-level verifier.


// NOTE — intentionally absent entries (documented so future investigators don't
// re-open these):
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
//     Previously concluded "historical-only" (investigation 2026-05-19, task
//     ba603773, origin mars-e2587d97). That conclusion was WRONG. Two live
//     failure modes in the current git.ts `mergeBranch()` produce this
//     signature because their first-line messages are not covered by any
//     existing classifier rule:
//
//     Path 2 — ancestry check: After the VCS supervisor completes a rebase,
//     git.ts calls `merge-base --is-ancestor` to confirm the fast-forward is
//     valid. If integration advanced in that window, it returns aborted=true
//     with the first-line message:
//       "fast-forward into <branch> not possible: <sha> is not an ancestor of <sha>."
//     The phrase "is not an ancestor of" does NOT match the existing
//     `not-fast-forward` rule's `match: /is not a fast-forward of/i`, and the
//     full output does NOT contain "Not possible to fast-forward" (different
//     wording), so `matchFull` also fails → unclassified.
//
//     Path 3 — CAS race: `git update-ref <ref> <new> <old>` (the atomic
//     fast-forward in mergeBranch) rejects if integration advanced between the
//     ancestry check and the CAS write. First-line message:
//       "integration moved during merge, retry needed: <branch> advanced concurrently."
//     No existing rule matches → unclassified.
//
//     Both paths produce the same aborted=true state as not-fast-forward and
//     have identical recovery: the code is committed on the task branch, just
//     re-land it. Fix: commit failure-signature.ts that added
//     `match: /is not an ancestor of/i` and `match: /integration moved during merge/i`
//     rules (both mapping to errorClass 'not-fast-forward'), closing the gap.
//     Future occurrences route to `merge:vcs-supervisor-aborted/not-fast-forward`
//     and are handled by `vcsAbortedNotFastForwardRecipe`.
//
//     Investigated 2026-05-30 (task mars-c5b48744, origin
//     6bc00239-add-a-retry-button-on-every-user-facing). Confirmed fresh (task
//     updated 2026-05-29, well after cab1551 landed 2026-05-18).
//
//     Diagnose discipline — ranked hypotheses considered:
//       (1) [WINNER, tie] Path 2 — ancestry check race: supervisor completed
//           (STATUS: completed, HEAD at 441c150 from 3fe69e3), so Path 1
//           (supervisor rejected) is ruled out. Ancestry check fires if
//           integration advanced in the supervisor→check window. First-line
//           "is not an ancestor of" explains the `/unclassified` outcome.
//           Falsification: would require the first line NOT to contain "is not
//           an ancestor of" — the truncated tail (showing supervisor JSON at
//           end) is consistent with both Path 2 and Path 3 since output
//           appends rebase_output+supervisor_json+[err] in all paths.
//       (2) [WINNER, tie] Path 3 — CAS race on update-ref: ancestry check
//           passes but integration advances before the CAS write. First-line
//           "integration moved during merge" also explains `/unclassified`.
//           Falsification: same as above — cannot distinguish 2 from 3
//           without the non-truncated error output.
//       (3) [Falsified] Supervisor rejected (Path 1): supervisor says
//           "No conflict markers remain; working tree is clean" and advanced
//           HEAD from 3fe69e3 to 441c150. git.ts's stillInProgress=false,
//           advanced=true, treeClean=true would all pass → no reject.
//       (4) [Falsified] Historical frozen signature: task updated 2026-05-29,
//           cab1551 landed 2026-05-18 → this is a fresh occurrence.
//       (5) [Falsified] git merge --ff-only path: git.ts no longer uses
//           `git merge --ff-only`; it uses `git update-ref` with CAS.
//     Repro: race conditions — not deterministically reproducible via a single
//     shell command. The classifier fix (pure function) is fully deterministic
//     and covered by the two new unit tests in failure-signature.test.ts.
//     Operator fix for mars-c5b48744: `mars restart mars-c5b48744` — the
//     merge step will retry; any fresh failure will now classify as
//     `not-fast-forward` and route to the existing recipe.
//
// • merge:vcs-supervisor-aborted/rebase-no-in-progress-state
//     mergeBranch Step 1's guard fires: git rebase exited non-zero WITHOUT
//     leaving a rebase-merge/ or rebase-apply/ state directory on disk.
//     This means git aborted the rebase before it could conflict (e.g.
//     uncommitted changes in the worktree blocked the rebase, an invalid
//     upstream ref, or an empty-commit stop). There is no conflict to
//     reconcile and Vega is NOT spawned (the guard was added to close the
//     false-premise Vega dispatch that previously produced
//     merge:vcs-supervisor-aborted/unclassified). No recipe — each
//     occurrence's root cause varies; the Investigator produces a targeted
//     follow-up task. Operator fix: inspect the worktree for uncommitted
//     changes or other blockers, clean up, then `mars restart <task-id>`.
//     Investigated 2026-06-20 (task mars-225f3d27, root-caused from origin
//     mars-c6cab686 / recovery fix-64929590 where a no-op rebase idled for
//     ~2h until the phantom-task watchdog killed it).

// • verify:test/unclassified (task mars-d4f3ea6d, origin 436f14c7)
//     Test `worker-stage-bindings.test.ts` line 45 expected `Workers.Triager.run(`
//     in triage-workflow.ts but the implementation used `runWorkerWithSpan({
//     worker: Workers.Triager, ... })` — the agent migrated the dispatch pattern but
//     forgot to update the structural test that checked for the older form.
//
//     Repro: worktree and branch were gone at investigation time; failure could not
//     be reproduced directly. The current main branch has the correct state: the test
//     now checks for `Workers.Triager` + `runWorkerWithSpan` and all 5 tests in
//     worker-stage-bindings.test.ts pass.
//
//     Ranked hypotheses considered:
//       (1) [WINNER] Incomplete migration: triage-workflow.ts was correctly updated to
//           use runWorkerWithSpan but the structural test from PRD 948691d0 slice 4
//           (which checked for Workers.Triager.run() — the OLD dispatch form) was not
//           updated. Test and implementation fell out of sync. Evidence: current main
//           has the fix in place; test description was renamed from "dispatches through
//           Workers.Triager.run" to "dispatches Workers.Triager through runWorkerWithSpan".
//       (2) [Falsified] Workflow not migrated at all: current main shows triage-workflow.ts
//           uses runWorkerWithSpan, ruling this out.
//       (3) [Timing, irrelevant now] test-assertion-error classifier not yet added: if
//           this task had failed after the classifier was added it would have been
//           classified as verify:test/test-assertion-error. But even so, the
//           test-assertion-error recipe says "do NOT modify test files" — wrong guidance
//           here since the TEST was the stale artifact, not the implementation.
//       (4) [Falsified] Environmental/flaky: the failing test is a pure structural check
//           (readFileSync + toMatch); fully deterministic.
//
//     Why no recipe: (a) worktree gone, cannot reproduce; (b) the fix is already on main;
//     (c) the test-assertion-error recipe would give wrong guidance (tells recovery agent
//     not to modify tests, but the test was the stale artifact — the correct fix requires
//     updating the test to check for Workers.Triager + runWorkerWithSpan rather than
//     Workers.Triager.run()); (d) this was a multi-slice PRD coordination gap specific to
//     the 436f14c7 migration, unlikely to recur in the same form.
//     Operator fix: `mars restart mars-d4f3ea6d` — the retry creates a fresh worktree
//     from current main where both the test and implementation are already correct.
//     Investigated 2026-05-31 (task 09758531, origin mars-d4f3ea6d).
//
/**
 * Generic, signature-agnostic recovery recipe (ADR: every regular-task
 * failure spawns a fix, even with no registered recipe). When a failure
 * signature has no purpose-built recipe, the orchestrator no longer dead-ends
 * the task with an "unknown signature" action-queue row — it spawns a recovery
 * that works from the original intent, the failure summary, and the existing
 * worktree. The fixer has no recipe script to follow, so the prompt tells it
 * to diagnose from first principles. NOT registered in `recipes` — it is
 * returned only by `getRecipeOrGeneric` as the explicit fallback, so
 * `hasRecipe` keeps reporting the true "no purpose-built recipe" state.
 */
export const genericRecoveryRecipe: FixRecipe = {
  signature: 'generic/no-recipe',
  title: (ctx) =>
    `Recover failed task: ${ctx.targetBranch || 'unknown branch'}`,
  buildPrompt: (ctx) => {
    const status = ctx.statusOutput.length > 0 ? ctx.statusOutput : '(empty)'
    const original =
      ctx.originalPrompt && ctx.originalPrompt.trim().length > 0
        ? ctx.originalPrompt
        : '(no original prompt recorded)'
    const integration = ctx.integrationBranch ?? 'main'
    // Gate failures (verify: prefix) mean the coder's work succeeded — the
    // code is already committed and tests/typecheck were green until an
    // unregistered verify gate rejected it. Re-reading the worktree state
    // is wasted tokens; jump straight to the gate failure output.
    const isGateFailure = ctx.failureSignature?.startsWith('verify:') ?? false

    if (isGateFailure) {
      return [
        `# Recovery run — first-principles (no matching recipe)`,
        '',
        `This is a standard recovery, not an emergency. A previous run of this task failed at the verify gate (signature: ${ctx.failureSignature}), and the failure does not match any of the orchestrator's purpose-built recovery recipes — so instead of dead-ending the task, the orchestrator handed it to you to fix the gate failure.`,
        '',
        `Your job: fix what the verify gate rejected. The prior run's committed work is already in this worktree on branch \`${ctx.targetBranch}\` — continue from where it stopped, do NOT start over. You succeed when the original goal is met AND the worktree verifies clean and is ready to merge.`,
        '',
        ...renderReproSection(ctx.reproCommand),
        `STEP 1 — Know why the gate failed. The failure summary captured at failure time:`,
        '```',
        status,
        '```',
        '',
        `STEP 2 — Know the original goal (for context). The task being recovered was asked to do:`,
        '```',
        original,
        '```',
        '',
        `STEP 3 — Fix the gate failure. Based on the failure summary above, repair the defect that caused the verify gate to reject. Stay within the original scope; surface genuinely new architectural work as a follow-up task rather than expanding scope here.`,
        '',
        `STEP 4 — Verify before you exit. Run the task's verification command(s) if the original goal named any; otherwise run the project's standard typecheck/test. Do not declare success without a green run — the orchestrator re-verifies and will bounce an unverified worktree right back.`,
        '',
        `If you genuinely cannot make progress (hard blocker, ambiguous scope, a decision only a human can make), do NOT bail silently and do NOT leave a half-done tree: emit a high-priority action-queue item via \`mars action-queue raise --from -\` describing exactly what blocks you, then exit.`,
        '',
        `Worktree path: ${ctx.targetPath}`,
        `Branch: ${ctx.targetBranch}`,
        '',
        `Save your work — the orchestrator does NOT commit on your behalf. An uncommitted recovery counts as no recovery at all.`,
      ].join('\n')
    }

    return [
      `# Recovery run — first-principles (no matching recipe)`,
      '',
      `This is a standard recovery, not an emergency. A previous run of this task failed, and its failure does not match any of the orchestrator's purpose-built recovery recipes — so instead of dead-ending the task, the orchestrator handed it to you to recover from first principles. There is no script to follow; you diagnose and finish the work yourself.`,
      '',
      `Your job: take the original task to completion. The previous run's work is already in this worktree on branch \`${ctx.targetBranch}\` — continue from where it stopped, do NOT start over. You succeed when the original goal is met AND the worktree verifies clean and is ready to merge. Until then the original task stays blocked on you.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `STEP 1 — Read what's already here. The prior run left commits and/or uncommitted changes in this worktree. Run each command separately to see how far it got before touching anything:`,
      '```',
      `git -C ${ctx.targetPath} log --oneline ${integration}..HEAD --max-count 30`,
      `git -C ${ctx.targetPath} status`,
      `git -C ${ctx.targetPath} diff`,
      '```',
      '',
      `STEP 2 — Know the original goal. The task being recovered was asked to do:`,
      '```',
      original,
      '```',
      '',
      `STEP 3 — Know why it failed. The failure summary captured at failure time:`,
      '```',
      status,
      '```',
      '',
      `STEP 4 — Finish or fix. Based on steps 1–3, either complete the remaining work or repair the defect that caused the failure. Stay within the original scope; surface genuinely new architectural work as a follow-up task rather than expanding scope here.`,
      '',
      `STEP 5 — Verify before you exit. Run the task's verification command(s) if the original goal named any; otherwise run the project's standard typecheck/test. Do not declare success without a green run — the orchestrator re-verifies and will bounce an unverified worktree right back.`,
      '',
      `If you genuinely cannot make progress (hard blocker, ambiguous scope, a decision only a human can make), do NOT bail silently and do NOT leave a half-done tree: emit a high-priority action-queue item via \`mars action-queue raise --from -\` describing exactly what blocks you, then exit.`,
      '',
      `Worktree path: ${ctx.targetPath}`,
      `Branch: ${ctx.targetBranch}`,
      '',
      `Save your work — the orchestrator does NOT commit on your behalf. An uncommitted recovery counts as no recovery at all.`,
    ].join('\n')
  },
}

/**
 * Behaviour verification found at least one Definition-of-Done criterion
 * observably contradicted on the live surface (signature
 * `behaviour-verify:dod-unmet/dod-unmet`, raised by the behaviour-verify
 * step between static verify and merge). The recovery Chore attaches to the
 * origin worktree — the branch, its commits, and the dev-server context are
 * all still alive because the gate is pre-merge — closes the behavioural gap
 * for exactly the failed criteria, and flows back through the same pipeline
 * (including the behaviour-verify gate itself).
 *
 * `ctx.statusOutput` carries the step's evidence block: the failed criteria
 * verbatim, one per-criterion verdict with its screenshot path, and the
 * dev-server log tail. The prompt inlines it so the Chore never re-derives
 * the diagnosis.
 */
const behaviourDodUnmetRecipe: FixRecipe = {
  signature: 'behaviour-verify:dod-unmet/dod-unmet',
  title: (ctx) =>
    `Close the behavioural gap on ${ctx.targetBranch || 'the task branch'}: Definition-of-Done criteria unmet on the live surface`,
  buildPrompt: (ctx) => {
    const evidence = ctx.statusOutput.length > 0 ? ctx.statusOutput : '(no evidence block captured)'
    const original =
      ctx.originalPrompt && ctx.originalPrompt.trim().length > 0
        ? ctx.originalPrompt
        : '(no original prompt recorded)'
    return [
      `# Recovery run — behaviour verification failed`,
      '',
      `The original task's code compiled, its tests passed, and static verify was green — but the behaviour-verify step then booted the task's preview command as a live dev server, drove it through a browser, and found at least one Definition-of-Done criterion observably CONTRADICTED on the running surface (screenshot evidence captured). The work must not merge in this state; your job is to close exactly that behavioural gap.`,
      '',
      `You are attached to the origin task's worktree at ${ctx.targetPath} on branch \`${ctx.targetBranch}\`. The prior run's commits are here — continue from them, do NOT start over and do NOT redo criteria that already verified.`,
      '',
      ...renderReproSection(ctx.reproCommand),
      `## Failed criteria and evidence`,
      '',
      'Only the criteria below failed. Each carries the verifier\'s verdict, its screenshot path (open the screenshot if you need to see the observed state), and the dev-server log tail:',
      '',
      '```',
      evidence,
      '```',
      '',
      `## Original task`,
      '',
      '```',
      original,
      '```',
      '',
      `STEP 1 — Reproduce. Start the task's preview command yourself (it is named in the evidence block; run it from the worktree with a PORT of your choosing) and observe the contradicted behaviour first-hand before editing anything.`,
      '',
      `STEP 2 — Fix the behaviour, not the checker. Change the code so each failed criterion is observably satisfied on the running surface. Do NOT weaken or reword the criteria, and do NOT touch unrelated passing behaviour.`,
      '',
      `STEP 3 — Verify before you exit. Re-run the project's standard typecheck/tests, then re-check each previously-failed criterion against your locally running server. The orchestrator re-runs the full pipeline — including the behaviour-verify gate — after you exit, so an unfixed criterion bounces straight back.`,
      '',
      `If a criterion is genuinely impossible to satisfy as written (ambiguous, contradicts another requirement, needs a product decision), do NOT bail silently: emit a high-priority action-queue item via \`mars action-queue raise --from -\` describing the conflict, then exit.`,
      '',
      `Save your work — stage and commit every change (\`git add -A && git commit\`). The orchestrator does not commit on your behalf.`,
    ].join('\n')
  },
}

const recipeList: readonly FixRecipe[] = [
  codeCommitContractRecipe,
  dirtyMergeTargetRecipe,
  behaviourDodUnmetRecipe,
  worktreeInstallFrozenLockfileRecipe,
  worktreeInstallTimeoutRecipe,
  noCommitsAheadRecipe,
  vcsAbortedNotFastForwardRecipe,
  typecheckPropertyNotExistRecipe,
  typecheckMissingExportRecipe,
  typecheckArgTypeMismatchRecipe,
  typecheckExcessPropertyRecipe,
  typecheckCannotFindNameRecipe,
  typecheckTypeMismatchRecipe,
  testAssertionErrorRecipe,
  testNoSuiteFoundRecipe,
  coderLeftUncommittedRecipe,
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

/**
 * Like {@link getRecipe} but never throws: returns the purpose-built recipe
 * for `signature` when one is registered, otherwise the signature-agnostic
 * {@link genericRecoveryRecipe}. This is the recovery-spawn entry point — every
 * regular-task failure spawns a fix, and a missing recipe is no longer a
 * dead-end (ADR: uniform failure→fix spawn supersedes ADR-0002).
 */
export const getRecipeOrGeneric = (signature: string): FixRecipe =>
  recipes[signature] ?? genericRecoveryRecipe

export const listRecipes = (): readonly FixRecipe[] => recipeList
