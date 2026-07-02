# Product

## Register

product

## Users

A single operator (the repo owner) running an AFK agent fleet against their own codebase. They check the UI in glances between other work: "is the fleet healthy, what needs me, what just landed." Sessions are short and diagnostic, not exploratory. The terminal is their home; the UI exists for the views a terminal renders poorly (the dependency graph, timelines, drill-downs).

## Product Purpose

Mars runs Claude Code as parallel workers in git worktrees (code → verify → merge). The UI is its mission-control surface: a live topology of tasks/proposals and their blocker edges, an action queue of everything needing a human, an event stream, and KPI trends. Success: the operator can answer "what needs me right now" in under five seconds, and can trust that what the screen shows IS the state (the queue is a pure projection of entity state — ADR-0048).

## Brand Personality

Calm mission control. Quiet confidence, dense but legible, nothing shouts. The warm Mars-dust palette carries identity at low volume; state colors (running, failed, blocked, done) are the only things allowed to draw the eye. You glance, you trust, you leave.

## Anti-references

- Generic SaaS dashboard: cool grays, identical stat-card grids, gradient accents, Linear/Vercel clone energy. The warm Mars identity is deliberate — do not neutralize it.
- Anything that decorates state: pulsing gradients, celebratory motion, badges for their own sake. Motion conveys state transitions only.

## Design Principles

- **The screen is the state.** Every surface is a thin projection of entity state (ADR-0048/0055). Never render optimistic or invented status; stale data must look stale (reconnecting strips, timestamps), never silently wrong.
- **Answer "what needs me" first.** Failed tasks, leases waiting on a human, and plan approvals outrank everything else on every screen.
- **Density with hierarchy.** Operators want many rows on screen; earn density with scale/weight contrast and state color, not chrome.
- **The graph is a map, not art.** Topology exists to trace lineage and blockage. Every visual choice (dimming, drill-in, edges) must make tracing faster; anything decorative that slows tracing loses.
- **Earned familiarity.** Standard affordances everywhere (tabs, drawers, breadcrumbs); novelty is spent only on the topology view, the one surface with no standard answer.

## Accessibility & Inclusion

WCAG AA. Existing commitments to preserve: 4.5:1 body contrast (tokens are annotated with measured ratios), global :focus-visible rings, prefers-reduced-motion alternatives for all animation (pulse, drill-in). Keyboard: every action reachable without a pointer — parity matters because the same operator lives in the TUI.
