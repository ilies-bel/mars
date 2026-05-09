# No-diff acknowledgment: mars-00cc790e

Task `mars-00cc790e` ("Mark daemon-restart casualties as 'interrupted'
and retry once, instead of failing them and triggering re-enqueue
storms.", branch `task/mars-00cc790e`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

The branch sits at zero commits ahead of `main`. This is the original
feature task itself, dispatched against the reflection idea
`b1f97480`, and the agent produced no commit on its single pass under
the new `MARS_CLAUDE_MAX_MESSAGES=100` cap (commit `2242e1f`).

## Why there is no diff

The acceptance criteria are implementable — the bug is real and well
diagnosed: `orchestrator/src/mastra/daemon/server.ts:738-747` already
classifies stuck `running`/`verifying`/`merging` rows as `failed` on
daemon boot, and 6 of 10 tasks in the recent reflect corpus carry
`errorTail='daemon restart while task was running'` with `$0` cost. The
problem is **shape**, not feasibility: the prompt asks one `claude -p`
session to deliver, in a single dispatch, a change that spans five
loosely-coupled surfaces:

1. **TaskStatus type widening + cross-file audit.** Add `'interrupted'`
   to the union at `orchestrator/src/mastra/queue.ts:6-16`, then audit
   every string-literal status check and every
   `ReadonlySet<Task['status']>` declaration across the orchestrator.
   The prompt itself enumerates seven distinct sites that must each be
   reasoned about explicitly: `sweeper/server.ts:103` (IN_FLIGHT),
   `sweeper/server.ts:110` (TERMINAL), `worktree-clean.ts:76`,
   `deep-reflect-query.ts:79`, `reflect-query.ts:184`,
   `daemon/server.ts:253`, `daemon/server.ts:573`, `daemon/server.ts:603`.
   Each site requires a yes/no/skip decision with no template; the
   prompt's "Default: 'interrupted' is NOT failed, NOT done, NOT
   in-flight" note is a default, not a closed-form answer.
2. **Idempotent schema migration.** Add a `retry_count INTEGER NOT NULL
   DEFAULT 0` column via a guarded `ALTER TABLE tasks` that swallows
   "duplicate column" errors on existing DBs. Requires picking the
   right LibSQL error-shape match (string vs code), and a fixture test
   that runs the migration twice on the same DB.
3. **Reconcile-loop rewrite at `daemon/server.ts:738-747`.** Change the
   in-place mutation from `status='failed'` to `status='interrupted'`
   while preserving the `error` string verbatim, then in the same pass
   transition each `interrupted` row back to `queued` exactly once
   (gated on `retry_count`), bumping `retry_count` to 1 and emitting
   `bus.emit('task.queued', { taskId })` so dispatch picks it up. On
   second hit, give up to `failed` while preserving the original error.
4. **Sweeper desync skip path.** In `sweeper/server.ts` (~lines
   230-260), when a worktree branch is on disk for a task whose status
   is `interrupted`, skip the self-heal enqueue and log
   `[sweeper] task ${taskId} interrupted; awaiting retry`.
5. **Four new tests** covering reconcile-with-retry-count-0, 
   reconcile-with-retry-count-1, sweeper-skip-on-interrupted, and the
   migration idempotency check — under
   `orchestrator/src/mastra/lib/__tests__/` or `daemon/__tests__/`,
   with realistic LibSQL fixtures and bus-spy assertions.

That is roughly 8–10 changed files across queue, daemon reconcile,
sweeper desync, three reflect/worktree-clean read paths, plus a new
test file with four cases that each need a live LibSQL DB. Well above
the working budget of one headless dispatch under the new 100-message
cap, especially because the cross-file audit in (1) requires opening
each of seven call sites before the actual mutation in (2)–(4) starts.

## Why this fix-fail task is itself a no-op (in code)

Splitting `mars-00cc790e` into smaller Mars tasks is a **planning**
action — it belongs in the `mars task add` queue, not in this
worktree's diff. The block-tracked-writes hook also forbids touching
`CONTEXT.md` / `docs/adr/**` directly from a coding worktree, so the
only correct on-disk artifact for this fix-fail row is this
acknowledgment.

The follow-up tasks below are the recommended split. They are not
enqueued by this commit; the daemon ack flow will surface this row to
the human operator, who can decide whether to enqueue them as written
or re-shape further before adding them via `mars task add`.

## Recommended split

Slice the original spec into three ordered tasks. Each is small enough
to fit one `claude -p` dispatch under the 100-message cap and verifies
independently.

1. **Add the `interrupted` TaskStatus variant + idempotent retry_count
   column.** Touch only `orchestrator/src/mastra/queue.ts` (union
   widening + the `ALTER TABLE tasks ADD COLUMN retry_count` guarded
   migration in the same module that owns the schema bootstrap). Then
   make the *mechanical* cross-file audit pass: at every string-literal
   status check and `ReadonlySet<Task['status']>` site listed in the
   original prompt (`sweeper/server.ts:103/110`,
   `worktree-clean.ts:76`, `deep-reflect-query.ts:79`,
   `reflect-query.ts:184`, `daemon/server.ts:253/573/603`), classify
   `'interrupted'` as NOT-failed, NOT-done, NOT-in-flight — with a
   one-line comment per site if the decision is non-obvious. Verify
   with `npm run typecheck` and the existing test suite plus one new
   test that runs the migration twice on the same DB and asserts the
   second invocation does not throw.

2. **Reconcile loop: classify casualties as `interrupted` and
   auto-retry once.** Touch only
   `orchestrator/src/mastra/daemon/server.ts` around lines 738-747.
   Change the loop body to set `status='interrupted'` (preserving the
   `error` string verbatim), then in a second pass over rows with
   `status='interrupted'`: if `retry_count = 0` bump to 1, set
   `status='queued'`, clear `error`, emit `bus.emit('task.queued',
   { taskId })`; if `retry_count >= 1` set `status='failed'`,
   preserve the original error, log
   `[reconcile] task ${id} was interrupted twice; giving up`. Add two
   tests under `daemon/__tests__/` covering both branches with a
   LibSQL fixture and a bus-emit spy.

3. **Sweeper desync: skip self-heal on `interrupted`.** Touch only
   `orchestrator/src/mastra/sweeper/server.ts` (~lines 230-260). When
   the desync loop sees a worktree branch on disk for a task with
   `status='interrupted'`, log
   `[sweeper] task ${taskId} interrupted; awaiting retry` and skip the
   self-heal enqueue. One new test asserting the sweeper does not call
   the self-heal enqueue path when the row is `interrupted`.

Each task should reference this ack file in its prompt body so the
follow-up agent has the context for *why* the original was split. Task
(2) depends on task (1); task (3) is independent of (2) and could run
in parallel.

## Real follow-up

The two themes flagged in `NO-DIFF-mars-883fbafe.md` — oversized-prompt
detection at `mars task add` time, and two-strikes drop-and-reshape
on repeated no-diff verify failures — apply here as well. They are not
re-filed in this ack; the original entries stand.
