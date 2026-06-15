# The `implement` pipeline (on `@mars/workflow`)

This documents the **implement** pipeline as it runs on the in-house
`@mars/workflow` engine — the real `ctx.step` sequence, how the four
**step primitives** compose, how resume works, and how failures
propagate. It describes what is in the code, not an idealized design.

Source: `orchestrator/src/workflows/implement-workflow.ts` (the bundled
fallback / canonical example), the four primitives in
`orchestrator/src/workflows/primitives/index.ts`, dispatched from
`orchestrator/src/core/daemon/server.ts`, persisted via
`orchestrator/src/workflows/queue-workflow-store.ts`.

## Two seams

Authoring a workflow touches two things, both behind the single
`mars/workflow` import surface (`orchestrator/src/workflows/authoring.ts`):

- the domain-agnostic **engine** — `defineWorkflow`, `ctx.step`,
  `ctx.input`, `ctx.emit`, `ctx.services` (`@mars/workflow`);
- the Mars **domain primitives** — `setupWorktree`, `runAgent`, `verify`,
  `merge`, each `(ctx, opts?)` (`./primitives`).

A scaffolded `.mars/workflows/<kind>-workflow.js` (ADR-0056) imports both
from `mars/workflow` and never sees the plumbing.

## Shape

The pipeline is **one imperative async function**, not a declarative
graph. The bundled fallback is exported as:

```ts
export const implementWorkflow = defineWorkflow<
  ImplementInput, ImplementOutput, MarsServices
>({ id: 'implement', inputSchema: implementInputSchema, fn: async (ctx) => { … } })
```

Native TypeScript control flow is the source of truth. Each durable unit
is wrapped in `ctx.step(name, fn)`. The four bundled step names are stable
and load-bearing — they key both checkpoint-resume and the trace-view node
label:

```
setup-worktree → run-claude-code → verify → merge
```

The whole bundled body is just four primitive calls:

```ts
fn: async (ctx): Promise<ImplementOutput> => {
  await ctx.step('setup-worktree', () => setupWorktree(ctx))
  await ctx.step('run-claude-code', () => runAgent(ctx))
  await ctx.step('verify', () => verifyPrimitive(ctx))
  return await ctx.step('merge', () => mergePrimitive(ctx))
}
```

Each primitive defaults every option from `ctx.input` (see below), so the
calls are bare `primitive(ctx)`. Scaffolded `.mars/workflows/*.js` files
use the same form (with their own step names, e.g. `setup`/`code`).

## `ctx.input` and the options precedence

`runWorkflow` parses the dispatch input (through `inputSchema` if present)
and publishes it on **`ctx.input`** — the same object handed to `fn` as
its second argument. Every primitive reads its options with the precedence:

```
opts.field  ??  ctx.input.field  ??  hard default
```

So `runAgent(ctx)` pulls `prompt` from `ctx.input.prompt`, `kind` from
`ctx.input.kind`, and so on; an explicit `runAgent(ctx, { model })` only
**overrides** the model and leaves the rest defaulting. The author never
copies fields out of an `input` argument into each call — there is no
`input` argument in the terse form. `MarsWorkflowInput`
(`primitives/index.ts`) is the dispatch-fact shape these reads expect; the
bundled `ImplementInput` is structurally a subtype of it.

## How the daemon runs it

`dispatchImplement` (in `server.ts`) resolves the workflow for the task's
kind — a user-owned `.mars/workflows/<kind>-workflow.js` wins over the
bundled fallback (`loadWorkflowForKind`) — then calls:

```ts
const result = await runWorkflow(workflowToRun, input, {
  store:    createQueueWorkflowStore(),        // run/step checkpoints in .mars/mars.db
  services: { store: taskStore, traceStore },  // → ctx.services
  runId:    task.id,                            // ← makes `mars continue` resume
  logger:   makeWorkflowLogger(log),
  onEvent,
})
```

- **`runId: task.id`** is the whole resume mechanism. Re-dispatching the
  same task id re-enters `runWorkflow` with that run id; every step whose
  record is already `'completed'` short-circuits (returns its recorded
  output without re-running `fn`). There is **no `resumeFrom` hint** in
  the input — resume is entirely engine-driven.
- **`ctx.services`** is typed `MarsServices` = `{ store, traceStore }`.
  Primitives read `ctx.services.store` (the Arc-backed `TaskStore`, the
  sole task-state write funnel, ADR-0052) and `ctx.services.traceStore`
  (spans/events; resolved once per run and memoised on `ctx`). The author
  never constructs these — they are injected by the composition root.
