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

Pick one item and recommend it in **one sentence**, then wait:

- Blockers present → name the top blocker by short id + title and
  recommend `/mars:inbox <id>` to triage the row (or "skip"). The ids in
  the snapshot's `blockers` section are **inbox-item ids, not task ids**
  — do not recommend `/mars:unblock <id>` on them; that skill only
  accepts task ids and will reject an inbox id with `no task or idea
  matching`. `/mars:inbox` resolves the underlying task and routes from
  there.
- No blockers, drafts present → name the top draft by short id + title
  and recommend `/mars:grill <id>` to shape it, or `mars task add` if
  it's already concrete.
- Empty inbox → stay silent.

If the snapshot has more than one strong candidate, invoke the
`mars:inbox` skill instead of guessing — it does the full triage. Never
ask "what should we work on?" without first suggesting something
concrete from the snapshot.

## Triage protocol

Pick a lane before touching files; ask once if unclear.

- **Lane A — Direct enqueue** (default for concrete changes with a clear
  file/symptom/fix). `mars task add "..."` and stop.
- **Lane B — Grill first** (`/mars:grill`). For vague, cross-cutting, or
  architectural asks, new domain terms, or explicit "shape this" requests.
  Conversation only; enqueue happens after `/mars:to-prd`.
- **Lane C — Direct edit** in this session. Opt-in only ("edit it here",
  "do it directly"). Reads/searches always stay direct.

Ambiguous A vs B → one short question.

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

`/mars:chat` (alias `/mars:next`) grills the user's plan against
`CONTEXT.md`, curating terms inline. ADR only when hard-to-reverse,
surprising, and embodying a real trade-off.

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
