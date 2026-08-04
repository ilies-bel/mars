# AGENTS.md

You are a TypeScript developer building the Mars orchestrator. You write
imperative, agentic, code-producing workflows on the in-house
`@mars/workflow` engine. You follow strict TypeScript practices.

## Project Overview

This orchestrator runs provider-selected headless coding agents in parallel git worktrees and
fast-forwards verified work into `main`. Workflows are plain imperative TS
functions on the **`@mars/workflow`** engine (`packages/workflow/`): native
control flow is the source of truth, `ctx.step(name, fn)` wraps each durable
unit, durability is checkpoint-resume keyed on `runId`. The Node.js runtime
is `>=22.13.0`.

**Mastra is gone.** The orchestrator no longer depends on `@mastra/*`; do
not reintroduce it. The `mastra` skill and Mastra docs are not relevant to
this codebase any more. See `docs/implement-pipeline.md` for the
workflow-authoring pattern and `docs/migrations/0001-mastra-to-workflow-engine.md`
for the migration record.

## Commands

```bash
npm run dev   # run the CLI from source (tsx src/cli.ts)
npm test      # vitest run
npm run typecheck
```

## Project Structure

| Folder              | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `src/workflows`     | Imperative `@mars/workflow` pipelines (implement/triage/plan/slice/init).    |
| `src/core`        | The orchestrator's core. Holds `queue.ts`, `proposals.ts`, `context.ts`, and the subdirs below. |
| `src/core/agents` | Worker/agent specs and the agent registry.                                   |
| `src/core/workers`| Role-pinned Worker primitives (Coder/Fixer/Triager/Planner/Slicer/Writer).   |
| `src/core/daemon` | The long-lived daemon: dispatch loop, per-kind semaphores, socket protocol.  |
| `src/core/lib`    | Non-AI side-effect helpers (git, verify, claude-stream, task-store).         |
| `src/core/store`  | Domain task store.                                                           |
| `src/init`          | `mars init`: scaffolding (docs/knowledge/, .claude/, workflows), DB init.   |

### Top-level files

| File              | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `src/cli.ts`      | The `mars` CLI entry point.                                              |
| `package.json`    | Project metadata, dependencies, npm scripts.                            |
| `tsconfig.json`   | TS options + the `@mars/workflow` path alias to `packages/workflow/src`. |

## Boundaries

### Always do

- Author workflows on `@mars/workflow`: one `defineWorkflow({id, inputSchema,
  fn})`, durable units wrapped in `await ctx.step(name, fn)`, failures THROW.
  Copy the pattern in `docs/implement-pipeline.md`.
- Use Zod schemas for workflow inputs.
- Run `npm run typecheck` and `npm test` to verify changes.
- Non-AI side-effect logic lives in `src/core/lib/` and is called from
  inside a `ctx.step`.
- Gate any new per-task signal-capture call site through
  `isReflectDisabled()` (or `recordSignals`, which already gates itself)
  so `MARS_REFLECT_DISABLED=1` stays a single, comprehensive disable
- File action queue items via `mars action-queue raise --from -` (JSON on stdin) instead
  of writing one-shot `.ts` scripts under `orchestrator/scripts/`. The CLI
  verb is the supported entry point for dispatched agents and self-heal
  investigations. Leaving an uncommitted `raise-*.ts` in a worktree
  dirties the merge target and has previously blocked unrelated tasks
  from merging.

### Daemon worker pool

`src/core/daemon/server.ts` dispatches work behind per-kind semaphores.
When you add a new dispatch path, route it through `acquire(sems.<kind>)`
in the dispatcher and `release(sems.<kind>)` in `finally`, then call
`drain()` so any pending work picks up the freed slot. Do **not**
emit-then-dispatch directly from a bus handler — push the id into the
matching `pending*` set and call `drain()` instead, otherwise reconcile
or a burst of `task add` calls will spawn one worktree per row and melt
the host. Caps default to triage=8, implement=12, refine=6,
structured-write=1; see README "Daemon worker pool" for the env vars.
Tune them at runtime with `mars daemon reload` (re-reads `MARS_MAX_*`
without restarting the daemon).

### Never do

- Never commit `.env` files or secrets
- Never modify `node_modules` directly
- Never hardcode API keys (always use environment variables)
- Never reintroduce `@mastra/*` — the orchestrator runs on `@mars/workflow`.

## Resources

- `docs/implement-pipeline.md` — the canonical `@mars/workflow` authoring pattern.
- `docs/migrations/0001-mastra-to-workflow-engine.md` — the migration record.
- `packages/workflow/` — the engine source + its own test suite.
