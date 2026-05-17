# Unblock note for mars-561de244 — "Remove the structured-write accommodation lane so the verify gate is uniform" (slice 1/2 of PRD df3b49ff)

The previous implementor was aborted with `too_hard:no-action-after-reads`
after reading `workers/index.ts`, `implement-workflow.ts`, `lib/git.ts`,
and the two test files without picking a starting shape. The stall cause
is a real ambiguity, not a missing helper: **how far does the "writer"
removal go in slice 1, and what is deferred to slice 2?** This note
resolves that boundary so the next attempt can go straight to a tracer
test → implementation loop.

## The decision that unblocks: how far slice 1 cuts

Collapse the classification to the **single surviving value `'coder'`**.
Slice 1 deletes the Writer worker and every special-case around it, and
reduces the tag type to one value. It does **NOT** build the friendly
CLI rejection message or the one-shot startup data migration — those are
**slice 2** (PRD user stories 2 and 3; they are deliberately absent from
this slice's acceptance criteria).

Why this is safe and in-scope for slice 1:

- Acceptance criterion 5 ("routing seam still exists and resolves every
  task to the default coding worker") is satisfied by keeping
  `TaskTag`, `TASK_TAGS`, `--tag`, `getWorkerForTag`, and `TAG_TO_WORKER`
  — just with one value, all routing to `Coder`.
- Reducing `TaskTag` to `'coder'` means `mars task add --tag writer`
  fails through the *existing generic* enqueue validation
  (`queue.ts` ~L787: `tag must be one of <TASK_TAGS>; got 'writer'`).
  That is acceptable for slice 1. The *clear, bespoke* rejection message
  is story 2 — do not build it here.
- Legacy queue rows with `tag = 'writer'` are already neutralised at the
  read boundary (`queue.ts` ~L695: `isTaskTag(rawTag) ? rawTag : 'coder'`),
  so no correctness gap. The one-shot startup migration that scrubs the
  stale value out of the data is story 3 — do not build it here.

Project posture is hard-cut (CLAUDE.md): remove `'writer'` everywhere now,
no "keep both for now". Let `npx tsc --noEmit` (run from `orchestrator/`)
enumerate every remaining call site after you change the type — that is
your exhaustive change-list; follow the type errors.

## Tracer bullet (start here)

1. **RED test** in `src/mastra/workers/__tests__/registry.test.ts`:
   assert `getWorkerForTag('coder')` returns `Workers.Coder` and that
   there is no `Writer` named worker (e.g. `('Writer' in Workers)` is
   `false`, `WorkerName` no longer includes `'Writer'`).
2. **GREEN**: in `src/mastra/workers/index.ts` delete
   `WRITER_DENIED_TOOLS`, the `Writer` entries in `WorkerName`,
   `WORKER_CONFIGS`, and `Workers`, and the `writer` row in
   `TAG_TO_WORKER` (leaving `{ coder: 'Coder' }`).

Then loop one criterion at a time.

## Change-map (let typecheck confirm completeness — do not treat as exhaustive)

`src/mastra/queue.ts`
- `TaskTag` → `'coder'`; `TASK_TAGS` → `['coder']`; `isTaskTag` → `value === 'coder'`.
  (This is the keystone change that makes typecheck list every other site.)

`src/mastra/workers/index.ts`
- Delete `WRITER_DENIED_TOOLS`, `Writer` from `WorkerName`, `WORKER_CONFIGS.Writer`,
  `Workers.Writer`, and the `writer` mapping in `TAG_TO_WORKER`.

`src/mastra/workflows/implement-workflow.ts`
- Delete `WRITER_FOOTER`, `WRITER_SYSTEM_PROMPT`.
- `composePrompt`: drop the `tag !== 'writer'` / `tag === 'writer'`
  branches — always append `DEVIATION_RULES` then `COMMIT_FOOTER`.
- `codeStep`: remove `systemPrompt: tag === 'writer' ? … : undefined`
  (pass `undefined`); the read-span watcher's `tag === 'coder'` guard is
  now unconditional — apply the watcher to every dispatched run.
- `verifyStep`: remove the `skipDiffCheck: inputData.tag === 'writer'`
  argument entirely (the diff/no-commits-ahead gate must run for every task).
- `mergeStep`: delete the entire `if (inputData.tag === 'writer')`
  short-circuit block (the one that `removeWorktree` + marks `done`
  without merging). Every task now flows through the real merge path.

`src/mastra/lib/git.ts`
- Remove `skipDiffCheck` from `VerifyArgs` and from the `verifyChanges`
  guard `if (args.branch && args.integrationBranch && !args.skipDiffCheck)`
  → `if (args.branch && args.integrationBranch)`. The gate must expose no
  skip option (acceptance criterion 4).

`src/cli.ts`
- `--tag` help/validation: drop `writer` from the accepted values and the
  `tagRaw !== 'writer'` check so only `coder` is accepted. Generic
  rejection only — bespoke message is slice 2.

Other producers (slicer/triager prompt text that tells the model it may
emit a `writer` tag, any scorer/fixture referencing it): typecheck +
`rg -n "writer|Writer|skipDiffCheck"` after the keystone change will
surface them. Fix every one in this slice (hard cut).

## Tests to update (acceptance criterion 6)

`src/mastra/workers/__tests__/registry.test.ts`
- Delete the `Writer pinned config` describe, the `WRITER_DENIED_TOOLS`
  import + assertions, and the `getWorkerForTag('writer')` expectation.
- Update the "named Workers" test to assert Writer is absent.
- Keep/strengthen: `getWorkerForTag('coder') === Workers.Coder`.

`src/mastra/workflows/__tests__/implement-workflow.test.ts`
- Delete the `composePrompt — writer routing` describe and the
  `WRITER_FOOTER` / `WRITER_SYSTEM_PROMPT` imports.
- Add: `composePrompt(...)` always ends with `COMMIT_FOOTER` and contains
  `DEVIATION_RULES` regardless of input; a test asserting the diff gate
  is uniform (clean tree + 0 commits ahead → verify fails with the
  no-commits-ahead outcome — `detectPostCoderState`/`checkBranchHasDiff`
  already give you the seam to assert on).

## Verify

From `orchestrator/`:

```
npx tsc --noEmit
npm test --silent
npx biome check .
```

All three must pass. Then `git add -A && git commit`. Self-check that the
commit count vs integration is `> 0` before exiting.

## Out of scope (do NOT do in this slice)

- Bespoke CLI rejection message for the retired tag (slice 2 / story 2).
- One-shot startup data migration of legacy `tag='writer'` rows (slice 2 / story 3).
- The unrelated slim-init file-writer subsystem — must not be touched.
- No new ADR (this implements the already-recorded ADR 0019).
