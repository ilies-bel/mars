# @mars/workflow

A small, **domain-agnostic** workflow engine for local TypeScript CLIs that
drive coding agents (Claude, others). Built for the Mars orchestrator;
designed to be useful outside it.

## Why this exists

The orchestrator was on Mastra but used `.then()` chains and nothing else
— no agents, no memory, no scorers. Mastra brought seven packages and a
migration story. This engine is the smallest thing that does the job:

- **DAG steps** with Zod-typed inputs and outputs.
- **Durable resume** from the last completed step (single SQLite file).
- **Logging by design** — every step receives a child logger; lifecycle
  events are logged automatically.
- **Pluggable agent runtimes** — `HeadlessRuntime` for `claude -p`,
  `TmuxRuntime` for interactive panes. Steps depend on the interface,
  not the binary.
- **Local-first.** No broker, no server, no UI. One process, one SQLite
  file, one event stream you can pipe wherever.

This package knows nothing about Mars, git worktrees, or coding tasks.
The orchestrator consumes it.

## Non-goals

- Distributed workers, multi-machine queues, cluster scheduling.
- Long-running cron / scheduled triggers (use `cron` + invoke the engine).
- Human-in-the-loop approval UI (consumer's job).
- A workflow editor / studio.

## Install

```bash
npm install @mars/workflow zod
```

Peer deps: `zod` (schemas), `better-sqlite3` (default store; optional if
you bring your own).

## Concepts

### Step

A typed unit of work with declared dependencies.

```ts
import { z } from 'zod';
import { defineStep } from '@mars/workflow';

const verify = defineStep({
  id: 'verify',
  deps: ['code'],
  inputSchema:  z.object({ worktree: z.string() }),
  outputSchema: z.object({ passed: z.boolean(), report: z.string() }),
  run: async (input, ctx) => {
    ctx.logger.info({ worktree: input.worktree }, 'verify started');
    const result = await runVerify(input.worktree, ctx.signal);
    ctx.emit('verify.result', result);
    return result;
  },
});
```

Steps receive a `ctx`:

| Field | Purpose |
|---|---|
| `workflowId`, `stepId` | identity |
| `signal` | `AbortSignal` propagated from the run |
| `emit(event, payload)` | fine-grained progress events |
| `logger` | child logger scoped to this step |

### Workflow

A set of steps, plus an `output` function that projects step results.

```ts
import { defineWorkflow } from '@mars/workflow';

export const implementWorkflow = defineWorkflow({
  id: 'implement',
  inputSchema:  z.object({ taskId: z.string(), prompt: z.string() }),
  outputSchema: z.object({ merged: z.boolean(), sha: z.string().nullable() }),
  steps: { setup, code, verify, merge },
  output: (results) => ({
    merged: results.merge.merged,
    sha: results.merge.sha,
  }),
});
```

Steps form a DAG via `deps`. The engine topologically sorts on every
run; cycles are a definition-time error.

### Run

```ts
import { runWorkflow, Sqlite3Store, pinoLogger } from '@mars/workflow';

const store  = new Sqlite3Store('.mars/workflow.db');
const logger = pinoLogger();          // any compatible logger

const result = await runWorkflow(implementWorkflow, {
  taskId: 'task-abc',
  prompt: 'fix the bug in src/foo.ts',
}, { store, logger });
```

Resume is automatic: re-running with the same `workflowId + input hash`
picks up after the last completed step. Pass `{ fresh: true }` to start
over.

### Agent runtimes

Steps that drive a coding agent depend on the `AgentRuntime` interface,
never on a specific binary:

```ts
import type { AgentRuntime } from '@mars/workflow/agent';

const codeStep = defineStep({
  id: 'code',
  deps: ['setup'],
  inputSchema:  z.object({ worktree: z.string(), prompt: z.string() }),
  outputSchema: z.object({ events: z.array(z.unknown()) }),
  run: async (input, ctx) => {
    const runtime: AgentRuntime = ctx.services.agent;
    const events: unknown[] = [];
    for await (const ev of runtime.run(input.prompt, {
      cwd: input.worktree,
      signal: ctx.signal,
    })) {
      ctx.emit('agent.event', ev);
      events.push(ev);
    }
    return { events };
  },
});
```

Two implementations ship in the box:

#### `HeadlessRuntime`

Spawns `claude -p` (or any compatible CLI), parses stream-json events,
yields them one-by-one.

```ts
import { HeadlessRuntime } from '@mars/workflow/runtimes/headless';

const runtime = new HeadlessRuntime({
  binary: 'claude',
  defaultArgs: ['--model', 'sonnet'],
});
```

Use for: daemons, CI, anything unattended.

#### `TmuxRuntime`

Attaches to a tmux session/pane, sends the prompt as keystrokes, scrapes
pane output. The user can watch, interrupt, or take over.

```ts
import { TmuxRuntime } from '@mars/workflow/runtimes/tmux';

const runtime = new TmuxRuntime({
  session: 'mars',
  windowName: (input) => `task-${input.taskId}`,
});
```

Use for: interactive supervisor mode, debugging, demos.

Both runtimes implement the same `AgentRuntime` interface, so steps are
runtime-agnostic. The orchestrator picks the runtime per-run; steps
never know which one they got.

### Wiring services into steps

Steps can declare service dependencies (logger and emitter come for
free; agent runtime / git / fs are passed in via `services`):

```ts
const result = await runWorkflow(implementWorkflow, input, {
  store,
  logger,
  services: { agent: new HeadlessRuntime({ binary: 'claude' }) },
});
```

Inside a step, `ctx.services.agent` is typed against whatever the
workflow declared in its `Services` generic.

## Logging by design

The engine wraps a structured logger (`pino`-shaped — `info`, `warn`,
`error`, `child`). Lifecycle events are logged automatically:

```
{ level: 'info', runId, workflowId, stepId, event: 'step.started'  }
{ level: 'info', runId, workflowId, stepId, event: 'step.completed', durationMs }
{ level: 'error', runId, workflowId, stepId, event: 'step.failed', err }
```

Inside a step, `ctx.logger` is a child scoped to `{ runId, stepId }`.
The same logger backs `ctx.emit` — every emitted event is also logged
at `debug`. There is no `console.log` path in the engine.

You bring the logger; the engine ships a `pinoLogger()` helper but
accepts any compatible interface.

## Storage

`WorkflowStore` is an interface. The default `Sqlite3Store`
(better-sqlite3) creates two tables:

```sql
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workflow_step_runs (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (run_id, step_id)
);
```

You can implement `WorkflowStore` against any backend (the Mars
orchestrator implements it against the existing `.mars/queue.db`).

## What this is not

- Not a queue. It runs *a* workflow. Dispatching, retries-with-backoff,
  and concurrency caps belong in the caller.
- Not durable across machines. One SQLite file, one host.
- Not an agent framework. Agent runtimes are opaque to the engine —
  it just streams whatever they yield.

## Status

Internal to the Mars repo, intended to be published as a standalone
package once the orchestrator finishes migrating off Mastra. API may
still shift; pin a version.

## See also

- ADR 0012 — Workflow engine is domain-agnostic with pluggable agent
  runtimes (`docs/adr/0012-...`)
