# Project Context

Canonical domain terms for this project. Edited via `mars glossary`.

## Language

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
The full tree of work sharing a single originId, from the first proposal (idea or direct task) through every promoted/spawned task and every Workflow instance to the merged commit(s); the unit of analysis for mars deep-reflect.

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
A Mars work unit whose purpose is a side-effecting repair (a fix or follow-up after a failure) rather than feature work; goes through the same code/verify/merge workflow as a Task.
_Avoid_: fix, fix-task, side-effect task, recovery task

**Task**:
A queued unit of work expected to produce one or more commits on a task/<id> branch, which the orchestrator verifies (verify:has-diff + .mars/verify.json) and fast-forwards into the integration branch.
_Avoid_: job, run

**Session**:
A single live claude -p execution of a Worker, identified by a Claude session id; the runtime instance of a Worker (Worker is the class, Session is the instance).

**Blocker**:
A row in task_blockers asserting that a Task cannot be dispatched until another Task terminates (merge or failure); written by the Linker (lexical overlap), the slicer (intra-cohort wave intent), the fix-task pipeline, or by an operator via mars block.

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

**Actionable state**:
A task status the triage UI surfaces because the operator can still influence the task: queued, running, verifying, merging, blocked. Excludes terminal states (done, failed, dropped).

**Owned file**:
A path the framework fully owns in a consumer repo. The manifest's owned[] list. 'mars install' / 'mars update' overwrite owned files unconditionally per ADR-0004.
_Avoid_: framework file, managed file

**Hybrid file**:
A path the framework would write to but the consumer may also edit (e.g. .claude/settings.json, .gitignore). The manifest's hybrid[] list. 'mars install' writes it only if absent; if present, it refuses and tells the user to back up and remove the file.
_Avoid_: shared file, merged file, conflicted file

**Framework version**:
A semver git tag (vMAJOR.MINOR.PATCH) on the mars-framework repository; the canonical identifier of a framework release and the source of truth consulted by 'mars update'. The version lives only as a git tag — there is no package.json version field and no VERSION file. The tag is autobumped on every release-worthy push to main, so 'mars update' always finds a fresh tag to pull.

**Focus subgraph**:
The slice of the Graph view's blocker DAG anchored at a selected node — by default the upstream blocker chain to its roots plus one downstream hop, with the selected node's originating Idea attached as a fixed provenance hop.
_Avoid_: focus query, focus mode

**Idea dependency**:
A row in idea_dependencies asserting that one Idea cannot be meaningfully PRD-shaped until another Idea reaches sliced; lives in the planning graph, is written by operators or by the recursive planner when it spawns a gap-filling child Idea, and is never fanned out into task_blockers when the blocker Idea is sliced.
_Avoid_: idea blocker

**Bundle**:
A tarball asset (mars-bundle-vX.Y.Z.tar.gz) containing manifest.json plus exactly the union of its owned and hybrid paths at a specific framework version. Published on the matching GitHub Release alongside a .sha256 sidecar; consumed by mars install and mars update.
_Avoid_: release tarball, framework bundle, mars bundle

**Mars id**:
An entity identifier rendered as 'mars-<kind>-<hex>' (with an optional '-<slug>' suffix for ideas), where the bare hex is the storage primary key and the prefix is added only at the CLI/render seam.
_Avoid_: prefixed id, namespaced id

**Bare id**:
The hex-only portion of a Mars id, stored as the primary key on every entity table (tasks, ideas, etc.). All SQL indexes and foreign keys use the bare form; the 'mars-<kind>-' prefix is added on render and stripped on parse.
_Avoid_: short id, raw id, hex id

**UI**:
Local frontend for inspecting Mars runs (Topology / Runs / Run timeline views), served on port 7777. Lives in `ui/`.

