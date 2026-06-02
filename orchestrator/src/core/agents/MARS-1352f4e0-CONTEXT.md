# mars-1352f4e0 — redundant follow-up, superseded

**Task:** `mars-1352f4e0` — context-gathering follow-up for
`mars-b44a45fc` ("Agent registry foundation", Slice 1 of PRD
`2b8e1d21-implement-the-agent-live-board-in-pencil`).

**Status:** Redundant. The unblock work this task was created to do is
already on `main` and there is nothing left to gather.

## Why

mars-1352f4e0 was queued because the *first* implementor for
mars-b44a45fc bailed with `too_hard:no-action-after-reads` after reading
`implement-workflow.ts` three times. Before mars-1352f4e0 was
dispatched, a separate context-gathering pass already landed the unblock
note for mars-b44a45fc:

- Commit `3f1ed50` — *context(mars-b44a45fc): unblock agent registry
  foundation slice*
- File: `orchestrator/src/core/agents/MARS-b44a45fc-CONTEXT.md` (sits
  next to this note)

That note covers everything the next dispatch needs:

1. The registry (`AgentSpec` interface, `agents` map, `getAgentSpec`)
   already exists on `main` with `vcs-supervisor` as its single entry —
   do **not** delete it; the slice text "exactly one agent today" is
   stale.
2. The "previously inlined writer prompt constant" is
   `WRITER_SYSTEM_PROMPT`, exported from
   `orchestrator/src/core/workflows/implement-workflow.ts` (~line 182).
   `WRITER_FOOTER` is a *user-prompt* footer and is **not** the one the
   slice means.
3. Schema mismatch (`id`/`displayName` in the slice vs. `name`/
   `description` on `AgentSpec`) — recommended resolution is to add an
   optional `displayName?: string` field, treat `name` as the id, and
   set `displayName` on both the existing `vcs-supervisor` entry and the
   new `writer` entry.
4. Step-by-step path forward for the writer-entry implementation, the
   `implement-workflow.ts` rewire to `getAgentSpec('writer').systemPrompt`,
   and the test additions.

## Read trail that mars-1352f4e0 followed

  1. Grep → `orchestrator/src`
  2. Glob → worktree root
  3. Grep → `orchestrator/src`
  4. Read → `orchestrator/src/core/agents/index.ts`
  5. Read → `orchestrator/src/core/agents/__tests__/registry.test.ts`

Both of those files are exactly what `MARS-b44a45fc-CONTEXT.md` describes:
the typed registry with `vcs-supervisor` and the existing four-test
vitest suite. There was nothing further for mars-1352f4e0 to discover.

## Recommended disposition

- `mars purge mars-1352f4e0` (or `mars unblock mars-1352f4e0 && mars
  purge mars-1352f4e0`) — the task has no remaining scope.
- Re-dispatch mars-b44a45fc directly; `MARS-b44a45fc-CONTEXT.md` is the
  brief.
- If a future watchdog re-creates a chain of context-gathering
  follow-ups on a task that already has a sibling `MARS-*-CONTEXT.md`
  note, treat that as a signal to short-circuit rather than re-walk the
  same read trail.
