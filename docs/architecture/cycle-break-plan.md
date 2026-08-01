# Cycle-Break Plan

**Status:** PLANNING ONLY. This document breaks no cycles. It names the
exact import edges that close each loop, the remedy for each, and the
ordered commit sequence that dismantles them.
**Base commit:** `69d4b45d`
**Measurement tool:** dependency-cruiser 18.1.0.

Read alongside `docs/architecture/PRD-ddd-restructure.md`,
`docs/architecture/aggregate-catalog.md`, ADR-0056 (engine → domain →
adapters), ADR-0055, ADR-0052 (Arc is the sole writer of task/arc state),
ADR-0023 (CLI Command seam), ADR-0021 (injected stores).

---

## 0. Baseline facts and the ground rules

Measured on `69d4b45d`, trusted, not re-derived here:

- 1,241 files, 3,629 import edges. Source 142,944 LOC / 565 files;
  tests 177,444 LOC / 676 files.
- 28 of 49 source folders sit in an import cycle.
- **One SCC spans 22 folders**: `core/lib`, `core/daemon`, `core`,
  `cli/commands`, `cli`, `workflows`, `workflows/primitives`,
  `core/lib/git`, `core/workers`, `core/daemon/view`, `core/daemon/rpc`,
  `core/daemon/spend-control`, `core/store`, `outbox`,
  `outbox/subscribers`, `internal-bus`, `init`, `ideas`, `bus`,
  `core/lib/deployment`, `core/mcp`, and the `orchestrator/src` root files.
- A second 6-folder SCC in `ui`: `widgets/chat`, `hooks`, `widgets`,
  `entities`, `shared`, `components`.
- Largest file cycle: 34 files around `core/arc.ts`, `core/queue.ts`,
  `core/lib/action-queue.ts`, `core/blocker-resolution.ts`,
  `core/daemon/kpi-store.ts`, `core/lib/action-queue-recipes.ts`.

Ground rules this plan obeys:

- **Hard cut** (CLAUDE.md). No compat re-exports, no `export * from
  './old-path'` shims, no deprecation aliases. When a symbol moves, every
  call site moves in the same commit. A barrel that re-exports the old
  name is exactly the thing that re-creates the cycle.
- **ADR-0052 is preserved.** `Arc` stays the sole writer of task/arc
  state. Nothing in this plan moves a write out of `arc.ts`. Where the
  plan deletes a function, it deletes a *pass-through wrapper* around an
  `Arc` method and repoints callers at `Arc` — that strengthens ADR-0052,
  it does not weaken it.
- **ADR-0021 is the lever.** Most of the hard cycle exists because
  modules reach for a *default* store via a module-level factory import
  instead of receiving an injected one. Inverting those is the single
  highest-leverage move in this document.
- **Three install roots.** Verification commands must be spelled
  `npm --prefix orchestrator run <x>` / `npm --prefix ui run <x>`. There is
  no workspace root that runs both.
- **There is no linter in this repo.** No ESLint, no Biome, no oxlint.
  What does exist (verified in `package.json`): `knip --no-exit-code` in
  both roots (unused-export detection, non-blocking) and
  `ui: lint:tokens` (a bespoke design-token check,
  `ui/scripts/lint-tokens.mjs`). Neither can express an import rule. The
  only enforcement surfaces available for layering are `tsc --noEmit`,
  `vitest`, and a dependency-cruiser config we have to add ourselves
  (Step 0).

### The one structural diagnosis

Four mechanisms, in descending order of damage, produce nearly every
cycle in the orchestrator:

1. **Types are declared inside the big behavioural module that happens
   to use them first.** `Task` and friends live in the 2,082-line
   `core/queue.ts`; the daemon's view DTOs live in the 2,525-line
   `core/daemon/http-server.ts`; `Semaphore` lives in the 5,753-line
   `core/daemon/server.ts`. Every consumer that wants one type must
   import a module full of behaviour — and that module imports back.
2. **Facades that delegate to the aggregate.** `core/queue.ts` and
   `core/store/task-store.ts` both hold thin wrappers over `Arc.*`, so
   the data layer imports the aggregate that imports the data layer.
3. **Service-locator default stores.** `arc.ts` calls
   `getDefaultTaskStore()` / `getDefaultDomainTaskStore()` imported
   directly from `core/store/task-store.ts` — the concrete composed
   facade — rather than taking the port injected.
4. **One stray upward type import.** `core/queue.ts` imports
   `type SliceSpec` from `workflows/slice-workflow.ts`. That single edge
   drags `workflows` and `workflows/primitives` into the core SCC.

Fixing 1–4 evicts the large majority of the 22 folders. Sections 1–5
give the file-level detail.

---

## 1. The 34-file SCC — `core/arc.ts` / `core/queue.ts` / `core/lib/action-queue.ts` / `core/blocker-resolution.ts` / `core/daemon/kpi-store.ts` / `core/lib/action-queue-recipes.ts`

This is the hard one. It is not one cycle; it is five independent loops
that overlap on `arc.ts` and `queue.ts` and therefore merge into one SCC.
Each loop has its own remedy and can be cut on its own commit.

### 1a. `core/queue.ts` → `core/arc.ts` → `core/queue.ts` — the facade loop

**Offending edges (verified by reading):**

- `core/queue.ts:12` — `import { Arc } from './arc'` (**value**).
- `core/arc.ts:23-48` — `import { …, getTask, reopenTerminalTask, updateTask, resolveQueueClient, rowToTask, TASK_SEL, ensureQueueSchema, MAX_PRIORITY, UNSETTLED_BLOCKER_SQL, type Task, type TaskPlan, type TaskStatus, type TaskDropReason, type TaskKind, type TaskTag, type EnqueueTaskOptions, type DropTaskResult, type UnblockTaskResult } from './queue'` (**value + type**).

`queue.ts` uses `Arc` in exactly one way: a family of pass-through
wrappers. Confirmed call sites in `queue.ts`:

