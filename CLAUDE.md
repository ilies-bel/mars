# CLAUDE.md

## Project: Mars Framework

A modular, lean, future-proof AI coding agent team behind a single TypeScript
CLI (`mars`). The repo bundles the framework, the orchestrator that runs
Claude Code in parallel git worktrees, the local read-only frontend (`ui/`),
and its design drafts (`design/`).

Installed globally via `install.sh`: clones into `~/.mars`, builds a
standalone `mars` binary with Bun, symlinks `~/.local/bin/mars`.

## Task management

**This repo uses `mars` as its main task manager.** Do not use the built-in
TodoWrite/TaskCreate tooling, ad-hoc markdown TODO files, or chat prose to
track work. All actionable work — current tasks, loose ends, follow-ups,
deferred refactors — must live in the `mars` queue (`.mars/queue.db`),
created via `mars add "..."` and inspected via `mars list`. The queue is
the single source of truth for outstanding work in this repo.

## Repositories / top-level directories

| Path | Purpose |
| --- | --- |
| `orchestrator/` | **mars** — Mastra-driven orchestrator. Runs Claude Code headless in parallel git worktrees, verifies (typecheck/test/lint), then fast-forwards into `integration`. Conflicts dispatched to bundled `vcs-supervisor` ("Vega") agent. State per-target-repo at `.mars/`. Node `>=22.13.0`. See `orchestrator/README.md` and `orchestrator/AGENTS.md`. |
| `ui/` | Local read-only frontend for Mars runs. Three views (Topology / Runs / Run timeline), single shell, SSE event stream. Foreground only, port 7777. CLI is the only control surface — the UI never mutates state. |
| `design/` | Design drafts (v0) that `ui/` is built from. Source-of-truth for layout/IA decisions; not shipped at runtime. |
| `.mars/` | Unified per-repo state for both the Mars CLI and the orchestrator: `state.db` (CLI), `queue.db` (LibSQL task queue), `mastra.db` (Mastra workflow runs/traces), `worktrees/<task-id>/`, `.merge.lock`. Gitignored. |
| `.worktrees/` | Git worktrees created by the orchestrator for parallel task execution. |
| `.agents/` | Agent skill definitions consumed by the framework. |
| `.claude/` | Claude Code project settings, hooks, slash commands. |
| `install.sh` | One-shot installer (Bun + clone + build + symlink). |
| `skills-lock.json` | Pinned skill versions. |

## Key concepts

- **`mars` CLI** — single TypeScript entry point. `mars context search/tree`
  is a deterministic, no-network, no-LLM tool that gives agents structured
  codebase context (`rg --json` for search, filtered tree). Prefer it over
  ad-hoc grep/find.
- **Orchestrator workflow** — 4 steps per task: `setup` (worktree on
  `task/<id>` off `integration`) → `code` (`claude -p`) → `verify` →
  `merge` (serialized via file lock; coding parallel).
- **Integration branch** — `integration` is the merge target; `main` is the
  PR target.

## Creating a new orchestrator task

Use the `mars` CLI (installed by `install.sh`, or via `npm link` from `orchestrator/`):

```bash
# from inside the target repo
mars add "implement X in src/foo.ts"   # enqueue a task
mars list queued                        # inspect the queue
mars run                                # dispatch all queued tasks in parallel
mars where                              # show resolved repo + state paths

# from anywhere — explicit target repo
mars --repo /path/to/repo add "fix bug Y"
mars --repo /path/to/repo run
```

The task prompt should be a single self-contained instruction; the orchestrator
spawns it in a fresh `task/<id>` worktree off `integration`. Inspect runs in
Mastra Studio (`cd orchestrator && npm run dev` → http://localhost:4111).

## Conventions

- Bun for the framework CLI; Node `>=22.13.0` for the orchestrator.
- Mastra APIs change frequently — load the `mastra` skill before touching
  `orchestrator/src/mastra/**`.
- Register new Mastra agents/tools/workflows/scorers in
  `orchestrator/src/mastra/index.ts`.
- Never commit `.env`, `.mars/`, or `node_modules`.

## Loose ends

Track loose ends as you work — latent bugs spotted but not fixed, deferred
refactors, missing features, orphan rows in `.mars/queue.db` or `state.db`,
anything outside the current task's scope. The queue is the source of truth;
do not park them in chat prose, a markdown TODO, or a MEMORY.md.

At the end of a session — or as soon as the user signals a stopping point
("looks good", "ship it", "done", "let's move on") — enumerate every loose
end you accumulated and enqueue **one `mars add` task per item**. No batching,
no speculative entries ("maybe consider X someday"); only concrete, actionable
work the user has seen or that blocks real follow-up. If the user says "skip"
or "not now" for a specific item, drop it.

Each task prompt must stand on its own — a colleague reading it cold should
be able to do the work without this session's context. Include:

- the file path(s) and the symptom,
- the suggested fix (or alternatives, with the trade-off),
- the explicit verification command(s) to run,
- a closing **"Save your work"** line reminding the agent to stage and commit
  the change — the orchestrator does not commit on their behalf.

Avoid bare regex-trigger phrases in the outer shell (the `block-tracked-writes`
hook denies standalone `git commit`, `git add`, `rm `, etc.). Inside a
heredoc'd `mars add "..."` prompt body those strings are fine, because the
outer command itself is `mars add`.
