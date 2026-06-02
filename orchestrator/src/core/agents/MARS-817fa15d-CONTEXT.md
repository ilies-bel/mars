# mars-817fa15d — third-order redundant context-gathering

**Task:** `mars-817fa15d` — context-gathering follow-up for `mars-1352f4e0`,
which is itself a context-gathering follow-up for `mars-b44a45fc`
("Agent registry foundation", Slice 1 of PRD
`2b8e1d21-implement-the-agent-live-board-in-pencil`).

**Status:** Doubly redundant. Both prior unblock notes are already on
`main` in this directory and together cover everything any future
implementor needs.

## Why nothing remains to gather

- `MARS-b44a45fc-CONTEXT.md` (sibling file) is the actual unblock note
  for the parent slice. It resolves the three contradictions that
  stalled the original implementor (stale "exactly one agent" premise,
  `WRITER_SYSTEM_PROMPT` location in `implement-workflow.ts:~182`,
  `id`/`displayName` vs. `name`/`description` schema mismatch) and gives
  a step-by-step path forward.
- `MARS-1352f4e0-CONTEXT.md` (sibling file) already documented that
  mars-1352f4e0 was redundant the moment it was dispatched, recommended
  `mars purge mars-1352f4e0`, and called out the watchdog pattern of
  re-creating context-gathering follow-ups on tasks that already have a
  sibling `MARS-*-CONTEXT.md`.
- The implementor for mars-1352f4e0 read exactly the two files the
  b44a45fc note describes (`agents/index.ts`, the four-test vitest suite
  in `agents/__tests__/registry.test.ts`), confirmed they match the
  brief, and had nothing further to do. mars-817fa15d would walk the
  same read trail and reach the same conclusion.

## Read trail before abort (mars-1352f4e0)

  1. Grep → `orchestrator/src`
  2. Glob → worktree root
  3. Grep → `orchestrator/src`
  4. Read → `orchestrator/src/core/agents/index.ts`
  5. Read → `orchestrator/src/core/agents/__tests__/registry.test.ts`

Both of those files already match what `MARS-b44a45fc-CONTEXT.md`
describes. There is no new context to surface.

## Recommended disposition

- `mars purge mars-817fa15d` and `mars purge mars-1352f4e0` — both have
  no remaining scope.
- Re-dispatch `mars-b44a45fc` directly; `MARS-b44a45fc-CONTEXT.md` is
  the brief.
- Treat this third-order chain (b44a45fc → 1352f4e0 → 817fa15d, all
  context-gathering, all redundant) as a watchdog bug: when the
  no-action-after-reads watcher fires on a task whose worktree already
  contains a sibling `MARS-<parent-id>-CONTEXT.md`, the right move is to
  short-circuit (mark the task done with that note as the artifact)
  instead of queuing yet another context-gathering child.