| line | wrapper | delegates to |
| --- | --- | --- |
| 1085 | `enqueueTask` | `Arc.createOrigin` |
| 1489 | (status write) | `Arc.applyStatusWrite` |
| 1761 | `dropTask` | `Arc.load(id).drop()` |
| 1772 | `insertReflectionTask` | `Arc.load('reflect').insertReflection` |
| 1786 | `addBlockers` | `Arc.load(taskId).addBlocker` |
| 1806 | `addPendingReviewBlockers` | `Arc.load(taskId).addPendingReviewBlockers` |
| 1818 | `removeBlocker` | `Arc.load(taskId).removeBlocker` |
| 1822 | `clearBlockers` | `Arc.load(taskId).clearBlockers` |
| 1966 | `transferProposalBlockerToTask` | `Arc.transferProposalEdges` |
| 1991 | `unblockTask` | `Arc.unblockTask` |
| 2159 | `promoteDraftToTriaging` | `Arc.promoteDraftToTriaging` |
| 2172 | `promoteDraftToQueued` | `Arc.promoteDraftToQueued` |

Their own doc-comments say so: *"Thin wrapper over {@link Arc.addBlocker}
(ADR-0052 sole-writer)"*.

**Remedy — split the two-responsibility module, then delete the facade.**

`core/queue.ts` currently is (a) `Task` type declarations + SQL constants,
(b) row-mapping and read queries, (c) an `Arc` facade. Cut it into:

- **New leaf** `orchestrator/src/core/task-types.ts` — everything from
  `queue.ts` lines 21–593 and the later interface blocks, i.e.
  `TaskStatus`, `TaskDropReason`, `BlockerState`, `BlockerCauseKind`,
  `Blocker`, `TaskKind`, `TaskTag`, `FailedPhase`, `TaskType`,
  `TASK_TYPES`, `SubDeliverableSpec`, `TaskSpec`, `TaskPlan`,
  `QaReportCriterion`, `QaReport`, `Task`, `MAX_PRIORITY`,
  `UpsertTranscriptInput`, `TaskTranscriptRow`, `EnqueueTaskOptions`,
  `DropTaskResult`, `UnblockTaskResult`. Zero imports except
  `SliceSpec` (see 1e).
- **New leaf** `orchestrator/src/core/task-sql.ts` — `TASK_SEL`,
  `UNSETTLED_BLOCKER_SQL`, `rowToTask`, `assertTaskKindInvariant`,
  `coerceToString`, `validatePriority`, `isTaskTag`, `isTaskType`.
  Imports `task-types.ts` only.
- `core/queue.ts` keeps only reads and non-arc writes; **its 12 `Arc.*`
  wrappers are deleted** and every caller is repointed at `Arc` directly.
  `import { Arc } from './arc'` disappears from `queue.ts`.
- `core/arc.ts` imports `./task-types` and `./task-sql` instead of
  `./queue`, plus the handful of true read helpers it still needs
  (`getTask`, `updateTask`, `reopenTerminalTask`, `resolveQueueClient`,
  `ensureQueueSchema`) — those stay in `queue.ts` and the edge
  `arc.ts → queue.ts` remains, now **one-directional**.

**Blast radius:** 82 non-test source files import `core/queue.ts`. Most
import only types and only need their specifier retargeted to
`core/task-types` — mechanical. The genuinely behavioural change is the
~12 wrapper deletions; a caller count for each must be taken at
implementation time (`grep -rn "enqueueTask\|dropTask\|unblockTask\|addBlockers" orchestrator/src`).
Tests: `core/queue.supersede.test.ts` and everything under
`core/__tests__` will need specifier updates.

**Risk:** medium-high. Deleting `queue.enqueueTask` in favour of
`Arc.createOrigin` changes which module owns default-store resolution for
those call sites. Do 1a **after** 1c (the store inversion) so the
injected-store seam already exists. This is the one step in the document
that needs real design judgement rather than mechanical retargeting.

### 1b. `core/store/task-store.ts` → `core/arc.ts` → `core/store/task-store.ts` — the store/aggregate loop

**Offending edges (verified):**

- `core/store/task-store.ts:79` — `import { Arc } from '../arc'` (**value**);
  used at lines 518, 526, 529, 535, 539 to build the `DomainTaskStore`
  facade (`enqueueTask`, `dropTask`, `insertReflectionTask`,
  `addBlockers`, `removeBlocker` all route through `Arc`).
- `core/store/task-store.ts:67,78` — value + type imports from `../queue`.
- `core/arc.ts:49-53` — `import { getDefaultTaskStore, getDefaultDomainTaskStore, type DomainTaskStore } from './store/task-store'` (**value**), consumed at 15 sites in `arc.ts` (lines 265, 282, 1754, 2337, 2491, 2677, 2768, 2855, 2891, 2999, 3113, 3251, 3302).

This is the ADR-0021 violation in its purest form: the aggregate reaches
into the concrete composed store to fetch a default instance.

**Remedy — extract the port, invert the default via a registry.**

- **New leaf** `orchestrator/src/core/store/task-store-port.ts` — the
  `TaskStore` and `DomainTaskStore` **interfaces only**. No imports
  except `../task-types`.
- **New leaf** `orchestrator/src/core/store/default-store-registry.ts` —
  a tiny module holding a settable slot:
  `registerDefaultTaskStore(factory)`, `getDefaultTaskStore()`,
  `getDefaultDomainTaskStore()`. Imports `task-store-port.ts` only.
  Throws a clear "no default store registered" error if unset.
- `core/store/task-store.ts` keeps the composed facade, imports `Arc`,
  `queue`, the port and the registry, and **calls
  `registerDefaultTaskStore(...)` at module load**. It becomes a
  composition-root module: nothing in the domain imports it.
- `core/arc.ts` imports the interfaces from `task-store-port.ts` and the
  two getters from `default-store-registry.ts`. The edge
  `arc.ts → store/task-store.ts` is gone.
- Whoever boots the process (`core/daemon/server.ts`, `cli.ts`, test
  setup) must import `core/store/task-store.ts` once so registration
  happens. This is the honest cost of the inversion and must be spelled
  out in the commit.

