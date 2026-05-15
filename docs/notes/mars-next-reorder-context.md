# Context for `mars next` reorder (PRD 4bfdb52d / task mars-fe98223a)

Implementor for mars-fe98223a hit the 5-read budget without acting.
This note captures the synthesis from the read trail so the re-dispatched
worker can act immediately.

## Key facts already in the code

1. **Priority sort is already done at the DB layer.**
   `listTasks('blocked')` in `orchestrator/src/mastra/queue.ts` (line ~928)
   issues `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC,
   created_at ASC`. Blocked tasks come back high-priority first, ties
   broken by oldest `created_at`. No extra sort in `cli.ts` is needed —
   just consume the array as returned.

2. **The print block lives in `orchestrator/src/cli.ts` ~lines 2238–2315**,
   inside `if (cmd === 'next')`. The `--json` branch (line 2278) emits
   `{ drafts, blocked }` directly from already-priority-sorted `blocked`,
   so the JSON acceptance criterion needs no change beyond what the
   reorder already gives you.

3. **The human-readable change is a pure reordering of three print
   blocks** plus moving the header:
   - Move the `if (blocked.length > 0) { ... }` block (lines 2303–2313)
     to print *before* the `if (drafts.length > 0) { ... }` block
     (lines 2288–2301).
   - The header `Pick something to refine, or describe a new feature:`
     currently lives inside the drafts branch. Lift it to print once at
     the top whenever `drafts.length > 0 || blocked.length > 0`.
   - Keep the blank-line spacer between the two sections (currently
     `if (drafts.length > 0) console.log('')` inside the blocked branch
     — invert it: emit the spacer between blocked and drafts when both
     are non-empty).
   - Per-row formatting for blocked rows is unchanged — do **not** add a
     `[priority:N]` suffix.

## Testing seam

`cli.ts` is one large `switch(cmd)`; there is no existing unit test for
the `next` command. The repo's pattern for testable CLI helpers is to
extract a small pure function into `orchestrator/src/cli/<name>.ts`
with a colocated test under `orchestrator/src/cli/__tests__/<name>.test.ts`
(see `blocked-title.ts` / `short-id.ts` and their tests).

For TDD here, extract a renderer:

```ts
// orchestrator/src/cli/next-render.ts
export interface NextDraft { id: string; title: string; source: string;
  problemSet: boolean; solutionSet: boolean; userStoryCount: number }
export interface NextBlocked { id: string; title: string; blockerIds: string[] }

export const renderNext = (input: {
  drafts: NextDraft[]
  blocked: NextBlocked[]
}): string => { /* returns the multi-line output */ }
```

Then `cli.ts` calls `console.log(renderNext({ drafts, blocked }))`. Tests
assert ordering and section formatting against the returned string —
behaviour through the public interface, no internal mocks.

## Verify

`cd orchestrator && npx tsc --noEmit` must pass (acceptance criterion).
Run the new unit test file as well (existing tests in the repo use the
standard `node --test` / vitest pattern visible in
`orchestrator/src/cli/__tests__/short-id.test.ts` — match what's there).
