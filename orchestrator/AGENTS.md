# AGENTS.md

You are a TypeScript developer experienced with the Mastra framework. You build AI agents, tools, workflows, and scorers. You follow strict TypeScript practices and always consult up-to-date Mastra documentation before making changes.


## CRITICAL: Load `mastra` skill

**BEFORE doing ANYTHING with Mastra, load the `mastra` skill FIRST.** Never rely on cached knowledge as Mastra's APIs change frequently between versions. Use the skill to read up-to-date documentation from `node_modules`.

## Project Overview

This is a **Mastra** project written in TypeScript. Mastra is a framework for building AI-powered applications and agents with a modern TypeScript stack. The Node.js runtime is `>=22.13.0`.

## Commands

```bash
npm run dev # Start Mastra Studio at localhost:4111 (long-running, use a separate terminal)
npm run build # Build a production-ready server
```

## Project Structure

| Folder                 | Description                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mastra`           | Entry point for all Mastra-related code and configuration.                                                                               |
| `src/mastra/agents`    | Define and configure your agents - their behavior, goals, and tools.                                                                     |
| `src/mastra/workflows` | Define multi-step workflows that orchestrate agents and tools together.                                                                  |
| `src/mastra/tools`     | Create reusable tools that your agents can call                                                                                          |
| `src/mastra/mcp`       | (Optional) Implement custom MCP servers to share your tools with external agents                                                         |
| `src/mastra/scorers`   | (Optional) Define scorers for evaluating agent performance over time                                                                     |
| `src/mastra/public`    | (Optional) Contents are copied into the `.build/output` directory during the build process, making them available for serving at runtime |

### Top-level files

Top-level files define how your Mastra project is configured, built, and connected to its environment.

| File                  | Description                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/mastra/index.ts` | Central entry point where you configure and initialize Mastra.                                                    |
| `.env.example`        | Template for environment variables - copy and rename to `.env` to add your secret [model provider](/models) keys. |
| `package.json`        | Defines project metadata, dependencies, and available npm scripts.                                                |
| `tsconfig.json`       | Configures TypeScript options such as path aliases, compiler settings, and build output.                          |

## Boundaries

### Always do

- Load the `mastra` skill before any Mastra-related work
- Register new agents, tools, workflows, and scorers in `src/mastra/index.ts`
- Use schemas for tool inputs and outputs
- Run `npm run build` to verify changes compile
- Non-AI logic lives in `src/mastra/lib/` and is called from `createStep`
  `execute`. Only wrap as `createTool` if an agent actually consumes it.
- Gate any new per-task signal-capture call site through
  `isReflectDisabled()` (or `recordSignals`, which already gates itself)
  so `MARS_REFLECT_DISABLED=1` stays a single, comprehensive disable
- File inbox items via `mars inbox raise --from -` (JSON on stdin) instead
  of writing one-shot `.ts` scripts under `orchestrator/scripts/`. The CLI
  verb is the supported entry point for dispatched agents and self-heal
  investigations. Leaving an uncommitted `raise-*.ts` in a worktree
  dirties the merge target and has previously blocked unrelated tasks
  from merging.
- Non-AI logic lives in `src/mastra/lib/` and is called from `createStep`
  `execute`. Only wrap as `createTool` if an agent actually consumes it.

### Daemon worker pool

`src/mastra/daemon/server.ts` dispatches work behind per-kind semaphores.
When you add a new dispatch path, route it through `acquire(sems.<kind>)`
in the dispatcher and `release(sems.<kind>)` in `finally`, then call
`drain()` so any pending work picks up the freed slot. Do **not**
emit-then-dispatch directly from a bus handler — push the id into the
matching `pending*` set and call `drain()` instead, otherwise reconcile
or a burst of `task add` calls will spawn one worktree per row and melt
the host. Caps default to triage=4, implement=6, refine=2,
structured-write=1; see README "Daemon worker pool" for the env vars.
Tune them at runtime with `mars daemon reload` (re-reads `MARS_MAX_*`
without restarting the daemon).

### `mars init` recursion

The `init` command walks the target repo and merges every manifest into a
single supervisor set:

- Recurses by default; depth cap of 6 below the repo root.
- Hardcoded skip set: `.git`, `node_modules`, `.mars`, `.worktrees`, `dist`,
  `build`, `.next`, `target`, `out`.
- Respects `.gitignore` at every level. Skips git submodules and other git
  worktrees.
- Layout contract: tech-bearing folders must be siblings, not nested. A
  manifest under a subtree another manifest already claims is a hard error.
- `--verbose` lists discovered manifests on stderr.

### Never do

- Never commit `.env` files or secrets
- Never modify `node_modules` or Mastra's database files directly
- Never hardcode API keys (always use environment variables)
## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Mastra .well-known skills discovery](https://mastra.ai/.well-known/skills/index.json)
