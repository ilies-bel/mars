# Target Architecture — modular core

> Status: **target spec**. This document is the contract the implementation
> agents build against. It describes where code *ends up*, not where it is.
> The ordered, executable plan is `docs/rework/MIGRATION.md`.
>
> Branch: `rework/modular-core`. Companions: ADR-0052 (Arc is the sole writer),
> ADR-0056 (one library, three logical layers), ADR-0057 (scaffolded workflows
> are user-owned), ADR-0093 (steward findings always enqueue),
> `docs/architecture/PRD-ddd-restructure.md`, `docs/architecture/split-inventory.md`.

---

## 0. The one-paragraph version

Mars becomes a **meta-framework**: a small container that owns a service
registry, a plugin lifecycle and a typed event bus; a set of **tools** (coder,
verify, merge, qa, deploy) that are registered *into* that container rather than
hard-imported from a god module; and a set of **registries** that turn today's
closed unions (`ProviderName`, `WorkerName`, the `ValidateRecorderEntry.primitive`
union) into open, seedable sets. Every default ships wired — one install, no
external modules, zero configuration to get today's behaviour. Swapping a tool,
a provider or a verify heuristic becomes opt-in configuration, never a fork.

One thing does **not** become pluggable: the Arc write funnel.

---

## 1. Invariants that must survive the rework

These are non-negotiable. An implementation agent that cannot satisfy one of
these stops and raises, rather than working around it.

### 1.1 The Arc funnel is non-bypassable (ADR-0052)

Every primitive that mutates task state routes that mutation through
`ctx.services.store` — the Arc-backed `DomainTaskStore`
(`orchestrator/src/core/store/task-store.ts`, injected by the daemon at
`runWorkflow` time, see `orchestrator/src/core/daemon/server.ts:1701`). A
user-owned workflow in `.mars/workflows/*.js` therefore *cannot* strand a task,
because the write funnel is baked into the primitive, not left to the caller.

The container must preserve this **by construction**:

- `store` and `traceStore` are **sealed services** (§3.4). A plugin that calls
  `ctx.provide('store', …)` throws at registration time.
- A tool never writes task state. A **tool returns a result**; the framework-owned
  **primitive shell** that invoked it performs the task-state write through the
  Arc store. Plugins swap *what a tool does*, never *whether task state is
  recorded*.
- Corollary: `runAgent`, `review`, `merge`, `setupWorktree`, `awaitHuman`,
  `finalizeReport`, `finalizeMockup` remain framework-owned shells exported
  from `mars/workflow`. `ctx.tools.*` is what those shells delegate the
  *domain-agnostic work* to.

### 1.2 `mars/workflow` stays backward compatible

`orchestrator/package.json` maps `"./workflow"` → `./src/workflows/authoring.ts`.
Every symbol that barrel exports today must still be exported, with the same
name and a compatible signature, when the rework lands:

```
defineWorkflow, WorkflowCtx (type)
setupWorktree, runAgent, review, merge, awaitHuman, finalizeReport, finalizeMockup
behaviourVerify
MarsWorkflowInput, SetupWorktreeOpts, RunAgentOpts, ReviewOpts, MergeOpts,
AwaitHumanOpts, FinalizeReportOpts, FinalizeMockupOpts, BehaviourVerifyOpts (types)
```

User files on disk in consumer repos import these. The barrel's *body* may be
re-pointed at the new `tools/` tree; its *surface* may only grow.

### 1.3 Step names are durable keys

`ctx.step(name, …)` names key checkpoint-resume records
(`packages/workflow/src/workflow.ts`) and are read back by
`orchestrator/src/core/daemon/continue-task.ts:498`
(`clearStepsFromCheckpoint(id, 'run-claude-code')`) and by
`orchestrator/src/core/lib/step-evaluators.ts:122`
(`LLM_STEPS = ['run-claude-code', 'slicer', 'triage', 'plan', 'slice']`).
Renaming a step name is a **data migration**, not a rename. See §4.4.

### 1.4 The arch baseline may only shrink

`.dependency-cruiser-known-violations.json` is keyed by **file path**. Moving a
file that participates in a baselined cycle re-keys its violation, and
`npm run arch` fails on what looks like a brand-new cycle. Three files planned
for relocation are in the baseline today:

```
orchestrator/src/core/lib/reflector.ts
orchestrator/src/core/lib/reflect-signals.ts
orchestrator/src/core/lib/failure-reflector.ts
```

all inside the same SCC:

```
reflector -> reflect-signals -> store/task-store -> arc -> lib/blocker-invariant
  -> lib/main-dirty -> queue-fix-tasks -> lib/failure-reflector -> reflector
```

Their move (Phase G) therefore **must break that cycle in the same change**.
Regenerating the baseline to absorb a re-keyed entry is forbidden. The only
legitimate regeneration is switching on the brand-new rules of §7 — recorded
explicitly in that commit message.

---

## 2. Target folder structure — `orchestrator/src`

