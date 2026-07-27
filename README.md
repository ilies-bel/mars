<div align="center">

# Mars

**An AFK agent team for your repo — on your laptop, on your Claude subscription.**

Mars runs Claude Code as a fleet of parallel workers against a single repo:
each task gets its own git worktree, gets coded, verified, and merged — while
you do something else. No servers to stand up. No API keys. No per-token bill.

[Why Mars](#why-mars) · [How it works](#how-it-works) · [Quick start](#quick-start) · [Features](#features) · [The UI](#the-ui) · [CLI reference](./orchestrator/README.md)

</div>

---

<!-- TODO: replace with a 60-90s hero demo video showing the full loop:
     mars task add → daemon picks up → workers coding in parallel → verify → merge → done
     Record with: mars task add "add a /healthz endpoint to server.ts"
                  + mars list (show statuses ticking)
                  + mars ui (show board updating live)
     Host on YouTube/Vimeo and embed here. -->

https://github.com/user-attachments/assets/PLACEHOLDER-HERO-VIDEO

![Mars topology view — the live dependency graph of tasks and proposals](./docs/assets/ui-topology.png)

## Why Mars

**A real agent team, zero infrastructure.** Queue work and walk away.
A local daemon picks up tasks, spawns a Claude Code worker per task in
its own isolated git worktree, runs them in parallel, verifies each
(typecheck → test → lint), and fast-forwards the passing ones into your
branch. Merge conflicts go to a dedicated reconciler agent ("Vega"). It feels
like a managed agent platform — but it's a single CLI and a local database
next to your project. Nothing to deploy, nothing to log into, nothing in the
cloud.

**Your subscription, not an API bill.** Every model call shells out to your
authenticated `claude` CLI. There are no provider SDKs and no API keys
anywhere in Mars — so a long AFK session draws on the Claude subscription
you already pay for instead of metering you per token.

**Smart model routing.** Mars routes each Worker role to the cheapest model
that can do the job — Haiku for routine writing, Sonnet for coding, Opus only
where architectural reasoning earns it. The human-facing surface is a CLI,
not a chat transcript, so orchestration state stays out of the context window
instead of bloating it.

## How it works

You drop work into a queue; the daemon turns it into merged commits.

```
  mars task add "<prompt>"
            │
            ▼
     tasks row (status=queued) ──► daemon claims it
            │
            ▼
  ┌──────────────────────────────────────────────────────┐
  │  1. setup    git worktree on task/<id> off main       │
  │  2. code     claude -p  (parallel across tasks)       │
  │  3. verify   typecheck → test → lint  (fail-fast)     │
  │  4. merge    serialized via file lock → fast-forward   │
  │              conflict → reconciler agent ("Vega")      │
  └──────────────────────────────────────────────────────┘
            │
            ▼
   done  (worktree removed)   |   failed  (kept for triage)
```

- **Coding is unlimited-parallel; merging is serialized** by a file lock, so
  many workers run at once but the integration branch is never raced.
- **Persistence across restarts.** State lives in an embedded Postgres
  database (`.mars/`), and every run writes a journal — so stopping the
  daemon, restarting it, or recovering from a crash resumes cleanly instead of
  losing or double-running work.
- **Self-healing.** When a task fails, the orchestrator spawns one recovery
  task to fix it. Recovery recipes match known failure signatures to targeted
  prompts. Unknown failures trigger an Investigator agent that proposes a
  recipe for next time.

For fuzzy work, there's a shaping lane (`mars proposal add` → grill → slice
into tasks) that turns a one-line goal into a wired dependency graph of tasks.
Both lanes end at the same dispatcher above.

## Quick start

```sh
# 1 — install the mars CLI (once per machine; re-run to upgrade)
curl -sSL https://github.com/ilies-bel/mars/releases/latest/download/get-mars.sh | bash

# 2 — inside your repo: scaffold state + activate the mars:* skills
mars init

# 3 — add work and watch it run
mars task add "implement X in src/foo.ts"   # daemon auto-spawns on first write
mars list                                    # see live statuses
mars ui                                      # open the dashboard
```

