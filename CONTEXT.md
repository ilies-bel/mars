# Project Context

Canonical domain terms for this project. Edited via `mars glossary`.

## Language

**originId**:
Tracer id for a full workflow from `mars proposal add` (or `mars task add`) through to merge; propagated onto every Mastra span in the arc so `mars arc reflect` can analyze the whole workflow as one timeline.

**Daemon**:
The long-lived background process started by 'mars daemon' that runs Claude instances on ready tasks.
_Avoid_: watch process, watcher, mars watch

**Sweeper**:
Background component that manages worktree cleanup, removing finished or abandoned task worktrees under .worktrees/ and .mars/worktrees/.

**Arc**:
The full tree of work sharing a single originId, from the first proposal or direct task through every promoted/spawned task and every Workflow instance to the merged commit(s); the unit of analysis for mars arc reflect.

**Events**:
A read-only, passive activity feed in the ui/ frontend tracking progress of completed tasks (and other terminal-state lifecycle moments) for situational awareness, with no acknowledgement or action required from the user.

**Worker**:
A preconfigured agent invocation bound to a class (model, effort, permission-mode, disallowed tools, message cap), a Provider (which agent CLI), and a Runtime (headless or pty); the six classes are Coder, Planner, Slicer, Triager, Fixer, Writer.
_Avoid_: Slot, dispatch slot

**Slot**:
One concurrent unit inside a Pool; pulls a task from the daemon and runs it to completion by enacting a Worker.
_Avoid_: daemon worker, dispatch slot

**Pool**:
A bounded concurrency budget per dispatch kind (triage, implement, refine, structured-write); a set of Slots.

**Failure signature**:
A human-readable technical key identifying a class of orchestrator failure (e.g. `verify:has-diff/no-commits-ahead`, `merge:dirty-target`, `setup:install-failed`); composed from the `failingStep` and a normalized error class so the same root cause produces the same signature across runs. The unit a recovery recipe binds to.
_Avoid_: failure hash, error fingerprint

**Recovery recipe**:
A code-registered handler keyed by failure signature that owns the failure class end-to-end: the plain-language reason shown on its Alert, the operator action set with a recommended action, and the prompt for the spawned recovery task; signatures with no recipe fall back to a first-principles recovery (ADR-0061) and the default action set Diagnose/Continue/Restart.

**Investigator**:
The agent the orchestrator spawns when a task fails with a signature that has no registered Recovery recipe; its job is to inspect the failure and propose a draft recipe for the maintainer to review, not to fix the failing task.

**Non-FF merge**:
A task arc whose merge step could not land as an instant git fast-forward into the integration branch and therefore had to be reconciled by the vcs-supervisor (Vega), typically because the integration branch advanced after the worktree branched off.
_Avoid_: non-fast-forward, conflicted merge, vega merge

**KPI**:
One of a small fixed vector of read-only health numbers derived from completed Arcs over a rolling time window, surfaced on the dashboard so the operator can spot orchestrator drift at a glance. KPIs are defined over framework primitives (Arc, Task, Worker, recovery, Action queue) and never over codebase-specific artifacts, so they hold for any Mars deployment regardless of what its agents produce. A single 'harness health' scalar is deliberately rejected: the goals (autonomy, frugality, resilience, operator ergonomics) trade against each other, so health is a vector and a regression in one KPI is only meaningful held against the others. The canonical vector: Cost per completed Arc, Failure rate, Autonomous completion rate, Recovery success rate.
_Avoid_: metric, stat, gauge, harness health score

**Chore**:
A Mars work unit whose purpose is a side-effecting repair (a fix or follow-up after a failure) rather than feature work; goes through the same code/verify/merge workflow as a Task.
_Avoid_: fix, fix-task, side-effect task, recovery task

**Task**:
A queued unit of work expected to produce one or more commits on a task/<id> branch, which the orchestrator verifies (verify:has-diff + .mars/verify.json) and fast-forwards into the integration branch.
_Avoid_: job, run

**Session**:
A single live execution of a Worker — one agent process driving one Task — identified by the Provider's session identifier where it exposes one; the runtime instance of a Worker (Worker is the class, Session is the instance).

**Blocker**:
A row in task_blockers asserting that a Task cannot be dispatched until another Task terminates (merge or failure); written by the Linker (lexical overlap), the slicer (intra-cohort wave intent), the fix-task pipeline, or by an operator via mars block.