**Blast radius:** 52 non-test source files import `store/task-store`.
The majority import `type DomainTaskStore` / `type TaskStore` only —
retarget to `task-store-port`, mechanical. Real work is confined to
`arc.ts` (15 sites), `task-store.ts`, and the boot modules.

**Risk:** medium. The failure mode is a **load-order bug**: a module
calls `getDefaultDomainTaskStore()` before `task-store.ts` has been
imported. Mitigation: make the registry throw loudly (never return
`undefined`), and add one test that boots the CLI entry and the daemon
entry and asserts a default store resolves. An alternative design —
threading the store through every `Arc` entry point and deleting the
default entirely — is cleaner but is a far larger change; the registry is
the pragmatic cut. Flag for a human: **do we accept a registry
service-locator here, or pay for full injection?**

### 1c. `core/lib/action-queue.ts` ↔ `core/lib/action-queue-recipes.ts` — the type loop

**Offending edges (verified):**

- `core/lib/action-queue.ts:8` — `import { lookupRecipe, getRecipeVerbs } from './action-queue-recipes'` (**value**).
- `core/lib/action-queue-recipes.ts:14` — `import type { ActionQueueKind } from './action-queue'` (**type only**).

Pure type placement. Nothing more.

**Remedy — extract shared types to a leaf.**

- **New leaf** `orchestrator/src/core/lib/action-queue-kinds.ts` —
  `ActionQueueKind` and any sibling literal unions / row-shape types the
  two modules share. Zero imports.
- Both modules import from it. Cycle gone.

**Blast radius:** 53 non-test source files import `lib/action-queue`.
Only those importing `ActionQueueKind` change — likely a dozen or so;
count at implementation time. Purely mechanical.

**Risk:** low. This is the safest step in the whole document and is the
right first substantive commit.

### 1d. `core/blocker-resolution.ts` — pulled in transitively, no own fix needed

**Verified:** `blocker-resolution.ts` does **not** import `arc.ts`. Its
imports are `./queue-retry`, `./queue` (`getTask`),
`./lib/action-queue`, `./lib/worktree-ahead-payload`, `./lib/sweep`,
`./lib/failure-signature`. Meanwhile `core/arc.ts:76-100` imports ~14
symbols and types from `blocker-resolution.ts`.

So the loop is `arc → blocker-resolution → queue → arc`, and it is closed
**by 1a alone**. `blocker-resolution.ts` needs no edit. Do not open it.

### 1e. `core/queue.ts` → `workflows/slice-workflow.ts` — the one edge that drags in `workflows`

**Offending edge (verified):**

- `core/queue.ts:16` — `import type { SliceSpec } from '../workflows/slice-workflow'` (**type only**), used once at `queue.ts:301` inside `TaskSpec` (`subDeliverables?: SliceSpec[]` shape).
- Return leg: `workflows/slice-workflow.ts:6-19` imports 14 symbols from
  `core/*` including `core/queue`, `core/arc`, `core/store/task-store`,
  `core/lib/action-queue`, `core/daemon/config`.

`workflows → core` is the correct direction (ADR-0056: adapters/pipelines
above the domain). `core → workflows` is the offender, and it is a single
type-only edge.

**Remedy — move the type to the side that owns it.** `SliceSpec`
describes a unit of task work, not a workflow implementation detail. Move
its declaration into the new `orchestrator/src/core/task-types.ts` (or, if
it is genuinely workflow-shaped, into a new leaf
`orchestrator/src/core/slice-spec.ts`). `workflows/slice-workflow.ts`
imports it from there.

**Blast radius:** small — everyone importing `SliceSpec` from
`workflows/slice-workflow` retargets. `workflows/slice-workflow.ts` is
1,818 lines but only the `export … SliceSpec` declaration moves.

**Risk:** low, and the payoff is disproportionate: this one edge is what
puts `workflows` and `workflows/primitives` (5,040 + 5,205 LOC) inside
the core SCC.

### 1f. `outbox/subscribers/steward-runtime-tune.ts` → `core/daemon/server.ts`

**Offending edges (verified):**

- `outbox/subscribers/steward-runtime-tune.ts:6,7` — `import type { Semaphore }` and `import { setSemLimit }` from `core/daemon/server.js` (**value**).

`daemon/server.ts` is downstream of the outbox subscribers it dispatches,
so this closes an `outbox → daemon → outbox` loop and is what puts
`outbox` and `outbox/subscribers` in the SCC.

**Remedy:** the same `Semaphore` extraction as §2 below. Once
`makeSem`/`acquire`/`release`/`setSemLimit`/`Semaphore` live in
`core/daemon/semaphore.ts`, this subscriber imports the leaf and the loop
is gone. **§2 and §1f are one commit.**

### 1g. `core/daemon/kpi-store.ts` — pulled in transitively

**Verified:** `kpi-store.ts` imports only `../lib/kpi-snapshots.js`,
`../lib/kpi-compute.js`, `../store/task-store.js`. It has **no** back-edge
of its own; it is in the SCC solely via `store/task-store.ts`, which
imports `Arc`. **1b alone evicts it.** No edit to `kpi-store.ts`.

Note: `core/app-services.ts:71-76` imports `listKpis`/`listKpiArcs` from
`daemon/kpi-store`, which is why `kpi-store` also touches §4b's loop.

---

## 2. The 5-file RPC cycle — `rpc/handlers.ts → rpc/registry.ts → rpc/types.ts → daemon/server.ts → rpc/handlers.ts`

**It is NOT pure type placement. Verified by reading — there is a real
value edge.**

**Offending edges:**

| edge | line | kind |
| --- | --- | --- |
| `daemon/server.ts` → `rpc/registry.ts` | `server.ts:158` `import { rpcRegistry, dispatchRpc }` | value |
| `daemon/server.ts` → `rpc/types.ts` | `server.ts:159` `import type { DaemonDeps }` | type |
| `rpc/registry.ts` → `rpc/handlers.ts` | `registry.ts:16` `import { allRpcHandlers }` | value |
| `rpc/handlers.ts` → `daemon/server.ts` | `handlers.ts:20` `import { setSemLimit }` | **value — this is the one that matters** |
| `rpc/types.ts` → `daemon/server.ts` | `types.ts:38` `import type { Semaphore }` | type |

