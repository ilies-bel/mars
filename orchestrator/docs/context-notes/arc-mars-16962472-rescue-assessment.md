# Rescue assessment — arc mars-16962472 (vega-supervisor timeout + progress events)

**Date:** 2026-08-18
**Failed task:** mars-16962472 (add wall-clock timeout and progress events to vega-supervisor merge step)
**First-principles recovery:** fix-d84249e6 (running — completing the rebase and re-running verify)
**Rescue task:** mars-d5b94622 (this task)

## What happened

`mars-16962472` was enqueued to fix a silent merge-lock hang observed on 2026-08-17
(task mars-e50bbc6e sat inside the vega-supervisor step for 6m 36s with zero events, holding
the merge lock throughout). The required changes were:

1. Wall-clock timeout on the vega-supervisor step (configurable via `MARS_VCS_SUPERVISOR_TIMEOUT_MS`,
   default 10 min), using an AbortController to actually kill the subprocess rather than merely
   racing a Promise.
2. Distinct failure signature `merge:vega-timeout` on expiry, with `vegaTimedOut: true` on
   `MergeResult`.
3. Progress events emitted from the merge worker through a new `onSupervisorEvent` callback, wired
   in `server.ts` to both `traceStore.record` and the phantom-task liveness tracker.

The previous coder completed a comprehensive implementation commit:

```
ff972718 fix(merge): timeout+progress for vega-supervisor step
```

This commit touched six files:
- `orchestrator/src/core/daemon/merge-worker.ts` — new `onSupervisorEvent` callback + wiring
- `orchestrator/src/core/daemon/server.ts` — wires callback to trace store + activity tracker
- `orchestrator/src/core/lib/git/__tests__/invoke-vcs-supervisor-timeout.test.ts` — 3 new tests
- `orchestrator/src/core/lib/git/merge.ts` — AbortController-based kill, `vegaTimedOut`, env-var config
- `orchestrator/src/workflows/primitives/__tests__/merge-vega-timeout.test.ts` — 4 new tests
- `orchestrator/src/workflows/primitives/index.ts` — maps `vegaTimedOut` → `merge:vega-timeout` signature

After completing the commit, the orchestrator attempted to rebase `task/mars-16962472` onto a
newer `main` tip. The rebase produced a conflict in `merge.ts`; the conflict was resolved
(no conflict markers remained) but the resolved file was not staged (`git add`), leaving the
rebase suspended. The verify step ran against the suspended state and failed.

The orchestrator created `fix-d84249e6` as a recovery task. The rescue-operator was dispatched
when `fix-d84249e6` was still `queued` with an `unknown/unclassified` failure signature (the
orchestrator could not classify the original `verify` failure into a known fix recipe).

## State at rescue time

By the time this rescue-operator ran, `fix-d84249e6` had already transitioned from `queued`
to `running`. It resolved the suspended rebase — the worktree is now clean:

```
$ git -C .mars/worktrees/mars-16962472 status
On branch task/mars-16962472
nothing to commit, working tree clean

$ git -C .mars/worktrees/mars-16962472 log --oneline -3
ff972718 fix(merge): timeout+progress for vega-supervisor step
93ac55ca feat(arc-verifier): route arc QA artefacts to marsStateDir/arc-qa/<originId>
97e7bbab feat(prompts): restructure composePrompt into stable prefix + task suffix
```

The arc is NOT dead-ended; it is actively resolving. The rescue-operator was spawned
pre-emptively based on snapshot state that was already stale when the task started.

## Arc status

| Task | Status | Notes |
|---|---|---|
| mars-16962472 | blocked | Blocked by fix-d84249e6 (confirmed edge); failed_phase=verify |
| fix-d84249e6 | running | Working in mars-16962472 worktree; rebase resolved; running verify |
| mars-d5b94622 | running | This rescue task |

## Verdict

**continue** — the worktree contains the complete, correct implementation (commit `ff972718`)
and fix-d84249e6 is already executing the continuation. There is no need to restart (which
would wipe a good six-file implementation) or supersede (the original approach is sound).
The arc will resolve on its own once fix-d84249e6 completes verify and merges.

The rescue-operator does not need to issue any `mars` command: `mars continue mars-16962472`
would be refused (the task is `blocked`, not `failed`, and has an in-flight recovery), and
`mars restart` would corrupt the running fix-d84249e6 session. The verdict records the
correct action name for bookkeeping purposes only.