Grouped by **capability**, not by layer noun. ADR-0056's `engine → domain →
adapters` direction is preserved as a *dependency rule* (§7), realized by these
folders rather than by three literal `engine/ domain/ adapters/` directories —
those were specified in ADR-0056, never built, and a three-bucket tree is not
navigable at 140k LOC. The stub rules in `.dependency-cruiser.cjs` are rewritten
against these names in Phase H.

```
orchestrator/src/
├── engine/                     NEW — the domain-agnostic runtime seam
│   ├── index.ts                re-exports @mars/workflow (defineWorkflow, WorkflowCtx, runWorkflow)
│   ├── agent-event.ts          neutral AgentEvent  (was ClaudeEvent)
│   ├── agent-result.ts         neutral AgentInvocationResult (was RunClaudeResult)
│   └── agent-runtime.ts        the neutral "spawn an agent, stream events" contract
│
├── container/                  NEW — the meta-framework (§3). A LEAF: imports nothing above it.
│   ├── index.ts                createRootContext(), MarsContext
│   ├── context.ts              MarsContext, fork/scope, ctx.tools / ctx.services surface
│   ├── service.ts              provide() / get() / has(), keyed services
│   ├── seal.ts                 sealed-key table (ADR-0052 funnel guard)
│   ├── plugin.ts               Plugin, `inject`, apply(), ForkScope
│   ├── events.ts               typed emit / parallel / serial / waterfall
│   ├── disposer.ts             Disposer, DisposerSet, reversible registration
│   └── types.ts                MarsServiceMap, MarsToolMap, MarsEventMap (declaration-merged)
│
├── registries/                 NEW — open sets replacing closed unions (§4)
│   ├── index.ts
│   ├── providers.ts            ProviderDescriptor registry  (was ProviderName union)
│   ├── workers.ts              WorkerDescriptor registry    (was WorkerName union)
│   ├── primitives.ts           PrimitiveDescriptor registry (was the primitive union + primitive-catalog)
│   ├── verify-heuristics.ts    VerifyHeuristic registry (§4.5)
│   ├── deploy-providers.ts     moved from core/lib/deployment/registry.ts
│   └── workflows.ts            wraps loadWorkflowByName (workflows/queue-workflow-store.ts:363)
│
├── tools/                      NEW — the leaves split out of primitives/index.ts (§2.1)
│   ├── index.ts                barrel consumed by workflows/authoring.ts
│   ├── context.ts              MarsCtx, MarsServices, resolveTrace/resolveWorktree/resolveTaskId
│   ├── validate-recorder.ts    the `mars workflow validate` dry-run seam
│   ├── shared/                 prompt composition, abort messages, post-coder state
│   ├── coder/
│   │   ├── setup-worktree.ts
│   │   ├── worktree-currency.ts     ensureWorktreeCurrent
│   │   ├── run-agent.ts
│   │   ├── coder-exit.ts            exit classification / empty-diff / uncommitted
│   │   └── providers/               claude/, gemini/, codex/ adapters (registry-fed only)
│   ├── verify/
│   │   ├── review.ts                the `review` primitive shell
│   │   ├── runner.ts                heuristic-free runner (was core/lib/git/verify.ts)
│   │   ├── selection.ts             selectVerifySteps / getChangedFiles
│   │   └── heuristics/              default heuristics, registered at boot (§4.5)
│   │       ├── typescript-toolchain.ts
│   │       └── infra-failure-patterns.ts
│   ├── merge/
│   │   ├── merge.ts                 the `merge` primitive shell
│   │   └── git-merge.ts             was core/lib/git/merge.ts
│   ├── qa/
│   │   ├── behaviour-verify.ts      was workflows/primitives/behaviour-verify.ts
│   │   ├── browser-check.ts         was workflows/primitives/browser-check.ts
│   │   ├── app-boot-discovery.ts    was workflows/primitives/app-boot-discovery.ts
│   │   └── finalize-mockup.ts
│   ├── deploy/                      was core/lib/deployment/{config,provider,noop,http,teardown}
│   ├── human/await-human.ts
│   └── report/finalize-report.ts
│
├── growth/                     NEW — how the framework improves itself (§6)
│   ├── reflect/                was core/lib/{reflector,reflect-query,reflect-signals,
│   │                                deep-reflector,auto-reflect-gate,self-evolve-trigger,
│   │                                suggestion-outcome,lever-registry}.ts
│   ├── narration/              was src/narration/*
│   ├── step-suggestion.ts      NEW — "this workflow is missing a step" finding (§6.1)
│   └── workflow-patch.ts       was core/lib/steward-workflow-patch.ts
│
├── workflows/                  EXISTING, shrinks to pipelines + authoring
│   ├── authoring.ts            the `mars/workflow` barrel — surface frozen (§1.2)
│   ├── queue-workflow-store.ts
│   ├── implement-workflow.ts, plan-workflow.ts, slice-workflow.ts,
│   │   triage-workflow.ts, init-workflow.ts, validate-workflow.ts,
│   │   tool-forge-workflow.ts
│   └── (primitives/ is GONE — its contents live in tools/)
│
├── core/                       EXISTING — the domain. Out of scope for this rework
│   ├── arc.ts, queue.ts, proposals.ts, app-services.ts, store/, workers/, lib/, …
│
├── daemon/                     MOVED from core/daemon (Phase I — path move only)
├── cli/                        EXISTING
├── bus/, outbox/, internal-bus/, init/, mcp/, registry/, ideas/, util/
└── cli.ts, version.ts
```

### 2.1 Splitting `workflows/primitives/index.ts`

4,622 LOC, ~50 concrete tool-module imports, one file. Validated export map and
the line ranges each destination takes:

| Source lines | Symbols | Destination |
|---:|---|---|
| 163–190 | `buildSessionKey` | `tools/coder/session-key.ts` |
| 192–413 | `MarsServices`, `MarsWorkflowInput`, `MarsCtx`, `PrimitiveTraceArgs`, `resolveTrace`, `resolveWorktree`, `readWorkflowInput` | `tools/context.ts` |
| 415–456 | `ValidateRecorderEntry`, `ValidateRecorder` | `tools/validate-recorder.ts` |
| 458–476 | `resolveTaskId`, `spanStore` | `tools/context.ts` |
| 478–653 | `ensureWorktreeCurrent` | `tools/coder/worktree-currency.ts` |
| 654–1300 | `SetupWorktreeOpts`, `SetupWorktreeResult`, `setupWorktree` | `tools/coder/setup-worktree.ts` |
| 1301–2417 | `RunAgentOpts`, `RunAgentResult`, `runAgent` | `tools/coder/run-agent.ts` + `tools/coder/coder-exit.ts` |
| 2418–3521 | `buildSpecVerifyCmdStep`, `ReviewOpts`, `VerifyGateOutcome`, `ReviewResult`, `review` | `tools/verify/review.ts` |
| 3522–4254 | `MergeOpts`, `MergeOutput`, `merge` | `tools/merge/merge.ts` |
| 4255–4459 | `AwaitHumanOpts`, `awaitHuman` | `tools/human/await-human.ts` |
| 4460–4515 | `FinalizeReportOpts`, `finalizeReport` | `tools/report/finalize-report.ts` |
| 4516–4622 | `FinalizeMockupOpts`, `finalizeMockup` | `tools/qa/finalize-mockup.ts` |

`workflows/primitives/shared.ts` (799 LOC) splits into `tools/shared/prompt.ts`
(`composePrompt`, `resolveWorkerSystemPrompt`), `tools/shared/abort-messages.ts`
(the `*_ABORT_MESSAGE` / `*_SIGNATURE` constants) and
`tools/shared/post-coder-state.ts` (`detectPostCoderState`, `failureExcerpt`,
`coderUncommittedFailure`, `recoveryAttachesToOrigin`).

`workflows/primitives/opts-descriptors.ts` (87 LOC) → `tools/opts-descriptors.ts`.

No behaviour changes in this split. Tests under
`workflows/primitives/__tests__/` (35 files) move alongside their subject.

---

## 3. The service container

Modelled on **Cordis** (the meta-framework behind Koishi): a context object that
is simultaneously a service registry, a plugin host and an event bus, where every
registration is reversible because it returns a disposer. Adapted to Mars, which
already has a `WorkflowCtx` with its own `emit` and its own `services` bag.

### 3.1 Two `ctx` objects, one surface — read this first

There is already a `ctx` in this codebase: the engine's
`WorkflowCtx<Services, Input>` (`packages/workflow/src/workflow.ts`), with:

- `ctx.step(name, fn, options)` — durable checkpointed unit of work
- `ctx.emit(event, payload)` — a **progress** emitter that publishes a
  `WorkflowEvent` to the logger and the bus (`ctx.emit('claude-event', ev)` at
  `primitives/index.ts:1468`)
- `ctx.services` — the flat bag typed `MarsServices` (`primitives/index.ts:192`)

The container **does not rename or repurpose either**. `ctx.emit` stays the
progress emitter — it is on the authoring surface. The container's dispatch modes
live on **`ctx.events`**. This name collision is the single most likely mistake
in this rework; it is called out again in `MIGRATION.md` Phase B.

The container augments `WorkflowCtx` by *widening its `Services` type parameter*:

```ts
// container/context.ts
export interface MarsContext extends WorkflowCtx<MarsServices, MarsWorkflowInput> {
  /** Keyed tools — swappable implementations. */
  readonly tools: Readonly<MarsToolMap>
  /** Container event bus (NOT ctx.emit — see §3.1). */
  readonly events: EventDispatcher<MarsEventMap>
  /** Register a service/tool for the lifetime of this scope. Returns a disposer. */
  provide<K extends keyof MarsProvidableMap>(key: K, value: MarsProvidableMap[K]): Disposer
  /** Load a plugin into a child scope. Returns the fork's disposer. */
  plugin<C>(plugin: Plugin<C>, config?: C): ForkScope
  /** A child scope whose disposers are independent of the parent's. */
  fork(): MarsContext
}
```

`MarsServices` keeps every field it has today (`store`, `traceStore`,
`onManualPark`, `onPid`, `onVerifyChildPid`, `acquireVerifySlot`,
`releaseVerifySlot`, `enqueueMergeJobAndAwait`, `previewSpawn`,
`validateRecorder`). Nothing is removed — the daemon injection at
`core/daemon/server.ts:1701` keeps working unchanged.

### 3.2 Keyed tools

```ts
// container/types.ts — declaration-merged; a plugin adds its own key by
// augmenting this interface.
export interface MarsToolMap {
  coder: CoderTool
  verify: VerifyTool
  merge: MergeTool
  qa: QaTool
  deploy: DeployTool
}
```

Each tool is a narrow, **task-state-free** interface. Example:

```ts
// tools/verify/types.ts
export interface VerifyTool {
  readonly name: string
  /** Run the selected gates in the worktree. Returns evidence; writes nothing. */
  run(req: VerifyRequest): Promise<VerifyEvidence>
}
```

The primitive shell keeps the writes:

```ts
// tools/verify/review.ts  (framework-owned, exported via mars/workflow)
export const review = async (ctx: MarsCtx, opts: ReviewOpts = {}): Promise<ReviewResult> => {
  const store = ctx.services.store            // ← the Arc funnel, ADR-0052
  const evidence = await ctx.tools.verify.run(buildRequest(ctx, opts))
  await recordVerifyOutcome(ctx, store, evidence)   // ← the only writer
  return toReviewResult(evidence)
}
```

A plugin that replaces `ctx.tools.verify` changes *which gates run and how they
are classified*. It cannot change *whether the task row is updated*, because it
never sees `store`.

### 3.3 Plugins with `inject`-style dependency declaration

```ts
// container/plugin.ts
export interface Plugin<C = unknown> {
  readonly name: string
  /** Service/tool keys this plugin needs. It is applied only once all are present,
   *  and its fork is disposed automatically if one is withdrawn. */
  readonly inject?: readonly (keyof MarsProvidableMap)[]
  /** Optional keys: injected when available, absent otherwise; never gate loading. */
  readonly optional?: readonly (keyof MarsProvidableMap)[]
  apply(ctx: MarsContext, config: C): void | Disposer | Promise<void | Disposer>
}
```

Semantics, straight from Cordis and unchanged:

- `ctx.plugin(p, config)` creates a **fork scope** and returns it. `fork.dispose()`
  reverses *everything* the plugin registered — services, tools, event listeners,
  child plugins — with no bookkeeping on the plugin author's part.
- A plugin whose `inject` list is not yet satisfied is **pending**, not failed.
  It applies the moment the last dependency is provided.
- If a dependency is withdrawn (its disposer runs), dependents are disposed
  first, then re-applied if it returns. This is what makes `mars daemon reload`
  able to swap a workflow's tools without a process restart.

### 3.4 Sealed services — the ADR-0052 guard

```ts
// container/seal.ts
export const SEALED_KEYS = ['store', 'traceStore'] as const
```

`provide()` throws `SealedServiceError` for any sealed key, at registration time,
with the ADR reference in the message. `mars workflow validate` runs the same
check statically against a candidate `.mars/workflows/*.js` before the daemon
loads it, so a bad plugin fails at validate, not mid-dispatch.

The arch test in §7 rule 9 is the third layer: nothing under `tools/` may import
`core/store/state-client.ts` (the raw client) — only `core/store/task-store.ts`.

### 3.5 Disposer-based reversible registration

```ts
// container/disposer.ts
export type Disposer = () => void
```

Every registering call returns one: `provide`, `events.on`, `plugin`,
`registries.*.register`. A `ForkScope` is a `DisposerSet` with a name. Rules:

- Disposers are **idempotent** and run **LIFO** within a scope.
- A throwing disposer is logged and does not abort the rest of the set.
- Disposing a parent disposes children first.

This is what makes registries safe to seed at boot and mutate at reload without
leaking listeners — the failure mode that a process-global `Map`
(`core/lib/deployment/registry.ts` today) has no answer for.

### 3.6 Typed event dispatch modes

```ts
// container/events.ts
export interface EventDispatcher<M> {
  on<K extends keyof M>(name: K, listener: M[K]): Disposer
  /** Fire-and-forget, all listeners in parallel, return values ignored. */
  emit<K extends keyof M>(name: K, ...args: Args<M[K]>): void
  /** Await every listener (Promise.all). Rejections are aggregated, not swallowed. */
  parallel<K extends keyof M>(name: K, ...args: Args<M[K]>): Promise<void>
  /** Sequential; the first listener returning a non-undefined value short-circuits. */
  serial<K extends keyof M>(name: K, ...args: Args<M[K]>): Promise<Ret<M[K]> | undefined>
  /** Chained transform; each listener receives the previous return value. */
  waterfall<K extends keyof M, T>(name: K, seed: T, ...args: Args<M[K]>): Promise<T>
}
```

Which mode a Mars event uses is part of the event's contract, declared in
`container/types.ts`:

```ts
export interface MarsEventMap {
  // emit   — observers only; a slow listener must never delay a dispatch
  'agent-event':        (e: AgentEvent) => void
  'task/status-changed':(t: TaskStatusChange) => void
  // parallel — everyone must finish before the step continues
  'verify/before-run':  (r: VerifyRequest) => Promise<void>
  // serial — first non-undefined answer wins (classification, routing)
  'verify/classify':    (s: RanVerifyStep, o: StepOutput) => VerifyVerdict | undefined
  'worker/select':      (tags: TaskTag[], kind: TaskKind) => WorkerName | undefined
  // waterfall — successive transformation of one value
  'prompt/compose':     (prompt: string, c: PromptContext) => string
  'verify/select-steps':(steps: VerifyStepSpec[], c: SelectionContext) => VerifyStepSpec[]
}
```

`serial` is how the verify heuristics of §4.5 plug in without the runner knowing
any of them. `waterfall` is how a plugin appends to a composed prompt without
owning `composePrompt`.

---

## 4. How agnosticism is achieved

Today the neutral seams leak Claude. Every item below is a validated leak with a
file:line.

### 4.1 Neutral agent contracts

| Leak (today) | Target |
|---|---|
| `ClaudeEvent` — `core/lib/claude-stream.ts:1`, re-exported through `core/workers/provider-types.ts` and used as `runAgent`'s stream type | `AgentEvent` in `engine/agent-event.ts` |
| `RunClaudeResult` — `core/lib/git/claude.ts:268` | `AgentInvocationResult` in `engine/agent-result.ts` |
| `ClaudeConversation`, `parseClaudeStreamLine`, `readClaudeOutput`, `extractLastStreamText`, `diagnoseClaudeFailure` — `core/lib/claude-stream.ts` | `AgentTranscript`, `parseAgentStreamLine`, `readAgentOutput`, `extractLastStreamText`, `diagnoseAgentFailure` in `engine/` |
| `ClaudeEffort`, `ClaudePermissionMode` — `core/lib/git/claude.ts:259` | `AgentEffort`, `AgentPermissionMode` in `engine/agent-runtime.ts` |

> **Name collision.** `RunAgentResult` is already exported from
> `primitives/index.ts:1349` as the `runAgent` *primitive's* return type
> (`{ sessionId }`), and reachable from the frozen barrel's type surface. The
> transport-level type is therefore **`AgentInvocationResult`**, not
> `RunAgentResult`. Do not collapse them.

Vendor names survive in exactly one place: `tools/coder/providers/claude/`.
The naming arch test (§7 rule 6) enforces it.

### 4.2 Provider registry replaces the closed union

`ProviderName = 'claude' | 'gemini' | 'codex'` (`core/workers/provider-types.ts:13`)
is a closed union that `PROVIDER_MODELS` (`provider-types.ts:24`), `tierForModel`
(`provider-types.ts:50`), `PROVIDERS` (`core/workers/providers.ts:79`),
`usageSemanticsOf` (`providers.ts:75`) and `resolveProviderName`
(`providers.ts:247`) all key off with `Record<ProviderName, …>`.

Target:

```ts
// registries/providers.ts
export type ProviderName = string   // open

