# Unblock note for mars-8d6a8204 — "fail verify on dirty worktree with named files"

The previous implementor was aborted with `too_hard:no-action-after-reads`
after reading `implement-workflow.ts` and `lib/git.ts` repeatedly without
picking a starting shape. This note prescribes that shape so the next
attempt can go straight to writing one test, then one implementation.

## Where the new check lives

Add a sibling to `checkBranchHasDiff` in
`orchestrator/src/mastra/lib/git.ts`:

```ts
export const checkWorktreeClean = async (cwd: string): Promise<VerifyStep>
```

Implementation outline:

1. Run `git status --porcelain` (NOT `--porcelain=v1 -uall`; the default
   already includes untracked entries and honours `.gitignore`).
2. Parse the output into a list of paths. Each porcelain line is
   `XY <path>` where `XY` is the status code; untracked is `??`. Strip
   the leading 3 characters to get the path. Quoted-renamed entries
   (`R `) include ` -> `; for this slice it is fine to take the
   right-hand side.
3. If the path list is empty, return
   `{ name: 'worktree-clean', passed: true, output: 'worktree clean' }`.
4. Otherwise return `passed: false` with `output` whose **first line**
   enumerates every offending path:

   ```
   dirty worktree: <path1>, <path2>, <pathN>
   <raw git status --porcelain output for diagnostics>
   ```

   (Comma-separated on the first line is enough to satisfy
   "first line names every offending file path". Diagnostics go on
   subsequent lines.)

Name the step `worktree-clean` (or `dirty-worktree` — pick one and stay
consistent) so the failing-step key produced by `verifyStep` in
`implement-workflow.ts` becomes `verify:worktree-clean`. This is
**distinct from** the existing `verify:has-diff` step name, which is the
acceptance criterion's "distinct signature" requirement.

## Where it wires into `verifyChanges`

In `verifyChanges` (same file), add the new check **alongside** the
existing `checkBranchHasDiff` block, and run it before the user-supplied
verify steps:

```ts
if (args.branch && args.integrationBranch && !args.skipDiffCheck) {
  const diffStep = await checkBranchHasDiff(args.cwd, args.branch, args.integrationBranch)
  if (!diffStep.passed) {
    return { passed: false, steps: [diffStep] }
  }
  const cleanStep = await checkWorktreeClean(args.cwd)
  if (!cleanStep.passed) {
    return { passed: false, steps: [cleanStep] }
  }
}
```

Gating it behind `skipDiffCheck` keeps Writer tasks (which land via the
structured-write daemon and have a clean worktree by construction) on
the same skip path. Returning early ensures the merge step never runs
when the worktree is dirty — `verifyStep` already sets `verified: false`
when `verifyChanges` returns `passed: false`, and `mergeStep` already
short-circuits on `!inputData.verified`.

## Failure-signature registration

Add one rule to `errorClassRules` in
`orchestrator/src/mastra/lib/failure-signature.ts`:

```ts
{
  errorClass: 'dirty-worktree',
  match: /^dirty worktree:/i,
},
```

Resulting signature: `verify:worktree-clean/dirty-worktree`, distinct
from `verify:has-diff/no-commits-ahead`.

## Tests (vertical, one at a time)

Extend `orchestrator/src/mastra/lib/__tests__/verify-changes.test.ts`.
Follow the existing `checkBranchHasDiff` describe block's tmpdir +
`execFileSync('git', ...)` pattern — no mocks. One tracer-bullet test
first, then add one per acceptance criterion as you green each:

1. **Tracer:** untracked non-gitignored file → `checkWorktreeClean`
   returns `passed: false` and `output` starts with `dirty worktree:`
   followed by the file's path.
2. Unstaged modification to a tracked file → same failure shape.
3. Path in `.gitignore` does NOT trip the check (write a `.gitignore`
   that excludes the file, then create the file, then assert
   `passed: true`).
4. Clean worktree (no edits, no untracked files) → `passed: true`.
5. `verifyChanges` short-circuits before user steps when the worktree
   is dirty (analogous to the existing
   `verifyChanges short-circuits when empty-diff guard fails` test).
6. A new `failure-signature.test.ts` case asserting the
   `verify:worktree-clean/dirty-worktree` signature is produced for a
   `dirty worktree: ...` lead line, and that
   `verify:has-diff/no-commits-ahead` is unchanged.

## What NOT to do

- Do not gate this behind the Writer `skipDiffCheck` exception's
  inverse; reuse the same `skipDiffCheck` flag.
- Do not enumerate `git ls-files --others --exclude-standard` separately
  — `git status --porcelain` already merges the unstaged + untracked
  views and honours `.gitignore`.
- Do not pre-build the slice-2 surfacing-to-action queue path; this slice ends
  at "verify fails with the new signature, merge does not run".

## Verify command

From the worktree's `orchestrator/` subdirectory:

```
npm test --silent
npx tsc --noEmit
npx biome check .
```
