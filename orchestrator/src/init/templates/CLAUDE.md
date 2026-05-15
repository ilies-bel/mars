# CLAUDE.md

## Mars Framework

Modular AI coding agent team behind a single TypeScript CLI (`mars`).
Bundles the framework, orchestrator (Claude Code in parallel git worktrees),
read-only frontend (`ui/`), and design drafts (`design/`).

Install: `install.sh` clones into `~/.mars`, builds with Bun, symlinks
`~/.local/bin/mars`.

## Session start

A SessionStart hook runs `mars inbox --lean` and injects an inbox
snapshot — counts (e.g. `inbox 58 open (high:58)`) plus the top
blockers and drafts by short id and title. Once per session,
**propose a specific next action** — do not just echo the count back.

Pick **one** item across the whole snapshot and recommend it in **one
sentence**, then wait. Don't default to "first blocker in the list"
every session — scan blockers *and* drafts and pick what actually wins:

- A blocker with the highest severity, or one in a category that
  hasn't been touched recently → `/mars:inbox <id>` to triage. Ids in
  the `blockers` section are **inbox-item ids, not task ids** — never
  use `/mars:unblock <id>` on them; that skill only accepts task ids.
- A draft that already looks concrete (clear file/symptom/fix) →
  recommend `mars task add "..."` directly (Lane A). Don't grill what's
  already shaped.
- A draft that's vague or cross-cutting → `/mars:grill <id>` to shape.
- A quick win that unblocks others — call that out as the reason.

If multiple candidates are close, say **why** the chosen one wins
("highest priority", "blocks others", "quick win", "rotates off
last session's category") in the same sentence.

Empty inbox → stay silent.

## Triage protocol

Pick a lane before touching files. Read the user's request through these
tells:

**Lane A — Direct enqueue.** `mars task add "..."` and stop. Tells:
- A file, symbol, or command appears in the ask.
- A symptom + a desired behaviour are both stated.
- Imperative shape: "fix", "add", "rename", "remove", "wire up", "make
  X do Y".
- The change is local and doesn't introduce a new concept.

**Lane B — Grill first** (`/mars:grill`). Conversation only; no enqueue
in this session. Tells:
- Question-shaped or exploratory: "should we…?", "how do we…?", "what
  about…?", "I'm thinking…".
- Introduces a term not in the glossary, or redefines an existing one.
- Cross-cutting: touches multiple modules, or the user can't point at
  a file.
- Architectural choice with real trade-offs (new seam, new dependency,
  new data shape).
- Explicit shape requests: "shape this", "grill this", "let's think
  about", "I'm not sure how to".

**Lane C — Direct edit** in this session. Opt-in only ("edit it here",
"do it directly", "in this repo"). Reads/searches always stay direct.

If signals from A and B both fire, default to B and ask **one** short
question naming the fork ("sounds like a quick fix in `src/foo.ts` —
or are you asking whether we should restructure X? grill or enqueue?").
Don't enqueue a Lane B ask just because it's faster.

## Tasks

Tasks live in `.mars/queue.db`. Enqueue via `mars task add "..."`; the
orchestrator dispatches automatically (worktree → code → verify → merge).
Inspect via `mars list` or Mastra Studio.

Default mutations route through the orchestrator. Direct `Edit`/`Write` on
the working tree is Lane C only.

## Top-level directories

| Path | Purpose |
| --- | --- |
| `orchestrator/` | Mastra-driven orchestrator. Claude Code headless in parallel worktrees → verify → fast-forward into `main`. Conflicts → bundled `vcs-supervisor` ("Vega"). Per-repo state at `.mars/`. Node `>=22.13.0`. |
| `ui/` | Read-only frontend. Three views, SSE stream, port 7777. CLI is the only control surface. |
| `design/` | v0 design drafts; not shipped at runtime. |
| `.mars/` | Per-repo state: `state.db`, `queue.db`, `mastra.db`, `worktrees/<task-id>/`, `.merge.lock`. Gitignored. |
| `.worktrees/` | Orchestrator-created git worktrees. |
| `.agents/` | Agent skill definitions. |
| `.claude/` | Claude Code project settings, hooks, slash commands. |

## Key concepts

- **`mars context search/tree`** — deterministic, no-network, no-LLM
  codebase context (`rg --json` + filtered tree). Prefer over ad-hoc grep.
- **Orchestrator workflow** — 4 steps: `setup` (worktree on `task/<id>` off
  `main`) → `code` (`claude -p`) → `verify` → `merge` (serialized via file
  lock; coding parallel).
- **Merge target** — `main`. Override per-invocation with
  `INTEGRATION_BRANCH=<branch>`.

## Glossary and ADRs

Both written via the daemon's **structured-write** path (worktree off
`main`, deterministic edit, commit, merge through the lock). No LLM in the
edit itself.

- **`CONTEXT.md`** — domain glossary. Edit only via `mars glossary
  set/remove`. Read via `mars glossary list/show`.
- **`docs/adr/NNNN-<slug>.md`** — ADRs. Add via `mars adr add`. Read via
  `mars adr list/show`.

Direct edits to `CONTEXT.md` or `docs/adr/**` from coding worktrees are
forbidden. Coding agents may **read** `CONTEXT.md` freely.

`/mars:chat` grills the user's plan against `CONTEXT.md`, curating
terms inline. ADR only when hard-to-reverse, surprising, and embodying
a real trade-off.

## Enqueue example

```bash
mars task add "implement X in src/foo.ts"   # auto-dispatched
mars list queued
mars where
mars --repo /path/to/repo task add "fix bug Y"
```

Inspect runs at `http://localhost:4111` (`cd orchestrator && npm run dev`).

## Conventions

- Bun for the framework CLI; Node `>=22.13.0` for the orchestrator.
- Mastra APIs churn — load the `mastra` skill before touching
  `orchestrator/src/mastra/**`.
- Register new Mastra agents/tools/workflows/scorers in
  `orchestrator/src/mastra/index.ts`.
- Never commit `.env`, `.mars/`, or `node_modules`.

## Loose ends

Enqueue the moment you spot one — **one `mars task add` per item**, no
batching, no MEMORY.md, no markdown TODOs. Only concrete, actionable work
the user has seen. If user says "skip", drop it. At stopping points
("looks good", "ship it"), do a final sweep as a safety net.

Each task prompt must stand alone. Include:

- file path(s) + symptom,
- suggested fix (with trade-offs if alternatives),
- verification command(s),
- a closing **"Save your work"** line — the orchestrator does not commit
  on the agent's behalf.

The `mars task add "..."` outer call is a CLI invocation; any `git`/`rm`
strings inside the heredoc'd prompt are passed verbatim to the dispatched
agent and don't trip the outer shell's hooks.