export interface ProviderDescriptor {
  readonly name: ProviderName
  readonly models: ProviderModels             // { flagship, balanced, fast }
  readonly usageSemantics: ProviderUsageSemantics
  readonly bin: () => string                  // was provider-bin.ts
  run(req: AgentRunRequest): Promise<AgentInvocationResult>
}

export interface ProviderRegistry {
  register(d: ProviderDescriptor): Disposer
  get(name: ProviderName): ProviderDescriptor | undefined
  require(name: ProviderName): ProviderDescriptor    // throws with the list of known names
  list(): readonly ProviderDescriptor[]
  tierForModel(model: string, provider: ProviderName): ProviderModelTier | undefined
}
```

`PROVIDER_MODELS` stops being a top-level `const Record` and becomes
`registry.get(name).models`. `ProviderModelTier` stays a closed union
(`'flagship' | 'balanced' | 'fast'`) — tiers are Mars vocabulary, not vendor
vocabulary, and closing them is the point.

**Unknown-provider behaviour is a decision, not an accident:** `require()` throws
a named error listing registered providers. Anywhere a `Record<ProviderName, X>`
exhaustiveness check disappears, a `require()` call takes its place.

### 4.3 Worker registry replaces `WorkerName`

`WorkerName` (`core/workers/index.ts:97`) is a closed union of eight names, with
`Workers` / `WORKER_CONFIGS` as `Record<WorkerName, …>` and `pickWorkerForTags`
switching over it. There is already a `persisted-registry.ts` alongside it for
operator-declared workers — the closed union is the thing that makes that a
second-class citizen.

Target: `WorkerName = string`; `registries/workers.ts` owns
`register(WorkerDescriptor): Disposer`, `require(name)`, `list()`, and
`selectForTags(tags, kind)`. The eight built-ins are seeded at boot (§5).
`pickWorkerForTags` becomes `registry.selectForTags`, with the container's
`'worker/select'` **serial** event consulted first so a plugin can override
routing without patching the registry.

`core/lib/primitive-catalog.ts:24` imports `WORKER_CONFIGS` and `WORKER_PROVIDER`
for the `GET /view/primitives` projection — it reads the registry instead.

### 4.4 Primitive registry replaces the primitive union

`ValidateRecorderEntry.primitive` (`primitives/index.ts:421`) is a closed union of
seven names; `PRIMITIVE_NAMES` (`core/lib/primitive-catalog.ts:29`) is a parallel
closed tuple of six. They already disagree — `finalizeReport` / `finalizeMockup`
are in one and not the other, `behaviourVerify` vice-versa. That drift is the
argument.

Target: one `registries/primitives.ts` holding `PrimitiveDescriptor`
(`{ id, aliases, phase, executor: 'agent'|'deterministic'|'human', workers?, stepNames }`),
seeded with **eight** descriptors — `setupWorktree, runAgent, review (alias
`verify`), behaviourVerify, merge, awaitHuman, finalizeReport, finalizeMockup`.
`review` and `verify` are the same primitive under two names; `review` (the
exported function) is canonical. There is no `deploy` primitive — deployment is
reached from inside `review`'s manual gate, not as a step.
`ValidateRecorderEntry.primitive` becomes `string`, validated against the
registry at record time. `primitive-catalog.ts` collapses into this registry's
read projection.

**Step-name aliasing (see §1.3).** The registry is also where the durable step
name lives:

```ts
{ id: 'runAgent', stepNames: { canonical: 'run-agent', aliases: ['run-claude-code'] } }
```

Resume paths (`continue-task.ts:498`), evaluators (`step-evaluators.ts:122`) and
the trace views resolve through `registry.resolveStepName(name)` so an in-flight
task journalled under `run-claude-code` still resumes after the rename. Bundled
workflows switch to `'run-agent'`; the alias is removed only after a release that
drains in-flight runs.

### 4.5 Verify runner free of tool-specific heuristics

`core/lib/git/verify.ts` (1,149 LOC) hard-codes TypeScript knowledge:

| Lines | Heuristic |
|---:|---|
| 20 | `TSC_DECOY_MARKER = 'This is not the tsc command you are looking for'` |
| 73 | `VERIFY_INFRA_FAILURE_PATTERNS: readonly RegExp[]` |
| 94 | `isInfraFailureOutput(output)` |
| ~103 | `isTscStep(spec)` — `spec.cmd === 'npx' && spec.args[0] === 'tsc'` |
| 808–857 | pre-flight guard: skip `npx tsc` when no `tsconfig.json` + no local `tsc` binary |
| 884–900 | post-flight decoy guard → reclassify failure as skip |
| 900–951 | infra-retry: dep-refresh then re-run, sentinel `typecheck-infra` |

Target — three hooks, no strings in the runner:

```ts
// registries/verify-heuristics.ts
export interface VerifyHeuristic {
  readonly name: string
  /** Runs before the step. Return a decision to skip/short-circuit it. */
  beforeStep?(step: VerifyStepSpec, cwd: string): PreStepDecision | undefined
  /** Runs on a failing step. Return a verdict to reclassify it. */
  classify?(step: VerifyStepSpec, result: StepResult): VerifyVerdict | undefined
  /** Runs on a failing step after classify. Return a retry plan, or undefined. */
  retry?(step: VerifyStepSpec, result: StepResult): RetryPlan | undefined
}
```

Dispatched through the container's **`serial`** mode: first heuristic returning a
non-undefined value wins; registration order is the priority. Ships with two
registered by default:

- `tools/verify/heuristics/typescript-toolchain.ts` — the decoy marker, the
  `isTscStep` predicate, the pre-flight presence guard, the post-flight decoy
  guard and the dep-refresh retry (lines 20, 103, 808–857, 884–951).
- `tools/verify/heuristics/infra-failure-patterns.ts` — `VERIFY_INFRA_FAILURE_PATTERNS`
  and `isInfraFailureOutput` (lines 73–96).

Acceptance for this phase is behavioural, not structural: `runner.ts` contains
zero occurrences of `tsc`, `typecheck`, `npx`, `node_modules` or a language name,
**and** the existing tests
(`workflows/primitives/__tests__/verify-*.test.ts`, `verify-coverage`,
`verify-failure-diagnostics`, `verify-filtered-pipeline-false-green`,
`verify-judgment-tier`, `verify-output-per-command-status`) pass unchanged.

`isInfraFailureOutput` is imported by `primitives/index.ts` today; after the
split it is reached only through the heuristic registry.

---

## 5. Opinionated defaults

The container is a mechanism. Mars is not a construction kit — it ships a
product. The rule:

> **Everything in §3 and §4 ships wired out of the box. One command installs it.
> Zero external modules. Swapping is opt-in configuration.**

Concretely:

1. **A single boot function seeds every registry.** `container/boot.ts` exports
   `createMarsRuntime(): MarsContext`, which registers, in order: the three
   providers, the eight workers, the eight primitives, the two verify heuristics,
   the two deploy providers (`noop`, and `http` when
   `MARS_HTTP_DEPLOY_ENDPOINT` + `MARS_HTTP_DEPLOY_TOKEN` are set — the current
   behaviour at the foot of `core/lib/deployment/registry.ts`), and the five
   default tools. The daemon (`core/daemon/server.ts`) calls it once at boot; the CLI
   calls it for one-shot commands; tests call it for a hermetic runtime.
2. **No plugin resolution from `node_modules`.** There is no plugin *discovery*
   mechanism in this rework. The only extension points are (a) the built-in
   seeds, and (b) whatever a user's `.mars/workflows/*.js` registers through the
   `mars/workflow` barrel. A package-based plugin ecosystem is explicitly a
   non-goal (§8).
3. **A fresh `mars init` produces byte-identical behaviour to today.** The
   scaffolded workflows (`init/scaffold-workflows.ts`) are unchanged apart from
   the step-name canonicalisation of §4.4. If a consumer never opens a config
   file, they cannot tell this rework happened.
4. **Configuration is subtractive/substitutive, never additive-required.**
   Overriding a tool looks like:
   ```js
   // .mars/workflows/task-workflow.js
   import { defineWorkflow, review, useTool } from 'mars/workflow'
   useTool('verify', myVerifyTool)      // returns a disposer; scoped to this workflow
   ```
   `useTool` is the one *new* export on the frozen barrel (adding is allowed,
   §1.2). It throws `SealedServiceError` for sealed keys.
5. **Defaults are named, not anonymous.** Every seeded registration carries a
   `name` (`'claude'`, `'typescript-toolchain'`, `'default-verify'`) so
   `mars doctor` / `mars worker list` / `GET /view/primitives` can print what is
   actually wired, and narration (§6.2) can say *which* implementation made a
   call.

---

## 6. Growth

Two distinct capabilities that are often conflated. Keep them apart:
**suggestion** is speculative and LLM-driven; **narration** is factual and
deterministic.

### 6.1 Suggesting new workflow steps

Build on the path that already exists — do not invent a parallel one.

Today: `mars reflect` → `loadRecentTaskCorpus` (`core/lib/reflect-query.ts`) →
`runReflector` (`core/lib/reflector.ts`) → `persistSuggestions` →
`createProposal({ source: 'reflection' })` (`core/proposals.ts`) → action-queue
row of kind `draft-proposal` → `/mars:grill` → `mars task add`. Separately,
`core/lib/self-evolve-trigger.ts:186` files `source: 'reflection'` proposals from
KPI drift, and `core/lib/steward-workflow-patch.ts` can propose a unified diff
against `.mars/workflows/**` that parks at `awaiting-human`.

Target — one new finding kind, reusing all of the above:

```ts
// growth/step-suggestion.ts
export interface StepGapFinding {
  workflowId: string            // e.g. 'task'
  afterStep: string             // canonical step name the gap follows
  rootCauseKey: string          // snake_case, joins the existing lever registry
  proposedStep: {
    primitive: string           // a registered primitive id (§4.4)
    name: string
    opts: Record<string, unknown>
    guide: string | null        // Step guide when mode is manual
  }
  evidence: { taskIds: string[]; frequency: number; confidence: number }
}
```

Detection is a query over data Mars already records, not a new instrument:

- **repeated post-merge repair** — N arcs where a `fix` task followed a `done`
  origin with the same failure signature ⇒ propose a gate *before* merge;
- **repeated manual intervention** — N arcs parked at `awaiting-human` for the
  same reason ⇒ propose promoting the manual check to an automated step;
- **a heuristic that keeps firing** — a verify heuristic (§4.5) returning a skip
  or infra verdict on M% of runs ⇒ propose a dedicated step instead of a retry;
- **`reflect-workflow-fit`** (`core/reflect-workflow-fit.ts`) already computes
  whether the dispatched workflow suited the task — its negative verdicts feed
  the same finding.

Routing rules, non-negotiable:

- A `StepGapFinding` becomes a **draft proposal** (`source: 'reflection'`),
  never a direct edit. `.mars/workflows/*.js` are user-owned Hybrid files
  (ADR-0057) and steward findings always enqueue (ADR-0093).
- When the finding is mechanical *and* clears the confidence threshold, the
  proposal carries a ready-made unified diff via
  `stewardProposeWorkflowPatch(...)` (`growth/workflow-patch.ts`), which already
  restricts writes to `.mars/workflows/` and parks at `awaiting-human`. The
  operator applies it; the framework never does.
- Every suggestion binds to a lever or opens a lever gap (ADR-0092) — the
  existing `lever-registry.ts` contract, unchanged.

### 6.2 Explaining why things happen (narration)

`narration/narrator.ts` is a **pure, deterministic, zero-token** transform:
`narrate(NarrationEvent[]) → NarrationLine[] | null`, classifying an arc as
`landed` / `stumbled-recovered` / `needs-you`. Keep every one of those properties
— no clocks, no randomness, no model calls.

Extend it from *arc shapes* to *decisions*. The container is the enabler: every
registry lookup and every `serial` short-circuit is a decision with a named
winner, so it can be recorded without instrumenting call sites by hand.

```ts
// growth/narration/types.ts — additive
export type NarrationEvent =
  | ArcLifecycleEvent                     // existing
  | DecisionEvent                         // NEW

export interface DecisionEvent {
  kind: 'decision'
  at: number
  taskId: string | null
  /** What was being decided: 'worker/select' | 'verify/classify' | 'tool/resolve' | … */
  slot: string
  /** The registered name that won. */
  chosen: string
  /** The registered names that were consulted and declined. */
  declined: readonly string[]
  /** Deterministic, human-readable reason. Never model-generated. */
  because: string
}
```

Wiring: `container/events.ts` emits `'container/decision'` whenever a `serial`
dispatch resolves or a registry `require()` succeeds;
`growth/narration/collector.ts` subscribes (a plain `ctx.events.on`, so it is
disposable) and appends `DecisionEvent`s to the same span `narrate()` already
consumes. Rendering:

> `MARS-1a2b` needs attention.
> verify ran 3 gates; `typescript-toolchain` skipped `npx tsc` (no local tsc
> binary in `orchestrator/`), so the typecheck gate did not run.

That second line is the payoff: today that skip is a comment in
`verify.ts:857` and a log line. After the rework it is a first-class,
queryable, zero-token explanation attached to the arc.

Boundary to hold: **narration never speculates.** If the answer requires
inference, it belongs in §6.1 as a suggestion, not in narration.

---

## 7. Architectural test strategy

Two mechanisms, both already present in the repo — extend, do not add a third.

### 7.1 dependency-cruiser rules (`.dependency-cruiser.cjs`)

The file currently carries four live rules (`no-circular`, `no-orphans`,
`not-to-unresolvable`, `no-duplicate-dep-types`) and a commented-out block of
four ADR-0056 layer rules that were written against `engine/ domain/ adapters/`
folders that were never created. **Replace that commented block** with the rules
below, retargeted at the capability folders of §2.

```js
{
  name: 'container-is-a-leaf',
  severity: 'error',
  comment:
    'The container is the bottom of the stack: a service registry, a plugin host and an ' +
    'event bus. It may not know about tools, workflows, the domain, or any adapter. If it ' +
    'needs something from above, that thing must be provided into it.',
  from: { path: '^orchestrator/src/container/' },
  to:   { path: '^orchestrator/src/(tools|workflows|core|cli|daemon|growth|registries|bus|outbox|init)/' },
},
{
  name: 'engine-is-a-leaf',
  severity: 'error',
  comment: 'ADR-0056: the engine layer knows nothing of tasks or arcs.',
  from: { path: '^orchestrator/src/engine/' },
  to:   { path: '^orchestrator/src/(tools|workflows|core|cli|daemon|growth|registries)/' },
},
{
  name: 'registries-depend-only-on-contracts',
  severity: 'error',
  comment:
    'A registry holds descriptors and hands them out. It must not reach into a concrete tool ' +
    'implementation, or the open set closes again by import.',
  from: { path: '^orchestrator/src/registries/' },
  to:   { path: '^orchestrator/src/(workflows|cli|daemon|growth)/' },
},
{
  name: 'tool-families-are-independent',
  severity: 'error',
  comment:
    'coder/verify/merge/qa/deploy are siblings, not a chain. Shared code goes in tools/shared/. ' +
    'Cross-family reuse is what made primitives/index.ts 4,622 lines.',
  from: { path: '^orchestrator/src/tools/([^/]+)/' },
  to:   { path: '^orchestrator/src/tools/[^/]+/', pathNot: '^orchestrator/src/tools/(\\1|shared)/' },
},
{
  name: 'tools-do-not-import-adapters',
  severity: 'error',
  comment: 'A tool runs inside a workflow step. It has no daemon, no CLI, no HTTP, no TTY.',
  from: { path: '^orchestrator/src/tools/' },
  to:   { path: '^orchestrator/src/(cli|daemon|core/daemon|ui)/' },
},
{
  name: 'tools-do-not-import-workflows',
  severity: 'error',
  comment:
    'Direction is workflows -> tools. A tool that imports a bundled pipeline cannot be reused ' +
    'by a user-owned workflow, which is the whole point of the tools/ tree.',
  from: { path: '^orchestrator/src/tools/' },
  to:   { path: '^orchestrator/src/workflows/' },
},
{
  name: 'arc-funnel-is-the-only-write-path',
  severity: 'error',
  comment:
    'ADR-0052: task-state writes funnel through the Arc-backed store. Nothing under tools/ or ' +
    'growth/ may reach the raw state client; go through core/store/task-store.ts.',
  from: { path: '^orchestrator/src/(tools|growth)/' },
  to:   { path: '^orchestrator/src/core/store/state-client\\.ts$' },
},
{
  name: 'provider-adapters-are-registry-fed',
  severity: 'error',
  comment:
    'Only the provider registry and the coder tool may import a concrete provider adapter. ' +
    'A direct import anywhere else re-creates the closed ProviderName union by another name.',
  from: { pathNot: '^orchestrator/src/(registries/providers\\.ts|tools/coder/)' },
  to:   { path: '^orchestrator/src/tools/coder/providers/' },
},
{
  name: 'growth-is-read-mostly',
  severity: 'error',
  comment:
    'ADR-0057 + ADR-0093: growth observes and proposes. It must not reach into the tools it is ' +
    'reasoning about, nor into an adapter to apply its own findings.',
  from: { path: '^orchestrator/src/growth/' },
  to:   { path: '^orchestrator/src/(tools|cli|daemon|core/daemon)/' },
},
```

Notes for the implementing agent:

- The `\\1` backreference in `tool-families-are-independent` uses
  dependency-cruiser's group matching (a group captured in `from.path` is
  referenced in `to.path`/`to.pathNot`). **Verify it resolves** on a deliberately
  planted violation before relying on it. If it does not, degrade to five
  explicit rules, one per family — verbose but exact.
- These are **new rules**, which is the one legitimate reason to regenerate
  `.dependency-cruiser-known-violations.json` (root `package.json` `//arch` note).
  Regenerate **once**, in the Phase-H commit, and say so in the commit message.
  Regenerating for any other reason in any other phase is forbidden.
