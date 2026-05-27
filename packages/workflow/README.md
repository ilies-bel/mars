# @mars/workflow

A small, **domain-agnostic** workflow engine for local TypeScript CLIs that
drive coding agents (Claude, others). Built for the Mars orchestrator;
designed to be useful outside it.

> **This supersedes the declarative DAG model.** Earlier drafts specced
> `defineStep({ id, deps, … })` + `defineWorkflow({ steps, output })` with a
> topological sort. That model is gone. A workflow is now a plain
> **imperative TypeScript function**; native control flow is the source of
> truth. ADR 0012 (DAG step model) and ADR 0014 (linear `.then` v1
> composition) describe the old design and will need amendment — this README
> is the current contract.

## Why this exists

The orchestrator was on Mastra but used `.then()` chains and nothing else
— no agents, no memory, no scorers. Mastra brought seven packages and a
migration story. This engine is the smallest thing that does the job:

- **Imperative workflows** — a workflow is `async (ctx, input) => output`.
  Branch with `if`, repeat with `for`, sequence with `await`. No graph, no
  `deps`, no DSL.
- **A step contract** — `ctx.step(name, fn)` wraps each durable unit. The
  `name` is explicit and load-bearing: it keys both resume and the trace
  view.
- **Checkpoint-resume durability** (single SQLite file) — a step whose
  record is already `completed` does not re-run its `fn`.
- **Logging by design** — every step receives a child logger; lifecycle
  events are logged automatically.
- **Pluggable agent runtimes** — `HeadlessRuntime` for `claude -p` (and a
  `TmuxRuntime` slot for interactive panes). Steps depend on the
  interface, not the binary.
- **Local-first.** No broker, no server, no UI. One process, one SQLite
  file, one event stream you can pipe wherever.

This package knows nothing about Mars, git worktrees, or coding tasks.
The orchestrator consumes it.

## Non-goals

- Deterministic replay / event-sourced history. The codebase moves under
  the workflow and side effects live in git and the filesystem, not in a
  replayable event log — replay would be a category mismatch. We
  checkpoint and resume instead.
- Declarative or visual authoring, a graph editor, or graph↔code
  round-trip. Code is the only authoring surface.
- A state-machine library (XState et al.). The "state machine" is your own
  TS control flow.
- Distributed workers, multi-machine queues, cluster scheduling.
- Long-running / "react to every new commit forever" workflows. A workflow
  terminates.
- Human-in-the-loop approval UI, and the trace UI itself (consumer's job;
  the per-step record carries everything that UI needs).

## Install

```bash
npm install @mars/workflow zod
```

The default SQLite store uses `node:sqlite`, built into Node (stable from
Node 22.13) — no native addon to compile, no `better-sqlite3` install step.

## Concepts

### Workflow = a function

A workflow is a plain async function. Control flow is native TypeScript.

```ts
import type { WorkflowCtx } from '@mars/workflow';

interface ImplementInput { taskId: string; prompt: string; qa: 'full' | 'none'; }
interface ImplementOutput { merged: boolean; sha: string | null; }

async function implement(
  ctx: WorkflowCtx,
  input: ImplementInput,
): Promise<ImplementOutput> {
  const wt   = await ctx.step('setup', () => createWorktree(input));
  const code = await ctx.step('code',  () => runCoder(wt));

  if (input.qa !== 'none') {
    await ctx.step('verify', () => runVerify(wt));   // omit this = "merge without checking"
  }

  const merge = await ctx.step('merge', () => mergeToMain(wt));
  return { merged: merge.merged, sha: merge.sha };
}
```

There is no `deps` array and no topological sort: the order the function
reaches each `ctx.step(...)` *is* the execution order. Loops and branches
are just loops and branches.

### Step = `ctx.step(name, fn)`

`name` is an explicit string and it is **load-bearing**: it keys both
checkpoint-resume and the trace-view node label. `fn` is
`(handle) => Promise<T> | T`; its return value is recorded as the step's
result.

- Reaching the **same name twice within a run throws.** Use templated names
  for looped or conditional steps:

  ```ts
  for (const pkg of input.packages) {
    await ctx.step(`verify-${pkg}`, () => runVerify(pkg));
  }
  ```

- The `handle` lets a step annotate its own record for resume and the trace
  view:

  ```ts
  await ctx.step('code', (handle) => {
    handle.setSha(currentWorktreeSha);          // re-anchor point on resume
    handle.setTranscriptKey('transcript/abc');  // full output lives by key
    handle.setSummary('wrote 12 files');        // compact trace summary
    return runCoder(wt);
  });
  ```

The `ctx` a workflow receives:

| Field | Purpose |
|---|---|
| `runId`, `workflowId` | run identity |
| `step(name, fn, opts?)` | wrap a durable unit |
| `signal` | `AbortSignal` for the run |
| `emit(event, payload)` | fine-grained progress events |
| `logger` | run-scoped child logger |
| `services` | injected dependencies (agent runtime, git, fs…) |

### Run (and resume)

```ts
import { runWorkflow, SqliteStore, pinoLogger } from '@mars/workflow';

const store  = new SqliteStore('.mars/workflow.db');
const logger = pinoLogger();          // any compatible logger

const result = await runWorkflow(implement, {
  taskId: 'task-abc',
  prompt: 'fix the bug in src/foo.ts',
  qa: 'full',
}, { store, logger });
```

`runWorkflow(fn, input, options)` returns
`{ runId, status: 'completed' | 'failed', output?, error? }`. You can pass a
bare function (its `.name` becomes the `workflowId`) or a `defineWorkflow`
result to pin the id and an input schema:

```ts
import { defineWorkflow } from '@mars/workflow';
import { z } from 'zod';

export const implementWorkflow = defineWorkflow({
  id: 'implement',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    qa: z.enum(['full', 'none']),
  }),
  fn: implement,
});
```

**Resume** is checkpoint-based, not replay. Pass the existing `runId` to
re-run:

```ts
const resumed = await runWorkflow(implement, input, { store, runId: result.runId });
```

The function body runs from the top again — that is just how an imperative
function resumes — but every `ctx.step(name, fn)` whose stored record is
already `completed` **short-circuits**: `fn` is not invoked and the recorded
result is returned in its place. A step left in `running` or `failed` (e.g.
a crash mid-step, or a verify that went red) runs again, its `attempt`
counter incrementing. Side effects already committed to git/fs are not
repeated; the `sha` on each record is your re-anchor point.

### Agent runtimes

Steps that drive a coding agent depend on the `AgentRuntime` interface,
never on a specific binary:

```ts
import type { AgentRuntime, WorkflowCtx } from '@mars/workflow';

async function code(ctx: WorkflowCtx<{ agent: AgentRuntime }>, input: { worktree: string; prompt: string }) {
  return ctx.step('code', async (handle) => {
    const events: unknown[] = [];
    for await (const ev of ctx.services.agent.run(input.prompt, {
      cwd: input.worktree,
      signal: handle.signal,
    })) {
      ctx.emit('agent.event', ev);
      events.push(ev);
    }
    return { events };
  });
}
```

`HeadlessRuntime` (spawns `claude -p`, yields parsed stream-json lines)
ships as a minimal reference implementation:

```ts
import { HeadlessRuntime } from '@mars/workflow';

const result = await runWorkflow(implement, input, {
  store,
  services: { agent: new HeadlessRuntime({ binary: 'claude', defaultArgs: ['--model', 'sonnet'] }) },
});
```

A `TmuxRuntime` (interactive panes the user can watch and take over) is the
intended second implementation; the interface is the load-bearing part, so
steps stay runtime-agnostic and the caller picks the runtime per run.

## Logging by design

The engine wraps a structured logger (`pino`-shaped — `info`, `warn`,
`error`, `child`). Lifecycle events are logged automatically:

```
{ level: 'info',  runId, workflowId, step, event: 'step.started',   attempt }
{ level: 'info',  runId, workflowId, step, event: 'step.completed', attempt, durationMs }
{ level: 'info',  runId, workflowId, step, event: 'step.skipped',   attempt }   // resume
{ level: 'error', runId, workflowId, step, event: 'step.failed',    attempt, err }
```

Inside a step, `handle.logger` is a child scoped to `{ runId, workflowId,
step }`. `ctx.emit(event, payload)` adds fine-grained progress events, also
logged at `info` and forwarded to the optional `onEvent` sink. There is no
`console.log` path in the engine — you bring the logger; the bundled
`pinoLogger()` is a dependency-free default and `silentLogger()` suppresses
output (handy in tests).

## Storage

`WorkflowStore` is an interface — the seam the consumer (Mars) implements
against its own `.mars/queue.db`. Two reference impls ship: `InMemoryStore`
(tests, ephemeral runs) and the default `SqliteStore` (`node:sqlite`), which
creates two tables:

```sql
CREATE TABLE workflow_runs (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT    NOT NULL,
  input_json  TEXT    NOT NULL,
  status      TEXT    NOT NULL,      -- 'running' | 'completed' | 'failed'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE workflow_step_runs (
  run_id         TEXT    NOT NULL,
  step_name      TEXT    NOT NULL,   -- the explicit, load-bearing step name
  status         TEXT    NOT NULL,   -- 'running' | 'completed' | 'failed'
  sha            TEXT,               -- worktree SHA the step ran against (re-anchor)
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  attempt        INTEGER NOT NULL,   -- retry count (1-based once run)
  summary        TEXT,               -- COMPACT result summary, not full output
  error_summary  TEXT,               -- compact failure summary
  transcript_key TEXT,               -- key into external transcript storage
  result_json    TEXT,               -- recorded return value (resume hands this back)
  PRIMARY KEY (run_id, step_name)
);
```

One lean record per step, keyed by `(run_id, step_name)`, serves **both**
roles: resume reads `status` + `result_json`, and the read-only trace view
reads `step_name`, `status`, `started_at`/`finished_at`, `attempt`, `sha`,
and `transcript_key` to render a timeline and resolve full transcripts by
key on expand. This per-step log is the workflow-instance analog of an
append-only outbox — full transcripts are **referenced by key, never
inlined**.

Note there is no persisted `'skipped'` status: a step skipped on resume is
simply one whose stored status is already `'completed'`. Skip is a
runtime/trace concept (the `step.skipped` event), not a stored state.

## What this is not

- Not a queue. It runs *a* workflow. Dispatching, retries-with-backoff, and
  concurrency caps belong in the caller.
- Not a replay engine. Durability is checkpoint-resume; the step record is
  the checkpoint.
- Not durable across machines. One SQLite file, one host.
- Not an agent framework. Agent runtimes are opaque to the engine — it just
  streams whatever they yield.

## Status

Internal to the Mars repo, intended to be published as a standalone package
once the orchestrator finishes migrating off Mastra. API may still shift;
pin a version.

## See also

- ADR 0012 — Workflow engine domain model (the declarative DAG variant this
  README supersedes; pending amendment).
- ADR 0014 — Linear `.then` v1 composition (likewise pending amendment).
