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
A preconfigured claude -p invocation bound to a stage (model, effort, permission-mode, agent, disallowed tools, output-format); the five named instances are Triager, Planner, Slicer, Coder, and Experimenter.

**Slot**:
One concurrent unit inside a Pool; pulls a task from the daemon and runs it to completion by enacting a Worker.
_Avoid_: daemon worker, dispatch slot

**Pool**:
A bounded concurrency budget per dispatch kind (triage, implement, refine, structured-write); a set of Slots.

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
A queued unit of work where the prompt is the source of truth: it may or may not produce commits. Skips the verify:has-diff gate (and its recovery recipe) but still runs the project's verify.json steps. If commits exist, they are merged into the integration branch; if not, the chore completes without merging.
_Avoid_: fix, fix-task, side-effect task

**Task**:
A queued unit of work expected to produce one or more commits on a task/<id> branch, which the orchestrator verifies (verify:has-diff + .mars/verify.json) and fast-forwards into the integration branch.
_Avoid_: job, run

**Session**:
A single live claude -p execution of a Worker, identified by a Claude session id; the runtime instance of a Worker (Worker is the class, Session is the instance).

**Fix-task**:
A Chore (kind='chore') spawned by a recovery recipe (per ADR-0002) in response to a failure signature on another task. The fixForTaskId column links back to the failed task; the kind column distinguishes it from a user-initiated chore.
_Avoid_: recovery task, fix task

**Blocker**:
A row in task_blockers asserting that a Task cannot be dispatched until the referenced row terminates; the referenced row is either another Task (terminates on merge/failure) or an Idea (terminates on promote, which transfers the block to every slice-spawned Task, or on reject, which drops it).

**Linker**:
The deterministic, no-LLM component of triage that scans the Idea+Task graph by keyword overlap and writes Blocker rows for a freshly-promoted Task; its output alone gates dispatch, replacing the prior LLM actionable verdict.

**Triaging**:
A transient Task status assigned by the slicer at emit-time; the Task is not yet dispatch-eligible. The Linker runs synchronously over Triaging tasks, writes blocker rows, and flips the status to queued. A Task stuck in Triaging means the Linker pass did not complete.

**draft (task)**:
TaskStatus initial state: a task row that has been authored but not yet triaged into the dispatch queue. Triage promotes draft → queued.

**queued (task)**:
TaskStatus: a task that has cleared triage and is waiting for a Worker slot. The dispatcher picks tasks in this state.

**ready (task)**:
TaskStatus: legacy/unreachable state that predates 'queued' as the claimable state. Slated for removal (idea 05fad6e6).

**running (task)**:
TaskStatus: a task whose code step (claude -p in the worktree) is currently executing.

**verifying (task)**:
TaskStatus: the code step has finished and verify (typecheck/test/lint) is running on the worktree.

**merging (task)**:
TaskStatus: verify passed and the task is being fast-forwarded into the merge target (main by default), serialized via the merge lock.

**done (task)**:
TaskStatus terminal-success: the task has merged into the integration branch. Worktree and branch may be reaped.

**failed (task)**:
TaskStatus terminal-failure: a step (code, verify, or merge) errored out. Operator recovers via mars unblock or the (planned) mars continue/mars restart verbs.

**dropped (task)**:
TaskStatus terminal: the task was abandoned without merging (e.g. zero-commit run, user purge). Distinct from 'failed' — no error to recover from.

**blocked (task)**:
TaskStatus: the task has at least one open task_blocker row referencing another task that has not yet reached 'done'. Auto-promotes to 'queued' when the last blocker clears.

**draft (idea)**:
IdeaStatus initial state: an unshaped idea row. Needs title + problem + solution + ≥1 user story before it can become prd-ready.

**prd-ready**:
IdeaStatus: a fully-shaped idea that has passed validateIdeaShaped(). Eligible for the slicer. Produced by 'mars idea promote' — note the verb name mismatch with the status.

**sliced**:
IdeaStatus terminal: the slicer has decomposed the idea into N tracer-bullet tasks (each linked back via parent_idea_id). The idea row stays alive as the PRD reference.

**dismissed (idea)**:
IdeaStatus terminal: the idea was decided against — no slicing, no tasks. Produced by 'mars idea reject' (verb name mismatch — it writes 'dismissed', not 'rejected').

**open (inbox)**:
InboxState initial: an inbox item that needs operator attention (stale-worktree alert, blocked task, failed task).

**acknowledged (inbox)**:
InboxState: operator has seen the item via 'mars inbox ack' but has not yet resolved or dismissed it.

**resolved (inbox)**:
InboxState terminal: the underlying problem was fixed. Set via 'mars inbox resolve [--root-cause <text>]'.

**dismissed (inbox)**:
InboxState terminal: the item was acknowledged-and-ignored — operator decided it does not need a fix. Set via 'mars inbox dismiss'.
