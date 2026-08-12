# Rescue assessment — arc 6bad3849-make-verification-exit-code-faithful

**Date:** 2026-08-12  
**Rescue task:** mars-fe80a510  
**Failed task:** mars-c2e06166 (Slice 5 — shared contract: verify.ts)  
**Recovery task:** fix-a0166e1d (running)

## What happened

`mars-c2e06166` was auto-failed by the phantom-task watchdog (`reason: dead-pid`,
`observation: worker PID 95185 was not alive when checked`, task age: 1 min). The
failure was a transient infrastructure event — the worker process exited before the
watchdog's next liveness check, not a code or logic failure.

## State at rescue time

The task had **already completed its work** before the watchdog fired:

```
2ce3ccbf feat(verify): add verifyCmd execution and commandLine to VerifyStep
cac3486f feat(primitives): complete shared contract for verify exit-code slices
e4c30956 feat(primitives): add shared contract for exit-code and verifyCmd slices
```

All three commits landed on `main` (confirmed: `HEAD` of both
`task/mars-c2e06166` and `main` resolved to the same SHA at assessment time,
then `main` advanced to `2ce3ccbf` which is the third commit in the list).

The acceptance criterion — "orchestrator/src/core/lib/git/verify.ts contains
all changes required by the 2 consumer slices" — was met.

## Arc status

| Task | Status | Notes |
|------|--------|-------|
| mars-c2e06166 | done | work merged to main before watchdog fired |
| fix-a0166e1d | running | recovery task; will find work already complete |
| mars-4e771675 | running | unblocked, consuming shared contract |
| mars-ddf6f12c | blocked | waiting on mars-4e771675 |
| mars-f65e20f9 | blocked | waiting on mars-4e771675 + mars-ddf6f12c |
| mars-508579d7 | done | |

## Verdict

**supersede** — the arc recovered itself. No restart or continue intervention
required. The phantom-watchdog failure did not corrupt any work; the shared
contract is on `main` and downstream slices are progressing normally.

## knip check

`npm run knip` exits 0. `buildSpecVerifyCmdStep` at
`src/workflows/primitives/index.ts:2166` appears as an unused export because
the consuming slices (mars-4e771675, mars-ddf6f12c) are still in progress;
this is expected and will be resolved when those slices merge.
