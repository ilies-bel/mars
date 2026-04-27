# VISION — Mars Framework

> **Status:** v1.0 — locked
> **Date:** 2026-04-27

## North Star

A **modular, lean, future-proof AI coding agent team** behind a **single TypeScript CLI**. Agents are **declarative**: they describe *what* they want done, never *how* it's persisted, tracked, or versioned. The CLI's adapter layer handles the "how" and is swappable.

**Success:** ask Claude for a new feature → a plan is generated → implementation runs → review runs → done. Fully autonomous from a proper plan, no human in the loop after kickoff.

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
| Plan storage | Wrapped behind an adapter (beads, filesystem, future trackers — agent doesn't care) |
| Compiler | Built-in `.md` link/reference validator |

## Anti-goals (locked)

- **Token cost ceiling.** If a typical autonomous run burns absurd tokens, the design is wrong. Lean prompts, no chatty multi-agent loops for their own sake, no re-reading the world every step.
- Not a chat UI.
- Not multi-domain (no research, writing, ops).
- Not stateful — no agent memory.
- Not framework-married — Claude Agent SDK is one option, not the foundation.

## Core Principles

1. **Stable interface, swappable internals.** The CLI is the contract. Underneath, everything is an adapter.
2. **Declarative agents.** Agents return structured intent (plan items, file edits, review verdicts). Adapters carry it out. An agent never knows whether its plan landed in beads, a markdown file, or a future system.
3. **Plans are first-class artifacts.** Whatever the storage backend, the *plan* has a stable shape: goal, tasks, dependencies, acceptance criteria.
4. **Markdown compiler.** `.md` links resolve, plans match a schema, references point to real files. Broken plan = build halts.
5. **Lean by default.** Add abstraction only when a second real implementation forces it. No speculative interfaces.
6. **Token-frugal.** Watchdog on cost per run. Prompts are tight. Context is curated, not dumped.
7. **Future-proof through boundaries.** Provider, VCS, plan-store, and tool layers are isolated. Swapping any one is mechanical.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  CLI (TypeScript)                                │  ← stable surface
│  mars plan | build | review | check | audit      │
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
type Plan = {
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

The Plan goes to whatever PlanStore is configured (beads, fs, future). The edits go through the FS adapter. The checkpoint hint goes through the VCS adapter. Agent code never imports `git` or `bd`.

## Command Surface (v0 target)

- `mars plan "<goal>"` — planner agent emits a Plan; PlanStore persists it.
- `mars build` — orchestrator picks ready tasks, builder executes, reviewer gates, loop until done.
- `mars review` — standalone review pass.
- `mars check` — markdown compiler: link integrity, plan schema, reference graph.
- `mars audit` — harness/cost/health audit.

## The Autonomous Loop

```
ask Claude: "add feature X"
   ↓
mars plan "X"            → PlanStore (beads/fs/…)
   ↓
mars build               → loops:
                            • read next ready task
                            • builder declares edits
                            • reviewer gates
                            • adapter checkpoints
                            • mark task done
   ↓                       until plan exhausted or halt
mars check               → compiler verifies artifact integrity
```

## Open Questions Still to Resolve (round 3)

These are smaller — they shape v0 implementation, not direction.

1. **Plan shape.** Beads-native (issues + deps) or markdown-native (`PLAN.md` with task list) as the *canonical* form, with adapters translating? My recommendation: **markdown-canonical** — easiest to read, version, diff; PlanStore adapter syncs it to beads if configured.
2. **Failure handling.** When a builder step fails: retry once, replan, or halt-and-flag? My recommendation: **halt-and-flag** by default; retry only on adapter-level transient errors.
3. **Config file.** `mars.config.ts` per-repo (TS for type safety on adapter wiring). Global config deferred.
4. **Token budget.** Per-run hard cap (e.g. `MARS_MAX_TOKENS=200000`). Exceeded = halt with summary.

If you agree with the recommendations, we proceed. If you want to push back, now's the time.

## Next Steps

1. Resolve round-3 questions (or accept recommendations).
2. **Harness audit** (requested) — separate document.
3. Define adapter interfaces (`Provider`, `PlanStore`, `VCS`, `FS`).
4. Build the markdown compiler first — smallest standalone piece, immediately useful.
5. Build planner → builder → reviewer loop with stub adapters.
6. Wire real adapters: Claude provider, beads PlanStore, git VCS.
7. Demo: one autonomous coding project end-to-end.
