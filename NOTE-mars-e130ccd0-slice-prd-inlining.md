# Context for mars-e130ccd0 — inline PRD into dispatched slice prompts

Filed by the context-gathering task mars-97b4d08e. The mars-e130ccd0
implementor read 5 files and was aborted by the read-span watcher
before acting. This note pins the exact change site and the data the
fix needs, so the next dispatch can act after one read.

## What needs to change

File: `orchestrator/src/mastra/workflows/slice-workflow.ts`
Line 211 (inside `composeTaskPrompt`):

```ts
Read the parent PRD with \`mars idea show ${ideaId}\` to see the full intent
and the other slices' scope. Match the project's existing testing and
naming conventions.
```

This instruction is the bug. The dispatched coder runs from
`.mars/worktrees/<id>/`; `mars` resolves the repo from CWD upward and
binds to that worktree's own (empty) `.mars/`, so `mars idea show <id>`
returns "not found" and the implementor never sees the PRD.

## Recommended fix — option (b), inline the PRD body

Option (b) from the parent brief is preferred: inline the PRD content
into the dispatched prompt at slice-build time so the dispatched coder
needs no DB lookup. This is robust against any CWD shenanigans
(worktree resolution, future `--repo` flag churn, etc.).

The caller of `composeTaskPrompt` (in `generateStep.execute`, around
line 287 of the same file) already has the full `idea` object loaded
via `getProposal(inputData.ideaId)`. That object exposes exactly the
fields `buildSlicerPrompt` already uses:

- `idea.title`
- `idea.problem`
- `idea.solution`
- `idea.outOfScope`
- `idea.notes`
- `idea.userStories: string[]`

(See `buildSlicerPrompt` in the same file — its parameter type is the
authoritative reference for what's available.)

### Minimal surgical diff sketch

1. Widen `composeTaskPrompt`'s signature from `(ideaTitle, ideaId,
   slice, index, total)` to `(idea, slice, index, total)` where `idea`
   carries the six fields above plus `id`.
2. Replace lines 211–213 with an inlined PRD block:

   ```ts
   ## Parent PRD

   Title: ${idea.title}

   ### Problem
   ${idea.problem || '(not specified)'}

   ### Solution
   ${idea.solution || '(not specified)'}

   ### User stories
   ${renderUserStories(idea.userStories)}

   ### Out of scope
   ${idea.outOfScope || '(not specified)'}

   ### Notes
   ${idea.notes || '(not specified)'}
   ```

   `renderUserStories` is already exported (well, defined) in the same
   file — reuse it.

3. Update the single call site at ~line 287 from
   `composeTaskPrompt(idea.title, idea.id, slice, i + 1, total)` to
   `composeTaskPrompt(idea, slice, i + 1, total)`.

## Verify (per parent brief)

- A dispatched coder for any PRD slice can obtain PRD intent without
  passing `--repo` manually, OR the generated prompt no longer
  requires any DB lookup (PRD content is inlined).
- Add a unit test asserting `composeTaskPrompt`'s output contains the
  inlined PRD body (e.g. assert the rendered prompt includes
  `idea.problem` text and `idea.solution` text and does **not**
  contain the string `mars idea show`). The existing slice-workflow
  test file is the natural home; if none exists for `composeTaskPrompt`
  specifically, export it from the module (it's currently
  module-private) so the test can import it.
- `cd orchestrator && npm test` green.

## Read trail that burned the budget last time

1. Grep (broad)
2. Grep (broad)
3. Read `slice-workflow.ts` ← **the bug is here, line 211**
4. Grep `proposals.ts` ← unnecessary; the `idea` object's shape is
   already visible in `buildSlicerPrompt`'s parameter type two
   functions above in the same file
5. Glob `*slice*`

Skip steps 4–5. Read `slice-workflow.ts` once, edit, add the test,
commit.
