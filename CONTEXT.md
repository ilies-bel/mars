# Project Context

Canonical domain terms for this project. Edited via `mars glossary`.

## Language

**Idea**:
A draft of work to do, persisted in .mars/state.db, regardless of who proposed it; every Idea carries a source — reflection (synthesized by mars reflect / deep-reflect from past task signals), human (created by the user), or planner (raised by the planner agent when it spots a gap while refining another Idea).
_Avoid_: suggestion

**TODO page**:
The single read-only ui/ view that lists every item awaiting human attention: ideas to refine (the unified ideas bucket) and blocked tasks from queue.db; users act via the CLI, never via the page.

**originId**:
Tracer id for a full workflow from `mars idea add` (or `mars task add`) through to merge; propagated onto every Mastra span in the arc so `mars deep-reflect` can analyze the whole workflow as one timeline.

**Daemon**:
The long-lived background process started by 'mars daemon' that runs Claude instances on ready tasks.
_Avoid_: watch process, watcher, mars watch

**Sweeper**:
Background component that manages worktree cleanup, removing finished or abandoned task worktrees under .worktrees/ and .mars/worktrees/.

**Arc**:
The full tree of work sharing a single originId, from the first proposal (idea or direct task) through every promoted/spawned task and every Mastra span to the merged commit(s); the unit of analysis for mars deep-reflect.

**Inbox**:
The single human-curatable list of items that need a human's attention, surfacing across lifecycle stages: ideas to shape (status='draft'), tasks blocked needing unblock, and tasks that finished in a state requiring review (e.g. failed).

**Events**:
A read-only, passive activity feed in the ui/ frontend tracking progress of completed tasks (and other terminal-state lifecycle moments) for situational awareness, with no acknowledgement or action required from the user.

**Worker**:
A long-lived orchestrator process that hosts one or more Slots; the panel groups Slot cards by their parent Worker.

**Slot**:
A single concurrency lane inside a Worker that runs one task at a time; the unit shown by each card in the Workers panel and the mars monitor TUI.

**Pool**:
A named work queue (triage, implement, refine, structured-write) that a Slot is configured to consume tasks from; each Slot belongs to exactly one Pool.

**Failure signature**:
A human-readable technical key identifying a class of orchestrator failure (e.g. `verify:has-diff/no-commits-ahead`, `merge:dirty-target`, `setup:install-failed`); composed from the `failingStep` and a normalized error class so the same root cause produces the same signature across runs. The unit a recovery recipe binds to.
_Avoid_: failure hash, error fingerprint

**Recovery recipe**:
A code-registered handler keyed by failure signature that builds the prompt for the recovery task spawned when a normal task fails with that signature; without a recipe for the observed signature, the orchestrator does not enqueue a recovery (see Investigator).

**Investigator**:
The agent the orchestrator spawns when a task fails with a signature that has no registered Recovery recipe; its job is to inspect the failure and propose a draft recipe for the maintainer to review, not to fix the failing task.

**Non-FF merge**:
A task arc whose merge step could not land as an instant git fast-forward into the integration branch and therefore had to be reconciled by the vcs-supervisor (Vega), typically because the integration branch advanced after the worktree branched off.
_Avoid_: non-fast-forward, conflicted merge, vega merge

**KPI**:
A read-only aggregate health number derived from completed task arcs over a rolling time window, surfaced on the dashboard so the operator can spot orchestrator drift at a glance.
_Avoid_: metric, stat, gauge

**Chore**:
A queued unit of side-effect-only work (e.g. re-running install.sh, warming a cache) that is expected to produce zero commits and therefore skips the verify:has-diff gate and its recovery recipe.
_Avoid_: fix, fix-task, side-effect task
