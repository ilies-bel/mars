# mars

Mastra-driven orchestrator that runs Claude Code in parallel git worktrees. Installable globally; works against any git repo.

## How it works

Each task in the queue runs through a 4-step Mastra workflow:

1. **setup** — `git worktree add` on a fresh `task/<id>` branch off `integration`
2. **code** — `claude -p "<prompt>"` runs headless inside the worktree
3. **verify** — typecheck → tests → lint (must all pass)
4. **merge** — fast-forward into `integration`. On conflict, the bundled **vcs-supervisor** ("Vega") agent prompt is dispatched via `claude -p` to reconcile intent and verify, then commit. If unresolvable, `git merge --abort` and the task is marked `failed`. Merges are serialized via a file lock; coding runs unlimited-parallel.

## Install

```bash
cd orchestrator
npm install
npm link            # exposes `mars` globally
```

## Usage

```bash
# inside any git repo
mars add "implement X in src/foo.ts"
mars list queued
mars run                    # dispatch all queued tasks in parallel
mars where                  # show resolved repo + state paths

# from anywhere — explicit target
mars --repo /path/to/repo add "fix bug Y"
mars --repo /path/to/repo run

# Mastra Studio (workflow traces, time-travel, logs)
cd orchestrator && npm run dev   # http://localhost:4111
```

## Repo & state resolution

Target repo is resolved in this order:
1. `--repo <path>` flag
2. `MARS_REPO` env var
3. `git rev-parse --show-toplevel` from the current directory

State lives at `<target-repo>/.mars/`:

| File                  | Purpose                       |
| --------------------- | ----------------------------- |
| `queue.db`            | LibSQL task queue             |
| `mastra.db`           | Mastra workflow runs/traces   |
| `worktrees/<task-id>` | Per-task git worktree         |
| `.merge.lock`         | Serializes the merge step     |

Add `/.mars/` to the target repo's `.gitignore`.

## Layout (orchestrator source)

| Path                            | Purpose                                            |
| ------------------------------- | -------------------------------------------------- |
| `src/cli.ts`                    | CLI: `add`, `list`, `run`, `where`                 |
| `src/mastra/context.ts`         | Resolves target repo + state paths                 |
| `src/mastra/index.ts`           | Mastra registration                                |
| `src/mastra/queue.ts`           | LibSQL-backed task queue                           |
| `src/mastra/lib/git.ts`         | All shell side-effects (git, claude, verify)       |
| `src/mastra/workflows/`         | `implementWorkflow`                                |
| `src/mastra/tools/`             | Same primitives wrapped as Mastra tools            |
| `src/prompts/vcs-supervisor.md` | Bundled supervisor spec, inlined into `claude -p`  |

## Prerequisites

- `claude` CLI on PATH (Claude Code).
- An `integration` branch in the target repo (`git checkout -b integration` if missing).
- Node `>=22.13.0`.

## Env

- `INTEGRATION_BRANCH` — target branch for merges (default `integration`).
- `MARS_REPO` — target repo path (overrides cwd-based detection).

## Failure handling

- Verify gate fails → task marked `failed`, worktree retained at `.mars/worktrees/<taskId>`.
- Merge conflicts vcs-supervisor cannot reconcile → `git merge --abort`, task `failed`, worktree retained.
- Clean merge (or supervised resolution) → worktree removed, task `done`.
