# CLAUDE.md

## Project: Mars Framework

A modular, lean, future-proof AI coding agent team behind a single TypeScript
CLI (`mars`). The repo bundles the framework, the orchestrator that runs
Claude Code in parallel git worktrees, and design drafts for a local read-only
UI.

Installed globally via `install.sh`: clones into `~/.mars`, builds a
standalone `mars` binary with Bun, symlinks `~/.local/bin/mars`.

## Repositories / top-level directories

| Path | Purpose |
| --- | --- |
| `orchestrator/` | **mars** — Mastra-driven orchestrator. Runs Claude Code headless in parallel git worktrees, verifies (typecheck/test/lint), then fast-forwards into `integration`. Conflicts dispatched to bundled `vcs-supervisor` ("Vega") agent. State per-target-repo at `.mars/`. Node `>=22.13.0`. See `orchestrator/README.md` and `orchestrator/AGENTS.md`. |
| `design/` | UI design drafts (v0) for `mars ui` — a read-only local viewer for Mars runs. Three views (Topology / Runs / Run timeline), single shell, SSE event stream. Foreground only, port 7777. CLI is the only control surface. |
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
