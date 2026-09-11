# Topology view maps intra-arc lineage, not the cross-arc blocker graph

## Status

Accepted

## Context

`TopologyView` renders **arcs as nodes**. The only relationship it can express between two
nodes is a **cross-arc blocker edge**. In practice the view is almost always edgeless, and
renders as a grid of disconnected cards with a footer reading
`No dependencies between active arcs.`

This is not a rendering defect. The empty state is honestly derived, and the code comment
at `ui/src/widgets/TopologyView.tsx:715` explains it correctly: a recovery edge is internal
to its arc's card, so a snapshot where nothing blocks anything *across* arcs genuinely has
no line to draw.

The non-obvious part is **why** that is the steady state rather than a coincidence:

- Recovery lineage (origin -> recovery -> merge) is intra-arc by construction, so it can
  never surface as a line on an arc-node canvas.
- **ADR-0040 makes recovery tasks leaf nodes** — they cannot have blockers, cannot be
  blocked, and the blocker cascade does not recurse through them. The richest relationship
  in the domain is therefore structurally forbidden from ever being an edge in this view.

ADR-0040 was authored as an orchestration constraint, to make the blocker cascade
terminate. It silently determined what this visualisation could ever show, three layers
away. Nothing recorded that coupling, so the view kept being treated as if its emptiness
were a data-volume problem that more tasks would eventually fix.

What remains as a legitimate cross-arc edge is the operator's occasional hand-authored
`--blocked-by` between two separate arcs. Real, but not the common case.

Meanwhile PRODUCT.md spends the product's entire novelty budget here — "novelty is spent
only on the topology view, the one surface with no standard answer" — and states the view's
purpose as tracing "lineage and blockage". The view currently maps the blockage that is
usually absent and not the lineage that is always present.

The costs of the canvas are not hypothetical: a ReactFlow/dagre dependency, a CSS
custom-property name built by string-concatenating a data value (`:227`) that silently
yields a transparent group for any new cluster name, a `rgba(0,0,0,0.4)` dark-canvas shadow
left on a cream ground (`:196`), and an `aria-label` (`:617`) that redirects
screen-reader and keyboard users to the Board tab beside it.

A precedent already exists one level down. `ui/src/widgets/ArcTree.tsx:1-13` records
replacing a G6 canvas with a pure DOM/CSS indented list, for reasons that hold verbatim at
page scale: selectable text reachable with Cmd-F, real semantic markup instead of an
aria-hidden canvas workaround, and no animation/drag/zoom overhead for a read-only
4-8 node arc. The arc-level widget adopted that decision; the page-level one did not.

## Decision

**The topology view maps intra-arc lineage — origin -> recovery -> merge, with durations
and per-step outcome. Cross-arc blocker edges become an overlay on that view, not its
organising principle.**

Consequently:

- The subject of the map is the arc's own lineage, which is always present, rather than
  the cross-arc blocker graph, which is empty by design most of the time.
- The step-rail model already validated in the task drawer is extracted to a pure function
  serving both the drawer and the page, unit-testable without a DOM, following
  `ArcTree`'s `buildArcTree` precedent.
- Rendering is DOM-first for the same reasons `ArcTree` gives. Position and ordering must
  carry information (arc age, blocked depth, task count); a layout where position means
  nothing is not a map.
- The honest empty state is kept but promoted from an 11px footer note to a real
  `EmptyState` on the canvas: a graph empty of relations is a finding about the fleet, not
  a footnote.
- `TopologyView.tsx:617`'s accessibility concession must become **false**, not reworded.

## Consequences

**Accepted costs.** Cross-arc blocker edges lose their status as the primary subject and
become secondary; an operator who hand-authors many `--blocked-by` edges across arcs sees
them as an overlay rather than as the layout itself. Extracting the drawer's step-rail
model adds a seam that both surfaces must respect, and a page-level regression can now
affect the drawer. Dropping to DOM-first forgoes pan/zoom on very large fleets — if node
counts later make that untenable, this ADR should be revisited rather than worked around.

**Gains.** The view is useful in the system's normal state instead of empty in it. It stops
being strictly less useful than the Board tab it currently redirects to. It becomes
accessible on its own terms rather than by referral. The canvas-era defects
(`:196`, `:227`, `:579`, `:596`) are retired with the canvas rather than individually
patched.

**Constraint made explicit.** ADR-0040's leaf-node rule for recovery tasks is now recorded
as a binding input to what the topology view can show. Any future change to that rule must
consider this view, and any future proposal to "add more edges" to topology must first
establish that the edges can exist at all.

**Rejected alternative — keep the canvas, make position meaningful.** Ranking nodes by arc
age or blocked depth would make an edgeless grid informative at lower cost. Rejected
because it retains every canvas cost, including the accessibility concession, while still
mapping the relationship that is usually absent.

**Fallback, not target.** If lineage promotion proves too large for one slice, applying
`ArcTree`'s decision unchanged at page level (an indented DOM list of arcs, no lineage
model) is the acceptable floor: it removes the accessibility concession and the canvas
defects without yet delivering the lineage map.
