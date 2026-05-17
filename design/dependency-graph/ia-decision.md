# IA decision: dependency graph lives on every task-detail page

Status: accepted (v1, design-only)
Scope: mars-ui task-detail page
Related: PRD `578ab441-design-a-per-blocked-task-recovery-timel`,
ADR-0002 (recipe-per-failure-signature),
ADR-0008 (idea_dependencies and task_blockers live in separate junctions)

## Decision

The dependency-ordered graph renders on **every** task-detail page in the
mars-ui. There is no conditional gating:

- not behind a tab,
- not on a separate route,
- not gated by task status (blocked / in-flight / succeeded / not-started
  all show the graph),
- not gated by closure size (a single-node closure still renders).

The graph is part of the task-detail page itself — opening any task is
opening its dependency closure. A task with no idea ancestor and no
blockers degenerates to a single node, which is the expected and
self-explanatory shape for that case. Consistency across all detail
pages is the point: the operator never has to remember which tasks
"have" a graph.

## Vocabulary boundary

This view shows a **dependency closure** rooted at a task: the transitive
closure of two edge kinds from the current task, walked backwards —

- `originId`-parent edges (idea → task, task → fix-task, slice
  promotions): why this task exists.
- `blocker` edges (task → task it is waiting on): why this task is not
  done.

A dependency closure is deliberately narrower than an **Arc** and broader
than a **recovery chain**:

| Term                  | What it includes                                      | What it excludes                                  |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Arc (glossary)        | The full `originId` tree — every task descended from one originating idea, *including siblings*. The unit of analysis for `mars deep-reflect`. | Nothing within the origin tree.                   |
| **Dependency closure (this view)** | Lineage (`originId`-parent) **and** blockers, walked backwards from the current task. | Sibling tasks of any ancestor (no sideways walk). |
| Recovery chain        | A single fix-task chain rooted at one failure signature. | The originating idea, blockers outside that chain, and any task that isn't part of the fix-task lineage. |

Two narrower-than-Arc choices follow:

- **No siblings.** When the closure passes through an ancestor task, only
  the ancestor itself is rendered — not its sibling slices. The view
  walks lineage backwards, never sideways.
- **Includes blockers.** Unlike a recovery chain, the closure follows
  `task_blockers` edges as well, so "what is this waiting on" is part of
  the same picture as "how did this come to exist".

This is why the PRD avoids the word "arc": the colloquial sense
("recovery arc") clashes with the glossary's `Arc`, and neither matches
what this view actually renders.

## v1 scope exclusions

The following are deliberately out of scope for v1 and must not be
designed for:

- **No siblings.** Sibling tasks of any `originId`-ancestor are not
  rendered. This view walks lineage backwards only. The full Arc tree
  belongs to `mars deep-reflect`, not the detail page.
- **No time-as-layout-axis.** Depth drives layout, not time. The
  horizontal/vertical axis encodes distance-from-root, not chronology.
  Time appears only as a per-node attribute in the side-panel, never as
  a layout dimension.
- **No per-status color.** Statuses collapse into a small semantic
  palette (succeeded / needs-attention / in-flight / not-started). One
  color per granular task status is explicitly rejected for v1.
- **No in-view writes.** The graph and side-panel are read-only.
  Resolving inbox items, retrying tasks, unblocking, and any other state
  mutation continue to flow through the CLI. The view never mutates
  state.

## Storage and escalation context

The two edge kinds rendered by this view come from separate storage, as
established by **ADR-0008**: `idea_dependencies` and `task_blockers` are
two junction tables with no cross-graph edges. The closure walker must
therefore query both junctions independently and merge results; the
graph renderer distinguishes them visually (solid for `originId`-parent
lineage, dashed for blocker). ADR-0008 also confirms there is no
unified-graph storage to lean on — the view is the first consumer that
materialises a merged closure, and it does so at read time only.

The badge surfaced on fix-task nodes — `recovery-failed` or `no-recipe`
— is defined by **ADR-0002**: each failure signature has at most one
recipe, a fix-task is spawned when a recipe matches, and the absence of
a recipe (or a recovery-failed outcome from one) escalates the failure
to an inbox item. The graph reads those inbox items to decide which
nodes get a badge; it does not define when they exist.

## Write affordance

The view itself never writes. The **only** write affordance reachable
from the graph is the **inbox deep-link** rendered on a node's badge or
in the side-panel when the corresponding inbox item exists. The
deep-link points at **`/mars:inbox`**, where the operator resolves the
item using the existing inbox flow.

Retrying tasks, unblocking, editing blockers, and resolving the
underlying recovery state all remain CLI operations. The graph is a
read view with one well-defined exit toward the one place writes
already happen.

## Acceptance-criteria coverage (HITL checkpoint)

This section maps each acceptance criterion of slice 6/6 to the
section of this record that satisfies it, so a human verifier can
audit the decision without re-reading the whole document.

| Acceptance criterion | Section that satisfies it |
| -------------------- | ------------------------- |
| Graph appears on every task-detail page without conditional gating | "Decision" — bulleted list of *no* gates (tab, route, status, closure size). |
| Defines 'dependency closure' and contrasts it with 'Arc' and 'recovery chain' | "Vocabulary boundary" — table comparing all three terms plus the "no siblings / includes blockers" follow-ups. |
| Lists v1 scope exclusions: siblings, time-as-axis, per-status color, in-view writes | "v1 scope exclusions" — one bullet per excluded concern. |
| References ADR-0002 and ADR-0008 as storage/escalation context | "Storage and escalation context" — ADR-0008 for the two-junction storage shape, ADR-0002 for the badge / escalation semantics. |
| Names the inbox deep-link as the sole write affordance and points it at /mars:inbox | "Write affordance" — single deep-link to `/mars:inbox`; all other state changes remain CLI. |