**Runtime**:
A Worker attribute, valued either 'headless' (today's claude -p, the default) or 'tmux' (a window inside a per-repo tmux session the operator can attach to and type into), that says how that Worker's Sessions execute. Runtime is set on the Worker, not per Task: Tasks route to a Worker via tag matching and then inherit its Runtime.

**Workflow**:
A named, declarative pipeline of typed TypeScript steps composed via the in-house engine's fluent builder (createWorkflow({...}).then(step).then(step).commit()). The Workflow is the runtime contract under which a Task executes: it owns the step shape, the input/output schemas, the order of steps, and the logging surface. In v1 the composition primitive is linear .then chaining only; richer primitives (branching, parallel, foreach, dountil, dowhile) are added when a real pipeline demands them. Workflows are domain-agnostic and introspectable as plain data so future tooling can render them without importing the engine at runtime.
_Avoid_: named pipeline, workflow definition, pipeline, Mastra workflow

**Workflow instance**:
A single execution of a Workflow. In v1 a Workflow instance is one-to-one with a Task: the moment a Task is dispatched, the orchestrator resolves its tag plus task type to exactly one Workflow id and records it on the Task, and from that point on Task and Workflow instance are the same thing. The instance carries durable per-step state (last completed step, step input/output payloads, child-logger lineage) so a crashed Task can resume from the last completed step on retry.
_Avoid_: workflow run, run, task run, workflow execution

**Precondition (fix-task)**:
An optional cheap, no-LLM check that a recovery recipe may declare so the dispatcher can evaluate the condition before spawning the fix-task agent. When the precondition already holds, the dispatcher marks the fix-task done with a skip_reason and never invokes the agent, avoiding no-op recoveries.

**skip_reason**:
The structured signal persisted on a fix-task that ended in done without invoking an agent. Set by the dispatcher when a recovery recipe precondition was already satisfied at dispatch time, recording why no agent run was needed so dirty-tree recovery stays idempotent and observable.

**Invalidator**:
A declaration attached to an inbox item at raise-time stating which bus events close it and how to match them against the event payload. The inbox engine evaluates invalidators centrally; raisers commit up front to what closes their item.
_Avoid_: auto-resolver, inbox-closer, close-rule

**Bus event**:
A past-tense, daemon-emitted fact about a state change Mars itself performed. Named '<noun>.<past-verb>' (e.g. 'task.unblocked', 'merge.preflight-passed'). Never derived from polling external state.
_Avoid_: daemon event, bus message, emit

**Merge mode**:
Per-task setting that controls what the orchestrator does after a green verify: 'auto' fast-forwards into the merge target, 'gated' parks the task on green for human review before merge.
_Avoid_: task type, task-type, checkpoint flag

**Verify scope**:
A subtree of the repo to which a set of verify steps applies, keyed by the verify recipe (e.g. web/, api/).
_Avoid_: supervisor scope, project root, stack scope

**Root verify scope**:
The repo-root verify scope whose steps run on every task as a repo-wide invariant floor, with any narrower matched verify scopes layered on top.
_Avoid_: default scope, dot scope, baseline scope

**Self-unblock follow-up**:
A Task filed by the Coder of the currently-running Task via 'mars task add --blocks $TASK_ID', creating a task_blockers edge in which the current Task waits on the new follow-up; the workflow short-circuits the current Task to blocked before verify and re-dispatches it once the follow-up reaches done.
_Avoid_: self-block, unblock task, blocked-by self

**Structured-write**:
A glossary or ADR mutation performed by the daemon on its own internal worktree and fast-forwarded into the integration branch, never a dispatched task's deliverable.
_Avoid_: glossary slice, adr slice, writer task, structured-write slice

**Action queue**:
The operator-facing surface listing causal chains that have no automated next move left, one row per chain; replaces the catch-all Inbox.
_Avoid_: inbox, inbox item, inbox_items, needs-you list, operator queue

**Chain**:
A causal failure unit identical to a node's focus subgraph extended along recovery edges (fix_for_task_id): the originating task, its fix-task descendants, and tasks transitively blocked behind that set; the unit of collapse for the Action queue and the tree shown in task detail.
_Avoid_: failure chain, causal chain, task chain

**Recovery edge**:
A directed edge in the Actionable graph from a source task to its fix-task (fix_for_task_id), walked by the focus subgraph alongside blocker and provenance edges.
_Avoid_: fix edge, recovery link, fix_for_task_id edge

**TaskStore**:
The deep module that owns all access to .mars/queue.db. Exposes domain methods (getTask, listTasks, enqueue, claimQueued, updateTask, addBlockers, ...) plus a generic Stmt-based side door (query/execute/atomic) for queries no domain method covers. Hides the libsql Client, Transaction, schema migration, and row<->Task mapping behind one seam. Constructed at the composition root with an injected libsql Client (file: for prod, :memory: for tests); never exposes the raw client. Replaces the exported getClient()/initQueue() pair from queue.ts.
_Avoid_: queue client, getClient, task repository, db layer

**StateStore**:
The deep module that owns all access to .mars/state.db (proposals, inbox). Sibling seam to TaskStore: same constructor-injected libsql Client pattern, same generic side door. Collapses the duplicated private getClient()/clientSingleton currently re-declared independently in proposals.ts and lib/inbox.ts into one connection owner.
_Avoid_: proposals client, state db layer, inbox client

**Command seam**:
The CLI's testable-unit boundary. Each invocable path (e.g. 'task add', 'glossary set') is one Command registered by its full path in a flat path-keyed registry; the top-level 'task'/'idea' grouping is computed routing, not a unit. A Command exposes run(args, deps) -> CommandResult{code,value?}; it never calls process.exit (the 110 scattered exits collapse to one site per adapter) and never imports subsystems directly. Two real adapters: production (argv -> route -> run -> process.exit/stdout) and in-process test (constructed args + injected TaskStore(:memory:) + injected daemon-client, asserting on the returned result). Transport (local read vs daemon-routed mutation) is an injected dependency, never a Command taxonomy, because it varies per-subcommand not per-command.
_Avoid_: command handler, subcommand registry, cli router, command pattern

**TaskFlightTracker**:
The deep module that owns the dispatch-storm-prevention invariant inside daemon/server.ts. Hides the four bookkeeping collections (inFlight: Map<taskId,{taskId,kind}>, pendingTriage/pendingImplement: Set<taskId>, claimedTriage/claimedImplement: Set<taskId>) and the predicates over them (isInFlight, isClaimed, trackInFlight, enqueuePending, drainPending). The named invariant: for every taskId, at most one Slot in inFlight ∪ claimed{Triage,Implement} holds it at any instant; claim runs BEFORE await acquire(sem) and clears AFTER trackInFlight commits, covering the await-acquire gap that caused the dispatch-storm bug (server.ts:230-236). Deliberately NARROWER than a SlotPool: leaves sems, drain, dispatchers, and bus glue in startDaemon. A full SlotPool seam was considered and rejected because semaphore primitives are already top-level, the dispatch-storm invariant is flight-tracker-shaped not pool-shaped, and the two-adapter rule fails today (one real adapter, fake-for-test does not count).
_Avoid_: slot pool, worker pool, dispatch pool, daemon pool

**Context-gathering chain**:
The sequence of tasks spawned when a coder trips too-hard and the framework parks the parent behind a context-gathering child as a blocker.
_Avoid_: too-hard chain, context chain, blocker chain

**Probe**:
A read-only Mars work unit that gathers information for a parent task and writes its findings to a notes file, without entering the code/verify/merge workflow.
_Avoid_: read-only task, readonly task, diagnostic task, context-gathering task, inquiry

**Proposal**:
A draft of work to do, persisted in .mars/state.db, regardless of who proposed it; every Proposal carries a source — reflection (synthesized by mars reflect / deep-reflect from past task signals), human (created by the user), or planner (raised by the planner agent when it spots a gap while refining another Proposal).
_Avoid_: idea, suggestion