- `no-circular` stays at `error` throughout. Every phase that moves a file must
  land cycle-free at the new path — see §1.4.

### 7.2 Vitest arch tests

Things dependency-cruiser cannot see. New file
`orchestrator/src/__tests__/arch/*.test.ts`:

1. **`neutral-contracts-name-no-vendor`** — no exported identifier under
   `engine/`, `container/`, `registries/`, or `tools/` (excluding
   `tools/coder/providers/claude/`) matches `/Claude|Anthropic|Gemini|Codex|GPT/`.
2. **`verify-runner-is-heuristic-free`** — `tools/verify/runner.ts` contains no
   occurrence of `tsc`, `typecheck`, `npx`, `node_modules`, `eslint`, `vitest`,
   `jest`, `cargo`, `pytest`.
3. **`sealed-services-are-sealed`** — `provide('store', …)` and
   `provide('traceStore', …)` throw `SealedServiceError`; every other key in
   `MarsProvidableMap` succeeds and returns a working disposer.
4. **`every-registration-is-reversible`** — for each registry, snapshot
   `list()`, register a fake, dispose, assert `list()` deep-equals the snapshot.
   Catches listener and Map leaks.
5. **`authoring-barrel-surface`** — golden-file test asserting the exact export
   list of `workflows/authoring.ts` is a **superset** of the §1.2 list. Fails on
   any removal or rename. This is the compatibility guard for user files in
   consumer repos.
