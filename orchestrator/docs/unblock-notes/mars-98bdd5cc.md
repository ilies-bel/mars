# Unblock note for mars-98bdd5cc — "Remove task worktree on successful merge"

Two prior implementor runs (`mars-98bdd5cc`, `mars-f79a83d7`) bailed via
`too_hard:no-action-after-reads` while hunting for a workflow-level test
harness that does not exist. This note collapses the search.

## What's already in place

`orchestrator/src/mastra/workflows/implement-workflow.ts` already calls
`removeWorktree` after a successful merge:

- **line 938**: `await removeWorktree({ path: inputData.path, branch: inputData.branch }, true)`
- **line 939**: `await updateTask(inputData.taskId, { status: 'done', failedPhase: null })`

`removeWorktree` is defined in `orchestrator/src/mastra/lib/git.ts:163-175`:

```ts
export const removeWorktree = async (
  ref: WorktreeRef,
  force = true,
  keepBranch = false,
): Promise<void> => {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(ref.path)
  await exec('git', args, { cwd: repoRoot() })
  if (!keepBranch) {
    await exec('git', ['branch', '-D', ref.branch], { cwd: repoRoot() }).catch(() => {})
  }
}
```

## The actual delta this slice needs

Three precise changes against the acceptance criteria:

1. **Drop the force flag on the success path.** Acceptance criterion:
   "Worktree removal does not use a force flag; a dirty worktree
   surfaces as a failure rather than being silenced." Change
   `implement-workflow.ts:938` from `..., true)` to `..., false)`.
   Leave the writer short-circuit at line 816 alone — that path is
   unrelated and the parent PRD's other slices may touch it.

2. **Tolerate a failure to remove and still flip to `done`.**
   Acceptance criterion: "If worktree removal fails (e.g. dirty
   worktree), the task still flips to done." Wrap the line-938 call in
   `try/catch`; on catch, log the failure (`console.error`) and
   **still** run the `updateTask(..., { status: 'done', ... })` at
   line 939. Do not call `handleTaskFailureWithFixTask` from this
   path — the merge already succeeded; the cleanup failure surfaces
   through stderr / the orchestrator log per the AC ("the failure
   surfaces through the cleanup-failure path").

3. **Add the happy-path test.** Do NOT try to mock `mergeStep`'s
   workflow plumbing — there is no precedent for it in
   `workflows/__tests__/`. Instead, exercise `removeWorktree`
   directly with a real git repo + worktree in a temp dir, mirroring
   the existing `describe('checkMergeTargetStatus', …)` block in
   `orchestrator/src/mastra/lib/__tests__/git.test.ts:338-415`. That
   block already shows the exact pattern: `mkdtempSync` + `git init` +
   `MARS_REPO=repo` + `vi.resetModules()` + `await import('../git')`.

   The test should:
   - `git init` a repo, commit a file on `main`.
   - `git worktree add <path> -b task/x main`, commit something on
     `task/x` from inside the worktree.
   - `git checkout main` in the repo, `git merge --ff-only task/x`.
   - Call `removeWorktree({ path, branch: 'task/x' }, false)`.
   - Assert `existsSync(path) === false`.

   Place it in a new `describe('removeWorktree', …)` block at the
   bottom of `git.test.ts`. Imports needed are already in the file
   (`mkdtempSync`, `rmSync`, `execFileSync`, `tmpdir`, `existsSync`
   via `node:fs`).

## What NOT to do (these tripped the earlier runs)

- Don't try to write workflow-level tests under
  `workflows/__tests__/`. The existing file only tests
  `composePrompt`; there is no Mastra workflow harness pattern in
  the codebase yet, and inventing one is out of scope for this
  tracer-bullet slice.
- Don't introduce a separate `removeWorktreeOnMerge` helper. Inline
  the try/catch in `mergeStep` — it's three lines and matches the
  style of the surrounding code.
- Don't touch the writer short-circuit at line 816 or the failure
  branches that retain the worktree.

## Verify

From `orchestrator/`:

```
npx tsc --noEmit
npm test --silent -- git.test.ts
```

Both must pass. Then `git add -A && git commit`.