**Linker**:
The deterministic, no-LLM component of triage that scans the Proposal+Task graph by keyword overlap and writes Blocker rows for a freshly-promoted Task; its output alone gates dispatch, replacing the prior LLM actionable verdict.

**Triaging**:
A transient Task status assigned by the slicer at emit-time; the Task is not yet dispatch-eligible. The Linker runs synchronously over Triaging tasks, writes blocker rows, and flips the status to queued. A Task stuck in Triaging means the Linker pass did not complete.

**draft (task)**:
TaskStatus initial state: a task row that has been authored but not yet triaged into the dispatch queue. Triage promotes draft → queued.

**queued (task)**:
TaskStatus: a task that has cleared triage and is waiting for a Worker slot. The dispatcher picks tasks in this state.

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
TaskStatus terminal: the task will not merge under its own id — either abandoned without work (zero-commit run, user purge) or failed and handed to a superseding task that inherits its arc and branch; carries no live action-queue row.

**blocked (task)**:
TaskStatus: the task has at least one open task_blocker row referencing another task that has not yet reached 'done'. Auto-promotes to 'queued' when the last blocker clears.

**prd-ready**:
ProposalStatus: a fully-shaped proposal that has passed validateProposalShaped(). Eligible for the slicer. Produced by 'mars proposal promote' — note the verb name mismatch with the status.

**sliced**:
ProposalStatus terminal: the slicer has decomposed the proposal into N tracer-bullet tasks (each linked back via parent_proposal_id). The proposal row stays alive as the PRD reference.

**open (inbox)**:
The only operator-visible action-queue state: a row whose entity (task or worktree) is currently stuck. The row is a pure projection of entity state — it appears when the entity becomes stuck and disappears when the entity transitions; there is no operator gesture that closes a row directly.

**acknowledged (inbox)**:
Retired state. The action queue is a projection of entity state with no operator-facing ack/resolve/dismiss gesture; a row leaves only when its entity transitions, so there is no acknowledged state to occupy.

**resolved (inbox)**:
Internal-only terminal state written by the Invalidator when an entity transition closes a row (e.g. resolveAllRowsForTask on task.completed). Never set by an operator — the action queue has no resolve verb.

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
The slice of the Graph view's blocker DAG anchored at a hovered or selected node: its full upstream blocker chain to the roots, its full downstream dependents to the deepest still-pending leaf (all paths through diamonds, following blocker edges across Proposal-cluster boundaries), and the originating Proposal attached as a fixed provenance hop; anchoring on a Proposal instead yields the whole forest that Proposal sliced.
_Avoid_: focus query, focus mode, chain

**Bundle**:
A tarball asset (mars-bundle-vX.Y.Z.tar.gz) containing manifest.json plus exactly the union of its owned and hybrid paths at a specific framework version. Published on the matching GitHub Release alongside a .sha256 sidecar; consumed by mars install and mars update.
_Avoid_: release tarball, framework bundle, mars bundle

**Mars id**:
An entity identifier rendered as '<tag>-<hex>', where <tag> is a fixed 4-letter kind code (e.g. task, prop, orig, alrt) and the bare hex is the canonical identity: equality is on the hex alone, the tag is presentation framing. No slug suffix.
_Avoid_: prefixed id, namespaced id, slugged id

**Bare id**:
The hex-only core of a Mars id. It is NOT the stored identity: every entity table stores the full '<tag>-<hex>' string as its primary key, and foreign keys, worktree directory names, and git branch names all carry the tag. The bare hex is used only for equality/partial-match lookups.
_Avoid_: short id, raw id, hex id

**UI**:
Local frontend for inspecting Mars runs (Topology / Runs / Run timeline views), served on port 7777. Lives in `ui/`.

**Runtime**:
A Worker attribute, valued either 'headless' (the agent's print/non-interactive mode, e.g. 'claude -p', the default) or 'pty' (the agent's native interactive harness driven under a non-attachable node-pty, captured to traces/logs — no human attach), that says how that Worker's Sessions execute. Orthogonal to Provider. Set on the Worker, not per Task: Tasks route to a Worker via tag matching and inherit its Runtime.
_Avoid_: tmux, attachable runtime, interactive runtime

**Workflow**:
A named, declarative pipeline of typed TypeScript steps composed via the in-house engine's fluent builder (createWorkflow({...}).then(step).then(step).commit()). The Workflow is the runtime contract under which a Task executes: it owns the step shape, the input/output schemas, the order of steps, and the logging surface. In v1 the composition primitive is linear .then chaining only; richer primitives (branching, parallel, foreach, dountil, dowhile) are added when a real pipeline demands them. Workflows are domain-agnostic and introspectable as plain data so future tooling can render them without importing the engine at runtime.
_Avoid_: named pipeline, workflow definition, pipeline, Mastra workflow

