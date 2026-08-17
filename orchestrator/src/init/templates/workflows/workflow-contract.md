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
  setupWorktree, runAgent, review, merge,
} from 'mars/workflow'

export default defineWorkflow({
  id: 'task',
  async fn(ctx) {
    await ctx.step('setup',  () => setupWorktree(ctx))
    await ctx.step('code',   () => runAgent(ctx))
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
  `runAgent(ctx, { model: 'claude-opus-5' })` pins the model for that step.
  Omit it to use the resolved Worker's default. Precedence: `opts.model ??
  MARS_WORKER_MODEL` (Coder only) `?? the Worker's pinned model`.
- **Per-step Execution mode** — use `awaitHuman(ctx, { note })` to park a step
  for human review. It places the task `awaiting-human` with the Step guide
  visible in the action queue; `mars step done <id>` signals completion and the
  pipeline continues. `runAgent(ctx)` is always headless (auto); there is no
  `mode` option on `runAgent`. Example manual gate:
  ```js
  import { defineWorkflow, setupWorktree, runAgent, awaitHuman, review, merge } from 'mars/workflow'

  await ctx.step('qa', () =>
    awaitHuman(ctx, {
      note: 'Review the diff, run smoke tests, tick criteria, then mars step done.',
    }),
  )
  ```
  `setupWorktree` and `merge` are always auto and accept no `mode` option.
  `review` accepts `reviewType: 'auto' | 'manual' | 'full-review'` and an
  optional `guide: string`.
- Failures **THROW** — the engine records the step failed. Do not swallow.

## Steps as cordis plugins (advanced)

`ctx.container` is a real [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis)
`Context` — the same extension mechanism `mars/workflow` itself is built on
(see the primer linked from `ARCHITECTURE.md`). You never need it for the
five-primitive flow above, but a step (or your whole workflow body) MAY
register itself as a cordis plugin instead of a plain function, which buys
you three things for free: **declarative dependencies** (`inject`, gates
loading until every required service exists), **validated config**
(`Config`, a standard-schema — zod works out of the box) instead of hand
rolled option-bag checks, and **fiber lifecycle** — the plugin's own
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED transitions are republished
as `fiber.status` events on the same stream `ctx.emit` uses.

```js
import { defineWorkflow, setupWorktree, runAgent, review, merge, Context } from 'mars/workflow'
import { z } from 'zod'

export default defineWorkflow({
  id: 'task',
  async fn(ctx) {
    await ctx.step('setup', () => setupWorktree(ctx))
    await ctx.step('code', () => runAgent(ctx))

    // A step authored as a cordis plugin: `Config` validates the options bag
    // BEFORE `apply` ever runs (a bad config throws a ValidationError that
    // names the offending field, instead of a hand-rolled option check), and
    // disposing the fiber (e.g. when the run ends) runs whatever `ctx.effect`
    // registered, in reverse order — no manual cleanup. `inject` gates
    // loading on ordinary PROVIDED services only (see the note below on
    // `store`/`traceStore` — they're sealed accessors, not injectable).
    await ctx.step('verify', () =>
      ctx.container.plugin(
        {
          name: 'verify',
          Config: z.object({ reviewType: z.enum(['auto', 'manual', 'full-review']).optional() }),
          apply(pluginCtx, config) {
            pluginCtx.effect(() => {
              const t0 = Date.now()
              return () => pluginCtx.logger('verify').info('took %sms', Date.now() - t0)
            })
            return review(ctx, config)
          },
        },
        { reviewType: 'auto' },
      ),
    )

    return ctx.step('merge', () => merge(ctx))
  },
})
```

`store` and `traceStore` (ADR-0052) are SEALED — installed as cordis
**accessors**, not `provide`d services — so a plugin can read but never
re-provide, isolate, or reassign them, and `inject: ['store']` will never
resolve (cordis's dependency gate only watches provided services, not
accessors — a plugin that injects a sealed name stays PENDING forever). To
read the store from inside a plugin, use `ctx.get('store')` (the `WorkflowCtx`
helper above, not `ctx.container.get`, which is cordis's own method and skips
accessors by design) or a plain property read, `pluginCtx.store`, which — like
any Proxy-trapped property on a cordis `Context` — reaches the accessor fine.
`Context`, `Service`, `Plugin`, `Inject`, `Fiber`, `FiberState` and friends are
all importable from `mars/workflow` for this purpose.

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
| `task-workflow.js`    | `v5`           |
| `fix-workflow.js`     | `v3`           |
| `diagnose-workflow.js`| `v3`           |
| `write-workflow.js`   | `v3`           |
| `live-workflow.js`    | `v1`           |
| `runbook-workflow.js` | `v2`           |
| `report-workflow.js`  | `v5`           |
