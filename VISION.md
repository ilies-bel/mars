# VISION — Mars Framework

> **Status:** v1.1 — locked
> **Date:** 2026-04-27

## North Star

A **modular, lean, future-proof AI coding agent team** behind a **single TypeScript CLI**. Agents are **declarative**: they describe *what* they want done, never *how* it's persisted, tracked, or versioned. The CLI's adapter layer handles the "how" and is swappable.

**Success:** ask Claude for a new feature → the feature is planned → implementation runs → review runs → done. Fully autonomous from a properly refined feature, no human in the loop after kickoff.

## Locked Decisions

| Area | Decision |
|---|---|
| Domain | Coding only |
| User | Solo dev (you) |
| CLI language | TypeScript (Node) |
| First provider | Claude only (boundaries drawn for future providers) |
| State | Stateless — persistence lives in adapters, not agents |
| Agent posture | **Declarative** — agents emit intent, never call storage/VCS directly |
| VCS | Wrapped behind an adapter (agents don't `git commit`; they declare "checkpoint this") |
| Feature storage | Wrapped behind an adapter (beads, filesystem, future trackers — agent doesn't care) |
| Compiler | Built-in `.md` link/reference validator |
| Observability | Event stream (`runs/<ts>/events.jsonl`) — single source of truth |
| Interface | Local web dashboard via `mars ui` (Hono + Vite + React + React Flow) |
| UI posture | **Read-only viewer.** CLI is the only control surface, ever. |

## Anti-goals (locked)

- **Token cost ceiling.** If a typical autonomous run burns absurd tokens, the design is wrong. Lean prompts, no chatty multi-agent loops for their own sake, no re-reading the world every step.
- **Compaction is failure.** If a Mars session ever hits Claude Code's context-compaction threshold, we failed as a framework. Compaction is not a problem to recover from — it is a signal that the orchestrator carried too much state, the loop ran too long, or the prompts were too fat. The fix is upstream: shorter loops, leaner prompts, more aggressive intent-and-exit, smaller curated context bundles. **No `PreCompact` recovery hook.** No checkpoint files, no transcript replay, no "rehydrate from summary." If compaction happens, halt the run and treat it as a `mars retro` defect with `rootCause: 'context_bloat'` — fix the harness so it can't happen again. The contract is: a run completes well below the compaction threshold, or it doesn't deserve to complete.
- Not a chat UI.
- Not multi-domain (no research, writing, ops).
- Not stateful — no agent memory.
- Not framework-married — Claude Agent SDK is one option, not the foundation.

## Core Principles

1. **Stable interface, swappable internals.** The CLI is the contract. Underneath, everything is an adapter.
2. **Declarative agents.** Agents return structured intent (feature definitions, file edits, review verdicts). Adapters carry it out. An agent never knows whether its feature landed in beads, a markdown file, or a future system.
3. **Features are first-class artifacts.** Whatever the storage backend, the *feature* has a stable shape: goal, tasks, dependencies, acceptance criteria.
4. **Markdown compiler.** `.md` links resolve, features match a schema, references point to real files. Broken feature = build halts.
5. **Lean by default.** Add abstraction only when a second real implementation forces it. No speculative interfaces.
6. **Token-frugal.** Watchdog on cost per run. Prompts are tight. Context is curated, not dumped.
7. **Future-proof through boundaries.** Provider, VCS, feature-store, and tool layers are isolated. Swapping any one is mechanical.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  CLI (TypeScript)                                │  ← stable surface
│  mars feature | build | review | check | audit   │
├──────────────────────────────────────────────────┤
│  Orchestrator                                    │  ← runs planner → builder → reviewer
├──────────────────────────────────────────────────┤
│  Declarative Agent Layer                         │  ← agents return intent objects
│  Planner | Builder | Reviewer                    │
├──────────────────────────────────────────────────┤
│  Adapters (swappable)                            │
│  • Provider:    Claude (today)                   │
│  • PlanStore:   beads | fs-markdown | …          │
│  • VCS:         git | (future: jj, hg, none)     │
│  • FS / Exec:   local                            │
│  • Compiler:    md-linkcheck + schema            │
└──────────────────────────────────────────────────┘
```

### The declarative contract (sketch)

Agents return typed intent. Example:

```ts
// Planner returns:
type Feature = {
  goal: string
  tasks: Task[]                // each with id, title, deps, acceptance
}

// Builder returns:
type BuildResult = {
  edits: FileEdit[]            // declarative edits, not "git add"
  checkpointHint?: string      // "save progress" — adapter picks how
  done: boolean
}

// Reviewer returns:
type Review = {
  verdict: 'pass' | 'fail' | 'needs-changes'
  findings: Finding[]
}
```

The Feature goes to whatever PlanStore is configured (beads, fs, future). The edits go through the FS adapter. The checkpoint hint goes through the VCS adapter. Agent code never imports `git` or `bd`.

## Command Surface (v0 target)

- `mars feature plan "<goal>"` — register a draft feature; persists `features/<id>.md`.
- `mars feature refine <id>` — planner agent expands a draft into tasks; emits a `Feature`; PlanStore persists it.
- `mars feature start <id>` — kick off the build loop for a refined feature.
- `mars build` — orchestrator picks ready tasks, builder executes, reviewer gates, loop until done.
- `mars review` — standalone review pass.
- `mars check` — markdown compiler: link integrity, feature schema, reference graph.
- `mars audit` — harness/cost/health audit.
- `mars ui` — boot the local dashboard (foreground; Ctrl-C stops). Opens browser to `localhost:7777`.

## Observability & Interface

The system is observable through **one event stream** that everything else reads from. This is the contract that decouples *recording* from *viewing* and lets us add new viewers (TUI, VS Code extension, future export) without touching the orchestrator.

### The event stream

Every run writes append-only newline-delimited JSON to `runs/<timestamp>/events.jsonl`. The CLI, the orchestrator, and every adapter emit events through a single sink.

```ts
type MarsEvent =
  | { kind: 'run.start'; runId: string; goal: string; ts: number }
  | { kind: 'agent.start'; agent: 'planner' | 'builder' | 'reviewer'; taskId?: string; ts: number }
  | { kind: 'agent.intent'; agent: string; intent: unknown; tokensIn: number; tokensOut: number; ts: number }
  | { kind: 'adapter.call'; adapter: 'planstore' | 'vcs' | 'fs' | 'provider'; op: string; ts: number }
  | { kind: 'adapter.result'; adapter: string; ok: boolean; durationMs: number; ts: number }
  | { kind: 'review.verdict'; taskId: string; verdict: 'pass' | 'fail' | 'needs-changes'; ts: number }
  | { kind: 'tool.call'; handleId: string; role: 'planner' | 'builder' | 'reviewer'; name: string; callId: string; ts: number }
  | { kind: 'tool.result'; callId: string; ok: boolean; durationMs: number; ts: number }
  | { kind: 'run.end'; runId: string; status: 'done' | 'halted' | 'failed'; tokensTotal: number; ts: number }
```

Schema is versioned (`schemaVersion` in run start) so old traces remain readable as the shape evolves.

### Topology — config-as-documentation

`mars.flow.ts` declares the static agent graph. Same file:
- the orchestrator imports it to wire agents together at runtime,
- the UI imports it to render the topology view,
- `mars check` validates it against the adapter contracts.

```ts
// mars.flow.ts
import { defineFlow } from 'mars'

export default defineFlow({
  agents: {
    planner:  { in: 'Goal',        out: 'Feature' },
    builder:  { in: 'Task',        out: 'BuildResult' },
    reviewer: { in: 'BuildResult', out: 'Review' },
  },
  edges: [
    { from: 'planner',  to: 'builder',  via: 'PlanStore' },
    { from: 'builder',  to: 'reviewer', via: 'FS' },
    { from: 'reviewer', to: 'builder',  when: 'needs-changes' },
  ],
})
```

One source of truth. Type-safe wiring AND the diagram on the UI's topology page render from the same export.

### The `mars ui` dashboard

Local web app. Runs only when you boot it. No daemon, no auth, no telemetry.

**Stack:**
- **Server:** Hono (serves static bundle + `/api/events` SSE endpoint).
- **UI:** Vite + React + React Flow (topology graph) + Tailwind for layout.
- **Boot:** `mars ui` runs in the foreground. Ctrl-C stops it. Default port `7777`.

**Three views:**

1. **Topology** — the static graph from `mars.flow.ts`. Nodes are agents, edges are typed intent flow, hover shows the contract.
2. **Runs** — list of past runs from `runs/`. Click one to open the timeline.
3. **Run timeline + inspector** — agent calls in order with durations, token meters, status chips. Click any agent invocation to see its input intent, output intent, reviewer verdict, raw prompt (collapsed by default).

Live runs stream via SSE; past runs render from disk. Same component, same data shape.

### Storage policy

- `runs/` is gitignored by default.
- Rotation: keep the last 50 runs. Older ones are deleted on `mars build` start.
- Opt-in to keep a milestone run: `mars build --keep` flags that run as non-rotatable.

### Why this shape

- **Lean:** no DB, no daemon, no service. Just files + a viewer that reads them.
- **Token-frugal:** the trace itself is how you find waste. Every event has token counts, so the UI can highlight the chatty agents and the redundant adapter calls.
- **Future-proof:** `events.jsonl` is the stable contract. Anyone — TUI, VS Code, an export script — can consume it without touching Mars internals.
- **CLI sovereignty:** the UI never writes back to the system. You can never *control* Mars from the browser. The CLI stays the only command surface.

## The Autonomous Loop

```
ask Claude: "add feature X"
   ↓
mars feature plan "X"     → features/<id>.md (draft)
mars feature refine <id>  → planner expands; PlanStore (beads/fs/…)
   ↓
mars build               → loops:
                            • read next ready task
                            • builder declares edits
                            • reviewer gates
                            • adapter checkpoints
                            • mark task done
   ↓                       until feature exhausted or halt
mars check               → compiler verifies artifact integrity
```

## Open Questions Still to Resolve (round 3)

These are smaller — they shape v0 implementation, not direction.

1. **Feature shape.** Beads-native (issues + deps) or markdown-native (`features/<id>.md` with task list) as the *canonical* form, with adapters translating? My recommendation: **markdown-canonical** — easiest to read, version, diff; PlanStore adapter syncs it to beads if configured.
2. **Failure handling.** When a builder step fails: retry once, replan, or halt-and-flag? My recommendation: **halt-and-flag** by default; retry only on adapter-level transient errors.
3. **Config file.** `mars.config.ts` per-repo (TS for type safety on adapter wiring). Global config deferred.
4. **Token budget.** Per-run hard cap (e.g. `MARS_MAX_TOKENS=200000`). Exceeded = halt with summary.

If you agree with the recommendations, we proceed. If you want to push back, now's the time.

## Next Steps

1. Resolve round-3 questions (or accept recommendations).
2. **Harness audit** — done; apply P0/P1 fixes to project `.claude/settings.json`.
3. Define adapter interfaces (`Provider`, `PlanStore`, `VCS`, `FS`) and the `MarsEvent` schema.
4. Build the event sink + JSONL writer (smallest standalone piece, unblocks the UI later).
5. Build the markdown compiler.
6. Build planner → builder → reviewer loop with stub adapters; emit events.
7. Wire real adapters: Claude provider, beads PlanStore, git VCS.
8. Build `mars ui` (Hono server + Vite/React viewer reading the event stream).
9. Demo: one autonomous coding project end-to-end with the dashboard streaming live.