**Workflow instance**:
A single execution of a Workflow against an origin row — a Task in the task-scoped case (Coder, Writer, Fixer, plus setup/verify/merge/recovery) or a Proposal in the proposal-scoped case (Planner, Slicer, Triager). The origin row's id is the Workflow instance's identity; the orchestrator resolves tag plus task type to exactly one Workflow id and records it on the origin row at dispatch. The instance carries durable per-step state (last completed step, step input/output payloads, child-logger lineage) so a crash resumes from the last completed step on retry.
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
The deep module that owns all access to .mars/mars.db (task domain). Exposes domain methods (getTask, listTasks, enqueue, claimQueued, updateTask, addBlockers, ...) plus a generic Stmt-based side door (query/execute/atomic) for queries no domain method covers. Hides the libsql Client, Transaction, schema migration, and row<->Task mapping behind one seam. Constructed at the composition root with an injected libsql Client (file: for prod, :memory: for tests); never exposes the raw client. Replaces the exported getClient()/initQueue() pair from queue.ts.
_Avoid_: queue client, getClient, task repository, db layer

**StateStore**:
The deep module that owns all access to .mars/mars.db (proposals, action queue). Sibling seam to TaskStore: same constructor-injected libsql Client pattern, same generic side door. Collapses the duplicated private getClient()/clientSingleton currently re-declared independently in proposals.ts and lib/action-queue.ts into one connection owner.
_Avoid_: proposals client, state db layer, inbox client

**Command seam**:
The CLI's testable-unit boundary. Each invocable path (e.g. 'task add', 'glossary set') is one Command registered by its full path in a flat path-keyed registry; the top-level 'task'/'proposal' grouping is computed routing, not a unit. A Command exposes run(args, deps) -> CommandResult{code,value?}; it never calls process.exit (the 110 scattered exits collapse to one site per adapter) and never imports subsystems directly. Two real adapters: production (argv -> route -> run -> process.exit/stdout) and in-process test (constructed args + injected TaskStore(:memory:) + injected daemon-client, asserting on the returned result). Transport (local read vs daemon-routed mutation) is an injected dependency, never a Command taxonomy, because it varies per-subcommand not per-command.
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
A draft of work to do, persisted in .mars/mars.db, regardless of who proposed it; every Proposal carries a source — reflection (synthesized by mars reflect / mars arc reflect from past task signals), human (created by the user), or planner (raised by the planner agent when it spots a gap while refining another Proposal).
_Avoid_: idea, suggestion

**task-terminal invalidator**:
The first concrete Invalidator kind: auto-attached to any inbox item raised with a structured taskId, it closes that item when a task.terminal bus event reports its task reached done or dropped (failed is excluded — the operator owns failed-task items).
_Avoid_: stale-closer, task-done invalidator, terminal sweep

**task.terminal**:
A bus event emitted at the single TaskStore status-write chokepoint whenever a task reaches a terminal state (done, dropped, or failed), carrying { taskId, state }. Distinct from task.completed, which fires per workflow run rather than per task-state transition.
_Avoid_: task.done, terminal event, task-state event

**Step span**:
A persisted record of one Workflow-instance step's execution (started_at, ended_at, outcome); the steps are setup, code, verify, merge and recovery steps. A Step span whose step is a claude -p execution is a Session and additionally carries a Worker and a Claude session id; non-LLM steps have neither.
_Avoid_: step record, step run, span, workflow step, phase

**Authorization profile**:
The declared, registry-keyed set of capabilities a Worker forfeits, in two dimensions (claude tools it may not use; mars verbs it may not invoke) that both compile to the single claude --disallowedTools denylist string.
_Avoid_: denylist, disallowed tools, tool ban, permission set

**Provenance triple**:
The (Worker name, Session id, Author) attribution stamped on a verb-invocation audit event so a dispatched action can be traced back to the exact Worker Session and author that issued it.
_Avoid_: audit tuple, trace tuple, attribution triple, worker provenance

**Verb-invocation audit event**:
A bus event emitted whenever a dispatched Worker Session invokes a mars verb, carrying the resolved Command path, argument shape, and the provenance triple; not emitted for non-Session (human-terminal) callers.
_Avoid_: verb log, command audit, invocation log, verb.invoked