So the load-bearing loop is `server → registry → handlers → server`, a
genuine runtime cycle, plus a type-only leg through `types.ts`.

**What `handlers.ts` actually needs** is 40 lines of semaphore code that
live inside a 5,753-line file. Verified: `server.ts:200-256` declares
`interface Semaphore`, `makeSem`, `acquire`, `release`, `setSemLimit`.
This block imports nothing — it is a pure, self-contained utility that
happens to be parked in the daemon entry point.

**Remedy — extract to a leaf.**

- **New leaf** `orchestrator/src/core/daemon/semaphore.ts` — moves
  `server.ts:200-256` verbatim: `Semaphore`, `makeSem`, `acquire`,
  `release`, `setSemLimit`. Zero imports.
- `server.ts`, `rpc/handlers.ts`, `rpc/types.ts` and
  `outbox/subscribers/steward-runtime-tune.ts` import from it.
- Do **not** move `pickWorkflowFor` (server.ts:214) in the same commit —
  it imports `Task` and belongs with the 1a work.

**Blast radius:** exactly 12 files, enumerated:
`core/daemon/server.ts`, `core/daemon/rpc/types.ts`,
`core/daemon/rpc/handlers.ts`, `outbox/subscribers/steward-runtime-tune.ts`
(source, 4); `outbox/subscribers/steward-runtime-tune.test.ts`,
`core/daemon/__tests__/sem-reload.test.ts`,
`core/daemon/__tests__/merge-does-not-starve-implement.test.ts`,
`core/daemon/__tests__/verify-concurrency.test.ts`,
`core/daemon/__tests__/rpc-step-reset.test.ts`,
`core/daemon/__tests__/rpc-seam.test.ts`,
`cli/__tests__/proposal-take.test.ts` (tests, 7).

**Risk:** very low. Pure code motion, no behaviour change, exhaustively
enumerated blast radius. Best first commit after Step 0.

**Residual after the fix:** `rpc/types.ts` still imports from
`../../queue`, `../../arc`, `../../blocker-resolution`,
`../../../workflows/init-workflow`. Those are downward once §1 lands; they
are not cycles on their own.

---

## 3. The 4-file provider cycle — `provider-bin.ts ↔ providers.ts ↔ providers/codex-headless.ts ↔ providers/gemini-headless.ts`

**Confirmed by reading: this is 100% type placement. The
"registry/plugin inversion" hypothesis is WRONG — no inversion is needed.**

**Offending edges:**

| edge | line | kind |
| --- | --- | --- |
| `providers.ts` → `providers/codex-headless.ts` | `providers.ts:16` `import { codexHeadless }` | value (legit, downward) |
| `providers.ts` → `providers/gemini-headless.ts` | `providers.ts:17` `import { geminiHeadless }` | value (legit, downward) |
| `providers/codex-headless.ts` → `providers.ts` | `codex-headless.ts:20` `import type { HeadlessAdapter, HeadlessRunOpts }` | **type only** |
| `providers/gemini-headless.ts` → `providers.ts` | `gemini-headless.ts:16` `import type { HeadlessAdapter, HeadlessRunOpts }` | **type only** |
| `provider-bin.ts` → `providers.ts` | `provider-bin.ts:30` `import type { ProviderName }` | **type only** |
| `providers/codex-headless.ts` → `provider-bin.ts` | `codex-headless.ts:21` `import { providerBinPath }` | value (legit) |
| `providers/gemini-headless.ts` → `provider-bin.ts` | `gemini-headless.ts:17` `import { providerBinPath }` | value (legit) |

Every back-edge is `import type`. Three types are the whole problem:
`ProviderName` (`providers.ts:19`), `HeadlessRunOpts` (`providers.ts:94`),
`HeadlessAdapter` (`providers.ts:134`).

**Remedy — one leaf, no inversion.**

- **New leaf** `orchestrator/src/core/workers/provider-types.ts` —
  `ProviderName`, `HeadlessRunOpts`, `HeadlessAdapter`, plus
  `ProviderUsageSemantics` if it too is shared. It may import
  `type ClaudeEvent` from `../lib/claude-stream` safely —
  **verified: `core/lib/claude-stream.ts` has zero imports of its own and
  is already a leaf.** `ClaudeEvent` does not need to move.
- `providers.ts`, `provider-bin.ts`, `providers/codex-headless.ts`,
  `providers/gemini-headless.ts` all import the leaf.
- The eager registry import (`providers.ts` → the two adapters) stays.
  It is a legitimate downward composition edge and is not part of any
  cycle once the types are leaf.

**Blast radius:** 27 import statements across 24 files reference
`workers/providers`; the ones that import only `ProviderName` /
`HeadlessAdapter` / `HeadlessRunOpts` retarget. Known consumers include
`core/daemon/config.ts`, `core/daemon/chat-runner.ts`,
`core/lib/worker-json.ts`, `core/lib/failure-reflector.ts`,
`core/lib/run-worker-with-span.ts`, `core/lib/reflector.ts`,
`core/lib/usage-sources.ts`, `core/lib/deep-reflector.ts`,
`core/workers/run-pty-session.ts`, `core/workers/index.ts`,
`core/workers/persisted-registry.ts`, `workflows/reflect-workflow.ts`,
`workflows/primitives/index.ts`, `cli/commands/doctor.ts`,
`cli/commands/install.ts`, `cli/commands/provider-probe.ts`, plus 4 test
files.

**Risk:** low. Mechanical. The only judgement call is whether
`ProviderUsageSemantics` and `ClaudeEvent` follow the types into the leaf.

---

## 4. The two 3-file cycles

### 4a. `daemon/chat-runner.ts` ↔ `daemon/chat-stream-hub.ts` ↔ `daemon/ui-message-chunks.ts`

