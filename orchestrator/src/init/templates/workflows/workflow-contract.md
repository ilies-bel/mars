<!-- mars-scaffold-workflows-contract:v1 -->

# Scaffolded workflows contract

`mars init` scaffolds the official Mars workflows into `.mars/workflows/` as
plain JavaScript you are **expected to edit** to author your own flows. These
files are **user-owned** (ADR-0057): once they exist on disk, `mars update`
**never silently overwrites** them — when the bundled template changes, update
shows you a unified diff and lets you merge by hand (or skip).

## File set

The bundle ships exactly these workflow templates. `mars init` copies each one
into `.mars/workflows/<name>` (the directory is created if absent):

| Template                | Destination                          | Role                                                          |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `task-workflow.js`      | `.mars/workflows/task-workflow.js`   | Default end-to-end task pipeline (setup → code → verify → merge, all auto). |
| `fix-workflow.js`       | `.mars/workflows/fix-workflow.js`    | Recovery pipeline for a failed task (ADR-0040: one attempt, leaf). |
| `diagnose-workflow.js`  | `.mars/workflows/diagnose-workflow.js` | Read-only diagnosis of a stuck/failed task arc.              |
| `write-workflow.js`     | `.mars/workflows/write-workflow.js`  | Structured-write pipeline (glossary / ADR / docs).           |
| `live-workflow.js`      | `.mars/workflows/live-workflow.js`   | Human-driven coding: setup (auto) → code (MANUAL) → verify → merge. |
| `runbook-workflow.js`   | `.mars/workflows/runbook-workflow.js` | Manual-heavy release pipeline: setup → code → qa (MANUAL) → verify → merge. Default for `mars proposal take`. |

The template list is discovered dynamically: `scaffoldWorkflows` reads every
`*.js` file from `templates/workflows/` via `bundledWorkflowFiles()` in
`src/init/scaffold-workflows.ts`. Adding a template here means adding the
`.js` file to `templates/workflows/` — no code change required. Update this
table and re-run the maintainer bundle refresh (`npm run mars:bundle:refresh`)
to keep CI in sync.

## Module shape

Each template is a plain ES module that default-exports a workflow defined with
`defineWorkflow`. Everything — the `defineWorkflow` helper and the step-primitives
(`setupWorktree`, `runAgent`, `verify`, `merge`) — is imported from the single
`mars/workflow` surface:

```js
import {
  defineWorkflow,
  setupWorktree, runAgent, verify, merge,
} from 'mars/workflow'

export default defineWorkflow({
  id: 'task',
  async fn(ctx) {
    await ctx.step('setup',  () => setupWorktree(ctx))
    await ctx.step('code',   () => runAgent(ctx, { mode: 'auto' }))
    await ctx.step('verify', () => review(ctx, { reviewType: 'auto' }))
    return  ctx.step('merge',  () => merge(ctx))
  },
})
```

- `id` — the workflow id (load-bearing trace-view label).
- `fn(ctx)` — the imperative body. `ctx.step(name, fn)` wraps each durable
  unit; durability is checkpoint-resume keyed on the run id.
- **`ctx.input`** — the validated input this task was dispatched with (prompt,
  kind, integration branch, recovery payload, …). Every primitive DEFAULTS its
  options from `ctx.input`, so a step is just `primitive(ctx)` — you never copy
  fields out of an `input` argument into each call (there is no `input`
  argument). Read `ctx.input.foo` directly if your own step logic needs it.
- The primitives take `(ctx, opts?)`: `opts` is a small bag you pass ONLY to
  OVERRIDE a `ctx.input` default. Precedence is `opts.field ?? ctx.input.field
  ?? hard default`. The plumbing (Arc task store, trace store, worktree ref,
  event sink, step handle) is pulled off `ctx` for you — the worktree
  `setupWorktree` provisions is remembered for `verify`/`merge`. Every
  task-state write funnels through the Arc aggregate (ADR-0052).
- **Per-step model** — like the Agent SDK's `query({ prompt, model })`,
  `runAgent(ctx, { model: 'claude-opus-4-7' })` pins the model for that step.
  Omit it to use the resolved Worker's default. Precedence: `opts.model ??
  MARS_WORKER_MODEL` (Coder only) `?? the Worker's pinned model`.
- **Per-step Execution mode** — `runAgent` and `verify` accept `mode: 'auto' |
  'manual'` and an optional `guide: string`. `'auto'` (default) runs the
  primitive headlessly. `'manual'` parks the task `awaiting-human` with the
  Step guide visible in the action queue; `mars step done <id>` signals
  completion and the pipeline continues. Example manual gate:
  ```js
  await ctx.step('qa', () =>
    runAgent(ctx, {
      mode: 'manual',
      guide: 'Review the diff, run smoke tests, tick criteria, then mars step done.',
    }),
  )
  ```
  `setupWorktree` and `merge` are always auto (no `mode` option).
- Failures **THROW** — the engine records the step failed. Do not swallow.

## Ownership & update semantics

- **`mars init`** scaffolds the files when they do not yet exist (a fresh repo
  has nothing to protect). It never overwrites a pre-existing file.
- **`mars update`** re-scaffolds silently when the on-disk file is byte-identical
  to the bundled template; when it has diverged it prints a unified diff and
  prompts accept/skip. `--yes` (non-interactive / CI) defaults to skip-on-conflict.
- A workflow file the user has removed from the init manifest is treated as
  **unowned** and is left completely untouched by `mars update`.

## Marker

Every scaffolded template carries a `// @mars-workflow-template:vN` marker on
its first line so tooling can recognise an unedited template. The version
increments whenever the bundled content changes materially (a diff that
`mars update` would offer to merge). Current versions:

| Template              | Marker version |
| --------------------- | -------------- |
| `task-workflow.js`    | `v4`           |
| `fix-workflow.js`     | `v3`           |
| `diagnose-workflow.js`| `v3`           |
| `write-workflow.js`   | `v3`           |
| `live-workflow.js`    | `v1`           |
| `runbook-workflow.js` | `v1`           |