**Inbox item**:
A row in inbox_items representing one stuck origin task; updates in place as recovery attempts fail and auto-resolves when the origin reaches done/dropped or any recovery succeeds.
_Avoid_: inbox row, inbox entry, stuck-task notification

**Outbox**:
The single append-only log in .mars/mars.db where every Bus event is durably persisted in the same transaction as its triggering state mutation, and from which all Subscribers pull.
_Avoid_: event log, event store, event queue, bus table, outbox_events

**Subscriber**:
A code-declared, named consumer of the Outbox with a durable cursor, a handler, and a bootstrap mode (replay or tail). One Subscriber's cursor is independent of every other's.
_Avoid_: listener, consumer, handler, bus listener

**Progress tab**:
The ui/ tab that renders all non-terminal work plus recent failures as a live monitoring surface, with a DAG default view and a kanban alternative view; replaces the legacy Kanban tab.
_Avoid_: Kanban tab, Runs tab, live tab

**Cluster**:
An operator-meaningful grouping of task statuses (or proposals) used by the Progress tab: Proposal, In progress (queued + running + verifying + merging), Blocked, Failed.
_Avoid_: bucket, group, status group, Graph bucket

**Tag**:
An author-supplied label on a Task that materialises a fixed set of Definition-of-Done criteria at enqueue time.

**Definition of Done**:
The list of criteria a Task must satisfy before verify passes; materialised from the Task's Tags at enqueue time.

**Status transition**:
A legal from-to edge between two task statuses; the set of all legal edges forms the task lifecycle's transition map.
_Avoid_: state change, status update, status write

**Transition seam**:
The single TaskStore entry point through which every task.status write must pass, validating the from-to edge against the legal transition map.
_Avoid_: status setter, updateTask, transition function

**Criterion**:
A single free-text outcome the agent must validate or waive before verify can pass.

**validate**:
The agent's verb for marking a Criterion satisfied.

**waive**:
The agent's verb for skipping a Criterion with a recorded reason.

**draft (proposal)**:
ProposalStatus initial state: an unshaped proposal row. Needs title + problem + solution + ≥1 user story before it can become prd-ready.

**dismissed (proposal)**:
ProposalStatus terminal: the proposal was decided against — no slicing, no tasks. Produced by 'mars proposal reject' (verb name mismatch — it writes 'dismissed', not 'rejected').

**Proposal dependency**:
A row in proposal_dependencies asserting that one Proposal cannot be meaningfully PRD-shaped until another Proposal reaches sliced; lives in the planning graph, is written by operators or by the recursive planner when it spawns a gap-filling child Proposal, and is never fanned out into task_blockers when the blocker Proposal is sliced.
_Avoid_: proposal blocker

**Spawn governor**:
The admission-control gate the daemon consults before acquiring a Worker semaphore slot; samples host load and memory at each watchdog tick and refuses new spawns when either signal is in High or Critical pressure, leaving the task in queued for the next drain cycle.
_Avoid_: admission control, pressure gate, load gate, governor

**Pressure level**:
The Spawn governor's per-tick verdict on host resource state — Normal, Elevated, High, or Critical — computed as the worst band across load-ratio (loadavg-1 / cpu-count) and memory-used (1 - freemem / totalmem); High and Critical both refuse spawns, Elevated and Normal allow them.
_Avoid_: pressure band, governor band, load level

**Cost per completed Arc**:
The headline frugality KPI: cache-weighted tokens summed across an Arc, divided by the count of Arcs that reached done over the window — an outcome-denominated cost, so failed work is not amortised away into a flattering average. Chosen over raw tokens-per-task because tasks differ in size and the field rejects size normalisation (lines-changed is gameable and weakly correlates with difficulty); anchoring the denominator to completed Arcs is the accepted framing (cf. SWE-bench 'cost per resolved issue'). Per-Arc token spend is also reported as a distribution (median and p90), never a bare mean, because the variance from task size lives in the distribution: a regressing p90 is signal, a regressing mean may just be bigger legitimate work.
_Avoid_: tokens per task, tokens per arc, average cost, mean token spend

**Failure rate**:
A reliability KPI: the fraction of Arcs over the window whose origin reached failed (recovery exhausted, operator not yet resolved). Sibling to Autonomous completion rate — failure rate counts terminal failure, autonomous completion counts clean success with no human touch; the band between them is work that finished only because the operator stepped in.
_Avoid_: error rate, fail percentage