- **`ctx.emit('claude-event' | 'vcs-supervisor-event', …)`** carries the
  high-volume agent/Vega streams. The primitives wire these internally
  (`runAgent` emits `claude-event`, `merge` emits `vcs-supervisor-event`);
  the daemon's `onEvent` drops them from the log, and per-step transcripts
  (keyed by `claudeSessionId`) carry the detail.

## The four primitives

Each primitive resolves its dispatch facts (`taskId`, `integrationBranch`,
`kind`, …) via the precedence above, pulls plumbing
(`store`/`trace`/`worktree`/`emit`/`handle`) off `ctx`, and wraps its work
in a trace span. `setupWorktree` memoises the worktree ref on `ctx` so
`verify`/`merge` read it implicitly (an explicit `opts.worktree`
overrides).

### 1. `setupWorktree` → returns `{ path, branch }`

1. `hasIncompleteBlockers(taskId)` → if true, **throw**
   `BLOCKERS_ABORT_MESSAGE` (a blocker landed between dispatch and run;
   the task stays queued).
2. `updateTask({ status: 'running' })`. For a `kind:'fix'` recovery that
   attaches to its origin (`recoveryAttachesToOrigin`), **attach** to the
   origin's existing worktree+branch (via `fixForTaskId`); a missing origin
   worktree stamps the fix failed, raises an operator action-queue item,
   and **throws** `ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE`. Otherwise
   **create** a fresh `task/<id>` worktree off `integrationBranch`.
3. Persist `branch`/`worktreePath`; capture `integrationHeadSha`
   (`ctx.currentStep?.setSha(headSha)`, non-fatal).
4. `installWorktreeDeps`. On a frozen-install failure, attempt an in-place
   lockfile repair first; only if that fails, `updateTask({ status:'failed',
   failedPhase:'code' })` + `handleTaskFailureWithFixTask` (`setup:install`)
   then **throw**. (`failedPhase:'code'` is the sentinel for non-resumable
   setup-time failures.)

The step returns `{ path, branch }`, so on resume those values come from
the engine's recorded step output. Dirty-main detection does **not** run
here — it runs dispatch-side (daemon) and verify-side (below).

### 2. `runAgent` → returns `{ sessionId }`

1. `cleanWorktreeIfNoCommitsAhead` (best-effort; never fails dispatch).
2. `composePrompt(...)`; pick the Worker: `kind === 'fix' ? Fixer :
   pickWorkerForTags(tags, allWorkers)`. `pickWorkerForTags` intersects the
   task's tags against each registered Worker's `config.tags` (including
   operator-declared registry Workers); when no Worker claims a tag the
   default headless Coder (`bypassPermissions`, full tool surface) is the
   fallback.
3. **Per-step model override:** if `opts.model` differs from the resolved
   Worker's pinned model, rebuild the Worker via
   `createWorker({ ...config, model })` — threads to both the headless and
   pty spawn paths. Omit `model` to use the Worker's default (precedence:
   `opts.model ?? MARS_WORKER_MODEL` (Coder only) `?? Worker default`).
4. Run the worker span; stream events via `ctx.emit('claude-event', …)`.
5. **Context-budget hard abort:** `exitCode === 138` + stderr
   `"context budget exhausted"` → `updateTask({ status:'failed',
   failureReason:'context-exhausted' })` + `handleTaskFailureWithFixTask`
   (`code:context-exhausted`, the worktree holds in-progress work to
   resume) then **throw** `CONTEXT_EXHAUSTED_ABORT_MESSAGE`. A non-zero
   coder exit (other than 138) throws `CODER_EXIT_NONZERO_ABORT_MESSAGE`
   rather than merging an empty diff as a false success.
6. `detectPostCoderState` logging; `summarizeUsage`; `recordSignals`
   (gated on `!isReflectDisabled()`); `updateTask({ claudeSessionId })`.
   The transcript key is recorded on the step record via
   `ctx.currentStep?.setTranscriptKey(r.sessionId)` — referenced by key,
   never inlined.

### 3. `verify` → returns `{ verified: true }` or **throws**

1. **Diagnose short-circuit:** `kind === 'diagnose'` returns
   `{ verified: true }` immediately (no committable artefact).
2. **Verify-time dirty-main check (non-fix only):** if the integration
   branch is dirty, park behind a `main-commiter` recovery
   (`spawnOrAttachMainCommitter`) and **throw** the `verify:main-dirty`
   sentinel.
3. `updateTask({ status:'verifying', failedPhase:null })`.
4. Scope-aware verify: `loadVerifyScopes` → `getChangedFiles` →
   `selectVerifySteps` → `verifyChanges` (a main-commiter recovery skips
   all test/typecheck/lint steps). The has-diff / commits-ahead gate always
   runs. Persist `verifyOutput` (gated on reflect).
