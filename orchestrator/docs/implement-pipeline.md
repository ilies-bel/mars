# The `implement` pipeline (on `@mars/workflow`)

This documents the **implement** pipeline exactly as it runs after the
port off Mastra onto the in-house `@mars/workflow` engine — the real
`ctx.step` sequence, the branches, how resume works, and how failures
propagate. It describes what is in the code, not an idealized design.

Source: `orchestrator/src/workflows/implement-workflow.ts`,
dispatched from `orchestrator/src/mastra/daemon/server.ts`
(`dispatchImplement`), persisted via
`orchestrator/src/workflows/queue-workflow-store.ts`.

## Shape

The pipeline is **one imperative async function**, not a declarative
graph. It is exported as:

```ts
export const implementWorkflow = defineWorkflow<
  ImplementInput, ImplementOutput, ImplementServices
>({ id: 'implement', inputSchema, fn: async (ctx, input) => { … } })
```

Native TypeScript control flow is the source of truth. Each durable unit
is wrapped in `ctx.step(name, fn)`. The four step names are stable and
load-bearing — they key both checkpoint-resume and the (future) trace
view:

```
setup-worktree → run-claude-code → verify → merge
```

Branches (diagnose-Chore short-circuits, the never-merge-unverified path)
are plain `if` statements, not edges.

## How the daemon runs it

`dispatchImplement` calls:

```ts
const result = await runWorkflow(implementWorkflow, input, {
  store:    createQueueWorkflowStore(),   // run/step checkpoints in .mars/queue.db
  services: { store: taskStore },         // orchestrator TaskStore → ctx.services.store
  runId:    task.id,                       // ← makes `mars continue` resume
  logger:   makeWorkflowLogger(log),
  onEvent,
})
```

- **`runId: task.id`** is the whole resume mechanism. Re-dispatching the
  same task id re-enters `runWorkflow` with that run id; every step whose
  record is already `'completed'` short-circuits (returns its recorded
  output without re-running `fn`). There is **no `resumeFrom` hint** in
  the input — resume is entirely engine-driven.
- **`ctx.services.store`** replaces Mastra's
  `requestContext.get('taskStore')`. The composition root injects the
  `TaskStore`; steps read it from `ctx.services.store`.
- **`ctx.emit('claude-event' | 'vcs-supervisor-event', …)`** replaces the
  Mastra workflow `writer`. The daemon's `onEvent` drops these
  high-volume streams from the log; per-step transcripts (keyed by
  `claudeSessionId`) carry the detail.
- Mastra's `tracingContext.currentSpan` is gone; the engine's structured
  logger + per-step records replace it.

## The four steps

### 1. `setup-worktree` → returns `{ path, branch }`

1. `hasIncompleteBlockers(taskId)` → if true, **throw**
   `BLOCKERS_ABORT_MESSAGE` (a blocker landed between dispatch and run;
   the task stays queued).
2. `updateTask({ status: 'running' })`, `createWorktree`, persist
   `branch`/`worktreePath`, capture `integrationHeadSha`
   (`handle.setSha(headSha)`). Dirty-main detection runs dispatch-side
   in `runMainDirtyDispatchCheck` (daemon) before this step runs, and
   verify-side at the top of the verify step below — both routing
   through `spawnOrAttachMainCommitter` (signature `verify:main-dirty`).
   The legacy setup-time `checkSetupPreflight` backstop was retired in
   slice K.
3. `installWorktreeDeps`. On failure: `updateTask({ status:'failed',
   failedPhase:'code' })` + `handleTaskFailureWithFixTask`
   (`setup:install`) then **throw**. (`failedPhase:'code'` is the
   sentinel for non-resumable setup-time failures.)

The step returns `{ path, branch }`, so on resume those values come from
the engine's recorded step output — not a re-read of the DB row.

### 2. `run-claude-code` → returns `void`

1. `cleanWorktreeIfNoCommitsAhead` (best-effort; never fails dispatch).
2. `composePrompt(...)`; pick the Worker (`kind === 'fix' ? Fixer :
   pickWorkerForTags(tags, Workers)`). `pickWorkerForTags` intersects the
   task's tag list against each registered Worker's `config.tags` set; when
   no Worker claims a tag the **default headless Worker** (Coder,
   `bypassPermissions`, full tool surface) is used as the fallback.
3. Wire the read-span watcher when `shouldWireReadSpanWatcher(kind)`
   (every kind except `diagnose`). Stream events via
   `ctx.emit('claude-event', event)`; the watcher observes each.
4. **Read-span guard:** if the watcher tripped its threshold **and** the
   agent took zero actions all run, spawn one diagnose Chore, park the
   parent `blocked` with an edge to it, and **throw**
   `TOO_HARD_ABORT_MESSAGE`. (Spawn failure → `updateTask` failed +
   rethrow.)
5. `detectPostCoderState` logging; `summarizeUsage`; `recordSignals`;
   `upsertTranscript` (gated on `!isReflectDisabled()`);
   `updateTask({ claudeSessionId })`. The transcript key is recorded on
   the step record via `handle.setTranscriptKey(r.sessionId)` — the full
   transcript is referenced by key, never inlined.

### 3. `verify` → returns `{ verified: true }` or **throws**

