# Rescue Assessment — Arc 76100dad-restructure-prompts-for-cache-reuse

**Date:** 2026-08-18
**Failed task:** mars-5ebab6e8 (Move resume banner and verify-failure block into prompt suffix)
**First-principles recovery:** fix-9b7fb46d
**Rescue task:** mars-7ca9b37c (this task)

## What happened

`mars-5ebab6e8` was slice 2 of PRD `76100dad-restructure-prompts-for-cache-reuse`
(Restructure prompts for cache reuse). Its goal was to move the resume banner and the
distilled verify-failure block out of the `basePrompt` prefix and into the prompt suffix
in `orchestrator/src/workflows/primitives/index.ts`, so that the stable boilerplate
bytes (COMMIT_EXIT_CONDITION → CODING_DISCIPLINE → COMMIT_FOOTER) are byte-identical
across fresh and resume dispatches and qualify for provider-side prefix caching.

The coder landed its commit, but verify failed (`failed_phase: verify`). The verify
command

```
cd orchestrator && npx vitest run src/workflows/__tests__/implement-workflow.test.ts && npx tsc --noEmit
```

failed due to typecheck errors (failure signature `unknown/typecheck-error`). These
arose because the prompt-composition refactor changed argument shapes or type
signatures in a way the existing test expectations did not anticipate.

## Recovery

`fix-9b7fb46d` was spawned as the first-principles recovery task. It operated on the
same worktree (`task/mars-5ebab6e8`, branch `task/mars-5ebab6e8`). By the time the
rescue operator arrived, the fix task had already completed and merged its corrected
commit to `main`:

```
f1bf22f2 refactor(coder): move resume banner into prompt suffix for cache reuse
```

The commit added a unit test asserting that fresh and resume dispatches share identical
leading stable-prefix bytes, with only the trailing suffix differing between them, and
also corrected the type / argument issues that caused the verify failure.

## State at rescue arrival

| Task | Status | Notes |
|---|---|---|
| mars-5ebab6e8 | done | Recovered and merged via fix-9b7fb46d |
| fix-9b7fb46d | done | Merged at 2026-08-18 ~09:51 |
| mars-7ca9b37c | running | This rescue task |

The arc is **not** dead-ended. The rescue-operator was dispatched when `fix-9b7fb46d`
was `queued` with signature `unknown/typecheck-error`, but by execution time the fix
task had already succeeded, both upstream tasks are `done`, and `main` is clean
(`npm run knip` exits 0).

## Actions taken

None. No `mars` command or code edit was required — the arc self-resolved before
operator intervention was possible.

## Verdict

**continue** — the arc self-resolved via `fix-9b7fb46d`. The implementation is on
`main`; no restart or supersede is warranted.
