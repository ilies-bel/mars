# Migration Plan — modular core

> Executable companion to `docs/rework/TARGET-ARCHITECTURE.md`. Every section
> below is sized to be one Mars task. Read the target doc first — this document
> assumes its vocabulary and does not restate its rationale.
>
> Branch: `rework/modular-core`.

---

## 0. Rules that bind every phase

1. **Hard cut, no shims.** No compat re-export barrel left behind "for now", no
   deprecation alias. A move lands with every call site updated in the same
   commit. The one exception is the frozen `mars/workflow` barrel
   (TARGET §1.2) and the step-name aliases (TARGET §4.4) — both are *contracts
   with data and with user files on disk*, not internal convenience.
2. **No behaviour change.** Acceptance for a refactor phase is: the *existing*
   test suite passes unchanged. If a test needs editing beyond an import path,
   stop — you changed behaviour. Say so and raise.
3. **Never grow `.dependency-cruiser-known-violations.json`.** Only Phase H may
   regenerate it, once, because it switches on brand-new rules. Any other phase
   that makes `npm run arch` fail has introduced a cycle: break the cycle.
4. **Never `git stash`** (shared `refs/stash` across Mars worktrees). Park work
   with a wip commit on your own branch.
5. **Commit your own work.** The orchestrator does not commit on your behalf.
   Conventional commits, one per phase, scoped `refactor(container)`,
   `refactor(tools)`, `feat(registries)`, etc.
6. **Do not touch** `.mars/`, `CONTEXT.md`, or `docs/knowledge/decisions/**`
   directly. Glossary edits go through `mars glossary set`; ADRs through
   `mars adr add`.

### Verify commands

```bash
pnpm --filter mars run typecheck      # tsc --noEmit over orchestrator
pnpm --filter mars test               # vitest run  (ADR-0033)
npm run arch                          # dependency-cruiser, root + ui
```

Every phase's done-criteria include all three, green. `npm run arch` is run from
the repo root; the other two resolve into `orchestrator/` via the pnpm filter
(verified — `pnpm --filter mars` binds to `orchestrator/`).

> **`npm run arch` is RED on `rework/modular-core` today, before this rework
> starts.** Measured at the time of writing: the root cruise reports NEW
> `no-circular` errors that are not in the baseline, all inside the
> `core/queue → core/arc → …` spine, e.g.
> `core/queue-retry.ts -> core/queue.ts` (cycle
> `queue -> arc -> queue-retry`) and `core/rescue-operator-spawn.ts ->
> core/lib/action-queue.ts` (cycle `action-queue -> queue -> arc ->
> blocker-invariant -> main-dirty -> queue-fix-tasks -> rescue-operator-spawn`).
> The `ui` cruise is green.
>
> This is **pre-existing drift, not caused by any phase here.** Two consequences:
>
> 1. Capture a **baseline snapshot** of `npm run arch` output before Phase A and
>    record it in the phase-A commit message. A phase is judged on "no *new*
>    errors beyond this snapshot", not on a green run, until the drift is fixed.
> 2. Fixing that drift is its own task — enqueue it separately, do **not** fold
>    it into a rework phase, and under no circumstances "fix" it by regenerating
>    the baseline. Note that the same `arc → blocker-invariant → main-dirty →
>    queue-fix-tasks` spine is the cycle Phase G has to break, so landing the
>    drift fix first makes Phase G materially easier.

---

## 1. Phase map

```
A  engine/ + neutral contracts        ──┐
B  container/                          ─┼─→  D  tools/ split (the big one)
C  registries/ (open sets)            ──┘        │
                                                 ├─→ E  verify heuristics
                                                 ├─→ F  tools wired through the container
                                                 └─→ G  growth/
                                                          │
                                          H  arch rules ←──┘
                                          I  daemon/ path move (optional, last)
```

A, B and C are independent of one another and can run in parallel.
D blocks on all three. E and F block on D. G blocks on B (it needs the event
bus) but not on D. H blocks on everything that moves a file. I is last and
optional.

| Phase | Title | Blocked by | Risk |
|---|---|---|---|
| A | Neutral agent contracts + `engine/` | — | medium (wide rename) |
| B | The container | — | low (all new code) |
| C | Open registries | — | high (closed unions are load-bearing) |
| D | Split `primitives/index.ts` into `tools/` | A, B, C | high (4,622 LOC) |
| E | Verify heuristics out of the runner | D | medium |
| F | Tools resolved through `ctx.tools` | D | medium |
| G | `growth/` — reflect + narration + step suggestion | B | medium (baselined cycle) |
| H | Arch rules + arch tests | A–G | low |
| I | `core/daemon` → `daemon` | H | low value, high churn |