1. **Diagnose-Chore short-circuit:** `kind === 'diagnose'` returns
   `{ verified: true }` immediately (a Chore produces no committable
   artefact).
2. `updateTask({ status:'verifying', failedPhase:null })`.
3. Scope-aware verify: `loadVerifyScopes` → `getChangedFiles` →
   `selectVerifySteps` → `verifyChanges`. Persist `verifyOutput` to the
   transcript (gated on reflect).
4. On `!r.passed`: `updateTask({ status:'failed', failedPhase:'verify'
   })` + `handleTaskFailureWithFixTask` (`verify:<firstFailedName>`, with
   `ranVerifySteps` for an accurate reproduce hint), then **throw**.

Because a failed verify throws, `merge` never runs on unverified work —
there is no `{ verified:false }` flag passed forward anymore.

### 4. `merge` → returns `ImplementOutput` `{ taskId, success, message }`

1. **Diagnose-Chore short-circuit:** `removeWorktree` + `updateTask({
   status:'done' })`; the verdict-driven follow-up runs from the
   daemon's `task.completed` branch.
2. `updateTask({ status:'merging', failedPhase:null })`.
3. `checkMergeTargetStatus`:
   - `needs-rebase` → falls through (recoverable; `mergeBranch` rebases
     before the `--ff-only`).
   - `dirty` → `updateTask` failed + handler + **throw**.
   - `error` → `updateTask` failed + **throw**.
4. **Template-leakage preflight:** `getChangedFiles` + `detectTemplatePaths`;
   any diff to `init/templates/**` → `updateTask` failed + handler +
   **throw**.
5. `mergeBranch` with `onVegaStart` (→ `vega-reconciling`) and
   `onSupervisorEvent` (→ `ctx.emit('vcs-supervisor-event')`). Supervisor
   usage → `recordSignals`. `m.aborted` → `updateTask` failed + handler +
   **throw**.
6. Success → `removeWorktree` + `updateTask({ status:'done',
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
keeps three suppressions for failures that are *expected* terminal-but-
not-really-failed states (the task is already parked `blocked` with a
real edge):

| Predicate | Sentinel | Meaning |
|---|---|---|
| `isBlockersAbortError` | `BLOCKERS_ABORT_MESSAGE` | blocker landed between dispatch and run; stays queued |
| `isMainDirtyVerifyError` | `verify:main-dirty` | integration branch dirty at verify; parked behind `main-commiter` recovery |
| `isTooHardAbortError` | `TOO_HARD_ABORT_MESSAGE` | read-span guard tripped; diagnose Chore spawned as blocker |

On any other failure the daemon emits `task.failed`; on success/other it
emits `task.completed` with the run status. `errorHaystack` still walks
the `cause` chain so a wrapped sentinel is still recognised.

## Resume (`mars continue`)

There is no longer a `resumeFrom` hint anywhere. Resume is purely the
engine's checkpoint-resume keyed on `runId = task.id`:

- `coreContinueTask` re-queues a `failed` task with
  `updateTask({ status:'queued', error:null })` — no resume hint.
- When the daemon re-dispatches it, `runWorkflow` runs with
  `runId: task.id`; steps already recorded `'completed'` (setup, code,
  maybe verify) short-circuit and the run re-enters at the first
  non-completed step.
- `failedPhase` is **retained** as a column. It no longer drives a
  resume hint, but it still:
  - drives `coreContinueTask`'s pre-setup/degraded-to-restart decision
    (`failedPhase === null | 'code'`, or missing worktree → degrade to a
    clean restart);
  - records which phase failed for operator display.

## What this port removed (hard cuts)

- **Mastra** for the implement pipeline: `createStep`/`createWorkflow`/
  `.then`/`.commit`, `run.start`, `RequestContext`, `tracingContext`,
  `writer`. (The other five pipelines — triage, slice, plan, init,
  ab-experiment — still run on Mastra; `implementWorkflow` is no longer
  registered in the Mastra `workflows` registry.)
- **`resumeFrom` / `resumeRank` / `STEP_ORDER`**: deleted from source.
  The `resume_from` DB column is left in place as legacy (no migration)
  but is never read or written.
- **The `verifyPassed` / `mergeClean` scorers**: deleted entirely
  (unused). Removed from `index.ts`; the `mastra_scorers` read path in
  `reflect-query.ts` is gone (`loadScoresForTasks` returns an empty map).

## Persistence

`createQueueWorkflowStore()` implements the engine's `WorkflowStore`
against the orchestrator's libsql client, creating
`workflow_runs` and `workflow_step_runs` (`CREATE TABLE IF NOT EXISTS`)
in `.mars/queue.db`. The per-step record is lean — status, SHA,
timestamps, attempt count, a compact summary, and the transcript key —
and is the single row that serves both resume and the trace view.

## Authoring model

The engine is **imperative**: a workflow is a plain async TypeScript function
and `ctx.step(name, fn)` wraps each durable unit. There is no declarative
DAG, no `defineStep({ deps })`, and no linear `.then` composition surface.
Two draft ADRs that proposed those discarded designs (DAG step model and
linear `.then` v1 composition) were never built and have been removed.
This document is the authoritative description of the `implement` pipeline
as built.
