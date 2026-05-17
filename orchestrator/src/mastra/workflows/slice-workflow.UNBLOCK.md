# Unblock note for the slicer message-cap error task (mars-29052b4a)

The previous implementor stalled on reads because the parent prompt's
**coordinates are stale**, not because the work is unclear. Everything you
need already exists. Make the change with the corrected facts below, then
**delete this file in the same commit** so it does not land on `main`.

## 1. The real throw site (prompt says 202-206 — that is WRONG)

Line 202-206 of `slice-workflow.ts` is unrelated `extractSchemaIdentifiers`
code. The actual `Workers.Slicer.run` call + non-zero-exit throw is
**lines 338-345**:

```ts
const r = await Workers.Slicer.run(buildSlicerPrompt(idea), {
  cwd: getRepoRoot(),
})
if (r.exitCode !== 0) {
  throw new Error(
    `claude -p exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
  )
}
```

`idea.id` is in scope here (also `inputData.ideaId`). Special-case the
cap **before** the generic throw, e.g.:

```ts
if (r.exitCode !== 0) {
  if (r.exitCode === 137 && r.stderr.includes('message cap')) {
    const n = r.stderr.match(/message cap of (\d+)/)?.[1]
    throw new Error(
      `slicer hit its message cap${n ? ` (${n})` : ''} before emitting slices — ` +
        `PRD ${idea.id} is too large to slice in one pass; raise ` +
        `WORKER_CONFIGS.Slicer.maxMessages or split the PRD`,
    )
  }
  throw new Error(
    `claude -p exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
  )
}
```

The cap string is emitted verbatim by `lib/git.ts` (`runClaudeCode`,
~lines 662-669): `claude -p hit message cap of ${cap} (MARS_CLAUDE_MAX_MESSAGES)`
with `exitCode: 137`. `Workers.Slicer.run` is a thin wrapper that returns
that `RunClaudeResult` unchanged (`workers/index.ts:185-203`).

## 2. `describeSliceFailure` needs NO change

It does **not** collapse step errors. The throw above fires inside
`generateStep.execute`, so Mastra marks step `generate-slices` failed with
that Error; `describeSliceFailure` (lines 567-601) already appends
`step "generate-slices" failed: <your message>` and `runSlice` rethrows it
as `new Error(describeSliceFailure(result))`. The distinct message
propagates verbatim end-to-end with zero edits to `describeSliceFailure`.
Do not touch it. (The prompt's "if it collapses, adjust minimally" clause
does not apply — it doesn't collapse.)

## 3. Test mock seam — DO NOT stub `Workers.Slicer.run`

The prompt says "stub Workers.Slicer.run"; the existing suite never does
that and you should not either. `Workers.Slicer.run === runClaudeCode(...)`,
so you stub **`runClaudeCode` from `../../lib/git`** via `vi.doMock`. Copy
the existing test verbatim as your template:

> `slice-workflow.test.ts` lines 420-450 — *"leaves the idea at prd-ready
> when claude -p exits non-zero (slicer outage)"* — already mocks
> `runClaudeCode` to return `{ exitCode: 1, stdout: '', stderr: '...' }`.

- **Cap test:** clone that block, return
  `{ exitCode: 137, stdout: '', stderr: 'claude -p hit message cap of 250 (MARS_CLAUDE_MAX_MESSAGES)', sessionId: 'stub-session', conversation: [] }`,
  seed a prd-ready idea (`seedPrdReadyIdea` helper at lines 311/646), and
  assert `runSlice` rejects with a message containing `message cap` AND
  `split the PRD` AND `not.toBe('slice workflow failed')`.
- **Regression test:** the lines 420-450 test already covers the generic
  `exitCode: 1` path at the workflow level; add a focused assertion (or a
  sibling test) that the thrown message still matches
  `/claude -p exited 1: some other failure/` so the cap branch does not
  swallow the generic path.

Mock shape returned by the stub must include `sessionId` and
`conversation` (see the existing mocks) or the rehydrated result differs.

## 4. Verify

`cd orchestrator && npm run build && npm test`

Save your work: `git add -A && git commit -m '...'` — and remember this
note file must be **deleted** as part of that commit.