**Autonomous completion rate**:
The autonomy KPI: the fraction of Arcs over the window that reached done while raising zero Action queue items — i.e. completed with no human intervention beyond the planning phase. Directly measures the project's headline goal (no human touch except planning). Trades against Cost per completed Arc and Recovery success rate: pushing autonomy up (never ask the operator) tends to cost more tokens and risks a wrong unsupervised choice compounding, which is why it is read as a vector member, not maximised alone.
_Avoid_: autonomy rate, hands-off rate, no-touch rate

**Recovery success rate**:
The resilience (self-healing) KPI: the fraction of origin failures whose recovery task reached done AND whose origin then reached done, over the window — i.e. how often self-healing actually heals, per ADR-0002's one-shot recovery. Not capturable today: nothing records recovery outcome distinctly from a normal task transition. Deferred deliberately — it is to be derived from the forthcoming queryable workflow surface rather than bolted onto the current model, so this term names the target without mandating a schema that the workflow rework would obsolete.
_Avoid_: heal rate, fix success rate, recovery rate

**KPI drift**:
A sustained move in a KPI against its own rolling baseline (this window vs. prior) — the signal the dashboard exists to surface. Detecting drift requires a persisted KPI time-series; today KPIs are recomputed and printed, never stored, so drift is invisible. Drift in one KPI is read against the rest of the vector, never alone (see KPI).
_Avoid_: regression, metric drift, trend

**Self-evolve loop**:
The closed feedback arc that turns KPI drift into corrective work: KPI regression -> reflection -> draft proposal -> operator promotes -> merge -> KPI re-measured to confirm the change moved the number. The framework does NOT rewrite itself: it surfaces drift and proposes; the operator owns every promotion, keeping planning the single human touchpoint. The automatic KPI-regression->proposal trigger is opt-in and off by default; with it off, deep-reflect is the manual entry point to the same loop. Agnostic by construction — it tunes any project's specifics via proposals, carrying no codebase assumptions.
_Avoid_: auto-evolve, self-improvement, feedback loop, evolve loop

**Effectiveness-under-budget**:
The rigorous, size-fair backstop to Cost per completed Arc: success rate plotted against cumulative token spend, integrated as normalised area-under-curve up to a budget cap (after SWE-Effi). Because it never divides per-task, the one-line-vs-500-line size-variance problem dissolves entirely — it rewards cheaply-solved Arcs and discounts expensive or unsolved ones. Computed only during deep-reflect (too heavy and too hard to read for the daily dashboard), where Cost per completed Arc is the at-a-glance number and Effectiveness-under-budget is the audit-grade view.
_Avoid_: AUC, SWE-Effi, budget AUC, resource-bounded effectiveness

**triaging (task)**:
Transient lifecycle phase between a freshly-promoted task and dispatch-eligibility; the task is visible to readers but the dispatcher must not pick it up while linker analysis may still attach blockers.

**vega-reconciling (task)**:
The lifecycle phase a task enters when its merge hits a non-FF conflict and is handed to the vcs-supervisor for reconciliation before re-attempting the merge.

**UI fallback surface**:
A UI region that renders in place of, or alongside, real data when a read fails or returns nothing. A true initial-load failure (no prior data) produces RemoteState kind:'error' and warrants a full-pane FallbackSurface takeover (error copy splits by build mode). A background-refetch failure while prior data is still present produces kind:'stale': the data stays rendered and a thin, non-blocking ReconnectingStrip (ui/src/components/ReconnectingStrip.tsx) appears above it — no pane takeover. A read that returns nothing produces kind:'empty' (empty-state copy, no build-mode split). The RemoteState<T> union lives in ui/src/shared/useRead.ts.
_Avoid_: error panel, error state, fallback UI

**Mars project**:
A repository with a .mars/ directory on disk; the unit the global dashboard scans for and aggregates, independent of whether its daemon is currently running.
_Avoid_: repo, workspace, project root

**Daemon health**:
A scanned Mars project's live/degraded/down status, derived by the global dashboard from healthchecking that project's daemon over its loopback HTTP via the .mars/http.port file.
_Avoid_: daemon status, liveness, heartbeat

**Failure kind**:
The single record bundling everything known about one classified failure — its signature (<failingStep>/<error-class>), its plain-language human reason, its recovery recipe, and its operator actions — so code, reason, and actions live in one place keyed by signature.
_Avoid_: failure code, failure-reason catalog, error kind, error-kind, failure entry

