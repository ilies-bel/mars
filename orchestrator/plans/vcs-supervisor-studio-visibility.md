# Plan: surface vcs-supervisor (Vega) runs in Mastra Studio

## Why

Today the merge step shells out to `claude -p` (keeps Max-subscription billing —
must stay) and Studio only sees the final exit code. Operators have no
visibility into what Vega is doing during long conflict resolutions.

## Goal

Make Vega's run observable in Studio's
`Workflows → implementWorkflow → merge` step without changing the runtime
(still `claude -p`, still Max-billed).

## Scope

Single task, ~1 file + tests.

### 1. Add streaming variant in `orchestrator/src/mastra/lib/git.ts`

- New `runSubprocessStreaming(cmd, args, cwd, onChunk)` that calls
  `onChunk({ stream: 'stdout'|'stderr', data, ts })` as data arrives, in
  addition to returning the buffered `RunSubprocessResult`.
- Refactor existing `runSubprocess` to delegate to it (no behavior change for
  non-streaming callers).

### 2. Wire `invokeVcsSupervisor` (`lib/git.ts:237`) to emit Mastra logger events

- Accept an optional `logger` param (Mastra `IMastraLogger` from the step's
  `mastra` context).
- On each chunk, call
  `logger.info('vcs-supervisor', { taskId, branch, stream, chunk: data.slice(0, 2000) })`.
  Throttle/coalesce to ≤ 1 log/sec to avoid trace bloat.
- Log a `vcs-supervisor.start` event with
  `{ taskId, branch, integrationBranch, prompt: prompt.slice(0,200) }` and a
  `vcs-supervisor.end` event with
  `{ exitCode, durationMs, stdoutBytes, stderrBytes }`.
- Parse `session_id` from the supervisor's JSON stdout (reuse
  `extractSessionId`) and include it in the end event so operators can resume
  the Claude Code session.

### 3. Pass logger through the merge step

- In `orchestrator/src/mastra/workflows/implement-workflow.ts` merge step, grab
  `mastra.getLogger()` and forward into `mergeBranch` → `invokeVcsSupervisor`.
- Keep step output unchanged (status strings + truncated stdout).

### 4. Tests (`orchestrator/src/mastra/lib/__tests__/git.test.ts`)

- Streaming subprocess: stub a script that emits 3 stdout lines + 1 stderr
  line; assert `onChunk` called with each, and final result equals
  concatenation.
- Throttle: emit 100 chunks in <1s, assert ≤ 2 logger calls fired.
- Logger contract: spy on a fake logger and assert `.start` / `.end` events
  with expected fields shape.

### 5. Docs

- Append a short note to `orchestrator/README.md` ("Observing vcs-supervisor in
  Studio") pointing to the merge step's logs panel and explaining the
  `vcs-supervisor.start` / `.end` events.

## Out of scope

- No refactor to a Mastra `Agent` (would lose Max billing).
- No new tools, no MCP changes, no schema changes to step output.
- No changes to `runClaudeCode` for the `code` step (separate task if we want
  streaming there too).

## Definition of done

- `npm run build` in `orchestrator/` succeeds.
- New tests pass; existing tests unchanged.
- Manually triggering a synthetic merge conflict shows live `vcs-supervisor`
  log lines in Studio's merge-step trace.
- `claude -p` invocation (cmd + args + auth path) is byte-identical to before
  — no subscription regression.

## Files expected to change

- `orchestrator/src/mastra/lib/git.ts`
- `orchestrator/src/mastra/workflows/implement-workflow.ts` (merge step only)
- `orchestrator/src/mastra/lib/__tests__/git.test.ts` (new or extended)
- `orchestrator/README.md`

## One-liner for `mars-orch add`

```bash
mars-orch add "$(cat <<'EOF'
Surface vcs-supervisor (Vega) runs in Mastra Studio without leaving claude -p.

1. Add runSubprocessStreaming in orchestrator/src/mastra/lib/git.ts with an onChunk callback; refactor runSubprocess to delegate.
2. Update invokeVcsSupervisor to accept an optional Mastra logger; emit vcs-supervisor.start, throttled (<=1/s) chunk events, and vcs-supervisor.end with {exitCode,durationMs,sessionId,stdoutBytes,stderrBytes}.
3. In orchestrator/src/mastra/workflows/implement-workflow.ts merge step, pass mastra.getLogger() into mergeBranch -> invokeVcsSupervisor. Keep step output shape unchanged.
4. Tests in orchestrator/src/mastra/lib/__tests__/git.test.ts: streaming chunks, throttle (<=2 calls for 100 chunks <1s), logger event shape.
5. Append "Observing vcs-supervisor in Studio" note to orchestrator/README.md.

Constraints: do NOT refactor Vega to a Mastra Agent (must keep Max-subscription billing via claude -p). Do not change runClaudeCode for the code step. claude -p cmd + args must remain byte-identical. npm run build must pass.
EOF
)"
```
