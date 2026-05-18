# Context-gathering summary for mars-c02ba958

Context gathered and written to mars-c02ba958's worktree at:
`orchestrator/src/mastra/workers/UNBLOCK-mars-c02ba958.md`

## What was blocking the implementor

After reading `git.ts`, `tdd-brief.ts`, `slice-workflow.ts`,
`implement-workflow.ts`, and a glob, the implementor lacked two pieces:

1. **The `--agents` CLI flag** — the flag that defines custom agent
   personas inline is `--agents <json>` (not `--agent-def`). Format:
   `--agents '{"worker":{"prompt":"..."}}'`. Only visible via
   `claude --help`.

2. **`workers/index.ts` structure** — `WorkerConfig` does not currently
   have `agent` or `agentDef` fields, and `buildWorker` does not pass
   `agent` through to `runClaudeCode`. The implementor needed to see this
   to know where to add the new fields.

## What the implementor needs to do (summary)

- Add `agentDef` to `ClaudeStreamArgsOptions`, `RunClaudeArgs`
- In `claudeStreamArgs`: conditionally set `--setting-sources local` (drop
  `project`) and emit `--agents JSON` when `agentDef` is set
- Add `agent` + `agentDef` to `WorkerConfig`; set both on `Coder`
- Wire them through `buildWorker` → `runClaudeCode`
- Write tests in `workers/__tests__/registry.test.ts`

Full, actionable details are in the UNBLOCK note.
