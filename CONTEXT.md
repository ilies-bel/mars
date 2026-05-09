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
The long-lived background process started by 'mars watch' that runs Claude instances on ready tasks.
_Avoid_: watch process, watcher

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
