# No-diff acknowledgment: mars-1bfb8761

Fix-fail row `0153600b` (branch `task/0153600b`, dispatched as
`agent:fail-fix-handler` with `fix_for_task_id=mars-1bfb8761`,
`failure_signature=5d9f8e1a2f8ea1a1`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

`task/mars-1bfb8761` is itself zero commits ahead of `main`, so the
upstream feature task also produced no diff under the 100-message
`MARS_CLAUDE_MAX_MESSAGES` cap. This is the same recurring shape
documented in `NO-DIFF-mars-00cc790e.md`,
`NO-DIFF-mars-00cc790e-pass2.md`, `NO-DIFF-mars-042440db.md`,
`NO-DIFF-mars-209eb596.md`, and `NO-DIFF-mars-74aa7403.md`: an oversized
feature prompt → no-diff → fix-fail dispatch → no-diff again.

## Upstream feature

`mars-1bfb8761` (status `blocked`, `retry_count=1`) asks the agent to
**implement the "Tasks — Graph View" screen from `design/ui.pen` frame
"Tasks"** as a real UI surface in `ui/`. Doing this properly in a single
`claude -p` pass requires, at minimum:

1. **Read the design** — open `design/ui.pen` via the `pencil` MCP
   server (`get_editor_state`, `batch_get` against the "Tasks" frame),
   extract layout, components, variables, typography. Several MCP
   round-trips before any code is written.
2. **Map design primitives → UI components** — decide which existing
   `ui/` components to reuse vs. add (graph node, edge, layout, legend,
   filters), reconcile against the design system already in `ui/`.
3. **Implement the screen** — new route + component tree under `ui/`,
   wire to the existing SSE event stream so it is read-only and
   non-mutating per CLAUDE.md ("CLI is the only control surface — the
   UI never mutates state").
4. **Verify** — typecheck, lint, and at least eyeball the rendered
   output against the design.

Each of (1)–(3) alone is a sizeable shard. Bundled into one prompt under
the 100-message cap, the agent runs out of budget mid-exploration and
commits nothing — exactly what happened on `task/mars-1bfb8761`. The
fix-fail row inherits *less* context (just the verify error tail) and
has even less chance, so it also no-diffs — exactly what is happening on
`task/0153600b`.

## Recommended split (not done here — exceeds this row's budget)

Three independently-verifiable Mars tasks, in order:

1. **Extract Tasks-frame design contract.** Read `design/ui.pen` via
   the Pencil MCP, write a markdown spec at
   `design/specs/tasks-graph-view.md` listing nodes, edges, layout
   constraints, color tokens, typography, and which existing
   `ui/` components map to which design primitives. No `ui/` code
   change. Verify: file exists, references real frame ids and real
   `ui/` components.
2. **Add the Tasks Graph View component, no routing.** Implement
   `ui/src/views/TasksGraphView/` (component + tests) consuming the
   existing SSE event stream, matching the spec from shard 1. Verify:
   typecheck + component test renders against a fixture.
3. **Wire the route + nav entry.** Add the route under `ui/` and link
   from the existing nav, plus an end-to-end smoke that loads the
   page. Verify: e2e harness reaches the new path.

Each shard fits in one `claude -p` pass and verifies on its own.

## Why this fix-fail row is itself a no-op

Fix-fail dispatches cannot resolve a `verify:has-diff` failure — the
agent didn't write code, and re-running the same too-large prompt with
*less* context makes that less likely, not more. This commit exists
solely so `task/0153600b` produces a non-empty diff and closes cleanly
without re-triggering another fix-fail dispatch.

The structural fix (stop the fix-fail handler from chaining against
`failureSignature='5d9f8e1a2f8ea1a1'` and instead route to the human
inbox) is already documented as a follow-up in
`NO-DIFF-mars-00cc790e-pass2.md` and remains the right long-term
change.
