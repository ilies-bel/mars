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

| Template                | Destination                      | Role                                            |
| ----------------------- | -------------------------------- | ----------------------------------------------- |
| `task-workflow.js`      | `.mars/workflows/task-workflow.js`     | Default end-to-end task pipeline (setup → code → verify → merge). |
| `fix-workflow.js`       | `.mars/workflows/fix-workflow.js`      | Recovery pipeline for a failed task (ADR-0040: one attempt, leaf). |
| `diagnose-workflow.js`  | `.mars/workflows/diagnose-workflow.js` | Read-only diagnosis of a stuck/failed task arc. |
| `write-workflow.js`     | `.mars/workflows/write-workflow.js`    | Structured-write pipeline (glossary / ADR / docs). |

This list is the single source of truth for `planWorkflowCopies` /
`scaffoldWorkflows` in `src/init/scaffold-workflows.ts`. Adding a template here
means adding the file to `templates/workflows/` and re-running the maintainer
bundle refresh (`npm run mars:bundle:refresh`).

## Module shape

Each template is a plain ES module that default-exports a workflow object:

```js
export default {
  id: 'task',
  async fn(ctx, input) {
    await ctx.step('setup', async () => { /* … */ })
    // native control flow is the source of truth; each durable unit is a step.
    return { /* output */ }
  },
}
```

- `id` — the workflow id (load-bearing trace-view label).
- `fn(ctx, input)` — the imperative body. `ctx.step(name, fn)` wraps each
  durable unit; durability is checkpoint-resume keyed on the run id.
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

Every scaffolded template carries the `// @mars-workflow-template:v1` marker on
its first line so tooling can recognise an unedited template.