**Requirements:** `git`, the authenticated
[Claude Code](https://docs.claude.com/en/docs/claude-code) CLI on `PATH`
(every model call shells out to `claude -p` — no API keys), and Node >= 22.13.

<!-- TODO: record a 30s terminal screencast of the quick-start flow above.
     Tool suggestion: asciinema or vhs (https://github.com/charmbracelet/vhs)
     Host the .gif or .svg in docs/assets/quickstart.* -->

## Features

### Parallel task execution

Queue multiple tasks and Mars runs them simultaneously, each in its own
isolated git worktree. No stepping on each other's files, no manual branch
juggling.

```sh
mars task add "add input validation to the signup form"
mars task add "write unit tests for the billing module"
mars task add "refactor the auth middleware to use JWT"
# all three run in parallel — watch them on the board
mars ui
```

<!-- TODO: record video showing 3+ tasks running in parallel on the board view.
     Show tasks moving through queued → running → verifying → done.
     Host: docs/assets/demo-parallel.mp4 -->

### Task dependencies with blockers

Wire tasks into dependency chains. Blocked tasks wait until their prerequisites
merge, then auto-promote to the queue.

```sh
mars task add "define the User schema in src/models/user.ts" --tag coder
# capture the id from the output, e.g. abc123
mars task add "add CRUD endpoints for users" --blocked-by abc123
mars task add "write integration tests for user endpoints" --blocked-by abc123
```

<!-- TODO: record video showing blocker resolution: task A finishes, tasks B and C
     auto-promote from blocked → queued → running.
     Show the topology view with edges between them.
     Host: docs/assets/demo-blockers.mp4 -->

### Proposal shaping (the grill)

For fuzzy ideas that aren't ready for code yet: shape them into precise PRDs
through an adversarial grilling session, then slice into an execution plan.

```sh
mars proposal add "add real-time notifications to the app"
# then in Claude Code:
/mars:grill
# the grill challenges your spec, sharpens terminology,
# and outputs a structured PRD that slices into concrete tasks
```

<!-- TODO: record video of a /mars:grill session: show the back-and-forth where
     the grill challenges vague terms and refines the spec.
     Host: docs/assets/demo-grill.mp4 -->

### Self-healing and recovery

When a task fails verification, Mars doesn't just stop. It spawns a targeted
recovery task with the failure context, fixes the issue, and re-verifies.
Known failure patterns get matched to recovery recipes for faster resolution.

<!-- TODO: record video of a task failing verify (e.g., a type error),
     the orchestrator spawning a fix task, and the fix landing.
     Show the action queue alert appearing and resolving.
     Host: docs/assets/demo-recovery.mp4 -->

### Merge conflict reconciliation (Vega)

When parallel tasks touch overlapping files, Mars doesn't bail — it dispatches
the conflict to Vega, a dedicated reconciler agent that understands both sides
and merges intent, not just text.

<!-- TODO: record video of two tasks touching the same file, the merge step
     detecting a conflict, and Vega reconciling it.
     Host: docs/assets/demo-vega.mp4 -->

### Structured tasks

Give the agent clear guardrails: specify which files to touch, how to verify,
and what "done" looks like.

```sh
mars task add "migrate the config loader from YAML to TOML" \
  --files "src/config.ts,src/config.test.ts" \
  --verify "npm test -- --grep config" \
  --done "all tests pass, no YAML imports remain" \
  --priority 2
```

### Worker model routing

Each role runs on the right model tier — no Opus tokens wasted on boilerplate:

| Worker | Default model | Role |
| --- | --- | --- |
| Coder | `claude-sonnet-4-6` | Implementation |
| Fixer | `claude-sonnet-4-6` | Scoped mechanical recovery |
| Writer | `claude-haiku-4-5` | Documentation, routine text |
| Planner / Slicer | `claude-opus-4-7` | Architectural reasoning |
| Triager | `claude-sonnet-4-6` | Task classification |

Override the Coder model for a session: `MARS_WORKER_MODEL=claude-opus-4-7 mars daemon start`

### Claude Code skills

Mars installs a set of `/mars:*` slash commands into your Claude Code session:

| Command | What it does |
| --- | --- |
| `/mars:chat` | Triage entry point — classifies your input and routes to the right sub-skill |
| `/mars:task` | Quick-enqueue with terminology check |
| `/mars:grill` | Adversarial PRD shaping session |
| `/mars:action-queue` | Show everything that needs you |
| `/mars:alerts` | Failed tasks and stale worktrees |
| `/mars:unblock` | Diagnose and unblock a stuck task |
| `/mars:diagnose` | Post-mortem a failed task |
| `/mars:live` | Drive a manual-step task through its checklist |
| `/mars:reflect` | Synthesize improvement proposals from completed work |
| `/mars:deep-reflect` | Transcript-level post-mortem on a full arc |

## The UI

`mars ui` opens a read-only dashboard that streams live from the daemon. The
CLI is the only write surface — the UI never mutates state.

<!-- TODO: record a 45-60s walkthrough video of the UI:
     1. Open mars ui, show the topology view with tasks and edges
     2. Switch to the board tab, show tasks in columns
     3. Click into a task, show the transcript/trace
     4. Switch to events, filter by kind
     5. Switch to action queue, show a failed task with its failure reason
     Host on YouTube/Vimeo and embed here. -->

https://github.com/user-attachments/assets/PLACEHOLDER-UI-WALKTHROUGH

| Topology — the live dependency graph | Board — the AFK team at work |
| :---: | :---: |
| ![Topology view](./docs/assets/ui-topology.png) | ![Kanban board](./docs/assets/ui-board.png) |
| **Events — the full audit trail** | **Action queue — what needs you** |
| ![Events log](./docs/assets/ui-events.png) | ![Action queue](./docs/assets/ui-action-queue.png) |

- **Topology** — every task and proposal as a node, with blocker edges drawn
  between them, over a KPI strip (cost per arc, failure rate, recovery success).
- **Board** — a Kanban of Queued / In progress / Blocked / Failed / Proposals.
- **Events** — every `step_started` / `tool_invoked` / `step_ended`, filterable
  by severity, kind, and task — the audit trail, live.
- **Action queue** — the human-attention surface: pick a row, read the failure
  reason and full transcript, and resolve it (restart, drop, investigate).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  mars CLI                                                    │
│  (Bun single-file binary — installs with curl | bash)       │
├─────────────────────────────────────────────────────────────┤
│  Daemon                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Pool:    │  │ Pool:    │  │ Pool:    │  │ Pool:    │    │
│  │ implement│  │ triage   │  │ refine   │  │ write    │    │
│  │ (Slots)  │  │ (Slots)  │  │ (Slots)  │  │ (Slots)  │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│       │                                                      │
│       ▼                                                      │
│  @mars/workflow engine (packages/workflow/)                  │
│  ┌────────────────────────────────────────────────┐         │
│  │ setup → code → verify → merge                  │         │
│  │         (claude -p in isolated worktree)        │         │
│  └────────────────────────────────────────────────┘         │
├─────────────────────────────────────────────────────────────┤
│  Embedded PostgreSQL (.mars/pg/)                             │
│  tasks · task_blockers · proposals · events · sessions       │
├─────────────────────────────────────────────────────────────┤
│  Git worktrees (.mars/worktrees/<task-id>/)                  │
│  one per running task — branch task/<id> off main            │
├─────────────────────────────────────────────────────────────┤
│  UI (Vite + React — read-only, streams from daemon HTTP)    │
└─────────────────────────────────────────────────────────────┘
```

## CLI reference

| Command | Purpose |
| --- | --- |
| `mars init` | Scaffold `.mars/` state + activate skills |
| `mars task add "<prompt>"` | Enqueue a task (flags: `--files`, `--verify`, `--done`, `--priority`, `--tag`, `--blocked-by`, `--live`, `--workflow`) |
| `mars list` | List tasks with live statuses |
| `mars show <id>` | Print task details, plan, and trace |
| `mars daemon start\|stop\|status\|restart` | Control the background dispatcher |
| `mars ui` | Open the read-only dashboard |
| `mars proposal add "<idea>"` | Add a draft proposal for shaping |
| `mars block <id> <blocker-id>` | Add a dependency edge |
| `mars unblock <id>` | Remove blocker edges |
| `mars restart <id>` | Re-run a failed task |
| `mars step done <id>` | Signal manual-step completion |
| `mars glossary list\|set\|remove` | Manage domain terminology |
| `mars adr add\|list\|show` | Manage Architecture Decision Records |
| `mars reflect` | Synthesize proposals from completed arcs |
| `mars arc reflect [originId]` | Deep post-mortem on a task arc |

Full reference with env vars and workflow internals:
[`orchestrator/README.md`](./orchestrator/README.md)

## What Mars is not

- **Not a cloud service.** No hosted control plane, no multi-tenant queue, no
  auth, no telemetry. State is a local Postgres instance per repo.
- **Not an API wrapper.** No `ANTHROPIC_API_KEY`, no provider SDKs. Every model
  call goes through your local `claude -p`.
- **Not a managed agent runtime.** Mars is the plumbing — worktree isolation,
  parallel dispatch, verification gates, serialized merges, persistence, audit
  log — so you compose your own workflow on top.

## Documentation

| Document | What's in it |
| --- | --- |
| [`VISION.md`](./VISION.md) | Target state, canonical loop, non-goals |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Components and state as they exist today |
| [`PRODUCT.md`](./PRODUCT.md) | Product purpose, users, design principles |
| [`orchestrator/README.md`](./orchestrator/README.md) | Full CLI reference, workflow internals, env vars |
| [`CONTEXT.md`](./CONTEXT.md) | Domain glossary (edit via `mars glossary` only) |
| [`docs/adr/`](./docs/adr/) | Architecture Decision Records (add via `mars adr` only) |

## License

MIT — see [`LICENSE`](./LICENSE).