---

## Phase A — neutral agent contracts and `engine/`

**Goal.** No neutral seam names a vendor. `ClaudeEvent` / `RunClaudeResult` /
the `'claude-event'` literal disappear from everything that is not a Claude
adapter.

**Create**

```
orchestrator/src/engine/index.ts          re-export of @mars/workflow
orchestrator/src/engine/agent-event.ts    AgentEvent, AgentTranscript
orchestrator/src/engine/agent-result.ts   AgentInvocationResult
orchestrator/src/engine/agent-runtime.ts  AgentEffort, AgentPermissionMode, AgentRunRequest
```

**Rename (hard cut)**

| From | To |
|---|---|
| `ClaudeEvent` — `core/lib/claude-stream.ts:1` | `AgentEvent` |
| `ClaudeConversation` — `claude-stream.ts:6` | `AgentTranscript` |
| `parseClaudeStreamLine` — `claude-stream.ts:72` | `parseAgentStreamLine` |
| `readClaudeOutput` — `claude-stream.ts:87` | `readAgentOutput` |
| `diagnoseClaudeFailure` — `claude-stream.ts:306` | `diagnoseAgentFailure` |
| `RunClaudeResult` — `core/lib/git/claude.ts:268` | `AgentInvocationResult` |
| `ClaudeEffort` — `core/lib/git/claude.ts:259` | `AgentEffort` |
| `ClaudePermissionMode` — `core/lib/git/claude.ts:260` | `AgentPermissionMode` |
| event literal `'claude-event'` — emitted at `workflows/primitives/index.ts:1468` | `'agent-event'` |

**Do NOT rename in this phase**

- `runClaudeCode` (`core/lib/git/claude.ts:734`) — it *is* the Claude adapter.
  It moves to `tools/coder/providers/claude/` in Phase D.
- The step name `'run-claude-code'` — that is Phase C (§4.4 of the target doc),
  because it needs the primitive registry's alias table to be safe.
- `extractLastStreamText` — already neutral.

**Hazards**