**Confirmed: pure type placement.**

| edge | line | kind |
| --- | --- | --- |
| `chat-runner.ts` → `chat-stream-hub.ts` | `chat-runner.ts:51` `import type { ChatStreamHub }` | type only |
| `chat-stream-hub.ts` → `ui-message-chunks.ts` | `chat-stream-hub.ts:17` `import { ChunkMapper, type UiMessageChunk }` | value |
| `chat-stream-hub.ts` → `chat-runner.ts` | `chat-stream-hub.ts:18` `import type { ChatSegment }` | type only |
| `ui-message-chunks.ts` → `chat-runner.ts` | `ui-message-chunks.ts:19` `import type { ChatSegment }` | type only |

`ChatSegment` is declared at `chat-runner.ts:98`; `ChatStreamHub` is a
**class** at `chat-stream-hub.ts:48` but is imported type-only by
`chat-runner.ts`.

**Remedy — one leaf contracts module.**

- **New leaf** `orchestrator/src/core/daemon/chat-contracts.ts` —
  `ChatSegment` and a structural `ChatStreamHubPort` interface (the
  subset of `ChatStreamHub` that `chat-runner.ts` actually consumes;
  read the call sites and narrow it, do not copy the class shape
  wholesale). Zero imports.
- `chat-runner.ts` imports `ChatSegment` + `ChatStreamHubPort` from the
  leaf. `chat-stream-hub.ts` imports `ChatSegment` from the leaf and
  declares `class ChatStreamHub implements ChatStreamHubPort`.
  `ui-message-chunks.ts` imports `ChatSegment` from the leaf.

**Blast radius:** 3 source files + whatever imports `ChatSegment`
elsewhere (`core/daemon/__tests__/chat-runner.test.ts`,
`chat-provider-memory.test.ts` at minimum). Small — under 10 files.

**Risk:** low-medium. Narrowing `ChatStreamHub` to a port is a small
design call; taking the lazy route (moving the whole class shape into the
leaf) works but is uglier. Note the class stays where it is — only the
contract moves.

### 4b. `core/app-services.ts` ↔ `daemon/http-server.ts` ↔ `core/lib/primitive-catalog.ts`

**Confirmed: a two-responsibility module. `http-server.ts` is both the
HTTP transport AND the declaration site of the view DTOs.**

| edge | line | kind |
| --- | --- | --- |
| `app-services.ts` → `daemon/http-server.ts` | `app-services.ts:90-103` — 13 types: `StepSpan`, `RunTimeline`, `RunTimelineStep`, `StepPromptView`, `FrameworkUpdateState`, `DraftFeature`, `StaleWorktreeAlert`, `PrimitiveSummary`, `PrimitiveDetail`, `PrimitiveObservedTool`, `PrimitiveRun`, `PrimitivePark` | type only |
| `daemon/http-server.ts` → `app-services.ts` | `http-server.ts:25` `import type { AppServices }` | type only |
| `app-services.ts` → `lib/primitive-catalog.ts` | `app-services.ts:104-111` `PRIMITIVE_CATALOG, PRIMITIVE_NAMES, isPrimitiveName, primitiveForSpan, buildWorkerProfiles, type PrimitiveCatalogEntry` | value |
| `lib/primitive-catalog.ts` → `daemon/http-server.ts` | `primitive-catalog.ts:26` `import type { PrimitiveWorkerProfile }` (declared at `http-server.ts:204`) | type only |

