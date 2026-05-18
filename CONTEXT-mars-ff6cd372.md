# Context note: mars-ff6cd372

**Finding:** The `mars arc list` feature requested in the parent prompt is
**fully implemented on `main`** — commit `2b2e0de` ("feat: add mars arc list
CLI verb and refactor listDeepReflectArcCandidates opts").

## What is already on main

- `orchestrator/src/cli.ts` — `arc list` command handler at line 2494,
  including `--limit`, `--json`, `--with-transcript-only` flags, tab-separated
  text output with header row, and top-level usage string entry at line 308.

- `orchestrator/src/mastra/lib/deep-reflect-query.ts` —
  `listDeepReflectArcCandidates` already accepts
  `opts: { limit?: number; withTranscriptOnly?: boolean }` with
  `withTranscriptOnly` defaulting to `true`.

- `orchestrator/src/mastra/lib/__tests__/deep-reflect-query.test.ts` —
  11 tests pass, including the `withTranscriptOnly: false` branch tests
  (arcs without transcripts appear; ad-hoc single-task arcs are included).

## Verification (run in this worktree)

- `npm run build` — build successful ✓
- `npx vitest run src/mastra/lib/__tests__/deep-reflect-query.test.ts` —
  11/11 tests pass ✓

## Conclusion

Nothing to implement. Closing the 5-deep context-gathering chain:
`mars-d064152d → mars-47e7c440 → mars-14c5c24c → mars-0bd92d9b → mars-ff6cd372`.
