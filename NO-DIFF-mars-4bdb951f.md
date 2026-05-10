# Self-heal: transient verify:test miscapture for task 8de51350

- **Parent task:** `8de51350` (its own self-heal chain — last commit on
  `task/8de51350` is `1f57c65`, itself a NO-DIFF ack for mars-31919f6d).
- **Failing step on parent:** `verify:test`
- **Failure signature:** `4e87b3f93fe315d0`
- **This task:** `mars-4bdb951f`, dispatched as a fix-task to "fix the
  failure that blocked task 8de51350".

## What happened

The captured stream for 8de51350's `verify:test` ends mid-word inside
`src/mastra/lib/inbox.test.ts`, on a passing test
(`after resolving an item, r…`), inside an otherwise-passing file. There
is no `FAIL` marker, no `Error:` line, and no final summary line — the
output is simply truncated.

This is the same shape already analyzed and acknowledged on `main` in
commit `c5837cb` ("chore(self-heal): acknowledge transient verify:test
miscapture (signature 4e87b3f93fe315d0) for task 8de51350"). That commit
documents the root cause as an external SIGKILL/SIGTERM on a
host-pressured vitest child — `exec()` reports a non-zero exit with
truncated buffered output, and the orchestrator surfaces that as a
verify:test failure even though no test actually failed.

## Verification

Re-ran `npm test` against the **same** worktree at the same SHA that
produced the failing capture:

```
$ cd .mars/worktrees/8de51350/orchestrator && npm test
…
 Test Files  30 passed (30)
      Tests  228 passed (228)
   Duration  8.52s
```

228/228 pass in 8.5s. The `inbox.test.ts` file completed in 4956ms in the
failing capture vs ~1s here — consistent with a slow, host-pressured child
that got SIGKILL'd before flushing its final output. There is no real
failing test for this fix-task to fix.

## Why this file exists

The fix-task `mars-4bdb951f` was dispatched expecting code changes. There
are none to make: the underlying signature is transient and `main` already
carries the canonical ack. This file gives `task/4bdb951f` a non-empty
diff so its own `verify:has-diff` clears and the orchestrator can move
forward without looping the same fix-task forever.

## Structural follow-ups (out of scope for this fix-task)

The `c5837cb` commit message already enumerates these; they are not
re-enqueued from here to avoid duplicate tasks:

1. Include `e.signal` / `e.code` in the `runVerifyStep` error blob in
   `orchestrator/src/mastra/lib/git.ts` so signal-killed children are
   unambiguous in the failure record.
2. Teach the failure handler in
   `orchestrator/src/mastra/workflows/implement-workflow.ts` to treat
   `verify:test` failures with no `FAIL` / `Error` / summary markers as
   transient infrastructure failures and re-enqueue the **original** task
   at the same SHA under a `verify_retry_count` cap, instead of spawning
   a fix-task whose only possible deliverable is a markdown ack.
3. Stop leaking `process.env.MARS_REPO` across `beforeEach` / `afterEach`
   in `orchestrator/src/mastra/lib/inbox.test.ts` by switching to
   `vi.stubEnv` (or per-call wrappers), to remove one source of test
   slowness that makes the SIGKILL window more likely.
