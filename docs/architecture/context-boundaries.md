# Context Boundaries — proposal for discussion

Status: **DRAFT — for human approval.** Planning only. **No code moves in this change.**
Base commit: `69d4b45d`.
Companions: `PRD-ddd-restructure.md`, `aggregate-catalog.md`, `bounded-contexts.html`,
ADR-0056, ADR-0055, ADR-0052, ADR-0023, ADR-0021.

This document exists to be argued with. It proposes the top-level *physical*
structure of the Mars codebase (vertical slices by domain concern), reconciles
that with ADR-0056 (horizontal layers), and ends with a numbered agenda of
decisions only the human can make.

## Contents

1. [The tension: vertical slices vs ADR-0056's horizontal layers](#1-the-tension)
2. [The slice list](#2-the-slice-list)
3. [The shared kernel problem (`core/lib`)](#3-the-shared-kernel-problem)
4. [The import rule](#4-the-import-rule)
5. [Where primitives go](#5-where-primitives-go)
6. [Open questions for the human](#6-open-questions-for-the-human)

### Measurement note

Numbers below marked **(measured)** were counted on `69d4b45d` in this
worktree with `ls`/`wc -l`/`grep -rl` (raw line counts, non-test files only).
They will not match the dependency-cruiser figures in the brief exactly —
dep-cruiser reports *source* LOC (blank/comment-stripped) and counts the
`core/lib` subfolders differently. Both are directionally the same. Numbers
marked **NOT VERIFIED** were not measured and need a pass before anyone acts
on them.

---

## 1. The tension

### 1.1 What each side actually says

ADR-0056 decided:

> **One library: `@mars/mars`.** No internal package ladder. Inside the one lib,
> **three logical layers** with strict, arch-test-enforced dependency direction:
> engine → domain → adapters. […] **The layers are folders, not packages**.

The human asked for:

> "use proper vertical architecture, we should not see primitives, widgets and
> type folders, instead each part should be by domain concerns. Example: Coder
> worker, would have its own primitives helpers etc..."

These are not two answers to the same question. ADR-0056 answers *"which
direction may imports point?"*. The human answers *"what is the top-level
unit of the tree?"*. The conflict is real only in one clause — "the layers are
folders" — because that clause silently promotes a *rule* into a *layout*.

### 1.2 The argument: layers-as-folders would not have fixed anything

The tempting reading is "ADR-0056 is fine, just do it". Here is why it is not.

**Argument A — the observed cycle is intra-layer, so a horizontal cut cannot
break it.** The measured SCC spans 22 folders including `core/lib`,
`core/daemon`, `core`, `cli/commands`, `workflows`, `workflows/primitives`,
`outbox`, `bus`, `init`, `ideas`. Sort those into ADR-0056's layers and almost
all of them land in **domain** (`core`, `core/lib`, `core/store`, `outbox`,
`bus`, `ideas`) or straddle domain and adapters (`core/daemon`, `cli/commands`).
A build-guard that only forbids *upward* edges leaves every edge inside the
22-folder component untouched. The 34-file cycle around `core/arc.ts` ↔
`core/queue.ts` ↔ `core/lib/action-queue.ts` ↔ `core/blocker-resolution.ts` ↔
`core/daemon/kpi-store.ts` is a cycle between **Execution**, **Operator
Attention** and **Observability** concerns. It is a *cohesion* failure, not a
*direction* failure. Horizontal layering is the wrong instrument: it measures
the axis on which the codebase is already almost fine, and is blind to the axis
on which it is broken.

**Argument B — `domain/` would be born as `core/lib` with a new name.** Under
layers-as-folders, `domain/` absorbs ~all of `core` (29 files), `core/lib` (130),
`core/store` (6), `outbox` (20), `bus` (7) — call it 190+ files and 45k LOC in
one folder. That is the junk drawer we are trying to dissolve, re-created on day
one, with an arch test certifying it as correct. The reason `core/lib` reached
130 files is precisely that "shared, non-adapter code" is not a discriminating
category. Neither is "domain".

**Argument C — the human's ask is about *navigability*, and layers do not give
it.** "Coder worker would have its own primitives, helpers, etc." is a claim
about *change locality*: when I change how the Coder runs, I want one folder to
open. Under layers, that change touches `engine/agent-runtime`,
`domain/workers`, `domain/lib/worker-*`, `adapters/cli/commands/worker.ts` —
four folders, three layers, by design. Layers optimise for swapping an entire
tier (a different persistence engine, a different transport). Mars does not do
that. Mars adds features, and features are vertical.

**Argument D — ADR-0056's own layer definitions are unstable under its own
rules.** ADR-0056 puts "stores" and "application services" in Domain. ADR-0052
makes Arc the sole writer of task state; ADR-0055 makes application services the
one display seam. So `domain/` contains: aggregates, invariants, stores, events,
*and* the application services that adapters call. That is four different kinds
of thing distinguished only by "not engine, not adapter". Two of them (Arc,
services) are the most-changed code in the repo.

### 1.3 The position

> **Vertical slices become the top-level physical unit. ADR-0056's three layers
> survive as a dependency *rule*, applied within and between slices, not as a
> directory layout.**
>
> ADR-0056 is **amended, not superseded wholesale.** Its decision that Mars is
> one library with an arch-test-enforced downward dependency direction is kept
> and strengthened. Its decision that *the layers are the folders* is superseded.

Concretely, per clause:

| ADR-0056 clause | Verdict |
| --- | --- |
| "One library `@mars/mars`. No internal package ladder." | **Kept.** Slices are folders in one lib, not packages. |
| "Three logical layers with strict, arch-test-enforced dependency direction." | **Kept as a rule.** Reframed: the enforced graph is now slice-level (§4), with the layer roles applied *inside* each slice. |
| "**The layers are folders, not packages.**" | **Superseded.** The folders are slices. Layer role is expressed by file/module role inside a slice (`model.ts`/`service.ts`/`store.ts`/adapter modules), not by a top-level directory. |
| "Engine — workflow runtime, agent runtime, claude-session, git-worktree. Knows nothing of tasks/arcs." | **Kept, and promoted.** Engine is not a *layer beneath* the slices; it is a **peer root** (`runtime/`) that no slice may be imported by. It is the one part of the tree with genuinely no domain concern to slice on, so it stays horizontal. This is the honest exception, and it should be named as one. |
| "Engine **exports step primitives** (`setupWorktree, runAgent, verify, merge`) for scaffolded workflows." | **Kept as a published contract; relocated as an implementation.** See §5 — the *names* and the import path survive as a barrel; the *bodies* move into the owning slices. |
| "Domain — aggregates, invariants, stores, events, application services. Process/HTTP/TTY-free." | **Kept as a per-slice rule.** Each slice has its own aggregates/stores/services, and each slice's non-adapter modules stay process/HTTP/TTY-free. Enforced per slice rather than once globally — which is strictly stronger. |
| "Adapters — daemon, CLI, UI, TUI, skills. Thin; call application services." | **Kept.** ADR-0055 is unaffected and in fact easier: the application service is now literally the slice's `index.ts` (§4.3). |

**Nothing here contradicts ADR-0055 or ADR-0052.** ADR-0055 says every display
calls one application-service layer — under slices, that layer is the union of
the slices' public surfaces, composed by one facade (`app-services.ts` already
exists, 1,466 LOC, and becomes the composition root). ADR-0052 says Arc is the
sole writer of task/arc state — under slices, that is expressed as *only the
Execution slice contains a task-table writer*, which is a far easier arch test
to write than "no raw `INSERT INTO tasks` outside one file".

**ADR-0023** (leaf-granular CLI commands, `run(args, deps) -> CommandResult`) and
**ADR-0021** (injected `TaskStore`/`StateStore`, raw client never exported) are
untouched and become easier: `deps` is a bag of slice surfaces.

### 1.4 What this means for the ADR record

If accepted, this needs **one new ADR** that:
- amends ADR-0056 clause-by-clause per the table above (explicitly striking
  "the layers are folders"),
- records the slice list (§2) as the boundary set,
- records the import DAG (§4) as the enforced rule.

It should *not* supersede ADR-0056 outright. Most of ADR-0056 — one library,
scaffolded plain-JS workflows, sandboxed store access, the build-guard
principle — is correct and load-bearing.

---

## 2. The slice list

Derived from the six documented bounded contexts (`PRD-ddd-restructure.md`
§"Bounded contexts") **plus** what is actually on disk. Two findings from that
reconciliation:

- The documented contexts miss two real clusters: **Conversation** (chat) and
  **Improvement** (steward / forge / scorer / promotion). Neither existed when
  `aggregate-catalog.md` was written. Together they are ~60 files. Pretending
  they are sub-parts of Planning and Observability is how `core/lib` happened.
- **Provisioning** as documented (project registry, supervisor, install,
  workflow scaffold) is coherent and small.

Proposed tree:

```
orchestrator/src/
  kernel/          # shared kernel — domain vocabulary, no upstream deps
  platform/        # technical substrate — db, config, process. No domain.
  runtime/         # ADR-0056 "engine": workflow + agent + session + git-worktree
    workflow-api/  # the PUBLISHED step-primitive barrel (§5)
  slices/
    planning/
    execution/
    recovery/
    attention/
    observability/
    conversation/
    improvement/
    provisioning/
  apps/
    cli/
    daemon/
    mcp/
ui/src/
  slices/<same names>/   # presentation for the same boundaries
  app/                   # shell, routing, providers
```

Per slice below: **owns** (the domain question), **moves in** (real folders and
files today), **public surface** (what `index.ts` exports).

---

### 2.1 `execution`

**Owns:** *"What work exists, what state is it in, and how does one unit of work
get from queued to merged?"* Home of the Arc aggregate root and therefore, per
ADR-0052, the **sole writer of task/arc state**. This is the largest and most
constrained slice.

**Moves in:**
- `core/arc.ts` (3,243), `core/queue.ts` (2,082), `core/queue-retry.ts`,
  `core/queue-fix-tasks.ts`, `core/blocker-resolution.ts`, `core/land-task.ts`,
  `core/context.ts`, `core/author.ts`, `core/workflow-configs.ts`,
  `core/verify-gates.ts`, `core/verify-gates-reconcile.ts`
- `core/store/task-store.ts`, `core/store/merge-job-store.ts`
- `core/workers/**` (9 files + `providers/`) — Coder/Fixer/Investigator worker
  wiring, `provider-bin.ts`, `providers.ts`, `providers/codex-headless.ts`,
  `providers/gemini-headless.ts`, `run-pty-session.ts`, `stall-diagnostics.ts`
- `core/lib`: 29 files / 6,630 LOC **(measured)** — `arc-digest`, `arc-verifier`,
  `origin`, `origin-tree`, `blocker-invariant`, `dispatch-gate`,
  `resolve-task-cwd`, `run-worker-with-span`, `worker-json`, `worker-liveness`,
  `verify`, `no-commit-marker`, `collect-integration-evidence`,
  `git-metadata-preflight`, `dirty-main-salvage`, `main-dirty`,
  `repo-root-branch-warning`, `worktree-{ahead-payload,clean,dependents,install,prune,reclaim}`,
  `orphan-reaper`, `claude-{session-ids,stream,transcript,usage}`, `step-evaluators`
- `core/lib/git/**` (8 files / 4,718 LOC **measured**) — but see Q6: `git`
  arguably splits between `runtime` (mechanics) and `execution` (policy)
- `workflows/`: `implement-workflow.ts`, `queue-workflow-store.ts`,
  `validate-workflow.ts`, `triage-workflow.ts`, `context-gathering-brief.ts`,
  `tdd-brief.ts`
- `core/daemon/`: `continue-task.ts`, `restart-task.ts`, `remerge-task.ts`,
  `purge-task.ts`, `arc-purge.ts`, `validate-task.ts`, `merge-worker.ts`,
  `land-work.ts`, `dispatch-hint.ts`, `requeue-{ceiling,diagnostics}.ts`,
  `task-flight-tracker.ts`, `reconcile-{running,blocker-drift}.ts`,
  `phase-recovery.ts`, `pause-state.ts`, `startup-reconcile.ts`,
  `phantom-task-watchdog.ts`, `awaiting-validation-watchdog.ts`
- `cli/commands/`: `task.ts`, `lifecycle.ts`, `step.ts`, `merge.ts`, `run.ts`,
  `worker.ts`, `worktree.ts`, `purge.ts`, `verify.ts`, `verify-gate.ts`
- `outbox/subscribers/` — the blocker-resolution / terminal-transition drains

**Public surface (`slices/execution/index.ts`):**
```ts
arcs:    { createOrigin, addContinuation, list, show, status }
actions: { transition, block, unblock, drop }
queue:   { dispatchable, pauseState }
verify:  { gatesFor, recordResult }
readModel: { taskRow, arcRollup }   // read DTOs other slices may consume
```
Everything else — the raw store, `updateTask`, the workers, git — is internal.

---

### 2.2 `planning`

**Owns:** *"What should we do, and how does an idea become units of work?"*
Proposals, the Tree aggregate, slicing, glossary and ADR curation.

**Moves in:** `core/proposals.ts`, `ideas/`, `core/lib/glossary.ts`,
`core/lib/adr.ts`, `core/lib/primitive-catalog.ts`,
`workflows/slice-workflow.ts` (1,818), `workflows/plan-workflow.ts`,
`workflows/agent-draft.ts`, `workflows/slice-reference-validator.ts`,
`cli/commands/{proposal,propose,adr,glossary}.ts`,
`core/daemon/promote-from-thread.ts`.
From `core/lib`: 6 files / 1,835 LOC **(measured)** — but 3 of those 6
(`chat-store`, `chat-mars-verbs`, `chat-feedback-query`) go to `conversation`
if Q3 is answered "own slice"; then Planning takes 3 files / **NOT VERIFIED LOC**.

**Public surface:** `proposals: { create, setField, promote, reject, slice }`,
`trees: { list, show }`, `glossary: { list, show, set, remove }`,
`adr: { list, show, add }`.

**Note:** `slice()` emits into Execution. That is the single most important
slice-to-slice edge in the system and it must go through
`execution.arcs.createOrigin` — never a direct store write. See §4.

---

### 2.3 `recovery`

**Owns:** *"A unit of work failed. What kind of failure is it, and what is the
one recovery attempt?"* Failure classification, recipes, diagnose probes, the
one-recovery-per-origin budget, storm detection.

**Moves in:** from `core/lib`, 14 files / 3,877 LOC **(measured)** —
`diagnose`, `diagnose-followup`, `diagnose-verdict`, `fix-recipes`, `recipes`,
`learned-recipes`, `improvement-recipes`, `derive-repro-command`,
`missing-helper-classifier`, `retry-budget`, `step-prompt-recovery`,
`signature-storm-monitor`, `failure-reflector`, `loop-ledger`.
Plus `core/recipes/`, `core/rescue-operator-spawn.ts`,
`core/workers/rescue-operator.ts`, `core/daemon/{storm-breaker,storm-evidence,compensation-prompt}.ts`,
`core/daemon/{daemon-died-sweep,daemon-killed-sweep}.ts`,
`cli/commands/diagnose.ts`.

**Public surface:** `recovery: { classify(signature), recipeFor(kind), spawn(failedAction), diagnose(action) }`,
`stormBreaker: { state, trip, clear }`.

**Constraint:** Recovery *decides*; Execution *writes*. `recovery.spawn` returns
a spec; `execution.arcs.spawnRecovery` persists it. This keeps ADR-0052 intact
and keeps Recovery free of the task table. (This is a change from today, where
`core/queue-fix-tasks.ts` writes directly.)

---

### 2.4 `attention`

**Owns:** *"What needs a human right now, and why?"* The Action Queue projection
(ADR-0048: pure projection, no dismiss verb), the arc-rooted Alert aggregate
(ADR-0051), notices, deferrals, situation reports.

**Moves in:** from `core/lib`, 11 files / 3,744 LOC **(measured)** —
`action-queue` (1,540), `action-queue-recipes`, `alert`, `arc-alert-predicate`,
`notice-store`, `todo-feed`, `derived-row-actions`, `deferral-store`,
`situation-report`, `conversation-copy`, `conversation-delivery`.
Plus `core/daemon/{action-queue-repopulator,alert-dismisser,deferral-wake-sweeper,main-dirty-action-queue,stale-queued-watchdog,stale-worktree-sweep,stale-detection}.ts`,
`cli/commands/{action-queue,alert,notice,notifications}.ts`,
`core/daemon/view/**` (7 files) for the queue views.

**Public surface:** `actionQueue: { view() }`, `alerts: { list, show }`,
`notices: { list, raise }`, `deferrals: { list, defer, wake }`.

**Constraint:** read-only over Execution and Recovery. `alert-dismisser.ts` is
suspicious against ADR-0048 — see Q9.

---

### 2.5 `observability`

**Owns:** *"What happened, what did it cost, and is the system getting better or
worse?"* Traces, KPIs, spend/usage, reflection, pressure gauges, retention.

**Moves in:** from `core/lib`, 28 files / 9,634 LOC **(measured)** — the
single largest cluster in `core/lib`: `kpi-{compute,drift,snapshots}`,
`trace-events-store`, `usage-snapshot-store`, `usage-sources`, `spend-meter`,
`budget-pressure`, `machine-pressure`, `observability-prune`, `retention-prune`,
`reflect-query`, `reflect-signals`, `reflector`, `deep-reflector`,
`deep-reflect-query`, `auto-reflect-gate`, `overlap-scorer`, `scorer-runtime`,
`scorer-trend-trigger`, `tool-benchmark`, `api-circuit-breaker`,
`api-endpoint-probe`, `gate-burn-in`, `gate-enrichment`, `gate-meta-monitor`,
`review-packet`, `sweep`.
Plus `core/daemon/{kpi-store,usage-accumulator,usage-sampler,observability-sweeper,observability-watchdog,heartbeat-writer}.ts`,
`core/daemon/spend-control/`, `core/reflector/`, `workflows/reflect-workflow.ts`,
`cli/commands/{reflect,enrich,doctor,provider-probe}.ts`.

**Public surface:** `traces: { list, tail }`, `kpis: { snapshot, window }`,
`spend: { meter, pressure }`, `reflect: { run, arcReflect }`.

**Note:** `overlap-scorer` / `scorer-runtime` / `scorer-trend-trigger` sit on the
boundary with `improvement` — see Q4.

---

### 2.6 `conversation` *(proposed, not in the documented context list)*

**Owns:** *"How does a human talk to Mars, and how does a conversation become
work?"* Chat threads, streaming, compaction, the chat MCP surface, chat→task
promotion.

**Moves in:** `core/daemon/chat-*.ts` (11 files: `chat-runner`,
`chat-stream-hub`, `chat-context`, `chat-mcp`, `chat-memory-window`,
`chat-onboarding-prompt`, `chat-shell`, `chat-skills`, `chat-system-prompt`,
`chat-thread-tasks`, `chat-compaction-sweeper`), `core/daemon/ui-message-chunks.ts`,
`core/daemon/codex-api.ts`, `core/lib/{chat-store,chat-mars-verbs,chat-feedback-query}.ts`,
`core/store/memory-packet-store.ts`, `cli/commands/chat-feedback.ts`,
`ui/widgets/chat/**` (19 files), `ui/pages/ChatPage.tsx` (3,020).

**Why its own slice:** it has its own store, its own runtime, its own transport
(SSE hub), its own MCP surface, and the biggest single UI page. It also contains
the *known* 3-file cycle `chat-runner ↔ chat-stream-hub ↔ ui-message-chunks`,
which is intra-slice and therefore becomes legal-but-contained rather than a
cross-boundary violation.

**Public surface:** `chat: { threads, send, stream, promoteToTask }` — where
`promoteToTask` delegates to `planning` or `execution`.

---

### 2.7 `improvement` *(proposed, not in the documented context list)*

**Owns:** *"How does Mars change itself?"* Steward, skill forge, tool forge,
prompt optimisation, tool promotion, self-evolve triggers.

**Moves in:** `core/{steward-guard,steward-ledger,steward-prompt-optimizer,scorers,scorer-results,promotion-decide,promotion-ledger,reflect-workflow-fit}.ts`,
`core/lib/{skill-forge-detector,skill-forge-synthesizer,skill-forge-validate,tool-forge-scanner,steward-workflow-patch,self-evolve-trigger}.ts`,
`core/store/tool-promotion-store.ts`, `core/daemon/scoring-pool.ts`,
`workflows/tool-forge-workflow.ts`,
`cli/commands/{steward,skill-forge,tool-forge,scorer,tool-promotion}.ts`.
**~25 files, LOC NOT VERIFIED.**

**Public surface:** `improvement: { steward: {…}, forge: {…}, promotion: {…} }`.

**Why call it out:** this cluster is invisible in `aggregate-catalog.md`. If it
is not given a boundary, it will be split across Observability and Provisioning
and re-create a junk drawer within two quarters.

---

### 2.8 `provisioning`

**Owns:** *"How does Mars get installed, configured, and kept current in a
repo?"* Install/init, templates, project registry, deployment providers,
workflow scaffolding, self-update.

**Moves in:** `init/` (13 files) incl. `import-sqlite.ts` and
`templates/`, `registry/`, `core/lib/deployment/` (6 files / 438 LOC
**measured**), `core/lib/dev-server.ts`,
`core/daemon/{install-route,self-update,github-update-poller,deployment-status-sweeper,dev-staleness,preview-registry}.ts`,
`workflows/{init-workflow,authoring,workflow-lint}.ts`,
`cli/commands/{install,self-update,deploy,credentials,workflow,release-notes,preview-validation}.ts`.

**Public surface:** `install: { init, update }`, `projects: { add, list, remove }`,
`workflows: { list, scaffold, validate, reload }`, `deploy: { providers, status }`.

---

### 2.9 `runtime` (the ADR-0056 engine — a peer root, not a slice)

**Owns:** *"How does a durable step execute?"* No knowledge of tasks or arcs.

**Contains:** `packages/workflow/` (7 files), `packages/claude-session/` (5),
`core/lib/pty/` (1 file / 61 LOC **measured**), `core/agents/`,
`core/lib/run-tool.ts`, the git *mechanics* half of `core/lib/git/`,
and `runtime/workflow-api/` — the published step-primitive barrel (§5).

**Rule:** `runtime` may not import any slice. Slices may import `runtime`.

---

### 2.10 `kernel` and `platform` (two things, not one)

`aggregate-catalog.md` §8 lists a single "Shared kernel" containing ids, bus
events/outbox, `FailureKind`, and `Status`. That is right about *domain
vocabulary* but silently omits the *technical substrate* (db drivers, settings,
credentials). Merging them is how a shared kernel turns into a junk drawer,
because "everyone needs it" is true of both and they have opposite change rates.

- **`kernel/`** — domain vocabulary. No upstream deps at all. `MarsId`/`BareId`
  (`mars-id/`), `Status` + the transition contract, `FailureKind` /
  `failure-class` / `failure-signature` / `truncate-failure`, bus event types
  (`bus/`, `internal-bus/`), outbox contract. **7 files / 2,024 LOC** from
  `core/lib` **(measured)** plus `mars-id/`, `bus/` (7), `internal-bus/` (2),
  `outbox/` (6).
- **`platform/`** — technical substrate. May import `kernel` only. `db`,
  `libsql`, `node-sqlite`, `pg-schema`, `pg-server`, `db-busy-watchdog`,
  `structured-write`, `settings`, `credential-store`, `sentinels`,
  `workflow-terminal-error`. **12 files / 3,673 LOC** from `core/lib`
  **(measured)** plus `core/store/state-client.ts` and `state-store.ts`
  (ADR-0021: raw client stays unexported).

---

### 2.11 The UI

The human's "no widgets folder" applies here directly. `ui/src` today is
`widgets/` (57 files), `shared/` (63), `pages/` (27), `entities/` (~22 across 9
subfolders), `hooks/`, `components/`. `entities/` is already almost the right
idea — `alerts`, `actionQueue`, `proposals`, `kpi`, `watchtower`,
`stale-worktrees`, `notifications`, `primitive`, `studio` — but the *view* code
for those entities lives in `widgets/` and `pages/`, so every feature is split
across three folders. That split is also the second SCC in the brief
(`widgets/chat → hooks → widgets → entities → shared → components`).

Proposal: `ui/src/slices/<slice-name>/` with the **same names as the backend
slices**, each holding its own components, hooks, query bindings and types.
`ui/src/app/` keeps only the shell (routing, providers, theme). Genuinely
generic primitives (`components/ui/**` — 17 files of shadcn-style controls) stay
as `ui/src/ui/` because they carry no domain meaning; that is the one legitimate
"widgets" folder and it should be renamed to make its non-domain status obvious.

---

## 3. The shared kernel problem

This is where vertical slicing usually dies, so it gets the most evidence.

### 3.1 The measurement

`core/lib` top-level: **114 non-test `.ts` files, 32,581 raw lines (measured)**.
Plus `git/` (8 files / 4,718), `deployment/` (6 / 438), `pty/` (1 / 61).

Assigning every one of the 114 to exactly one destination — no file was left
unassigned, no file needed two homes:

| Destination | Files | Raw LOC | Share of files |
| --- | ---: | ---: | ---: |
| `slices/observability` | 28 | 9,634 | 24.6% |
| `slices/execution` | 29 | 6,630 | 25.4% |
| `slices/recovery` | 14 | 3,877 | 12.3% |
| `slices/attention` | 11 | 3,744 | 9.6% |
| `platform/` (technical substrate) | 12 | 3,673 | 10.5% |
| `kernel/` (genuine shared kernel) | 7 | 2,024 | 6.1% |
| `slices/planning` (3) + `conversation` (3) | 6 | 1,835 | 5.3% |
| `slices/improvement` + `provisioning` | 7 | 1,164 | 6.1% |
| **total** | **114** | **32,581** | **100%** |

**Read the top of that table.** 95 of 114 files (83%) belong to **exactly one
slice**. Only 7 files (6%, 2,024 LOC) are genuine shared kernel. `core/lib` is
not a shared kernel that grew; it is a co-location accident that was never a
kernel at all.

### 3.2 The independent check: fan-in

Counting, for each `core/lib` file, how many *distinct other folders* import it
under an explicit `.../lib/<name>` path (**measured**, `grep -rl`, tests
excluded):

| Distinct importing folders | Files |
| ---: | ---: |
| 4 or more | **6** |
| 2–3 | 37 |
| exactly 1 | 47 |
| 0 under this spelling | 24 |

The only files imported by 4+ folders are `action-queue` (7), `claude-stream` (6),
`db` (6), `trace-events-store` (6), `failure-signature` (4), `retry-budget` (4).

**Method caveat (be honest):** this grep matches the literal path fragment
`lib/<name>'`, so sibling imports written `./<name>` inside `core/lib` and any
alias spellings are missed. The 24 "zero" files are mostly intra-`lib` or
entry-point-registered, not dead — spot checks found e.g. `verify` with 6
external importers under a different spelling. Treat the table as *lower bounds
on fan-in* and therefore as **conservative** evidence for the claim: even
under-counting, only 6 files look repo-wide, and generously fewer than ~15 do.
The other ~100 are single-consumer code sitting in a shared folder.

Two of the six high-fan-in files are exactly the ones the slice model predicts:
`db` → `platform`, `failure-signature` → `kernel`. `action-queue` and
`trace-events-store` having 6–7 importing folders is the *symptom*: adapters
reach into projection internals instead of calling a service (precisely what
ADR-0055 forbids). Those two do not become kernel; they become the internals of
`attention` and `observability`, and their current importers become callers of
`attention.actionQueue.view()` and `observability.traces.*`.

### 3.3 The three categories, answered

**(a) Genuine shared kernel — 7 files / 2,024 LOC from `core/lib` (measured),
plus `mars-id/`, `bus/`, `internal-bus/`, `outbox/`.**
`failure-kinds`, `failure-class`, `failure-signature`, `truncate-failure`,
`outbox`, `outbox-lag`, `outbox-prune`. Test for admission: *is it a noun every
slice says out loud in the glossary, with no behaviour of its own beyond
classification and identity?* `FailureKind` passes (ADR-0042 makes it a
vocabulary). `MarsId` passes (ADR-0039). `Status` + the transition contract
passes. The outbox passes as the delivery substrate (ADR-0030/0031).

**Kernel admission must be adversarial.** Recommended hard cap: **the kernel may
not exceed 15 files, and adding a file to it requires naming the ≥3 slices that
need it.** A cap is arbitrary but the absence of one is what produced 130 files.

**(b) Belongs to exactly one slice — 95 of 114 files / 26,884 LOC (measured).**
The table in §3.1. This is the bulk of the move and it is mechanical: no file in
this category was ambiguous enough to need two homes, though 6 were close calls
(§3.4).

**(c) Duplicated and should stay duplicated.** The category vertical slicing
exists to permit, and the one people refuse to accept. **Counts here are
estimates — NOT VERIFIED.**

| Thing | Why duplication is correct | Est. sites |
| --- | --- | --- |
| Read DTOs / row shapes per slice | `attention`'s view of a task ≠ `observability`'s ≠ the UI's. A single `Task` type is what forces 20 folders to import one file. Each slice defines the projection *it* returns. | 8 slices |
| CLI output formatting helpers (`cli/commands/shared.ts`) | Table/colour helpers are 20-line functions. Sharing them couples every command's output to one file. | ~2–3 |
| `workflows/primitives/shared.ts` | Same argument, workflow side. | ~2 |
| Small time/string/id-format helpers | Cheaper to copy than to own. | ~10 |
| UI query-key and fetch wrappers per slice | Each slice's data hooks belong with its components. | 8 slices |

The rule to write down: **a helper under ~30 lines with no domain meaning may be
duplicated; a *decision* may never be.** Duplicate `formatDuration`. Never
duplicate "is this arc alertable" (`arc-alert-predicate`) — that is a decision
and it lives in exactly one slice.

### 3.4 The honest close calls

Six files resisted a clean assignment. Each is an Open Question below.

| File(s) | Tension |
| --- | --- |
| `action-queue-recipes.ts` | Recipes are a Recovery vocabulary; the queue is Attention. → Q7 |
| `overlap-scorer`, `scorer-runtime`, `scorer-trend-trigger` | Measurement (Observability) vs self-improvement (Improvement). → Q4 |
| `core/lib/git/**` (4,718 LOC) | Mechanics are `runtime`; merge/verify *policy* is `execution`. → Q6 |
| `claude-{stream,transcript,usage}` | Parsing an agent's output is `runtime`; attributing it to a task is `execution`/`observability`. → Q5 |
| `retry-budget` | High fan-in (4 folders) but is a Recovery *decision* (one attempt, ADR-0040). → Q7 |
| `primitive-catalog.ts` | Catalogues step primitives; sits in the `app-services ↔ http-server ↔ primitive-catalog` 3-cycle. → Q8 |

---

## 4. The import rule

### 4.1 Zones and their allowed targets

Five zones. Each may import only from zones below it, plus the explicit
slice-to-slice rule in §4.2.

| Zone | May import |
| --- | --- |
| `kernel/` | nothing (no upstream deps, per `aggregate-catalog.md` §8) |
| `platform/` | `kernel` |
| `runtime/` | `kernel`, `platform` |
| `slices/<x>/` | `kernel`, `platform`, `runtime`, and **other slices' `index.ts` only** (§4.2) |
| `apps/{cli,daemon,mcp}` and `ui/` | `kernel`, `runtime` types, and **slices' `index.ts` only** |

Note what is *not* on the list: `runtime` may never import a slice — that is
ADR-0056's engine clause, kept verbatim in effect. And no zone may import an
app. Those two rules alone kill most of the 22-folder SCC, because
`core/daemon` and `cli/commands` (both apps) currently sit inside it.

### 4.2 Slice-to-slice: allowed, but only through the barrel, and only downhill

**Position: slice-to-slice imports are allowed. Requiring every cross-slice call
to go through an event bus or a separate application-service package would be a
bigger change than the human asked for, would hide the ADR-0052 constraint
behind indirection, and would make `planning.slice() → execution.createOrigin`
asynchronous for no reason.**

Two constraints instead:

1. **Barrel-only.** A slice may import *only* `slices/<other>/index.ts`. Deep
   imports (`slices/execution/queue.ts`) are forbidden. The barrel *is* the
   application service (ADR-0055) — there is no second layer to build.
2. **Declared DAG.** Slice-to-slice edges must be acyclic and each edge must be
   named in the rule file. Proposed DAG (arrow = "may import"):

```
planning ──────────► execution ◄────── conversation
                        ▲   ▲
recovery ───────────────┘   │
                            │
attention ──► execution, recovery
observability ──► execution            (read-only)
improvement ──► observability, execution
provisioning ──► (none)
```

Reading the important edges:
- `planning → execution`: slicing a proposal creates arcs. **One direction only.**
  Execution must never import Planning; if Execution needs a proposal id it
  takes it as data.
- `recovery → execution`: Recovery reads a failed action and *returns a spec*;
  Execution persists it (§2.3). Execution must not import Recovery — instead the
  daemon app wires `recovery.spawn` into the failure path. This inverts today's
  `core/queue-fix-tasks.ts` and is the single biggest behavioural change the
  boundary implies.
- `attention → execution, recovery`: read-only projection. Guarded additionally
  by "no writer imports outside `execution`".
- `observability → execution`: read-only. `improvement → observability` because
  self-improvement consumes scores.
- `provisioning → nothing`: it installs, it does not run work. If it needs to
  seed a task, the *app* wires it.

### 4.3 Where ADR-0056's layers live now

Inside each slice, unchanged in spirit:

```
slices/execution/
  index.ts        # the application service (ADR-0055 seam). The ONLY public file.
  model/          # aggregates + invariants. No I/O, no process, no HTTP, no TTY.
  service/        # use-cases. May touch model + store + runtime.
  store/          # persistence. Imports platform. Raw client never re-exported (ADR-0021).
  workflow/       # step bodies this slice owns (§5)
  cli/            # this slice's leaf commands: run(args, deps) -> CommandResult (ADR-0023)
  daemon/         # this slice's subscribers/watchdogs, registered by the daemon app
```

Intra-slice direction: `cli|daemon|workflow → index → service → model`, and
`service → store → platform`. `model/` importing anything but `kernel` is a
violation. This is ADR-0056's downward rule, applied eight times instead of once
— strictly stronger, because today "domain" would be one 45k-LOC bag.

The `cli/` and `daemon/` subfolders inside a slice are the direct answer to
"Coder worker would have its own primitives, helpers, etc." — everything about
running a Coder lives under `slices/execution/`, not scattered across four
top-level folders.

### 4.4 The dependency-cruiser rule (sketch)

There is **no linter in this repo** (no ESLint, no Biome, no oxlint), so this
must be a standalone `depcruise` run in CI plus an arch test. Sketch — needs a
real pass before it is trusted:

```js
// .dependency-cruiser.cjs (sketch — NOT VERIFIED against depcruise 18.1.0 semantics)
forbidden: [
  { name: 'kernel-imports-nothing',
    from: { path: '^orchestrator/src/kernel/' },
    to:   { pathNot: '^orchestrator/src/kernel/' } },

  { name: 'platform-kernel-only',
    from: { path: '^orchestrator/src/platform/' },
    to:   { pathNot: '^orchestrator/src/(platform|kernel)/' } },

  { name: 'runtime-never-imports-slices',
    comment: 'ADR-0056: the engine knows nothing of tasks/arcs',
    from: { path: '^orchestrator/src/runtime/' },
    to:   { path: '^orchestrator/src/(slices|apps)/' } },

  { name: 'no-deep-cross-slice-import',
    comment: 'a slice is reachable only through its index.ts barrel',
    from: { path: '^orchestrator/src/slices/([^/]+)/' },
    to:   { path: '^orchestrator/src/slices/(?!$1/)[^/]+/.+',
            pathNot: '^orchestrator/src/slices/[^/]+/index\\.ts$' } },

  { name: 'no-slice-imports-app',
    from: { path: '^orchestrator/src/slices/' },
    to:   { path: '^orchestrator/src/apps/' } },

  { name: 'model-is-pure',
    comment: 'ADR-0056: domain is process/HTTP/TTY-free',
    from: { path: '^orchestrator/src/slices/[^/]+/model/' },
    to:   { path: 'node:(child_process|http|https|net|tty|fs)|^express$' } },

  { name: 'no-slice-cycles', from: {}, to: { circular: true } },
]
```

Plus one arch **test** that depcruise cannot express: *no SQL writing to
`tasks`/`task_blockers` outside `slices/execution/store/`* (ADR-0052).
A `grep`-based test over the tree is adequate and honest.

**Landing order matters.** ADR-0056's own risk table says it: land the guard
**last**, after the moves, with an explicit allowlist and a burndown. Do not
turn the rule on mid-move — 28 folders are currently in cycles and the rule
would be red for weeks and get disabled.

---

## 5. Where primitives go

### 5.1 The facts

`workflows/primitives/` is 6 non-test files, of which `index.ts` is **3,104
LOC** — the third-largest file in the repo. It exports exactly six step
primitives plus their option/result types **(measured)**:

`setupWorktree` · `runAgent` · `review` · `merge` · `awaitHuman` ·
`finalizeReport` (plus `resolveWorktree`, `buildPhaseCtx`, `MarsCtx`,
`MarsServices`, `MarsWorkflowInput`, `readWorkflowInput`).

ADR-0056 is unambiguous that these are a **published surface**: scaffolded
`.mars/workflows/*.js` files "import `defineWorkflow` + the step primitives from
the installed `mars` lib (the single `mars/workflow` surface)", and consumers own
those files (`mars update` never overwrites them, ADR-0057). Breaking the import
path or the names breaks *consumer* code, not just ours.

### 5.2 The position: decompose per slice, keep one published barrel

Not "exception", not "rename". **Both**, split along the line between contract
and implementation:

- **The contract stays.** `runtime/workflow-api/index.ts` continues to export
  `defineWorkflow`, `MarsCtx`, `MarsServices`, and the six primitive names from
  one module reachable as `mars/workflow`. Consumer files keep working
  unchanged. This is a *published package surface*, and a published surface is
  allowed to be a barrel — that is what barrels are for.
- **The implementations move into the slices that own them.**

| Primitive | Owning slice | Rationale |
| --- | --- | --- |
| `setupWorktree` | `execution` | worktree-per-task is an Execution invariant, not a runtime one |
| `merge` | `execution` | serialised merge + lock is Execution policy |
| `review` | `execution` | verify gates live in `core/verify-gates.ts` |
| `runAgent` | `runtime/agent` + a thin `execution` binding | agent spawn is genuinely engine; task attribution is not |
| `awaitHuman` | `attention` | parking a task is an Operator Attention concern; it raises the queue row |
| `finalizeReport` | `observability` | the report pipeline's terminal step persists a transcript |

Target: `runtime/workflow-api/index.ts` shrinks from 3,104 LOC to **under ~150**
— type declarations and re-exports.

### 5.3 Why this satisfies both constraints

The human's objection is to `primitives/` as *organisation*: a folder named
after a technical shape rather than a domain concern, holding six unrelated
behaviours. That objection is completely answered by moving the bodies —
after the move, "how does setup work?" is answered inside `slices/execution/`,
next to the worktree code and the Coder worker, which is exactly the "Coder
worker has its own primitives" ask.

ADR-0056's constraint is on the *import path and names*. That is untouched.

The one real cost: the barrel imports from five slices, making it a top-of-DAG
node. That is fine and should be stated explicitly in the rule — `runtime/workflow-api/`
is a **composition root**, exempt from `runtime-never-imports-slices` in the
same way `apps/cli` is. If that exemption feels like cheating, the alternative
is to move the barrel to `apps/workflow-api/` and have the packaging step
publish it as `mars/workflow`. **Recommendation: move it to `apps/`** — it is a
consumer-facing adapter, and calling it that removes the need for an exemption
entirely.

### 5.4 What must NOT happen

Do not distribute the *published names* per slice
(`mars/execution/setupWorktree`). Consumer workflow files are user-owned Hybrid
files that `mars update` refuses to overwrite (ADR-0057) — a path change is
unfixable-by-us breakage in every consumer repo. The hard-cut rule in CLAUDE.md
applies to *internal* API churn; this surface is external.

---

## 6. Open questions for the human

The agenda for the discussion you asked for. Each has a recommendation and the
trade-off you are accepting by taking it.

---

**Q1 — Do slices become the top-level unit, superseding ADR-0056's
"the layers are folders" clause?**

*Recommendation:* **Yes.** Amend ADR-0056 clause-by-clause (§1.3 table) via a
new ADR; do not supersede it wholesale.

*Trade-off:* You give up the ability to swap a whole tier at once (a different
persistence engine now touches eight `store/` folders instead of one
`domain/store/`). In exchange, every *feature* change touches one folder. Mars
changes features constantly and has changed persistence twice in its life. If
you expect a third persistence change soon, that calculus shifts — say so now.

---

**Q2 — Eight slices, or fewer?**

Proposed: `planning`, `execution`, `recovery`, `attention`, `observability`,
`conversation`, `improvement`, `provisioning`. The documented set has six;
`conversation` and `improvement` are my additions (~60 files that currently have
no home).

*Recommendation:* **Eight.** Both additions are >20 files with their own stores
and their own UI.

*Trade-off:* More slices = more barrels = more ceremony for small changes, and
`conversation`/`improvement` are the two least-settled parts of the system, so
their boundaries will move. Folding them into `planning` and `observability`
respectively is defensible and gets you to six — but §3 shows exactly what
happens to code with no home, and it is the shape of `core/lib`.

---

**Q3 — Is `conversation` its own slice, or part of `planning`?**

Chat is how ideas arrive; it also has 11 daemon files, a store, an SSE hub, an
MCP surface, and the 3,020-line `ChatPage.tsx`.

*Recommendation:* **Own slice.** Folding it into Planning roughly triples
Planning's size and mixes a transport concern (streaming) with a modelling
concern (proposals).

*Trade-off:* `conversation → planning → execution` is a three-hop chain for
"user types a task in chat". If that feels like too much indirection for the
most common path, fold it in.

---

**Q4 — Do the scorers belong to `observability` or `improvement`?**

`overlap-scorer`, `scorer-runtime`, `scorer-trend-trigger`, `core/scorers.ts`,
`core/scorer-results.ts`, `core/daemon/scoring-pool.ts`.

*Recommendation:* **Split.** Scoring *runtime and results* → `observability`
(it measures). *Acting on a trend* (`scorer-trend-trigger`,
`self-evolve-trigger`, promotion decisions) → `improvement`.

*Trade-off:* The split runs through the middle of a currently-coherent
mechanism, and `improvement → observability` becomes a required DAG edge.
Putting all of it in `improvement` is simpler but makes Observability
incomplete — the UI would read scores from a slice named "improvement".

---

**Q5 — Where does Claude/agent transcript parsing live?**

`claude-stream` (6 importing folders — one of only six high-fan-in files),
`claude-transcript`, `claude-usage`, `claude-session-ids`.

*Recommendation:* **Split by what the data means.** Parsing an agent's stream is
`runtime` (it is about the agent protocol, not about tasks). Attributing tokens
to a task is `observability`. Attributing a session id to an arc is `execution`.

*Trade-off:* Three homes for what is today four adjacent files, and
`claude-stream`'s six importers all have to be re-pointed. Keeping all four in
`runtime` is cheaper and only slightly wrong — the counter-argument is that
`claude-usage` knows about spend, which is a domain concept.

---

**Q6 — Does `core/lib/git/` (8 files, 4,718 LOC) split between `runtime` and
`execution`?**

ADR-0056 puts "git-worktree" in the engine. But `merge.ts`, `commit-main.ts`,
`lock.ts` and `verify.ts` encode Mars *policy*: serialise merges on a file lock,
fast-forward into `main`, checkpoint to `refs/mars/checkpoint/<task-id>`.

*Recommendation:* **Split.** `worktree.ts`, `internal.ts`, `checkpoint.ts` →
`runtime/git`. `merge.ts`, `commit-main.ts`, `lock.ts`, `verify.ts`, `claude.ts`
→ `slices/execution/git`.

*Trade-off:* You are cutting a cohesive 4,718-LOC module, and the two halves
will still call each other (downward only, which is legal). Keeping it whole in
`runtime` contradicts ADR-0056's own "knows nothing of tasks/arcs" — `merge.ts`
demonstrably knows about tasks.

---

**Q7 — Do "recipes" belong to `recovery` even when they drive the action queue?**

`action-queue-recipes.ts` and `retry-budget.ts` (4 importing folders) are
Recovery decisions consumed by Attention.

*Recommendation:* **`recovery` owns them; `attention` calls
`recovery.recipeFor(kind)`.** Decisions live in one slice (§3.3c); only data
crosses.

*Trade-off:* Adds an `attention → recovery` DAG edge and makes rendering a queue
row a cross-slice call. The alternative — duplicating the recipe table — is
exactly the "never duplicate a decision" rule violated.

---

**Q8 — Is `primitive-catalog.ts` Planning or `workflow-api`?**

It is in the 3-file cycle `app-services ↔ http-server ↔ primitive-catalog`.

*Recommendation:* **`apps/workflow-api`** (the published barrel, per §5.3) — it
describes the published primitives, so it belongs with them. That also breaks
the cycle, since a slice may not import an app.

*Trade-off:* The UI's `entities/primitive` then reads it through the daemon
rather than importing it, which is one more hop. **NOT VERIFIED** — I did not
read `primitive-catalog.ts`; if it turns out to catalogue *domain* primitives
rather than *step* primitives, this answer is wrong.

---

**Q9 — Does `core/daemon/alert-dismisser.ts` survive?**

ADR-0048 says the action queue is a pure projection with no dismiss/ack/resolve
verb, and `aggregate-catalog.md` §10 lists `/view/todo/dismiss` as **cut**. A
file named `alert-dismisser.ts` is still on disk at `69d4b45d`.

*Recommendation:* **Treat as a boundary violation and delete during the
`attention` move** — but confirm first; it may be a *sweeper* that clears
projection rows when the underlying entity transitions, which is legal and
merely badly named.

*Trade-off:* None if it is dead. If it is live behaviour someone relies on,
deleting it is a UX regression that ADR-0048 nonetheless demands.
**NOT VERIFIED** — I did not read the file.

---

**Q10 — Does the UI mirror the backend slice names exactly?**

*Recommendation:* **Yes, exactly** — `ui/src/slices/attention/` next to
`orchestrator/src/slices/attention/`. Same word for the same boundary, on both
sides of the wire.

*Trade-off:* The UI has real concerns with no backend counterpart (`studio`,
`watchtower`, page layout). Those need either a home in an existing slice or a
UI-only `app/` shell, and forcing a name match can create empty folders. Also
note the UI is a **separate install root** with its own `@/*` alias — mirroring
names does not mean sharing code, and no import may cross between the two trees.

---

**Q11 — Do the slices get their own test trees?**

Tests are **177,444 LOC / 676 files** — larger than source. They currently live
in `__tests__/` folders and alongside sources.

*Recommendation:* **Co-locate per slice** (`slices/execution/**/*.test.ts`), and
move the arch tests to a single top-level `arch/` suite.

*Trade-off:* This is the single largest mechanical diff in the whole plan and it
touches more lines than the source move. It could be deferred to a second pass
— at the cost of a period where tests and sources disagree about the structure,
which is exactly when people give up on a migration.

---

**Q12 — What is the migration unit, and does the guard land last?**

*Recommendation:* **One slice per change, `kernel`/`platform` first, guard last.**
Order: `kernel` → `platform` → `runtime` → `provisioning` (most isolated) →
`observability` → `recovery` → `attention` → `planning` → `conversation` →
`improvement` → `execution` (largest, most constrained) → turn on
`.dependency-cruiser.cjs` + the arch test. ADR-0056's own risk table calls for
exactly this ordering.

*Trade-off:* CLAUDE.md says every change is a **hard cut** — no shims, no
compat, no migration windows. A ten-step move is in tension with that unless
each step is itself a complete hard cut (every call site updated in the same
change, no re-export shims left behind at the old path). **That constraint must
be stated in the implementation brief or agents will leave barrels behind at
`core/lib/*` "temporarily".** Say explicitly whether "hard cut" applies
per-slice-move (my assumption) or to the whole restructure as one change (which
would be a ~1,200-file diff and unreviewable).

---

**Q13 — Is `improvement` in scope at all right now?**

The steward/forge/scorer cluster is the least-settled part of Mars.

*Recommendation:* **Give it a boundary now, move it last** (or leave it in place
behind a `slices/improvement/` barrel that re-exports, and finish the move
later). Naming the boundary costs nothing and stops the code leaking into
Observability meanwhile.

*Trade-off:* A re-export barrel is precisely the "compat shim" CLAUDE.md
forbids. If you hold that line strictly, `improvement` must be either fully
moved or fully out of scope — pick which.

---

## Appendix — what this document did not verify

- `core/lib/deployment`, `core/lib/pty`, `core/agents`, `core/mcp`,
  `core/sweeper`, `orchestrator/src/{commands,stubs,util}`: assigned by name
  only. **NOT VERIFIED.**
- The `ui/` slice mapping (§2.11) is based on folder names and file counts; I
  did not read `ui/src/widgets` or `ui/src/shared` contents. **NOT VERIFIED.**
- LOC for the `improvement` and `conversation` slices. **NOT VERIFIED.**
- The depcruise rule sketch (§4.4) has not been run. Its regex back-reference
  (`$1`) in `no-deep-cross-slice-import` is the part most likely to be wrong.
  **NOT VERIFIED.**
- `alert-dismisser.ts` (Q9) and `primitive-catalog.ts` (Q8) were not read.
- Whether `packages/workflow` and `packages/claude-session` should physically
  move under `runtime/` or stay path-consumed as they are today. Not addressed.
