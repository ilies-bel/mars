# Rescue assessment — arc aa29edd9-bound-code-retries (slice 2 test failures)

**Date:** 2026-08-18
**Failed task:** mars-209ca1ec (bound runAgent to one transient-exit retry)
**First-principles recovery:** fix-ed3bb569
**Rescue task:** mars-3695189c (this task)

## What happened

`mars-209ca1ec` was slice 2 of PRD `aa29edd9-bound-code-retries` (Bound code retries). Its
goal was to wrap the coder-invocation block in `orchestrator/src/tools/coder/run-agent.ts` in
an at-most-two-attempts loop keyed off the classifier added in slice 1, emit a `code-retry-attempt`
trace event on the retry, and add tests covering the 5 specified scenarios.

The coder landed one commit:

```
38b3c761 feat(code-retry): bound runAgent to one transient-exit retry
```

This commit added:
- `orchestrator/src/workflows/__tests__/code-retry-transient.test.ts` — new test file (378 lines)
- `orchestrator/src/workflows/primitives/index.ts` — retry loop implementation (+109 / -33 lines)
- `orchestrator/src/core/lib/trace-events-store.ts` — minor addition (+1 line)

Verify failed with test assertion errors in `implement-workflow.test.ts`:

```
src/workflows/__tests__/implement-workflow.test.ts:1184:17
  expect(out).toContain('## Resume prior work')
```

Five tests failed. The failures arose because `composePrompt` was restructured in a prior commit
(`97e7bbab feat(prompts): restructure composePrompt into stable prefix + task suffix`) and the
existing test expectations about banner ordering had not been updated to match the new structure.

## Recovery

`fix-ed3bb569` was spawned as the first-principles recovery task. It operated on the same
worktree and branch (`task/mars-209ca1ec`). By the time the rescue-operator was dispatched, the
fix task had already completed its work and was in the "merging" state. The merge succeeded:

```
08cf2c61 feat(code-retry): bound runAgent to one transient-exit retry
```

is now on `main`. `mars-209ca1ec` transitioned to `done` at 2026-08-18T07:44:58Z.
The immediate dependent `mars-c2f7fa9c` (slice 3 — workflow validation + typecheck) was
unblocked and is now running.

## State at rescue time

| Task | Status | Notes |
|---|---|---|
| mars-209ca1ec | done | Merged via fix-ed3bb569 |
| fix-ed3bb569 | done | Merged at 07:44:53Z |
| mars-c2f7fa9c | running | Unblocked, running slice 3 |
| mars-3695189c | running | This rescue task |

The arc is NOT dead-ended. The rescue-operator was spawned based on a snapshot taken when
`fix-ed3bb569` was queued with failure signature `unknown/test-assertion-error`, but by
execution time the fix had already succeeded.

## Verdict

**continue** — the arc self-resolved. No `mars` command is required. The implementation
commit is on `main`; the downstream slice (`mars-c2f7fa9c`) is running. There is no need to
restart (the implementation is complete and correct) or supersede (the fix task already
finished the work).
