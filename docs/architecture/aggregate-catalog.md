# Mars — Aggregate Catalog (DDD target model)

> Companion to `bounded-contexts.html`. This is the **write model**: every
> aggregate, entity, value object, and the methods each exposes — plus the CLI
> surface that drives them and the invariant each method enforces.
>
> Governing principle: **one Arc aggregate root is the sole writer of task/arc
> state.** The legacy free functions (`enqueueTask`, `upsertFixTask`,
> `enqueueFollowUpOnce`, `insertReflectionTask`) become private members of that
> aggregate. The raw libsql client stays unexported (ADR-0021, extended).
> `assertArcInvariant()` runs on every write path: **no mutation may create a
> stranded entity.**

---

## 1. Ubiquitous language delta

The glossary (`CONTEXT.md`) is the base. This strategy adds/sharpens three terms:

| Term | Definition | Relationship |
| --- | --- | --- |
| **Tree** | An idea and all the work sliced from it: a `Proposal` plus every `Arc` derived from it. A standalone `mars task add` (no proposal) is a **one-Arc Tree**. | Tree ⊇ Proposal, Tree ⊇ Arc[] |
| **Action** | A single unit of work with a `kind` (`task` \| `fix` \| `diagnose` \| `write`). `kind` selects the workflow. Supersedes the bare "Task" where polymorphism matters. | Action ∈ Arc |
| **Alert** | An arc-rooted read aggregate: the operator-facing view of a failed/blocked Arc, exposing `goal → reason → technical` in that hierarchy. Distinct from the raw projection row. | Alert over Arc |

`Arc`, `Proposal`, `Action Queue`, `Failure kind`, `KPI`, `Probe` keep their
existing glossary definitions.

---

## 2. Execution context

### Arc — **aggregate root** (the only task/arc writer)

| Attribute | Type | Notes |
| --- | --- | --- |
| identity | `origin_id` | the originating Action's id |
| members | `Action[]` | origin + every continuation/recovery sharing `origin_id` |

| Method | Replaces | Enforces |
| --- | --- | --- |
| `static createOrigin(spec: ActionSpec): Arc` | `enqueueTask` (origin path) | sets `origin_id = id`; `kind='task'`; `assertArcInvariant` |
| `addContinuation(spec, { inheritArc: true }): Action` | `--blocked-by` follow-up, `enqueueFollowUpOnce` | continuation **inherits** parent's resolved `origin_id` (ADR-0050); dedup key off `origin_id` |
| `spawnRecovery(failed: Action, kind: 'fix'\|'diagnose'): Action` | `upsertFixTask`, `attachToExistingFixTask` | by-construction origin edge (ADR-0049); leaf-node rule (ADR-0040); one-recovery budget |
| `transition(action, to: Status): void` | scattered `updateTask` callers | single status funnel; terminal immutability; atomic event emit |
| `addBlocker(from, to): void` | `addBlockers`, `mars block` | `assertNotRecoveryEdge` (ADR-0040); no Idea→Task cycle (ADR-0015) |
| `removeBlocker(from, to): void` | `removeBlocker` | unblock cascade re-check |
| `drop(): void` | `dropTask` | **cascades the whole arc** (ADR-0049); emits `task.terminal{purged}` |
| `status(): ArcStatus` | `arcStatus` (kept) | stateless rollup — no write |
| `private assertArcInvariant(action): void` | new | **every Action attached to an Arc; every Arc has an origin** |

### Action — entity within Arc

```ts
type ActionKind = 'task' | 'fix' | 'diagnose' | 'write'
interface Action {
  id: MarsId
  arcId: MarsId            // === origin_id of its Arc
  kind: ActionKind
  spec: ActionSpec         // prompt, files, verify, done, tags, merge-mode
  status: Status
  fixForTaskId: MarsId | null   // non-null IFF kind='fix'
  selectsWorkflow(): WorkflowId // kind-routed dispatch
}
```

Invariants: `kind='fix' ⟺ fixForTaskId != null` (ADR-0049);
`kind='diagnose' ⟹ fixForTaskId == null`; `selectsWorkflow()` routes on `kind`,
not status.

### WorkflowRun — value object (per Action execution)

`{ workflowId, steps: StepSpan[], runId }`. Steps for `kind='task'`:
`setup → code → verify → merge`. `kind='diagnose'` short-circuits after code
(never commits). `kind='fix'` routes to the Fixer worker.

---

## 3. Planning context

### Tree — aggregate

```ts
interface Tree {
  proposal: Proposal | null     // null ⇒ standalone (1-Arc Tree)
  arcs(): Arc[]
  slice(): Arc[]                 // Proposal → Arcs (emits into Execution)
}
```

### Proposal — aggregate

| Method | Enforces |
| --- | --- |
| `create(goal, author): Proposal` | starts `draft` |
| `setField(field, text): void` | field whitelist |
| `promote(): void` | `draft → prd-ready` |
| `markSliced(): void` | `prd-ready → sliced` |
| `reject(): void` | `→ dismissed` |
| `blockers(): Proposal[]` | separate junction (ADR-0008); Idea→Task edges allowed, Task→Idea rejected (ADR-0015) |

---

## 4. Recovery context

Recovery is **100% application-level** (ADR-0047 finding): it operates on the
Arc aggregate, not the engine.