Every edge is type-only except `app-services → primitive-catalog`. This
directly contradicts ADR-0055 ("displays are thin adapters over one
application-service layer") — the transport currently owns the contracts
the application service is supposed to define.

**Remedy — move the DTOs to the side that owns them.**

- **New leaf** `orchestrator/src/core/daemon/view/contracts.ts` — all 13
  DTO types above plus `PrimitiveWorkerProfile`, moved out of
  `http-server.ts`. `core/daemon/view/` already exists (`view/action-queue`,
  `view/terminal-events`, `view/release-notes`, `view/sessions`,
  `view/progress`), so this is the natural home and matches the shape
  `app-services.ts` already imports from.
- `app-services.ts` imports them from `view/contracts`.
- `lib/primitive-catalog.ts` imports `PrimitiveWorkerProfile` from
  `view/contracts`.
- `http-server.ts` imports them from `view/contracts` and keeps
  `import type { AppServices } from '../app-services'` — that edge is now
  one-directional and correct (adapter → application service, ADR-0055).

**Blast radius:** `app-services.ts`, `http-server.ts`,
`lib/primitive-catalog.ts`, plus every UI-adjacent module and test that
imports these DTOs from `daemon/http-server`. Count at implementation
time with
`grep -rn "from '.*http-server'" orchestrator/src`. Expect 15–30 files.
Note the `ui/` side declares its own copies (`ui/src/widgets/TaskDetailDrawer.tsx:85`
declares its own `RunTimeline`) — **do not** try to unify them in this
commit; that is a separate contract-sharing decision.

**Risk:** low-medium. Mechanical, but `http-server.ts` is 2,525 lines and
the DTOs are interleaved with route handlers; the extraction is fiddly to
do cleanly and is the step most likely to produce a noisy diff.

---

## 5. The 6-folder UI SCC — `widgets/chat`, `hooks`, `widgets`, `entities`, `shared`, `components`

**Key finding: `hooks` and `components` have no upward imports at all in
non-test code. They are in the SCC purely because of test-file edges out
of `shared/`.** Fixing four test imports evicts two of the six folders.

The intended layering (FSD-flavoured) is
`shared → entities → components → widgets → pages → app`, downward-only.
Every offending edge below points the wrong way.

**Offending edges (verified, non-test):**

| # | edge | line |
| --- | --- | --- |
| U1 | `shared/routing.ts` → `entities/primitive/types` | `routing.ts:3` `import { PRIMITIVE_NAMES, type PrimitiveName }` (value) |
| U2 | `shared/notifications/alertNotifier.ts` → `entities/actionQueue/useActionQueue` | `alertNotifier.ts:2` `import { useActionQueue }` (value) |
| U3 | `entities/studio/useStudio.ts` → `widgets/TaskDetailDrawer` | `useStudio.ts:18` `import type { RunTimeline }` |
| U4 | `entities/studio/api.ts` → `widgets/TaskDetailDrawer` | `api.ts:16` `import type { RunTimeline }` |
| U5 | `widgets/chat/SidebarFilters.tsx` → `pages/ActionQueuePageFilters` | `SidebarFilters.tsx:5` |
| U6 | `widgets/chat/queueThreads.ts` → `pages/ActionQueuePageFilters` | `queueThreads.ts:10` `import { filterByQuery }` |
| U7 | `widgets/chat/QueueThreadDetail.tsx` → `widgets/OriginTree`, `widgets/ArcChainRail`, `widgets/ArcTree` | `QueueThreadDetail.tsx:16-18` |

**Offending edges (test-only — these are what drag in `hooks` and `components`):**

| # | edge | line |
| --- | --- | --- |
| U8 | `shared/chatTurnTokens.test.ts` → `pages/ChatPage` | `:4` `import { MessageView }` |
| U9 | `shared/routing.test.ts` → `entities/primitive/types` | `:25` |
| U10 | `shared/highlightGlossary.test.ts` → `components/glossary/GlossaryHighlighter` | `:4` |
| U11 | `shared/useRead.test.tsx` → `components/ReconnectingStrip` | `:25` |
| U12 | `entities/actionQueue/useActionQueue.test.tsx` → `pages/ChatPage` | `:17` |

`hooks/` imports only `@/shared/*` (verified: `useWorkerSessions.ts`,
`useTasks.ts`, `useProgress.ts` — all `@/shared` only) and is imported by
`app/App.tsx`, `pages/ProgressPage.tsx`, `pages/ChatPage.tsx`,
`widgets/NavBar.tsx`, `widgets/chat/useThreadFocus.ts`. It is a clean
downward folder that got swept into the SCC transitively.

**Remedies, per edge:**

- **U1 / U9 — move the constant down.** `PRIMITIVE_NAMES` /
  `PrimitiveName` is shared vocabulary, not an entity. Move to
  **new leaf** `ui/src/shared/primitiveNames.ts`;
  `entities/primitive/types` re-declares nothing and imports from shared.
  Mechanical.
- **U2 — invert with an injected callback.** `alertNotifier` is a
  `shared/` module calling an entity hook. Change
  `alertNotifier` to take the action-queue rows (or a
  `() => ActionQueueRow[]` getter) as an argument, and have the
  `entities/actionQueue` layer wire it. This is the one UI edge needing
  design judgement.
- **U3 / U4 — move the DTO to the data layer.** `RunTimeline` is
  server-shaped data (`ui/src/widgets/TaskDetailDrawer.tsx:85`, alongside
  `RunTimelineStep:53` and `RunTimelineEntry:77`). Move all three to
  **new leaf** `ui/src/shared/schemas/runTimeline.ts` (or extend the
  existing `shared/schemas`). `TaskDetailDrawer.tsx` (1,918 lines) and
  both `entities/studio` files import from there. Mechanical, and it also
  pairs with §4b — the orchestrator declares the same shape.
- **U5 / U6 — move the filter logic down.** `ActionQueuePageFilters`
  contains reusable predicates (`filterByQuery`) sitting in `pages/`.
  Move to **new leaf** `ui/src/shared/actionQueueFilters.ts`;
  `pages/ActionQueuePageFilters.tsx` keeps only the React component and
  imports the predicates. Mechanical.
- **U7 — `widgets/chat` → `widgets` is arguably legal.** `widgets/chat`
  is a subfolder of `widgets`; a child importing siblings from its parent
  folder is normal composition, and dependency-cruiser flags it only
  because it treats the folders as distinct nodes. **Decision needed:**
  either (a) declare `widgets/**` a single layer in the
  dependency-cruiser config and stop counting this, or (b) flatten
  `widgets/chat/*` into `widgets/`. Recommend (a) — it is free and (b) is
  churn for no architectural gain. **Flag for the human.**
- **U8 / U10 / U11 / U12 — the test edges.** `shared/*.test.*` importing
  `pages/` and `components/` are integration tests filed in the wrong
  folder. Move each test file next to the component it exercises:
  `shared/chatTurnTokens.test.ts` → `pages/__tests__/`,
  `shared/highlightGlossary.test.ts` → `components/glossary/__tests__/`,
  `shared/useRead.test.tsx` → `components/__tests__/`,
  `entities/actionQueue/useActionQueue.test.tsx` → `pages/__tests__/`.
  Zero production-code change. **This single commit removes `hooks` and
  `components` from the SCC.**

**Blast radius:** small per edge — the UI SCC is wide but shallow.
Roughly 15–20 files touched across all of §5.

**Risk:** low, except U2 (real inversion) and U7 (a policy decision, not
a code change).

---

## 6. THE SEQUENCE

Each step is one commit, independently landable, independently
verifiable. Ordered so the dependency-cruiser baseline **strictly
shrinks** at every step and never grows. No step depends on a later step.

Shared verification, run after every step (all three must pass):

```
npm --prefix orchestrator run typecheck    # tsc --noEmit
npm --prefix orchestrator test             # vitest run
npm --prefix ui run typecheck              # tsc --noEmit && tsc -p tsconfig.server.json --noEmit
npm --prefix ui test                       # lint:tokens + vitest run + bun test (server/)
```

Script names verified against `orchestrator/package.json` and
`ui/package.json` on `69d4b45d`. Note `ui test` shells out to **bun** for
`test:server` (13 named `server/*.test.ts` files) — a machine without bun
will fail that leg even when the change is orchestrator-only. There is
also a fourth source tree, `ui/server/`, that the folder census above does
not cover; treat any edge into it as out of scope for this plan.

Plus the step-specific cycle assertion given below.

### Step 0 — commit the dependency-cruiser config and the baseline

**There is no dependency-cruiser config in this repo.** The measurements
in this document were taken ad hoc. Without a committed config and
baseline, "strictly shrinks" is unenforceable and every later step is
unverifiable.

- Add `orchestrator/.dependency-cruiser.cjs` and
  `ui/.dependency-cruiser.cjs` with a `no-circular` rule at `warn`
  (not `error` — 28 folders are currently in cycles).
- Add `"depcruise": "depcruise src --config .dependency-cruiser.cjs"` and
  `"depcruise:baseline": "depcruise src --config .dependency-cruiser.cjs --output-type err-long > .depcruise-baseline.txt"`
  to both `package.json` files. Add `dependency-cruiser` as a devDep in
  both roots (three install roots — it must be installed twice).
- Commit `.depcruise-baseline.txt` in both roots.
- Decide U7 here: whether `widgets/**` counts as one node.

**Verification:**
`npm --prefix orchestrator run depcruise` and `npm --prefix ui run depcruise`
both run and their output matches the committed baseline byte-for-byte.

**Why first:** every subsequent step's acceptance criterion is "the
baseline file shrank". Without this there is no gate.

### Step 1 — extract `core/daemon/semaphore.ts` (kills §2 and §1f)

Move `server.ts:200-256` to `core/daemon/semaphore.ts`. Retarget the 12
enumerated files.

**Verification:** the 5-file RPC cycle
(`handlers → registry → types → server → handlers`) is absent from the
new baseline; `outbox/subscribers → core/daemon` edge is gone;
`npm --prefix orchestrator test -- sem-reload verify-concurrency rpc-seam` passes.

**Why here:** smallest, safest, exhaustively-enumerated blast radius; it
removes two folders (`outbox`, `outbox/subscribers`) and one sub-folder
(`core/daemon/rpc`) from the 22-folder SCC on day one.

### Step 2 — extract `core/workers/provider-types.ts` (kills §3)

**Verification:** the 4-file provider cycle is absent; `core/workers` is
no longer a cycle participant via its own edges;
`npm --prefix orchestrator test -- providers run-pty-session` passes.

### Step 3 — extract `core/lib/action-queue-kinds.ts` (kills §1c)

**Verification:** `action-queue ↔ action-queue-recipes` absent from the
baseline.

### Step 4 — move `SliceSpec` out of `workflows/slice-workflow.ts` (kills §1e)

Land it in `core/slice-spec.ts` (a leaf) rather than waiting for
`core/task-types.ts` in Step 6, so this step stands alone.

**Verification:** `grep -rn "from '.*workflows/" orchestrator/src/core`
returns nothing. `workflows` and `workflows/primitives` drop out of the
core SCC in the new baseline.

**Why before Step 6:** it shrinks the SCC by two large folders for a
one-line change, and Step 6 is the risky one — bank the cheap wins first.

### Step 5 — extract `core/daemon/view/contracts.ts` (kills §4b)

**Verification:** `app-services ↔ http-server ↔ primitive-catalog` absent.

### Step 6 — extract `core/store/task-store-port.ts` + `default-store-registry.ts` (kills §1b)

The first step that needs design judgement. Land the registry, move the
port, repoint `arc.ts`'s 15 default-store call sites, add the
registration call to both boot paths, add the boot test.

**Verification:** `arc.ts` no longer imports `store/task-store`;
`core/daemon/kpi-store` drops out of the SCC; full
`npm --prefix orchestrator test` green — **specifically the tests that
construct an in-memory store**, since load-order regressions surface
there first.

**Why after Steps 1–5:** those are pure code motion; if Step 6 goes wrong
you can revert one commit without losing the mechanical wins.

### Step 7 — split `core/queue.ts` into `task-types.ts` + `task-sql.ts` (type/constant motion only)

**No behaviour change, no wrapper deletions.** Move the declarations,
retarget the 82 importers. `queue.ts` still imports `Arc` after this
step — the cycle is not yet cut, but the baseline does not grow and the
diff is reviewable on its own.

**Verification:** baseline unchanged or smaller (this step must not add
edges); typecheck green.

### Step 8 — delete the 12 `Arc` wrappers from `core/queue.ts` (kills §1a, closes the 34-file SCC)

Repoint every caller at `Arc` directly. Delete
`import { Arc } from './arc'` from `queue.ts`.

**Verification:** `grep -n "Arc" orchestrator/src/core/queue.ts` returns
only comment matches; the 34-file cycle is absent from the baseline;
full orchestrator test suite green, with particular attention to
`core/arc-purge-orphan.test.ts`, `core/arc-unblock-orphan.test.ts`,
`core/queue.supersede.test.ts`.

**Why last in the orchestrator half:** it is the highest-risk change and
depends on Step 6's injected-store seam existing.

### Step 9 — extract `core/daemon/chat-contracts.ts` (kills §4a)

Independent of Steps 1–8; placed here only because it is low-priority.
Could equally run in parallel as Step 1.5.

### Step 10 — UI: relocate the four misfiled test files (§5, U8/U10/U11/U12)

Zero production-code change. Removes `hooks` and `components` from the UI
SCC.

**Verification:** `npm --prefix ui run depcruise` baseline shrinks by two
folders; `npm --prefix ui test` green.

### Step 11 — UI: move `PRIMITIVE_NAMES` to `shared/primitiveNames.ts` (U1/U9)

### Step 12 — UI: move `RunTimeline*` to `shared/schemas/runTimeline.ts` (U3/U4)

### Step 13 — UI: move `filterByQuery` to `shared/actionQueueFilters.ts` (U5/U6)

### Step 14 — UI: invert `alertNotifier` (U2)

The only UI step needing design judgement. Last, so the mechanical UI
wins are already banked.

### Step 15 — tighten the gate

Only once the baselines are empty (or reduced to the U7 exception):
flip `no-circular` from `warn` to `error`, delete the baseline files, and
wire `depcruise` into `pretest` in both roots. This is the step that
makes ADR-0056's "arch-test enforced" claim true for the first time.

**Not in scope of this document:** building the actual ADR-0056
engine/domain/adapters folder structure. None of `engine/`, `domain/`,
`adapters/` exist. Breaking the cycles is a **prerequisite** for that
move, not a substitute for it — you cannot relocate 22 mutually-recursive
folders into three layers. Land Steps 0–15, then do the layer move as a
separate PRD.

---

## 7. REALITY CHECK

### Honest effort

| Step | Effort | Character |
| --- | --- | --- |
| 0 — depcruise config + baseline | 0.5 day | Setup. Fiddly across three install roots. |
| 1 — semaphore extraction | 2 hours | Mechanical. |
| 2 — provider types | 3 hours | Mechanical, 24 files. |
| 3 — action-queue kinds | 1 hour | Mechanical. |
| 4 — SliceSpec | 1 hour | Mechanical, huge payoff. |
| 5 — view contracts | 1 day | Mechanical but fiddly; extracting from a 2,525-line file. |
| 6 — store port + registry | 2–3 days | **Design judgement.** Load-order risk. |
| 7 — queue type split | 1–2 days | Mechanical but 82 importers; large noisy diff. |
| 8 — delete Arc wrappers | 3–5 days | **Design judgement.** Highest risk in the document. |
| 9 — chat contracts | 3 hours | Mostly mechanical; one small port decision. |
| 10 — UI test relocation | 1 hour | Mechanical. |
| 11–13 — UI type/constant moves | 0.5 day total | Mechanical. |
| 14 — alertNotifier inversion | 0.5 day | Design judgement. |
| 15 — tighten the gate | 0.5 day | Setup, plus fixing whatever the strict run surfaces. |

**Total: 11–16 working days of focused work** for one person who already
knows this codebase. Assume 3–4 calendar weeks in practice. Anyone
quoting "a couple of days" has not read `core/queue.ts`.

### Mechanical vs judgement

**Mechanical** (move a declaration, retarget importers, no behaviour
change): Steps 1, 2, 3, 4, 5, 7, 10, 11, 12, 13. Ten of sixteen steps.
These are safely delegable and safely parallelisable across agents,
**provided each takes its own commit** — two agents retargeting
overlapping importer sets will conflict badly.

**Real design judgement:** Steps 6, 8, 14, and the U7 policy call in
Step 0. Four decisions:

1. **Step 6** — registry service-locator vs full constructor injection
   for the default task store. The registry is cheaper and preserves
   every current call shape; full injection is what ADR-0021 actually
   asks for. This document proposes the registry and flags the compromise
   explicitly. **A human should decide.**
2. **Step 8** — which of the 12 `queue.ts` wrappers become direct `Arc`
   calls at the call site, and which are legitimate application-service
   operations that should move to a *new* module rather than being
   inlined. ADR-0055 suggests some belong in `core/app-services.ts`.
3. **Step 14** — the shape of the `alertNotifier` inversion.
4. **U7** — whether `widgets/chat → widgets` is a cycle at all.

### What could go wrong

- **Step 6 load-order.** The default-store registry is populated by
  importing `task-store.ts` for its side effect. Any entry point that
  forgets that import fails at runtime, not at compile time, and possibly
  only on a code path that tests do not cover. This is the most likely
  production incident in the plan. Mitigate with a loud throw and an
  explicit boot test — do not let it return `undefined`.
- **Step 8 silently weakening ADR-0052.** Deleting `queue.enqueueTask`
  and repointing callers at `Arc.createOrigin` is correct, but a careless
  repoint that reaches for `updateTask` instead of `Arc.transition`
  bypasses the aggregate's event emission. Every deleted wrapper needs a
  named replacement decided in advance, not improvised per call site.
- **Step 7's diff is large enough to hide a mistake.** 82 importers, all
  touched in one commit, in a repo with no linter. `tsc --noEmit` will
  catch wrong specifiers but not a wrongly-relocated type that happens to
  be structurally compatible. Consider splitting Step 7 by consumer
  folder if review capacity is thin.
- **Tests outnumber source 177k to 143k LOC.** Every mechanical step
  touches roughly as many test files as source files, and the effort
  estimates above assume that. If a step's test churn is surprising, it
  is usually a sign the extraction boundary is wrong.
- **The baseline can shrink while the design gets worse.** A leaf module
  that is really a grab-bag ("`core/types.ts`") satisfies
  dependency-cruiser and satisfies nothing else. Each new leaf in this
  plan is named for a concept (`task-types`, `provider-types`,
  `action-queue-kinds`, `chat-contracts`, `view/contracts`), not for its
  role in the fix. Hold that line under time pressure.
- **Merge pressure.** This repo runs many parallel worktrees. Steps 7 and
  8 touch files that almost everything else touches. Land them when the
  queue is quiet, or expect to re-do the retargeting.
- **The gate at Step 15 may be unreachable.** If `widgets/**` (U7) or
  some other legitimate composition edge cannot be modelled in the
  dependency-cruiser config, `no-circular: error` will need an allowlist,
  and an allowlist erodes. Budget for that conversation rather than
  assuming a clean zero.

### Confidence and gaps

**Verified at source level on `69d4b45d`:** every edge table in §1a, §1b,
§1c, §1d, §1e, §1f, §1g, §2, §3, §4a, §4b, §5. Line numbers are real and
the kind (value vs type-only) was read, not inferred.

**NOT VERIFIED — needs a pass:**

- The exact remaining membership of the 34-file SCC beyond the six named
  files. This document explains why each named file is in it and how each
  loop closes; it does not enumerate all 34. Re-run dependency-cruiser
  after each of Steps 1–8 and confirm the count actually falls.
- The per-symbol caller counts for the 12 `queue.ts` wrapper deletions
  (Step 8). Only the wrapper list itself is verified.
- Whether `hooks/` has any test-file upward imports. Non-test imports
  were verified to be `@/shared`-only; the test files in `hooks/` were
  not read.
- The size and content of the `PrimitiveSummary` / `PrimitiveDetail`
  family in `http-server.ts` (Step 5) — only their declaration site was
  confirmed, not their bodies or transitive type dependencies.
