# Context — mars-fc44af04 (pre-run blocker snapshot + short-circuit to blocked before verify)

mars-fc44af04 aborted with `too_hard:no-action-after-reads`. Read trail:

1. Read `orchestrator/src/mastra/workflows/implement-workflow.ts`
2. Grep `orchestrator/src/mastra/queue.ts`
3. Read `orchestrator/src/mastra/queue.ts`
4. Grep `isTooHardAbortError|isBlockersAbortError|TOO_HARD_ABORT_MESSAGE|isSelfUnblock`
5. Grep `orchestrator/src/mastra/daemon/server.ts`

The agent had every primitive it needed but did not commit to a shape. This
note pins the design so the next dispatch can go straight to test → code.

## What the slice must do

Slice 2 of PRD `8f53c9eb-clarify-blocked-by-directionality-in-mar`. Before
`codeStep`'s agent invocation, snapshot the task's *unresolved* blockers.
After the agent returns, recompute the unresolved-blocker set. If a blocker
exists in the post-run set that was NOT in the pre-run set, park the task
in `blocked` and short-circuit so verify+merge are skipped.

This catches the case where the coder runs `mars task add --blocked-by
$TASK_ID` (a self-unblock) and exits with partial work: verifying that
partial work would either falsely pass or generate a noisy verify failure,
when the right move is to wait for the new blocker to resolve and re-run
the whole task.

## Primitives that already exist (do NOT reinvent)

In `orchestrator/src/mastra/queue.ts`:

- `listBlockers(taskId): Promise<string[]>` — returns blocker task ids
  whose status is **not `done`**. This is the "unresolved blockers" set.
  Already filters resolved blockers out, so a diff of two `listBlockers`
  results IS the diff of unresolved blockers. Use this for both the
  pre-run snapshot and the post-run recompute.
- `hasIncompleteBlockers(taskId): Promise<boolean>` — same predicate,
  used by `setupStep` already. Don't use it here; you need the id set,
  not just a boolean.
- `updateTask(taskId, { status: 'blocked', error, failedPhase: 'code' })`
  — the existing too-hard branch (codeStep lines 734-773) shows the
  exact shape. Follow it.

In `orchestrator/src/mastra/workflows/implement-workflow.ts`:

- `BLOCKERS_ABORT_MESSAGE` / `isBlockersAbortError` — for the pre-dispatch
  gate (setupStep). Not what you want; that path keeps the task `queued`.
- `TOO_HARD_ABORT_MESSAGE` / `isTooHardAbortError` — for read-span aborts.
  The dispatcher branches on this so it does NOT stamp `failed` over
  `blocked`. **Add a parallel pair for this slice** (see below).

## Where to put the snapshot and the diff

- **Snapshot** — at the top of `codeStep.execute`, after the
  `resumeRank > run-claude-code` short-circuit (lines 601-614) and
  before the worktree-clean step. Resume cases re-use a prior run's
  worktree and should not re-snapshot — the diff would be meaningless
  on resume. Hold the result in a local `const preRunBlockers = new
  Set(await listBlockers(inputData.taskId))`.

- **Diff + short-circuit** — after the agent returns, after `usage` /
  `recordSignals` (line ~729), and BEFORE the existing `tooHardTrip`
  branch at line 734. Order matters: if both the watcher tripped AND
  the agent added a blocker, the too-hard branch is the more specific
  diagnosis and should win. Either: place the new branch after the
  too-hard branch, or short-circuit only when `tooHardTrip === null`.

  ```ts
  const postRunBlockers = await listBlockers(inputData.taskId)
  const newlyAcquired = postRunBlockers.filter(
    (id) => !preRunBlockers.has(id),
  )
  if (newlyAcquired.length > 0) {
    // listBlockers already excludes resolved (done) blockers, so the
    // filtered list is exactly "newly acquired AND not yet resolved".
    await updateTask(inputData.taskId, {
      status: 'blocked',
      error: `acquired ${newlyAcquired.length} unresolved blocker(s) during code step: ${newlyAcquired.join(', ')}`,
      failedPhase: 'code',
    })
    throw new Error(BLOCKER_SHORT_CIRCUIT_MESSAGE(inputData.taskId))
  }
  ```

## New module exports to add at the top of implement-workflow.ts

Mirror the existing `TOO_HARD_ABORT_MESSAGE` / `isTooHardAbortError` pair.
Pick a sentinel string the dispatcher can key on:

```ts
export const BLOCKER_SHORT_CIRCUIT_MESSAGE = (taskId: string): string =>
  `task ${taskId} acquired a new blocker during run; parked in blocked (verify+merge skipped)`

export const isBlockerShortCircuitError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('acquired a new blocker during run; parked in blocked')
}
```

Then thread `isBlockerShortCircuitError` through the dispatcher
(`orchestrator/src/mastra/daemon/server.ts`) the same way
`isTooHardAbortError` is — so the generic failure-handler does NOT also
fire (which would stamp `failed` over `blocked` and double-enqueue a
recovery fix-task). Search the daemon for `isTooHardAbortError` and add a
sibling branch.

Also add `listBlockers` to the existing `queue` import block at the top
of implement-workflow.ts (lines 32-39).

## Why `listBlockers` is the right primitive for "resolved"

`listBlockers` SQL: `WHERE b.task_id = ? AND t.status != 'done'`. So a
blocker that was added during the run but resolved before the post-run
check (status='done') is filtered out of `postRunBlockers` automatically
— it will NOT appear in `newlyAcquired`. Acceptance criterion "a
newly-acquired blocker that is already resolved does not trigger the
short-circuit" falls out for free; no extra check needed.

## Acceptance criteria → test plan (TDD vertical slice)

Test against `codeStep` (or, if easier, a small extracted pure helper
`diffBlockerSets(pre, post)`). Mock at system boundaries only — the
worker (`getWorkerForTag`) and `updateTask`/`listBlockers` if you don't
want a real test DB. Prefer a real test DB if one exists in
`orchestrator/src/mastra/__tests__/` patterns.

One test per AC, RED → GREEN, in this order:

1. With no newly-acquired blocker, verify still runs (the workflow
   completes through to `verifyStep`, OR codeStep returns its normal
   output without throwing).
2. A blocker that was already in the pre-run snapshot does NOT trigger
   the short-circuit, even if it's still unresolved post-run.
3. A blocker added post-run that is unresolved → task ends `blocked`,
   verifyStep is not invoked.
4. A blocker added post-run that is already `done` → no short-circuit
   (validates the `listBlockers` filter does the right thing).
5. The short-circuit error is `isBlockerShortCircuitError`-detectable.

The pre-run snapshot capture (AC1) is exercised by every test that adds
a blocker mid-run; it does not need its own dedicated test.

## Verify command

From the project subdirectory:

```
cd orchestrator && npm run typecheck && npm test -- implement-workflow
```

(Match whatever script names exist in `orchestrator/package.json`; the
slice brief says `cd orchestrator && <verifyCmd>`.)

## Out of scope (do NOT pull in)

- Dispatcher-side wiring for `isBlockerShortCircuitError` past the
  daemon's `dispatch` catch — other slices in the PRD will extend the
  failure-handler / inbox.
- Changing `listBlockers` semantics.
- Touching `setupStep`'s existing `hasIncompleteBlockers` gate.
- Resume-path handling — the resume short-circuit at the top of
  `codeStep` already returns early before the snapshot logic runs.