| Concept | Backing | Invariant |
| --- | --- | --- |
| Recovery Action | `Action{kind:'fix'}` | leaf node (ADR-0040); by-construction origin edge (ADR-0049); exactly one per origin failure |
| Probe | `Action{kind:'diagnose'}` | read-only; never commits; reads-span watcher exempt |
| Recovery recipe | `FailureKind.recipe` | every failure signature has a recipe (ADR-0002) |

Methods live on `Arc.spawnRecovery(...)` — there is no separate recovery writer.

---

## 5. Operator Attention context

### Action Queue — aggregate (pure projection, ADR-0048)

```ts
interface ActionQueue {
  alerts(): Alert[]     // failed / blocked / stale-worktree
  drafts(): Proposal[]  // draft proposals awaiting shaping
  // NO close/dismiss/ack/resolve verb — a row clears iff its entity transitions
}
```

### Alert — arc-rooted read aggregate (**new**)

```ts
interface Alert {
  arcId: MarsId                 // resolved origin_id (ADR-0051)
  goal: string                  // origin Action intent, plain summary
  reason: string                // FailureKind.humanReason — clear English
  technical: {
    failedAction: { id: MarsId; kind: ActionKind; worktree: string }
    signature: FailureSignature
    traceTail: TraceEvent[]
    descendants: Action[]       // fix/diagnose attempts
  }
  clearsBy: 'mutate the underlying entity'   // never a dismiss gesture
}
```

The Alert is **derived**, never stored as a mutable row. It clears exactly when
its Arc reaches a terminal-resolved state or its worktree is removed. This is
the structural form of *"an alert cannot be dismissed; the only way to stop
showing it is to mutate the underlying entity."*

---

## 6. Observability context

| Aggregate / VO | Methods | Notes |
| --- | --- | --- |
| KPI vector | `snapshot()`, `window()` | four KPIs (ADR-0038); cost denominated per completed Arc |
| Step span | `list(originId)` | paired step_started/ended (Transition seam timeline) |
| Reflection | `run()`, `arcReflect(originId)` | post-mortem → draft proposals (`source='reflection'`) |

Read-only consumer of the event stream (Open Host). No domain writes except
emitting draft proposals through the Planning context.

---

## 7. Provisioning context

| Aggregate / VO | Methods | Invariant |
| --- | --- | --- |
| Project registry | `add`, `list`, `remove` | one registry (ADR: Project registry) |
| Supervisor | `render(detectedStack)` | sibling-manifest layout rules |
| **Workflow scaffold** | `scaffold(name)`, `list()`, `validate()`, `reload()` | scaffolded into `.mars/workflows/*.js`; **user-owned Hybrid file** — `mars update` never overwrites (offers diff) |
| Install | `init({ interactive })` | single entry; **every wizard prompt has a flag/config equivalent** (parity-tested) |

---

## 8. Shared kernel

No upstream domain dependencies. Imported by every context.

- `MarsId` / `BareId` — identity (ADR-0039)
- `Bus event` / `Outbox` / `Subscriber` — delivery substrate (ADR-0030/0031)
- `FailureKind` — signature → human reason + recipe + actions (ADR-0042)
- `Status` + the transition contract (Transition seam)

---

## 9. Application-service layer (the one display seam)

Every adapter — CLI, daemon HTTP, TUI, skills — calls these use-cases. **No
adapter re-implements projection or invariant logic** (arch-test enforced).

```ts
appService = {
  proposals:   { create, promote, reject, slice },
  trees:       { list, show },
  arcs:        { createOrigin, addContinuation, list, show, status },
  actions:     { transition, block, unblock },
  recovery:    { spawn, diagnose },
  alerts:      { list, show },          // arc-rooted hierarchy
  actionQueue: { view },                // alerts + drafts, pure projection
  kpis:        { snapshot, window },
  reflect:     { run, arcReflect },
  projects:    { add, list, remove },
  workflows:   { list, scaffold, validate, reload },
}
```

---

## 10. CLI surface — additions & changes

| Command | Status | Purpose |
| --- | --- | --- |
| `mars tree list` / `tree show <id>` | **new** | Tree = proposal + its arcs as one unit |
| `mars arc list` / `arc show <id>` | exists; `show` enriched | rollup; gains goal→reason→technical |
| `mars alert list` / `alert show <id>` | **new** | the arc-rooted Alert aggregate |
| `mars workflow list` | **new** | built-in + scaffolded workflows |
| `mars workflow scaffold <name>` | **new** | write an editable stub into `.mars/workflows/` |
| `mars workflow validate` | **new** | contract-check user workflows before load |
| `mars init` | unified | single entry; TTY→wizard, `--yes`/`-f`→non-interactive |
| `action-queue resolve/dismiss/ack` | already removed (ADR-0048) | confirm no residual paths |
| `/view/todo/dismiss` (daemon) | **cut** | residual dismiss endpoint vs. ADR-0048 |

---

## 11. JS discipline (no "shitty code")

Enforced by lint/tsconfig + arch-tests, per the user's "use of JS should not
permit shitty code writing":

- **`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`** on.
- **No `any`** in domain/engine (`unknown` + narrow). Existing rule
  (`~/.claude/rules/typescript/coding-style.md`) elevated to build-failing.
- **Raw store client unexported**; aggregates are the only writers.
- **Arch-test build-guard**: import direction `adapters → domain → engine`;
  domain is process/HTTP/TTY-free.
- **No raw `INSERT INTO tasks`** outside the Arc aggregate (arch-test).
- **Zod at every boundary** (CLI args, HTTP payloads, scaffolded-workflow specs).
