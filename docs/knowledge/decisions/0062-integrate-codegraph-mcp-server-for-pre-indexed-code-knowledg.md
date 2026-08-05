# Integrate codegraph MCP server for pre-indexed code knowledge graph in dispatched workers

## Status

Accepted

## Context

The Mars orchestrator dispatches headless `claude -p` workers (Coder, Planner, Slicer, Triager, Fixer) into git worktrees. Those workers orient themselves by reading source files directly via rg/fd/Glob, which is expensive: every symbol lookup or blast-radius assessment triggers many small file reads, burns context tokens, and adds tool-call latency.

codegraph (github.com/colbymchenry/codegraph) is a pre-indexed code knowledge graph CLI that exposes symbol definitions, call graphs, caller/callee chains, and impact sets through MCP-compatible tools (`codegraph_explore`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_files`, `codegraph_status`). Registering it as a project MCP server means every dispatched worker gets those tools for free, without per-session startup overhead.

The workers most likely to benefit are the three "reasoning-heavy" roles: Planner (architectural decomposition), Slicer (PRD-to-slice analysis across the whole codebase), and Coder (implementation with blast-radius awareness). Triager (lightweight triage, 40-message cap) and Fixer (recovery, must stay focused on the broken code) are out of scope.

## Decision

1. Register the codegraph CLI as a project MCP server in the repo-root `.mcp.json` so its `codegraph_*` tools are available to every `claude -p` invocation that reads project MCP config (`--strict-mcp-config --setting-sources project,local`).

2. Append `CODEGRAPH_NUDGE` (an exported constant in `orchestrator/src/core/workers/index.ts`) via `appendSystemPrompt` to the Planner, Slicer, and Coder worker configs. The nudge steers workers to consult the graph before broad file-scanning; it does not mandate it.

3. Triager and Fixer deliberately do NOT carry the nudge. Triager's 40-message cap leaves no budget for graph queries; Fixer must focus on the broken code path, not exploratory traversal.

4. The blast radius is pinned by a test in `orchestrator/src/core/workers/__tests__/codegraph-nudge.test.ts` — a future edit that silently adds or drops the nudge from any worker will fail the suite.

## Fallback

Workers retain full access to direct file reads (rg, fd, Glob, Read). When the codegraph index lacks the detail needed (e.g. a newly added file not yet indexed, or a dynamic call site the static graph cannot resolve), workers fall back to direct file reads without any orchestrator involvement. The nudge is advisory, not mandatory.

## Trade-offs

**Benefits**
- Faster, cheaper symbol lookup and call-graph tracing: a single `codegraph_callers` call replaces dozens of rg sweeps, cutting tool calls and context churn.
- Blast-radius assessment at planning time becomes reliable: the graph knows all callers of a symbol without grep false-positives.
- Scales linearly with codebase size: the graph is indexed once and queried many times per session.

**Costs and risks**
- New hard external binary dependency: every developer machine and CI runner must install the `codegraph` CLI. Missing binary → workers still run but get no graph tools (MCP server absent, graceful degradation).
- Per-machine index: the `.codegraph/` directory must stay fresh. Stale index after large refactors may give workers incorrect call-graph data. The daemon or a file-watcher must trigger re-indexing on significant changes.
- Adds a consumer install prerequisite: `mars init` / the bootstrap script must document (or automate) the codegraph install step. Workers will silently degrade to file reads if the binary is absent.

## Consumer install prerequisite

Install codegraph once per machine before running `mars init`:

```
npm install -g codegraph   # or the install method documented at github.com/colbymchenry/codegraph
codegraph index            # initial indexing; re-run after large refactors
```

The daemon is expected to trigger periodic re-indexing via a file-watcher integration (tracked separately). Until that lands, operators must re-run `codegraph index` after significant codebase changes.