**Project**:
A registered repo the dashboard can view, identified by its repo root; the unit a Daemon and its UI are scoped to.
_Avoid_: repo, workspace, target

**Project registry**:
The operator-maintained file listing the repo roots the dashboard exposes as Projects; the UI server's sole source of truth for which Projects exist.
_Avoid_: projects.json, project list, workspace file

**Attempt**:
One execution of a task's work — the original run plus every operator-initiated 'mars restart' re-run; distinct from automatic recovery, which ADR-0040 caps at one.
_Avoid_: retry, re-run, recovery attempt

**Provider**:
A Worker attribute naming which agent CLI a Session drives (claude, codex, gemini, ...); each Provider is one adapter at the provider seam knowing how to spawn that CLI, pass the prompt, and parse its output, session id, and exit. Orthogonal to Runtime: a Provider can run under either Runtime.
_Avoid_: agent backend, vendor, model provider, cli backend

**Dangling origin**:
An Arc whose originId has no backing Task row: member tasks carry it as origin_id but no Task has it as its own id, so any lookup keyed on the originId (task detail, arc title) finds nothing.
_Avoid_: orphan origin, missing origin task, headless arc

**TUI**:
Terminal-native display surface for Mars, a thin adapter over the application-service layer (ADR-0055) — peer to the web UI and the CLI; its inaugural screen is the action queue.
_Avoid_: terminal ui, curses app, ncurses, text ui, console ui

**Context graph**:
The task detail drawer's vertical mini-graph of a focused task's lineage — its originating Proposal, blocker chain, and one downstream hop — laid out top-to-bottom; distinct from the main Progress Topology canvas.
_Avoid_: subgraph, mini-graph, focus subgraph, context subgraph

**Lease**:
Exclusive human ownership claim on a parked task's worktree. Taken with mars attach, released with mars release; a leased or awaiting-human task is exempt from the phantom watchdog, and lease expiry raises an action-queue row instead of auto-failing.
_Avoid_: lock, claim, checkout

**awaiting-human (task)**:
Parked task state: the workflow suspended at an awaitHuman step and a human may take the Lease and work in the task's worktree in their own session. Pipeline resumes at verify on release. Generalizes the --preview awaiting-validation gate.
_Avoid_: paused, parked, HITL state

**Completion report**:
Machine-parseable fenced block a Coder must emit as its final message: one done/partial/blocked line per done-criterion with evidence (file:line, commit sha, test name). Parsed by the completeness verify gate; absent or unsubstantiated reports fail verification.
_Avoid_: self-report, summary, final report

**Gate tier**:
Classification on every verify gate: 'task' gates are cheap and run per-task in the worktree (typecheck, lint, diff-affected tests, completeness); 'integration' gates are expensive and run once, serialized under the merge lock, against the merged tree (full suites).
_Avoid_: verify level, check tier