- `'claude-event'` is read at `core/daemon/server.ts:1632`
  (`if (evt.event === 'claude-event')`, the in-flight heartbeat) and interpreted
  in the UI at `ui/src/shared/actionQueueDetail.ts:58,142,225`. **Rows already
  in the outbox carry the old literal.** Emit `'agent-event'`; on the read side
  accept `evt.event === 'agent-event' || evt.event === 'claude-event'` with a
  comment naming this phase and a removal condition ("drop after a release that
  drains the outbox"). Do not migrate historical rows.
- `core/daemon/task-flight-tracker.ts:76,186` and
  `core/daemon/phantom-task-watchdog.ts:22` document the heartbeat in terms of
  "claude-event" — update the comments so the next reader is not misled.

**Verify.** All three commands green. Plus:
`rg -n "ClaudeEvent|RunClaudeResult" orchestrator/src packages ui/src` returns
nothing outside `tools/coder/providers/` (which does not exist yet — so:
nothing at all).

**Done when** the three commands are green, the grep above is empty, and the
daemon's heartbeat test (`core/daemon/__tests__/http-live-agents.test.ts`)
passes untouched.

---

## Phase B — the container

**Goal.** A working meta-framework, unused by anything yet. All new code; it can
land while other phases run.

**Create** `orchestrator/src/container/` per TARGET §2: `context.ts`,
`service.ts`, `seal.ts`, `plugin.ts`, `events.ts`, `disposer.ts`, `types.ts`,
`boot.ts`, `index.ts`.

**The one mistake to not make.** `WorkflowCtx.emit(event, payload)` already
exists (`packages/workflow/src/workflow.ts`) and is the *progress* emitter on the
public authoring surface. The container's dispatch modes go on **`ctx.events`**.
Do not rename, wrap, or shadow `ctx.emit`.

**Implement, in order**

1. `disposer.ts` — `Disposer`, `DisposerSet` (idempotent, LIFO, throwing
   disposers logged not propagated).
2. `events.ts` — `EventDispatcher` with `on / emit / parallel / serial /
   waterfall` exactly as specified in TARGET §3.6. `emit` never awaits;
   `parallel` aggregates rejections; `serial` short-circuits on the first
   non-`undefined`; `waterfall` threads the seed.
3. `service.ts` + `seal.ts` — `provide/get/has/require`, `SEALED_KEYS =
   ['store','traceStore']`, `SealedServiceError` whose message cites ADR-0052.
4. `plugin.ts` — `Plugin { name, inject?, optional?, apply }`, `ForkScope`,
   pending-until-satisfied semantics, dispose-dependents-first on withdrawal.
5. `context.ts` — `MarsContext extends WorkflowCtx<MarsServices, MarsWorkflowInput>`
   with `tools`, `events`, `provide`, `plugin`, `fork`.
6. `types.ts` — `MarsServiceMap`, `MarsToolMap`, `MarsEventMap`,
   `MarsProvidableMap`, all `interface`s so plugins can declaration-merge.
7. `boot.ts` — `createMarsRuntime()`. In this phase it seeds **nothing**; it is
   filled in by C, E and F.

**Tests** (new, `container/__tests__/`): each dispatch mode's ordering and
short-circuit contract; disposer idempotence + LIFO; sealed-key rejection;
`inject` pending → applied → withdrawn → disposed → re-applied; fork isolation.

**Done when** the three verify commands are green and `container/` has zero
imports from `tools|workflows|core|cli|daemon|growth|registries` (checked by
hand this phase; enforced by rule in H).

---

## Phase C — open registries

**Goal.** Replace three closed unions with seedable registries. Highest-risk
phase: the unions are load-bearing for exhaustiveness.

**Create** `orchestrator/src/registries/` — `providers.ts`, `workers.ts`,
`primitives.ts`, `deploy-providers.ts`, `workflows.ts`, `index.ts`.
(`verify-heuristics.ts` is Phase E.)

### C.1 Providers

Open `ProviderName` (`core/workers/provider-types.ts:13`). Fold into
`ProviderDescriptor`: `PROVIDER_MODELS` (`provider-types.ts:24`), `tierForModel`
(`provider-types.ts:50`), `PROVIDERS` (`core/workers/providers.ts:79`),
`usageSemanticsOf` (`providers.ts:75`), `resolveProviderName`
(`providers.ts:247`), `runHeadlessProvider` (`providers.ts:265`),
`core/workers/provider-bin.ts`.

Seed `claude`, `gemini`, `codex` from the existing tables — same models, same
semantics. `ProviderModelTier` stays a closed union.

Every `Record<ProviderName, X>` that loses its exhaustiveness check gains a
`registry.require(name)` call that throws with the list of registered names.
Known sites: `primitives/index.ts:113` (`PROVIDER_MODELS` import),
`core/lib/primitive-catalog.ts:25`, `core/lib/claude-usage.ts` consumers.

### C.2 Workers

Open `WorkerName` (`core/workers/index.ts:97`, 8 members). `Workers` and
`WORKER_CONFIGS` become registry seeds; `pickWorkerForTags` becomes
`registry.selectForTags(tags, kind)`, consulting the container's
`'worker/select'` **serial** event first. `core/workers/persisted-registry.ts`
(operator-declared workers) stops being a special case and registers through the
same API. `runAgent` builds its candidate map at
`primitives/index.ts:1645` (`Record<string, Worker> = { ...Workers }`) — that
line becomes a registry query.

### C.3 Primitives + step-name aliases

Merge `ValidateRecorderEntry.primitive` (`primitives/index.ts:421`, 7 members:
`setupWorktree, runAgent, review, merge, awaitHuman, finalizeReport,
finalizeMockup`) and `PRIMITIVE_NAMES` (`core/lib/primitive-catalog.ts:29`,
6 members: `setupWorktree, runAgent, verify, behaviourVerify, merge,
awaitHuman`) into one `PrimitiveDescriptor` registry.

The two lists disagree today, and resolving the disagreement is part of the
phase:

- `review` (recorder) and `verify` (catalog) are the **same primitive** under two
  names. Canonical id is `review` — the exported function name — with `verify`
  recorded as an alias so `GET /view/primitives` keeps rendering.
- `behaviourVerify` is in the catalog only; `finalizeReport` / `finalizeMockup`
  are in the recorder only. All three are real primitives and all three get
  descriptors.

That gives **eight** seeded descriptors: `setupWorktree, runAgent, review
(alias verify), behaviourVerify, merge, awaitHuman, finalizeReport,
finalizeMockup`. There is no `deploy` primitive — deployment is reached from
inside `review`'s manual gate (`loadDeployConfig` / `getProvider`), not as a
step primitive; do not invent one. `primitive-catalog.ts` becomes this registry's
read projection.

Add the alias table and canonicalise the coder step name:

```ts
{ id: 'runAgent', stepNames: { canonical: 'run-agent', aliases: ['run-claude-code'] } }
```

Route these through `registry.resolveStepName`:

- `core/daemon/continue-task.ts:498` — `clearStepsFromCheckpoint(id, 'run-claude-code')`
- `core/lib/step-evaluators.ts:122` — `LLM_STEPS`
- `core/lib/deep-reflect-query.ts:170`, `core/lib/run-worker-with-span.ts:50`
- `workflows/implement-workflow.ts:105`, `workflows/tool-forge-workflow.ts:130`
  (these two emit the name — switch them to `'run-agent'`)
- `workflows/primitives/index.ts:1708,2391`

**Hazard.** An in-flight task journalled under `run-claude-code` must still
resume. The alias table is the contract; the arch test
`step-name-aliases-resolve` (TARGET §7.2.7) is the guard. Do not remove the
alias in this rework.

**Verify.** Three commands green. Additionally the resume tests must pass
untouched: `core/daemon/__tests__/continue-pre-setup.test.ts`,
`core/daemon/__tests__/rpc-step-reset.test.ts`,
`core/daemon/__tests__/restart-force-verifying.test.ts`,
`cli/commands/__tests__/step-reset.test.ts`,
`workflows/__tests__/queue-workflow-store-step-reset.test.ts`.

**Done when** `rg -n "ProviderName =|WorkerName =" orchestrator/src` shows only
the `= string` declarations in `registries/`, and every listed test file is
green with no edits beyond import paths.

---

## Phase D — split `primitives/index.ts` into `tools/`

**Goal.** The 4,622-line god module becomes ~14 files under
`orchestrator/src/tools/`, with no behaviour change.

**Blocked by** A, B, C.

Use the validated line-range table in TARGET §2.1 as the cut list. It was
measured against the current file; re-measure with
`rg -n '^export' orchestrator/src/workflows/primitives/index.ts` before cutting,
because Phases A and C will have shifted line numbers.

**Order of operations** — do it in this order, committing after each, so a
failure is bisectable:

1. `tools/context.ts` + `tools/validate-recorder.ts` + `tools/coder/session-key.ts`
   (the plumbing; nothing else can move first).
2. `tools/shared/` — split `workflows/primitives/shared.ts` (799 LOC) into
   `prompt.ts`, `abort-messages.ts`, `post-coder-state.ts`.
3. Leaf relocations, no edits beyond imports:
   `primitives/behaviour-verify.ts` → `tools/qa/behaviour-verify.ts`;
   `primitives/browser-check.ts` → `tools/qa/browser-check.ts`;
   `primitives/app-boot-discovery.ts` → `tools/qa/app-boot-discovery.ts`;
   `primitives/opts-descriptors.ts` → `tools/opts-descriptors.ts`;
   `core/lib/git/merge.ts` → `tools/merge/git-merge.ts`;
   `core/lib/deployment/*` → `tools/deploy/*`
   (its `registry.ts` → `registries/deploy-providers.ts`);
   `core/lib/git/claude.ts` → `tools/coder/providers/claude/run.ts`;
   `core/workers/providers/{gemini,codex}-headless.ts` →
   `tools/coder/providers/{gemini,codex}/`.
4. The six primitive shells, largest last:
   `setup-worktree.ts` + `worktree-currency.ts`, then `await-human.ts`,
   `finalize-report.ts`, `finalize-mockup.ts`, then `merge.ts`, then
   `review.ts`, then `run-agent.ts` (+ `coder-exit.ts`).
5. `tools/index.ts` barrel; re-point `workflows/authoring.ts` at it.
6. Delete `orchestrator/src/workflows/primitives/` entirely. Move its 35
   `__tests__` files alongside their subjects
   (`tools/coder/__tests__/`, `tools/verify/__tests__/`, …).

**Frozen surface.** `workflows/authoring.ts` must still export exactly the list
in TARGET §1.2, plus the new `useTool`. `orchestrator/package.json`'s
`"./workflow": "./src/workflows/authoring.ts"` mapping does not change — only the
barrel's body.

**Hazards**

- `runAgent` is ~1,100 lines and does five things (debris sweep, prompt
  composition, worker selection, span-wrapped run, usage recording). Split the
  exit classification (`detectPostCoderState` handling, empty-diff, uncommitted,
  context-exhausted) into `coder-exit.ts`; keep the rest in `run-agent.ts`.
  Do not attempt a deeper decomposition in this phase.
- The per-`ctx` `WeakMap` caches (`traceCache`, `worktreeCache`,
  `indexCardCache` — `primitives/index.ts:342,367,371`) are shared between
  `setupWorktree`, `runAgent`, `verify` and `merge`, and by
  `behaviour-verify.ts`. They must live in **one** module (`tools/context.ts`)
  and be imported, never duplicated. Duplicating them silently breaks
  `mars continue` (the worktree recovery path at `resolveWorktree`).
- `no-circular` is at `error`. `tools/` families must not import each other
  (Phase H rule); route shared code through `tools/shared/`.

**Verify.** Three commands green with **zero** test-file edits other than import
paths and file locations.

**Done when** `orchestrator/src/workflows/primitives/` does not exist, no file
under `tools/` exceeds ~900 LOC, and `pnpm --filter mars test` is green.

---

## Phase E — verify heuristics out of the runner

**Goal.** `tools/verify/runner.ts` contains no tool-specific knowledge.

**Blocked by** D.

**Create** `registries/verify-heuristics.ts` (the `VerifyHeuristic` interface and
registry of TARGET §4.5) and
`tools/verify/heuristics/{typescript-toolchain,infra-failure-patterns}.ts`.

**Extract from `core/lib/git/verify.ts`** (line numbers as measured today;
re-measure after D):

| Lines | Symbol / behaviour | Goes to |
|---:|---|---|
| 20 | `TSC_DECOY_MARKER` | `typescript-toolchain.ts` |
| ~103 | `isTscStep` | `typescript-toolchain.ts` |
| 808–857 | pre-flight tsc-presence guard (tsconfig + local bin) | `typescript-toolchain.beforeStep` |
| 884–900 | post-flight decoy guard | `typescript-toolchain.classify` |
| 900–951 | infra-retry + `typecheck-infra` sentinel | `typescript-toolchain.retry` |
| 73 | `VERIFY_INFRA_FAILURE_PATTERNS` | `infra-failure-patterns.ts` |
| 94–96 | `isInfraFailureOutput` | `infra-failure-patterns.classify` |

`isInfraFailureOutput` is imported by `primitives/index.ts` today; after D that
call site is in `tools/verify/review.ts` and after E it goes through the registry.

The remainder of `verify.ts` (`verifyChanges`, `selectVerifySteps`,
`getChangedFiles`, `cleanWorktreeIfNoCommitsAhead`, `VerifyStepSpec`) becomes
`tools/verify/runner.ts` + `tools/verify/selection.ts`.

Dispatch the hooks through the container's `serial` mode; registration order is
priority. Seed both heuristics in `container/boot.ts`.

**Verify.** Three commands green, plus these tests passing **unchanged**:
`verify-coverage`, `verify-failure-diagnostics`,
`verify-filtered-pipeline-false-green`, `verify-judgment-tier`,
`verify-output-per-command-status`, `verify-step-threw`,
`spec-verify-cmd-runs-verbatim`, `behaviour-verify`.

**Done when** `rg -n 'tsc|typecheck|npx|node_modules|eslint|vitest|jest' orchestrator/src/tools/verify/runner.ts`
is empty and the suite is green.

---

## Phase F — tools resolved through `ctx.tools`

**Goal.** The primitive shells stop importing concrete implementations and start
resolving them from the container. This is where pluggability actually arrives.

**Blocked by** D (and benefits from E landing first).

1. Define the five tool interfaces (`CoderTool`, `VerifyTool`, `MergeTool`,
   `QaTool`, `DeployTool`) in `tools/<family>/types.ts`. Each is
   **task-state-free**: it takes a request, returns evidence, writes nothing.
2. Implement the default for each (`DefaultCoderTool`, …) from the code that is
   already in the shell.
3. Rewrite each shell to the TARGET §3.2 pattern: resolve
   `ctx.tools.<family>`, call it, then perform *all* task-state writes through
   `ctx.services.store`. The store must not be reachable from the tool.
4. Seed the five defaults in `container/boot.ts`.
5. Wire the daemon: `core/daemon/server.ts` calls `createMarsRuntime()` once at
   boot and passes the resulting context's `tools` through the existing
   `services` injection at `server.ts:1701`. `MarsServices` gains nothing it
   does not already have — `tools` rides on the context, not the services bag.
6. Add `useTool(key, impl)` to `workflows/authoring.ts` (scoped disposer;
   throws `SealedServiceError` on a sealed key).

**Non-negotiable acceptance.** Write a test proving the funnel:

- a workflow that swaps `ctx.tools.verify` for a fake that returns a failing
  verdict still produces the same task-state writes (status, failureSignature,
  action-queue row) as the built-in;
- a tool implementation has no reachable path to `ctx.services.store`.

**Done when** the three commands are green and the two funnel tests pass.

---

## Phase G — `growth/`

**Goal.** Reflect, narration and the new step-suggestion finding live under one
capability folder, and narration can explain container decisions.

**Blocked by** B (needs `ctx.events`). Independent of D/E/F.

**Move**

```
src/narration/*                     → src/growth/narration/
core/lib/reflector.ts               → src/growth/reflect/reflector.ts
core/lib/reflect-query.ts           → src/growth/reflect/query.ts
core/lib/reflect-signals.ts         → src/growth/reflect/signals.ts
core/lib/deep-reflector.ts          → src/growth/reflect/deep-reflector.ts
core/lib/auto-reflect-gate.ts       → src/growth/reflect/gate.ts
core/lib/self-evolve-trigger.ts     → src/growth/reflect/self-evolve-trigger.ts
core/lib/suggestion-outcome.ts      → src/growth/reflect/suggestion-outcome.ts
core/lib/lever-registry.ts          → src/growth/reflect/lever-registry.ts
core/lib/steward-workflow-patch.ts  → src/growth/workflow-patch.ts
```

**Hazard — this phase will break `npm run arch` if done naively.** Three of these
files are in the `no-circular` baseline, which is **keyed by file path**. Moving
them re-keys the violation and it reads as brand-new:

```
reflector.ts -> reflect-signals.ts -> core/store/task-store.ts -> core/arc.ts
  -> core/lib/blocker-invariant.ts -> core/lib/main-dirty.ts
  -> core/queue-fix-tasks.ts -> core/lib/failure-reflector.ts -> reflector.ts
```

(`failure-reflector.ts` also participates in a second, shorter cycle through the
same `task-store → arc → blocker-invariant → main-dirty → queue-fix-tasks` spine,
and `reflector.ts` in a third via `core/scorers.ts`.)

**The cycle must be broken as part of this move, not baselined.** The
back-edge is `queue-fix-tasks.ts → failure-reflector.ts`: the fix-task spawner
reaches *up* into reflection. Invert it — `queue-fix-tasks` emits a container
event (`'task/failed'`), and `growth/reflect/` subscribes. That is exactly the
kind of edge the event bus of Phase B exists to remove, which is why G blocks on
B and not on D.

`failure-reflector.ts` itself stays in `core/lib/` (it is failure *classification*,
domain, not growth) — but its inbound edge from `queue-fix-tasks.ts` becomes a
subscription.

**Create** `growth/step-suggestion.ts` — the `StepGapFinding` type and its four
detectors (TARGET §6.1), emitting `createProposal({ source: 'reflection' })`
through the existing `core/proposals.ts` path. Never writes `.mars/workflows/**`
(ADR-0057, ADR-0093); the mechanical path hands a unified diff to
`growth/workflow-patch.ts`, which parks at `awaiting-human`.

**Extend narration** — `DecisionEvent` (TARGET §6.2) added to `NarrationEvent`,
plus `growth/narration/collector.ts` subscribing to `'container/decision'`.
`narrate()` stays pure: no clocks, no randomness, no model calls. Its existing
tests (`narration/narrator.test.ts`, `composeAwayDigest.test.ts`) must pass
unchanged.

**Done when** the three commands are green, `npm run arch` passes **without**
regenerating the baseline, and the three stale baseline entries for
`reflector.ts` / `reflect-signals.ts` / `failure-reflector.ts` are gone
(harmless stale entries are acceptable; a *new* violation is not).

---

## Phase H — arch rules and arch tests

**Goal.** Make the boundaries mechanical.

**Blocked by** A–G (rules must be written against the tree that exists).

1. In `.dependency-cruiser.cjs`, **delete** the commented ADR-0056 stub block
   (the four `layer-*` rules targeting `orchestrator/src/{engine,domain,adapters}/`,
   folders that were never created) and replace it with the nine rules in
   TARGET §7.1.
2. Verify the `\\1` group backreference in `tool-families-are-independent`
   actually resolves: plant a deliberate cross-family import, confirm
   `npm run arch` fails, remove it. If the backreference does not resolve,
   degrade to five explicit per-family rules.
3. Regenerate `.dependency-cruiser-known-violations.json` **once**
   (`npm run arch:baseline`). This is the one legitimate regeneration — new
   rules, not new violations of existing rules. **Say so in the commit
   message**, and diff the file: `no-circular` entries must only have been
   *removed*, never added. If a `no-circular` entry was added, a previous phase
   introduced a cycle — go fix it instead.
4. Add the eight vitest arch tests of TARGET §7.2 under
   `orchestrator/src/__tests__/arch/`.
5. Update `docs/architecture/cycle-guard.md` and `ARCHITECTURE.md` to describe
   the capability tree, and note in the ADR log (via `mars adr add`) that
   ADR-0056's *direction* is preserved while its literal three-folder tree is
   superseded by the capability folders.

**Done when** `npm run arch` is green, the baseline diff shows only removals
under `no-circular`, and all eight arch tests pass.

---

## Phase I — `core/daemon` → `daemon` (optional, last)

Pure path move, no logic change: `orchestrator/src/core/daemon/**` →
`orchestrator/src/daemon/**`, plus the relative-import rewrite. It buys
traversability (the daemon is an adapter, not domain) and lets the §7.1 rules
name `^orchestrator/src/daemon/` instead of two alternatives.

It is genuinely low value and high churn (`server.ts` alone is ~6,000 LOC with
dozens of `../../` imports, and `core/daemon` sits in the 22-folder SCC, so the
baseline re-key hazard of Phase G applies at scale). **Do it only if H landed
clean and there is appetite.** If skipped, keep `core/daemon/` in the rule paths
— nothing else depends on the move.

---

## 2. Enqueueing this

One Mars task per phase, `--workflow` chosen per shape (all of these are code
changes; the default implement pipeline fits). Blockers mirror the phase map:

```bash
A=$(mars task add "Phase A — neutral agent contracts + engine/ …" --files … --verify "pnpm --filter mars run typecheck && pnpm --filter mars test && npm run arch")
B=$(mars task add "Phase B — container/ …" --verify "…")
C=$(mars task add "Phase C — open registries …" --verify "…")
D=$(mars task add "Phase D — split primitives/index.ts …" --blocked-by $A --blocked-by $B --blocked-by $C --verify "…")
E=$(mars task add "Phase E — verify heuristics …"  --blocked-by $D --verify "…")
F=$(mars task add "Phase F — ctx.tools …"          --blocked-by $D --verify "…")
G=$(mars task add "Phase G — growth/ …"            --blocked-by $B --verify "…")
H=$(mars task add "Phase H — arch rules …"         --blocked-by $E --blocked-by $F --blocked-by $G --verify "…")
```

Each prompt must stand alone: point at
`docs/rework/TARGET-ARCHITECTURE.md` for the target and at the phase's own
section here for the cut list, restate the three verify commands, restate the
baseline rule, and end with **"Save your work"** — the orchestrator does not
commit on the agent's behalf.

---

## 3. Rollback

Each phase is one commit on `rework/modular-core`. Phases A–C and G are
independently revertable. D is not — it is a single large mechanical cut; if it
goes wrong, revert the whole phase rather than partially unwinding it, because a
half-split `tools/` tree with a live `primitives/index.ts` is worse than either
end state. E, F and H revert cleanly on top of D.

The frozen `mars/workflow` barrel (TARGET §1.2) and the step-name alias table
(TARGET §4.4) mean no consumer repo needs a coordinated rollback: user-owned
`.mars/workflows/*.js` files and in-flight task journals keep working across
every phase boundary in both directions.
