# Arc-Verifier Trigger

The arc-verifier runs after the last task of an arc merges into the integration
branch. It judges whether the merged result satisfies the arc's done criteria and
verify commands, then persists a verdict (passing verdicts land as trace events;
failing verdicts raise an `arc-verification-failed` action-queue item).

## Arc origin types

### Task Arc

A Task Arc is a group of tasks that share the same `origin_id`, where that id
is a real task row. The simplest case is a self-rooted task (`origin_id = id`);
the more complex case is a task that spawned recovery fix tasks (all sharing
`origin_id = originTaskId`).

**Trigger path**: When a task terminal event (`task.terminal { reason: 'done' }`)
fires, the arc-verifier subscriber resolves the arc origin via
`resolveOriginIdForTask(taskId)` → returns `tasks.origin_id ?? tasks.id`.
If `arcStatus(originId) = 'arc-done'`, `dispatchArcVerification(originId)` is
called and the daemon schedules `runArcVerification(originId)`.

### Proposal Arc

A Proposal Arc is created when a PRD is sliced: every slice task is inserted with
`origin_id = proposalId`. The arc is rooted by the proposal id, not a task id.

**Trigger path**: Identical to Task Arc — each slice task fires
`task.terminal { reason: 'done' }`. `resolveOriginIdForTask` returns
`tasks.origin_id`, which is the proposal id. `arcStatus(proposalId)` queries
`SELECT id, status FROM tasks WHERE origin_id = proposalId`, returning `arc-done`
only when ALL slice tasks are terminal and at least one is `done`.

## Dedup gate

The arc-verifier subscriber gates `dispatchArcVerification` on
`arcStatus === 'arc-done'`. This prevents the per-daemon-lifetime dedup set
(`triggeredOriginIds` in `arc-verifier.ts`) from being consumed prematurely
on an intermediate done event for multi-task arcs.

Without this gate, the first slice task completing would consume the dedup slot
(the arc is still `in-progress`). All subsequent slice completions would return
`skipped-dedup`, and the verifier would never see the `arc-done` state.

With this gate, the slot is consumed exactly once: on the `task.terminal` event
that makes the arc fully settled.

## Implementation locations

| File | Role |
|---|---|
| `src/outbox/subscribers/arc-verifier-subscriber.ts` | Subscriber handler; gates dispatch on `arcStatus === 'arc-done'` |
| `src/core/lib/arc-verifier.ts` | Core verification logic; `triggerArcVerification` (dedup + kill-switch) |
| `src/core/store/task-store.ts` | `arcStatus(originId)` — rollup predicate, works for both arc types |
| `src/core/lib/origin.ts` | `resolveOriginIdForTask` — returns `origin_id ?? id` for a task |