**Foreground session**:
An interactive Claude Code session driven by the operator, as opposed to a Session (a Worker's headless execution instance). Identified by the CLAUDE_CODE_SESSION_ID env var that Claude Code exports to its subprocesses; captured at the mars CLI boundary as origin_session_id on the tasks and proposals it enqueues, letting deep reflect join the operator conversation with the downstream slice (enqueue, worker runs, merge).

**Progress journal**:
Append-only per-task record of mid-flight progress notes and done-criteria check-offs, written by Foreground sessions via mars task note / mars task check through the Arc write funnel (ADR-0052); read via mars task show, the UI, and the attach-time Handoff.
_Avoid_: progress log, task log, work log, notes field

**Live task**:
A task routed to a workflow whose code step has Execution mode manual: setup runs auto, the task parks awaiting-human at the manual step, and a Foreground session does the work before verify and merge gate the exit.
_Avoid_: foreground task, manual task, interactive task

**Handoff**:
The context bundle mars attach surfaces when a Foreground session takes a parked task: the Worker's Completion report, commits ahead of the integration branch, done-criteria state, and the Progress-journal tail. Derived at attach time; never a file inside the worktree (release refuses dirty worktrees).
_Avoid_: handover, context dump, briefing

**Execution mode**:
Per-step property declared in a workflow definition naming who executes the step: auto (an agent or machinery run by the daemon) or manual (a human in a Foreground session working the leased worktree).
_Avoid_: step mode, live flag, manual flag

**Step guide**:
Per-step brief declared on a manual step in a workflow definition — what the Foreground session should accomplish there; surfaced at park in the action-queue row, at attach, and by the session hooks, so a manual-heavy workflow reads as a runbook for live work.
_Avoid_: step prompt, manual note, instructions field

**Scorer**:
A per-pipeline quality evaluator attached to a specific Workflow that grades each Workflow instance's output on a normalized scale, suggested by reflection and run automatically on subsequent instances of that Workflow.
_Avoid_: grader, judge, eval, evaluator, quality gate

**Studio**:
The live per-instance execution-tree view: each Step rendered as a node with name, duration, status, and its input, output, and exact prompt, updating as the Workflow instance runs.
_Avoid_: playground, run view, execution graph, step graph, DAG view

**Self-authored workflow**:
A Workflow whose plain-JS pipeline body was written by an agent rather than scaffolded or hand-authored by the operator.
_Avoid_: generated workflow, agent workflow, dynamic pipeline, llm workflow

**Behaviour verification**:
A pipeline step that exercises a task's Definition-of-Done criteria against a live running surface via Playwright MCP (clicking the interface, taking screenshots, asserting observable behaviour) rather than static typecheck/test/lint.
_Avoid_: e2e gate, ui test, acceptance test, behavioural gate, playwright step

**Spend meter**:
An observe-and-warn subsystem that sums cache-weighted token usage over a rolling wall-clock window and per-arc, raising a level-triggered action-queue row when a configured token threshold is crossed; it never pauses dispatch or suppresses recoveries.
_Avoid_: spend governor, budget guard, cost cap, token governor, metric, gauge

**Main committer**:
The single recovery task per integration branch that commits or stashes the branch's uncommitted working-tree state so tasks blocked on a dirty integration branch can dispatch.
_Avoid_: committer, dirty-main recovery, main-commiter task, commit recovery

**Dirty-main source**:
A regular task parked in 'blocked' because it hit an uncommitted integration branch at dispatch, verify, or merge, and is waiting on the branch's Main committer.
_Avoid_: blocked dependent, parked task, committer dependent

**Notifier**:
The Subscriber that delivers a native OS desktop notification to the operator's machine when an Alert lands on the action queue; best-effort and never stalls its cursor.
_Avoid_: push notification, notification channel, notification service, alerter

**Thread**:
A created conversation on the chat surface — attached to an alert, purely informational, or free chat to shape a draft — that is a real entity with its own lifecycle, so unlike the action queue (a pure projection) it can be created and cleaned up directly.
_Avoid_: chat session, conversation, chat thread, action queue item

**Reflector**:
The mostly-deterministic agent woken fresh at the end of a Session or an Arc (or on manual/orchestrator trigger) to synthesize reflections over completed work into draft proposals; not a long-running thread.
_Avoid_: reflect worker, reflection agent, reflect loop

**Reflector checklist**:
The CLI-managed catalog of environment and workflow improvements the Reflector screens before suggesting, each item carrying the operator's past decision (accepted, declined, or snoozed-until) per project.

**Operator**:
The human-or-agent principal who runs Mars's control loop: triages the action queue and sets the control levers that govern dispatch and spend.
_Avoid_: user, admin, operator queue

**Control lever**:
A single operator-settable, persisted daemon.json field that gates a spend- or dispatch-affecting daemon behaviour (recovery, scoring, arc-verify, auto-reflect, dispatch, budget thresholds), read and flipped through the one operator surface.
_Avoid_: flag, kill-switch, toggle, set-flag

**Auto-reflect**:
The daemon behaviour of automatically triggering reflection (session-scoped reflect and arc deep-reflect) off completed work; a control lever gates it independently of per-task signal capture.
_Avoid_: auto reflect, reflect trigger, MARS_REFLECT_DISABLED

**Steward**:
The seam through which Mars observes and improves its own pipeline health, owning the context boundary and the intervention ledger that every proactive health adapter — reflect, deep-reflect, auto-configuration — writes through; a capability seam rather than an agent, so an adapter carries a model only when its work requires judgement.
_Avoid_: ai operator, operator agent, self-optimizer, tuner, auto-tuner, steward agent

**Vision**:
The product's enduring north-star — what it is, who it's for, and what success looks like — captured once during onboarding and persisted for the life of the project, surfaced to the chat agent in every session.
_Avoid_: mission, goals, north star, prd, charter

**Surface form**:
A stored spelling variant of a glossary term (its plural, lowercased, or otherwise inflected form) that the chat highlighter matches against, so a term lights up regardless of case or inflection.
_Avoid_: hit list, match form, highlight form, variant

**Mechanical verification**:
The deterministic verify step: it runs configured shell checks such as typecheck, lint, targeted tests, and commit/diff assertions in a task worktree. It is authoritative for mechanical correctness and is serialized by the global verify lock; it does not assess human-facing behaviour.
_Avoid_: agent verification, agent verify, shell verification

**Notice**:
A zero-token, entity-less fact Mars speaks on its own — in the main thread or into an Active subject without taking the floor — that clears only when the operator acknowledges it.
_Avoid_: bell notice, informational message, system message, toast

**Verify gate**:
An opt-in, per-verify-scope check the orchestrator runs during the verify phase, held in the gate registry and created by the operator at onboarding.
_Avoid_: gate, check, verify step, verify_gate

**Gate quarantine**:
The Steward's autonomous, reversible suspension of a systemically-failing verify gate, degrading that gate's coverage to CAN'T-VERIFY (alert + merge proceeds) instead of letting it block merges.
_Avoid_: gate disable, gate suspension, gate kill-switch, quarantined gate

**Semantic token**:
A color or radius variable named for UI intent (primary, destructive, status-failed) — the only vocabulary component code may reference.
_Avoid_: shadcn variable, intent token

**Palette token**:
A raw Mars brand color (iron, flame, dust) defined in the stylesheet and consumed only by semantic tokens, never directly by components.
_Avoid_: brand token, raw color

**Steward ledger**:
The append-only record of every Steward intervention, keyed by target kind, target id, and target version (or content hash), that both enforces the one-fix-per-version rule and feeds every display of Steward activity.
_Avoid_: intervention log, steward history, steward audit

**Subject**:
One topic under discussion in chat, backed one-to-one by a chat thread carrying its own freshly-loaded agent context, opened with exactly one Objective and one Terminal condition.
_Avoid_: topic, segment, conversation, thread segment

**Active subject**:
The single Subject currently bound to the composer, whose thread receives the operator's next turn.
_Avoid_: current thread, selected thread, focused subject, live subject

**Preloaded response**:
A labelled next move rendered inline in the chat feed as a tap-sized chip, standing for an op — a zero-token Mars verb, an autonomy-level write, an external reference, or opening a Subject — that the operator can equally trigger by typing it in their own words.
_Avoid_: quick reply, suggestion chip, action button, canned reply

**Subject boundary**:
The state of the chat feed when no Subject is active, where Cards offer the ranked next Subjects and free text is answered in the main thread rather than opening one.
_Avoid_: handoff, seam, thread break, context reload point

**Autonomy level**:
The per-lever setting governing whether Mars may act unprompted, valued off, ask, or tell.
_Avoid_: autonomy dial, permission level, auto mode, steward mode

**Main thread**:
The single durable conversation that answers the operator, owns Mars's unprompted messages, Away digests and the Context lines closed Subjects fold back, and never itself creates work.
_Avoid_: main chat, root thread, home feed, hero, seeded feed

**Context line**:
The one-sentence outcome of a closed Subject, appended to the main thread so the conversation carries what was settled without carrying the transcript.
_Avoid_: summary, recap, thread summary, closing note

**Offer set**:
The ops standing open in the chat feed at a given moment, rendered as Preloaded responses and matched against the operator's free text before it is treated as a new Subject.
_Avoid_: pending actions, open ops, chip set, suggestions

**Reachable surface**:
The entry point through which a human can actually exercise a PRD's user story in the merged result — a UI affordance, a CLI command, or a bot command — as distinct from an API route or table that only another program can reach.
_Avoid_: user-facing surface, frontend, UI layer

**Away digest**:
The single stored message narrating everything that happened during one absence, composed without a provider run when the operator returns and never regenerated afterwards.
_Avoid_: release notes, delta, what happened, hero delta, daily summary

**Card**:
The rich affordance in the feed carrying what happened together with the operator's available moves, and the only means by which a Subject is opened or closed.
_Avoid_: chip, preloaded response, offer, button, action button

**Closure card**:
The Card a Subject raises once its terminal condition is met, offering the close gesture that a Subject is never permitted to perform on itself.
_Avoid_: auto-close, archive prompt, done button, self-terminate

**Terminal condition**:
The domain event or done-statement declared when a Subject opens, whose satisfaction makes that Subject raise its Closure card.
_Avoid_: exit criteria, completion check, terminal event, done criterion

**Objective**:
The single reason a Subject exists, stated in one sentence when it opens and never revised for the life of that Subject.
_Avoid_: goal, purpose, scope, charter
