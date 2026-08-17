# Rescue Assessment: arc mars-93e9f75f

**Date:** 2026-08-17  
**Rescue task:** mars-ffa5b89b  
**Origin task:** mars-93e9f75f  
**Recovery task:** fix-7dab956e (dead-ended)

## Finding

The origin task's worktree (`task/mars-93e9f75f`) contained a correct fix
(`51a0b80f`) for the drop-cascade FK bug. The verify (`npm test`) failed
solely because `fix-recipes.test.ts` was missing an entry for the
pre-existing `code/empty-diff` recipe — this failure predates the task
branch (introduced in `9a3adbe6`, 79 commits before the merge base
`79cda6bb`).

## Action

Added the missing `code/empty-diff` entry to `RECIPE_CONTRACT_TABLE` in
`fix-recipes.test.ts` directly in the mars-93e9f75f worktree (commit
`ec090726`). All 186 `fix-recipes.test.ts` tests pass after the fix.

## Verdict

`continue` — the worktree is now verify-ready; the arc should proceed to
merge normally.