6. **`registries-are-seeded`** — `createMarsRuntime()` yields exactly the
   built-ins of §5: 3 providers, 8 workers, 8 primitives, 2 verify heuristics,
   ≥1 deploy provider, 5 tools. Guards "opinionated defaults" against silent
   erosion.
7. **`step-name-aliases-resolve`** — `resolveStepName('run-claude-code')` returns
   the `runAgent` descriptor, so `mars continue` on a pre-rename journal resumes.
8. **`growth-never-writes-workflows`** — no module under `growth/` other than
   `growth/workflow-patch.ts` references `.mars/workflows` in a write position.

Run them in the existing `npm --prefix orchestrator test` (vitest, ADR-0033).
No new runner.

---

## 8. Non-goals

- **No `engine/ domain/ adapters/` literal tree.** ADR-0056's *direction* is
  enforced by §7; its *folders* are superseded by the capability tree of §2.
  ADR-0056 is amended, not violated — record that when the rework lands.
- **No package split.** One library, `mars`, one `exports` map with `.` and
  `./workflow`. ADR-0047's ladder stays retired.
- **No plugin marketplace, no `node_modules` plugin discovery, no plugin
  manifest format.** §5.2.
- **No rewrite of `core/`.** `arc.ts`, `queue.ts`, `app-services.ts`,
  `daemon/server.ts` keep their current internals. This rework moves leaves and
  inverts dependencies; it does not re-architect the domain.
- **No behaviour change.** Every phase in `MIGRATION.md` is verified by the
  *existing* test suite passing unchanged. New tests are added for new seams
  only.
