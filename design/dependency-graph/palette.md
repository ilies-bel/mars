# Dependency graph: semantic color palette

Four named states encode all the information a node carries about status.
Individual task-status enum values (queued, running, verifying, merging,
done, failed, blocked, dropped) collapse into this palette — there is no
per-enum color. The palette applies uniformly to task nodes and idea-root
nodes alike; shape (not color) distinguishes an idea root from a task node.

---

## The four values

| Semantic name    | Token         | Hex       | Intent                                                                |
| ---------------- | ------------- | --------- | --------------------------------------------------------------------- |
| **succeeded**    | `$mars-ice`   | `#D9E4E8` | Terminal success — task reached `done` and merged cleanly, or idea has been fully sliced and dispatched. |
| **needs-attention** | `$mars-iron` | `#9C2E35` | Terminal failure or permanently blocked — the harness has stopped; operator action is required. Covers `failed`, `blocked` (no active blocker resolution), and `dropped`. |
| **in-flight**    | `$mars-amber` | `#E8A33D` | Actively worked — `running`, `verifying`, or `merging`. The harness is making progress right now. |
| **not-started**  | `$neutral-400` | `#A89684` | Dormant — `queued`, `draft`, or any other state where the harness has not yet claimed the work. |

---

## Color application on a node

The status color is applied as a **4 px left-edge accent bar** on the
node rectangle. The node body (`$surface-light`, `#FFFFFF`) is always
white; the accent bar is the only colored surface. This keeps the node
readable at small sizes and ensures the four states are distinguishable
for colour-vision deficiencies (they differ in both hue and luminance).

Badges (`recovery-failed`, `no-recipe`) use `$mars-iron` / `#9C2E35`
regardless of the underlying node's status color — the badge always
signals a terminal harness-failure condition independent of how the
status field resolved.

---

## Token cross-reference

All four tokens were originally defined in the now-retired
`design/ui.pen`. This document names only the four values used for
status encoding.

| Token         | Design-system role                                |
| ------------- | -------------------------------------------------- |
| `$mars-ice`   | Coolest accent in the Mars chromatic scale. Used for cool/resolved states. |
| `$mars-iron`  | Deepest red in the Mars chromatic scale. High-alert surfaces and error chips. |
| `$mars-amber` | Warm mid-range amber. Active/in-progress states. |
| `$neutral-400` | Medium neutral grey-brown. Dormant/inactive surfaces. |

> **Note on succeeded vs. green expectation.** The PRD user story (US-2)
> describes succeeded as "green". The Mars design system has no green
> token — the palette is Mars-landscape warm. `$mars-ice` (`#D9E4E8`,
> pale blue-grey) is the coolest/most neutral accent available and is
> used here as the "resolved, calm" encoding. A future design system
> pass may introduce an explicit `$status-succeeded` green token; until
> then, `$mars-ice` is the canonical succeeded color.
>
> **Note on side-panel.pencil (slice 3/6).** That file used `$mars-rust`
> (`#C77D4E`) for a `needs-attention` status chip. This palette supersedes
> that choice: `$mars-iron` (`#9C2E35`) is more distinctly red and avoids
> the visual clash between a rust-orange needs-attention and amber
> in-flight. If side-panel.pencil is updated in a future slice, it should
> adopt `$mars-iron`.