5. On `!r.passed`: `updateTask({ status:'failed', failedPhase:'verify' })`
   + `handleTaskFailureWithFixTask` (`verify:<firstFailedName>`, with
   `ranVerifySteps` for an accurate reproduce hint), then **throw**.

Because a failed verify throws, `merge` never runs on unverified work —
there is no `{ verified:false }` flag passed forward.

### 4. `merge` → returns `ImplementOutput` `{ taskId, success, message }`

1. **Diagnose short-circuit:** `removeWorktree` + `updateTask({
   status:'done' })`; the verdict-driven follow-up runs from the daemon's
   `task.completed` branch.
2. `updateTask({ status:'merging', failedPhase:null })`.
3. `checkMergeTargetStatus`:
   - `needs-rebase` → falls through (recoverable; `mergeBranch` rebases
     before the `--ff-only`).
   - `dirty` → `updateTask` failed + handler + **throw**.
   - `error` → `updateTask` failed + **throw**.
4. `mergeBranch` with `onVegaStart` (→ `vega-reconciling`) and
   `onSupervisorEvent` (→ `ctx.emit('vcs-supervisor-event')`). Supervisor
   usage → `recordSignals`. `m.aborted` → `updateTask` failed + handler +
   **throw**.
5. Success → `removeWorktree` + `updateTask({ status:'done',
   failedPhase:null })`; return `{ success:true, message }`.

The outer `try/catch` stamps any genuinely-unhandled `mergeBranch` throw
as a crash (`updateTask` failed + handler + **throw**) so the row never
strands at `merging`.

## Failure model: steps throw

Every terminal failure does its self-heal side-effects **and then
throws**. The engine records that step `status:'failed'` and
`runWorkflow` returns `{ status:'failed', error }` with the Error
verbatim on `result.error`.

The daemon reads `result.status === 'failed' ? result.error : null` and
keeps four suppressions for failures that are *expected* terminal-but-
not-really-failed states (the task is already parked `blocked`/`queued`
with a real edge or operator item):

| Predicate | Sentinel | Meaning |
|---|---|---|
| `isBlockersAbortError` | `BLOCKERS_ABORT_MESSAGE` | blocker landed between dispatch and run; stays queued |
| `isMainDirtyVerifyError` | `verify:main-dirty` | integration branch dirty at verify; parked behind `main-commiter` recovery |
| `isContextExhaustedAbortError` | `CONTEXT_EXHAUSTED_ABORT_MESSAGE` | coder hit the context token budget; resume fix-task spawned |
| `isOriginWorktreeMissingAbortError` | `ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE` | a recovery's origin worktree is gone; operator action-queue item raised |

On any other failure the daemon emits `task.failed`; on success it emits
`task.completed` with the run status. `errorHaystack` walks the `cause`
chain so a wrapped sentinel is still recognised.

## Resume (`mars continue`)

There is no `resumeFrom` hint anywhere. Resume is purely the engine's
checkpoint-resume keyed on `runId = task.id`:

- `coreContinueTask` re-queues a `failed` task with
  `updateTask({ status:'queued', error:null })` — no resume hint.
- When the daemon re-dispatches it, `runWorkflow` runs with
  `runId: task.id`; steps already recorded `'completed'` (setup, code,
  maybe verify) short-circuit and the run re-enters at the first
  non-completed step.
- `failedPhase` is **retained** as a column. It no longer drives a resume
  hint, but it still drives `coreContinueTask`'s
  pre-setup/degraded-to-restart decision (`failedPhase === null | 'code'`,
  or missing worktree → degrade to a clean restart) and records which
  phase failed for operator display.

## Persistence

`createQueueWorkflowStore()` implements the engine's `WorkflowStore`
against the orchestrator's libsql client, creating `workflow_runs` and
`workflow_step_runs` (`CREATE TABLE IF NOT EXISTS`) in the consolidated
`.mars/mars.db`. The per-step record is lean — status, SHA, timestamps,
attempt count, a compact summary, and the transcript key — and is the
single row that serves both resume and the trace view.

## Authoring model

The engine is **imperative**: a workflow is a plain async TypeScript (or
plain-JS, in `.mars/workflows/`) function, and `ctx.step(name, fn)` wraps
each durable unit. There is no declarative DAG, no `defineStep({ deps })`,
no `{ id, kind, steps }` config object, and no linear `.then` composition
surface. A custom workflow composes the four engine step primitives and
writes task state **only** through the injected `ctx.services.store`, so
the no-stranded-entity invariant (ADR-0052) holds for custom flows too.

This document is the authoritative description of the `implement` pipeline
as built. The canonical worked example is `implement-workflow.ts`; the
scaffolded consumer templates live in
`orchestrator/src/init/templates/workflows/` (contract:
`workflow-contract.md`).
