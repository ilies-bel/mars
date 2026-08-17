# Rescue assessment — arc mars-f67f6d7b

**Date:** 2026-08-17  
**Rescue task:** mars-8cacc2ec  
**Arc members:** mars-f67f6d7b (blocked), fix-0a9d24be (verifying at assessment time)

## What the original task did

Task `mars-f67f6d7b` added a 60-second watchdog to the PGLite backend
(`orchestrator/src/core/lib/db.ts`) so that any in-process query or
transaction still pending after the threshold rejects with a diagnostic
instead of silently hanging until the 20-minute verify gate kills the suite.
Commit `e60290b7` on branch `task/mars-f67f6d7b`.

A unit test (`db.watchdog.test.ts`) was also added: it mocks PGLite to
return a never-resolving promise, uses `vi.useFakeTimers()`, advances the
clock past the threshold, and asserts the rejection message names the SQL
and the timeout.

## Why it failed

The spec `verifyCmd` is:
```
cd orchestrator && npm run typecheck && npx vitest run src/core/lib
```

`npm run typecheck` passes (exit 0). `npx vitest run src/core/lib` **hangs
indefinitely with no output** — not even the `RUN v2.1.9` banner —
causing the verify gate to kill the process after 20 minutes.

**Key finding:** the same hang reproduces on `main` (without the task's
changes) and on the dedicated task worktree. This is a **pre-existing
environmental issue**, not caused by the watchdog commit. Possible root
causes: resource exhaustion (too many concurrent forks from parallel task
verify steps) or a vitest fork-pool initialisation hang under high system
load.

**Targeted runs work correctly.** Individual test files run fine:
```
npx vitest run src/core/lib/db.watchdog.test.ts → PASS (3) FAIL (0)
npx vitest run src/core/lib/db.test.ts          → PASS (34) FAIL (0)
npx vitest run src/core/lib/db.watchdog.test.ts src/core/lib/db.test.ts
                                                 → PASS (37) FAIL (0)
```

## State at assessment time

Recovery task `fix-0a9d24be` was in `verifying` state when this assessment
was written (updatedAt 2026-08-17T21:16:xx). It was attempting to verify
the same single commit under the same `verifyCmd`. Expected outcome: the
verify will time out again after ~20 minutes because the root cause
(vitest hanging on the directory filter under load) is unchanged.

## Action: **continue**

The watchdog implementation is correct and the code is in a clean,
committable state. The verify failure is environmental. The right path is
to let `fix-0a9d24be` settle (it will fail), then:

1. `mars continue mars-f67f6d7b` — resumes the original task on the
   existing worktree and branch.
2. The resumed coder should narrow the `verifyCmd` to the specific files
   touched by the commit rather than the whole `src/core/lib` directory:
   ```
   cd orchestrator && npm run typecheck \
     && npx vitest run src/core/lib/db.watchdog.test.ts \
                       src/core/lib/db.test.ts
   ```
   The task's structured `verifyCmd` field cannot be changed post-enqueue,
   but the coder can verify with the targeted command, confirm it passes,
   and note in the commit that the spec verifyCmd is known-hanging.

## Verification

```
root knip        : npm run knip            → exit 0
orchestrator tsc : npm run typecheck       → exit 0 (exit 0)
watchdog test    : npx vitest run src/core/lib/db.watchdog.test.ts
                                           → PASS (3) FAIL (0)
db tests         : npx vitest run src/core/lib/db.test.ts
                                           → PASS (34) FAIL (0)
combined target  : npx vitest run src/core/lib/db.watchdog.test.ts \
                                 src/core/lib/db.test.ts
                                           → PASS (37) FAIL (0)
full suite filter: npx vitest run src/core/lib
                                           → HANGS (pre-existing, also on main)
```
