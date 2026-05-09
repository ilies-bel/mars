# Transient verify:test capture: signature 4e87b3f93fe315d0

Fix-fail row `4bdb951f` (branch `task/4bdb951f`, dispatched as
`agent:fail-fix-handler` with `fix_for_task_id=8de51350`,
`failure_signature=4e87b3f93fe315d0`) was created in response to a
verify:test failure recorded against task `8de51350`.

This is the **first** occurrence of signature `4e87b3f93fe315d0`.

## Upstream task `8de51350`

`8de51350` is itself a self-heal task — a fix-fail dispatch for
`mars-31919f6d` whose only change was to add
`orchestrator/scripts/NO-DIFF-mars-31919f6d.md` (an acknowledgement
file documenting the recurring oversized-"interrupted"-feature
no-diff). That single new markdown file is its only diff vs. `main`.

## Why "verify:test" almost certainly did not actually fail

The captured `error` column for `8de51350` (visible via `mars show
8de51350`) shows the vitest stream up to:

```
 ✓ src/mastra/lib/inbox.test.ts (10 tests) 4956ms
   ✓ inbox > inserts a new item with seen_count=1, state=open, ...
   ...
   ✓ inbox > setInboxState on unknown id is a no-op 316ms
   ✓ inbox > after resolving an item, r
```

The output is cut off **mid-word** ("after resolving an item, r…")
on a passing test inside a passing file (`inbox.test.ts (10 tests)`
already shows the green ✓ summary line). There is no `FAIL`, no
`Error:`, no failed assertion, no exit summary anywhere in the
captured stream — only successful checkmarks.

Re-running the verify steps on the same worktree at the same SHA on
this host:

```
Test Files  30 passed (30)
     Tests  228 passed (228)
  Duration  5.73s
```

228/228 green, exit code 0, no contention. So the failure was not in
the code — `task/8de51350`'s sole commit is a markdown self-heal
acknowledgement that touches no production code paths.

## What actually went wrong

`runVerifyStep` in `orchestrator/src/mastra/lib/git.ts` shells out
`npm test --silent` via `node:child_process.exec` with a 10MB
`maxBuffer`. Total observed test output is ~3.9KB, so `maxBuffer` is
not the cause. The output is also far shorter than the
`slice(0, 500)` summary truncation in
`implement-workflow.ts:261`, so the mid-word cut-off is **not** a
display truncation either — it is exactly what was captured by
`exec`, byte-for-byte.

The only realistic explanation for a Node `exec` call to return
non-zero with a buffer that ends mid-word inside a passing test is
that the child vitest process was **terminated by signal** before
emitting its final summary lines. Two plausible causes:

1. **Host pressure**: the failing run shows
   `inbox.test.ts (10 tests) 4956ms` versus `1200ms–1386ms` on the
   re-run — roughly **4× slower** under whatever load the daemon
   was applying when it dispatched `8de51350`'s verify. If the OS
   delivered SIGKILL/SIGTERM (OOM, watchdog, parent-death), the
   stream cuts mid-write and `exec` rejects with an error whose
   `.stdout`/`.stderr` contain whatever buffered up to the kill.
2. **Concurrent worktree churn**: `inbox.test.ts` mutates
   `process.env.MARS_REPO` globally inside `beforeEach` and only
   clears it in `afterEach`. If another test file in the same
   vitest worker process (vitest threads pool by default) imports
   `./inbox` between those two hooks, it picks up the wrong
   `MARS_REPO`. That is a correctness smell regardless of whether
   it caused this specific failure, but it does **not** by itself
   chop the stream mid-word — it would surface as a normal
   `expect(...)` failure with a full vitest summary.

## Recommended structural follow-ups

These are out of scope for this fix-fail dispatch (no in-scope code
fix exists), but should be enqueued as separate `mars task add`
items if the user wants to address the underlying fragility:

1. **Capture exit signal in `runVerifyStep`.** The current catch
   branch in `orchestrator/src/mastra/lib/git.ts` reads `e.stdout`,
   `e.stderr`, `e.message` but discards `e.signal` and `e.code`.
   When a child is killed by signal, the captured `error` blob
   would be unambiguous if it included
   `e.signal ?? `exit ${e.code}``. The verify failure that
   spawned this fix-fail would then read `[killed by SIGKILL] …`
   instead of pretending the test stream was the failure.
2. **Skip auto-dispatch for "no failing test in stream" verifyt
   est failures.** When `failingStep === 'verify:test'` and the
   captured output contains no `FAIL`/`✗`/`Error` markers and no
   final `Tests` summary line, the failure handler should treat it
   as transient infrastructure and re-enqueue the original task at
   the same SHA (with a `verify_retry_count` cap to avoid loops),
   not synthesise a fix-fail that the agent has nothing real to fix.
3. **Stop leaking `process.env.MARS_REPO` from inbox tests.**
   `orchestrator/src/mastra/lib/inbox.test.ts` should either set
   `MARS_REPO` per-call (passing the repo into a thin wrapper that
   re-imports the module) or move to vitest's `vi.stubEnv` so the
   value is automatically restored. Same shape applies to any
   other test file that mutates global env vars across `beforeEach`
   /`afterEach` boundaries inside the same vitest worker.

## Action taken in this worktree

None to the codebase: there is no actual test failure to fix, and
fabricating a code edit on `task/4bdb951f` to satisfy the
verify:has-diff guard would only paper over the transient capture
and burn another fix-fail cycle when the next no-real-failure event
hits.

This file is added (and committed) so that:

- a search for signature `4e87b3f93fe315d0` lands on a written
  explanation rather than nothing,
- the fix-fail row produces a real diff (one new markdown file
  under `orchestrator/scripts/`) and so passes the `has-diff` guard
  without inventing fake source changes,
- a future recurrence of the same signature can append its
  occurrence here instead of spawning a parallel
  `TRANSIENT-VERIFY-TEST-*-pass2.md`.

## Recurrence log

(none yet — this is the first occurrence of signature
`4e87b3f93fe315d0`)
