# Note: scoping for mars-da0e8871 (per-run lifecycle tracing)

This note exists to unblock the implementor for **mars-da0e8871** (and its
recovery child **mars-cb461a73**), which has stalled twice on the same
brief without producing a diff. The blocker is not in the prompt's first
two steps — it is in step 3.

## What the prompt asks for

> Add per-run lifecycle tracing events so the read-only UI (port 7777)
> can show running agents live.

Four numbered steps:

1. Extend `InternalEvents` in `orchestrator/src/internal-bus/events.ts`
   with `run.started / run.step.started / run.step.finished /
   run.claude.event / run.claude.usage / run.finished`.
2. Emit them from `orchestrator/src/mastra/workflows/implement-workflow.ts`.
3. **Forward a filtered subset through the UI SSE hub in
   `ui/server/index.ts` + `ui/server/sse.ts`.**
4. Types: import `ClaudeEvent` from `../lib/claude-stream`, no `any`.

Steps 1, 2, and 4 are mechanical and live entirely inside `orchestrator/`.
Step 3 is the trap.

## Why step 3 is infeasible as written

The `internalBus()` in `orchestrator/src/internal-bus/index.ts` is a
**process-local** `EventEmitter` singleton ("only valid for the lifetime
of the current Node process", per its own jsdoc).

The UI server is a **separate Bun process**: `ui/package.json` ships its
own `dev:server` entry (`bun --watch run server/index.ts`) and has no
dependency on `orchestrator/` — its imports are all local to `ui/server/`,
and `ui/server/sse.ts` broadcasts only to clients connected to its own
`/events` stream. There is no in-process event bridge between the two.

Calling `internalBus().on('run.started', …)` from `ui/server/index.ts`
would:

- pull `@/orchestrator/src/internal-bus` into the UI's build graph
  (the UI does not depend on it),
- instantiate a **second** `TypedEmitter` inside the UI process,
- subscribe to a bus that never receives the orchestrator's emissions.

So step 3 needs an architectural decision that is not in the brief.

## What to do

**Implementor of mars-da0e8871**: do steps 1, 2, and 4 only. They land
the event vocabulary and the emit sites; they are mechanically clean and
test the same way they would as a complete unit (the parent prompt's
verification — `run.started / run.step.* / run.finished` emitted in
order from a mocked workflow run — only exercises the internal bus, not
the UI bridge).

**Step 3 is filed as a follow-up idea** (`cf0351cf` — `mars idea show
cf0351cf`) with three options to choose from:

  - durable outbox in `queue.db` the UI tails (consistent with how the
    UI already reads `queue.db` via `TaskDb`);
  - Unix domain socket the orchestrator publishes to;
  - shared SSE endpoint exposed by the orchestrator's `mastra dev`
    server that the UI proxies.

Pick one in a separate task (or grilling session) before re-attempting
step 3. The bridge is the harder architectural call, not the events
themselves.

## Verification of the trimmed scope

The parent prompt's verification block can land unchanged for the
trimmed scope:

- `cd orchestrator && npm run build` (TypeScript clean).
- `cd orchestrator && npm test internal-bus` and existing
  `implement-workflow` tests pass.
- New unit test: mocked workflow run emits `run.started`, at least one
  `run.step.started / run.step.finished` pair, and `run.finished` in
  order. `runClaudeCode` is mocked so no real `claude -p` is spawned.

The UI-side test from step 3 (SSE forwarding) is descoped along with
step 3 itself.

## File-level orientation

- Bus events: `orchestrator/src/internal-bus/events.ts` (current shape:
  `task.blocked`, `task.unblocked` only — extend here).
- Emit sites: `orchestrator/src/mastra/workflows/implement-workflow.ts`
  has four `createStep` calls (`setup-worktree`, `run-claude-code`,
  `verify`, `merge`) — wrap each with `run.step.started` / `…finished`
  inside `execute`, and bracket the whole workflow with `run.started` /
  `run.finished`. Generate `runId` once at workflow entry with
  `crypto.randomUUID()`; thread it through step inputs/outputs so each
  step's emit carries the same id.
- `ClaudeEvent`: re-exported from
  `orchestrator/src/mastra/lib/claude-stream.ts` (already imported by
  `implement-workflow.ts`).
- Usage summary: `summarizeUsage(conversation)` from
  `orchestrator/src/mastra/lib/claude-usage.ts` (already in scope in
  `codeStep`).
