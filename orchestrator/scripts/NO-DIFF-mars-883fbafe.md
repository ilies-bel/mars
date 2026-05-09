# No-diff acknowledgment: mars-883fbafe

Task `mars-883fbafe` ("Add a 'mars monitor' TUI subcommand…", branch
`task/mars-883fbafe`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

Unlike the prior `NO-DIFF-mars-*` notes, this is **not** a fix-fail row
dispatched by `agent:fail-fail-handler` against an already-resolved
upstream. It is the original feature task itself, dispatched once and
retried once (`retryCount: 1`), and both passes ended with the agent
producing no commit. The fix-fail dispatch on top of it is `e39eda08`,
which is the commit you are currently reading.

## Why there is no diff

The acceptance criteria are not unfixable in code — they describe a real,
implementable feature. The problem is **shape**, not feasibility: the
prompt asks one `claude -p` session to deliver, in a single dispatch, a
feature that spans four loosely-coupled surfaces:

1. **Daemon instrumentation** — emit `slot.acquire` / `slot.release` bus
   events at every acquire/release call site in
   `orchestrator/src/mastra/daemon/server.ts` (currently 8+ paired sites
   across triage / implement / refine / glossary-write / adr-add).
2. **`/status` RPC extension** — expand the existing inFlightCount
   response to include a per-slot `{ pool, index, taskId, goal,
   startedAt }` table, which requires threading a per-slot identity
   through every `acquire`/`release` pair (the current `Semaphore` has
   no slot index, only a count).
3. **SSE event forwarding** — wire the two new bus topics through the
   daemon's `/events` surface alongside `task.queued` / `task.completed`,
   without disturbing the existing `ui/server/sse.ts` consumer contract.
4. **A new Ink TUI subcommand** — three components (`<Slots/>`,
   `<Queue/>`, `<Recent/>`), a `useReducer` over five event types,
   `EventSource` transport with exponential-backoff reconnect, snapshot
   fetch on mount, plus a CLI dispatcher entry, plus reducer unit tests.

That is roughly 15–20 new/changed files spanning the daemon worker pool,
the SSE bus, the CLI router, and a new TUI tree — well above the working
budget of one headless dispatch, especially with the new
`MARS_CLAUDE_MAX_MESSAGES=100` cap (commit `2242e1f`, landed *after* this
task's two passes ran). Two consecutive no-diff results from the same
oversized prompt is the failure mode that shape — not the recipe — needs
to fix.

## Why this fix-fail task is itself a no-op (in code)

Splitting `mars-883fbafe` into four independently shippable Mars tasks is
a **planning** action — it belongs in the `mars task add` queue, not in
this worktree's diff. The block-tracked-writes hook also forbids touching
`CONTEXT.md` / `docs/adr/**` directly from a coding worktree, so the only
correct on-disk artifact for this fix-fail row is this acknowledgment.

The four follow-up tasks below are the recommended split. They are not
enqueued by this commit; the daemon ack flow will surface this row to the
human operator, who can decide whether to enqueue them as written or
re-shape further before adding them via `mars task add`.

## Recommended split

Slice the original spec into four ordered tasks. Each is small enough to
fit one `claude -p` dispatch and verifies independently.

1. **`mars monitor` — daemon: per-slot identity in the worker pool.**
   Replace the bare `Semaphore` counter with a `Slot[]` per pool, where
   each slot holds `{ pool, index, busy, taskId?, goal?, startedAt? }`.
   Update every `acquire` / `release` site in
   `orchestrator/src/mastra/daemon/server.ts` to claim/free a specific
   slot index. No bus events yet; verify with the existing daemon tests
   plus a new unit test that asserts slot reuse and FIFO ordering of
   pending acquirers.

2. **`mars monitor` — daemon: emit `slot.acquire` / `slot.release` and
   extend `/status`.** On top of (1), emit the two new bus topics with
   the payload shape from acceptance bullet 5, forward them through the
   daemon's `/events` SSE surface, and extend the `/status` RPC to
   include the per-slot table when busy. Verify by curl-ing `/status`
   and `/events` with one task in flight.

3. **`mars monitor` — Ink TUI scaffold.** New
   `orchestrator/src/cli/monitor/` directory: `<Monitor/>` root with a
   header line plus three empty section components, the reducer over
   five event types, and an `EventSource` client with snapshot-fetch on
   mount and exponential-backoff reconnect. Wire the `monitor` case into
   the CLI dispatcher. Reducer unit tests required; no e2e Ink render.

4. **`mars monitor` — Slot / Queue / Recent rendering polish.** Fill in
   the three components against the reducer state from (3): pool
   category, slot index, status, task id + 60-char goal, elapsed wall
   time; queue depth + next 3-5 ids; last 5 merged with duration and
   verify pass/fail. `q` / Ctrl-C exit. Manual verification per
   acceptance bullet 1.

Each task should reference this ack file in its prompt body so the
follow-up agent has the context for *why* the original was split. The
daemon worker pool note in `orchestrator/AGENTS.md` ("When you add a new
dispatch path, route it through `acquire(sems.<kind>)`…") is the
authoritative shape for tasks (1) and (2).

## Real follow-up

Two recurring themes in the NO-DIFF series suggest a planner-side rule,
not just an agent-side one:

- **Oversized-prompt detection.** A task whose acceptance bullets span
  more than ~3 distinct subsystems (daemon, SSE, CLI, TUI here) should
  be flagged at `mars task add` time, not after two failed dispatches.
  Could live in the `/mars:next` shaping flow as a heuristic check on
  the technical-notes section.
- **Two-strikes drop-and-reshape.** The retry mechanism currently
  re-queues a failed task as-is. After two consecutive `verify:has-diff`
  no-diff failures on the same prompt with the same retryCount delta, the
  daemon should auto-route to a "re-shape" inbox item rather than a third
  dispatch — same flavor as the rebase-landed-ref-stale auto-detection
  rule already filed in `NO-DIFF-mars-924033ce.md` / earlier acks.

Both follow-ups are out of scope for this acknowledgment commit and
should be filed as separate `mars task add` entries by the human operator
who reads this row.
