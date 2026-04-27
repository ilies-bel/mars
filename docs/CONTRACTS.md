# CONTRACTS — Mars Framework

> **Status:** v0.1 — initial lock
> **Date:** 2026-04-27
> **Companion to:** [`../VISION.md`](../VISION.md)

This document specifies the contracts (types, adapters, behaviors) that implement the architecture sketched in `VISION.md`. It is the authoritative reference for v0 implementation. No code yet — design only.

Every decision here was deliberately locked in conversation. Where a recommendation is non-obvious, the rationale is included so future contributors don't re-litigate it.

---

## 1. Core principles (recap + additions)

From `VISION.md` (locked):

- **Declarative agents.** Agents emit typed intent; adapters carry it out.
- **Stateless agents.** No memory; one task → one intent → exit.
- **Lean by default.** No speculative abstraction.
- **Token-frugal.** Hard per-run cap; curated context.
- **Stable interface, swappable internals.** CLI is the contract; everything underneath is an adapter.

Added in this document:

- **Questions are bugs.** Every `Question` raised is a defect in the harness — missing context, ambiguous prompt, weak adapter. The harness's job is to drive the question rate toward zero. `approve_checkpoint` (a deliberate gate) is the one exempt kind.
- **Centralized orchestration.** A single `mars build` process owns the loop. Agents are blind workers — they don't know other agents exist.
- **Parallelism by default.** Multiple agents run concurrently, gated by a configured cap.

---

## 2. Intent

An **intent** is a typed, structured value an agent returns to declare what it wants to happen — without doing it. It is the concrete embodiment of "declarative agents."

```ts
type AgentIntent =
  | { kind: 'plan';     plan: Plan }
  | { kind: 'build';    result: BuildResult }
  | { kind: 'review';   review: Review }
  | { kind: 'question'; question: Question }
```

**Transport.** Each spawned agent writes one intent to:

```
.mars/runs/<handleId>/intent.json
```

…and exits. The orchestrator reads the file, then routes through adapters.

**An agent never:**
- writes files (returns `BuildResult.edits`; FS adapter writes)
- calls `git` (returns `BuildResult.checkpointHint`; VCS adapter commits)
- calls `bd` (returns a `Plan` or task update; PlanStore adapter persists)
- prompts the user (returns a `Question`; HumanQueue parks/asks)

---

## 3. Tasks

### 3.1 Identity

```ts
type TaskId = string  // "<uuid8>-<slug>", e.g. "7f3a91c2-add-oauth-callback"
```

- **uuid8** = first 8 hex chars of a v4 UUID — canonical, immutable.
- **slug** = kebab-case from title, truncated to 40 chars, `[a-z0-9-]` only — cosmetic.
- **References use uuid prefix only.** Slug regenerates on title edit; uuid never changes.

### 3.2 States

```ts
type TaskState =
  | 'to_refine'           // exists, not yet executable; needs planner pass
  | 'ready_for_execution' // refined, deps satisfied; pickable by builder
  | 'awaiting_human'      // blocked on an open Question
  | 'done'                // acceptance criteria met, reviewer passed
```

Derived (not stored):

- **in_progress** = `ready_for_execution` AND `claimedBy != null` AND claim is alive
- **blocked** = `ready_for_execution` AND any dep not `done`

### 3.3 State machine

```
to_refine ──(planner refines + deps resolved)──▶ ready_for_execution
ready_for_execution ──(builder + reviewer pass)──▶ done
ready_for_execution ──(reviewer: needs-changes)──▶ to_refine    [+history entry]
ready_for_execution ──(agent emits question)─────▶ awaiting_human
awaiting_human ──(human answers)─────────────────▶ ready_for_execution
awaiting_human ──(human dismisses)───────────────▶ to_refine    [+history entry]
any failure ─────────────────────────────────────▶ to_refine    [halt-and-flag]
```

Reviewer rejections reuse `to_refine` rather than introducing a `needs_rework` state. Distinguish via `Task.history[]`.

### 3.4 Task type

```ts
type Task = {
  id: TaskId
  planId: PlanId
  title: string
  deps: TaskId[]                    // declared at plan time
  acceptance: string[]
  state: TaskState

  // Claim & liveness (set by orchestrator on next())
  claimedBy?: string                // agent handle id
  claimedAt?: string                // ISO timestamp
  claimedPid?: number               // OS process id of the agent
  claimedHost?: string              // hostname (forward-looking; v0 = single host)

  // Cross-references
  pendingQuestionId?: string        // when state = awaiting_human
  sourceQuestionIds?: string[]      // for retro-spawned tasks

  // Audit trail
  history?: TaskHistoryEntry[]
}

type TaskHistoryEntry = {
  at: string
  kind: 'created' | 'state_change' | 'claimed' | 'released'
       | 'reviewer_reject' | 'human_dismiss' | 'failed'
  from?: TaskState
  to?: TaskState
  by?: string                       // agent handle id, "human", or "orchestrator"
  note?: string
}
```

### 3.5 Claim semantics

**Atomic claim-on-fetch.** `PlanStore.next(query, claimAs)` returns and claims in one call. Two agents can never grab the same task.

**Liveness via PID.** When `next()` finds a claimed task, it checks:

```ts
function isClaimAlive(task: Task): boolean {
  if (!task.claimedPid) return false
  if (task.claimedHost && task.claimedHost !== os.hostname()) return true  // can't check; assume alive
  try { process.kill(task.claimedPid, 0); return true }   // signal 0 = is alive?
  catch { return false }                                    // ESRCH = dead
}
```

If not alive → claim is treated as released; the task is reclaimable immediately. **No wall-clock timeout exists.**

**A task is "free"** iff `claimedBy == null` OR `!isClaimAlive(task)`.

**Optional safety valve** (off by default):

```ts
// mars.config.ts
runaway: {
  enabled: false,
  perAgentTokensCap: 50_000,        // kill agent that exceeds this
}
```

---

## 4. Plans

```ts
type PlanId = string  // same scheme as TaskId
type PlanStatus = 'draft' | 'ready' | 'in_progress' | 'done' | 'failed' | 'halted'

type Plan = {
  id: PlanId
  goal: string
  status: PlanStatus
  origin: 'user' | 'retro'          // 'retro' = spawned by `mars retro`
  taskCount: number
  readyTaskCount: number            // computed: tasks ready AND deps satisfied AND unclaimed
  createdAt: string
  updatedAt: string
}
```

**Canonical form.** Markdown-canonical (`PLAN.md`-style files). PlanStore adapters sync to/from beads if configured.

---

## 5. Build & Review intents

### 5.1 BuildResult

```ts
type FileEdit =
  | { op: 'write';  path: string; contents: string }
  | { op: 'patch';  path: string; diff: string }       // unified diff
  | { op: 'delete'; path: string }
  | { op: 'rename'; from: string; to: string }

type BuildResult = {
  edits: FileEdit[]
  checkpointHint?: string           // human-readable; VCS adapter formats commit msg
  done: boolean                     // true = acceptance met; false = mid-task progress
  tokensUsed: number
}
```

Edits are declarative. The FS adapter applies them to the agent's worktree; the VCS adapter merges back to the main tree on checkpoint.

### 5.2 Review

```ts
type Verdict = 'pass' | 'fail' | 'needs-changes'

type Finding = {
  severity: 'info' | 'warn' | 'error'
  message: string
  path?: string
  line?: number
}

type Review = {
  verdict: Verdict
  findings: Finding[]
  tokensUsed: number
}
```

`pass` → task → `done`. `fail` or `needs-changes` → task → `to_refine` with a `reviewer_reject` history entry.

---

## 6. Questions & HumanQueue

### 6.1 Question type

```ts
type QuestionKind =
  | 'refine_plan'         // planner needs scope/strategy decision
  | 'unblock_task'        // builder can't proceed; needs human input
  | 'resolve_conflict'    // VCS conflict that can't auto-merge
  | 'approve_checkpoint'  // QA gate fired; needs sign-off

type QuestionCategory = 'defect' | 'gate'
// defect = harness shouldn't have asked; counted in retro/audit defect rate
// gate   = deliberate human checkpoint; informational only

type RootCause =
  | 'missing_context'
  | 'ambiguous_prompt'
  | 'weak_adapter'
  | 'plan_underspecified'
  | 'genuine_human_judgment'

type QuestionState = 'open' | 'answered' | 'dismissed'

type Question = {
  id: string                        // <uuid8>-<slug>
  kind: QuestionKind
  category: QuestionCategory
  taskIds: string[]                 // one question can block multiple tasks
  planId?: PlanId
  prompt: string
  options?: string[]                // for approve_checkpoint or A/B decisions

  context: {
    files?: string[]
    excerpts?: { path: string; lines: string }[]
    agentNotes?: string
  }

  state: QuestionState
  answer?: string
  raisedBy: string                  // agent handle id
  raisedAt: string
  answeredAt?: string

  // Filled on answer/dismiss — feeds `mars retro`
  rootCause?: RootCause
  resolution?: {
    kind: 'harness_fix' | 'one_off_answer'
    notes: string
    commitRef?: string              // VCS ref of harness change, if any
  }
}
```

### 6.2 Behavior

- **Any role** (planner, builder, reviewer) can emit a `question` intent.
- Orchestrator parks all matching tasks (`taskIds`) in `awaiting_human` and **continues to the next ready task**. The loop never blocks on humans.
- Resume happens via:
  - **push**: `mars answer <qid> "<text>"` — answers and immediately re-spawns the relevant agents.
  - **pull**: next `mars build` invocation sweeps for `awaiting_human` tasks with answered questions.

### 6.3 Dismiss

`mars dismiss <qid> --reason "<text>"`. Reason is required. Surfaces in `mars retro` as the highest-priority signal: the agent asked, the human said "you shouldn't have."

### 6.4 Default backend

`fs-jsonl` at `.mars/questions.jsonl`. Future: a beads-backed adapter that maps each `Question` to an issue.

---

## 7. QA checkpoints

Declarative rules in `mars.config.ts`. The orchestrator (or reviewer agent) evaluates them against `BuildResult.edits` before VCS checkpoint. A match emits an `approve_checkpoint` question (`category: 'gate'`).

### 7.1 Rule shape

```ts
type QACheckpointRule = {
  name: string
  when:
    | { kind: 'paths';       patterns: string[] }            // glob match on edited paths
    | { kind: 'taskTag';     tag: string }                   // task carries this tag
    | { kind: 'planOrigin';  origin: 'user' | 'retro' }      // e.g. always gate retro plans
    | { kind: 'always' }
  prompt: string
}
```

### 7.2 Default rules (ship-with)

```ts
qa: {
  checkpoints: [
    { name: 'schema-changes',
      when: { kind: 'paths', patterns: ['**/migrations/**', '**/*.sql'] },
      prompt: 'Schema migration in this checkpoint — review and approve?' },
    { name: 'harness-changes',
      when: { kind: 'planOrigin', origin: 'retro' },
      prompt: 'Harness change from retro — approve before checkpoint?' },
  ]
}
```

### 7.3 Semantics

- Rules are **AND-grouped per rule, OR-grouped across rules** — first match wins, only one gate per checkpoint.
- Empty config = no QA gates.
- CLI: `mars qa list`, `mars qa test <task-or-build>`.

---

## 8. Adapters

Five adapter interfaces. v0 ships one implementation per adapter.

### 8.1 Provider

```ts
interface Provider {
  invoke(opts: {
    prompt: string
    context: ContextBundle
    tokenBudget: number
  }): Promise<{ output: string; tokensUsed: number }>
}
```

v0: Claude. Boundaries are drawn for future providers; not built.

### 8.2 PlanStore

```ts
type ReadyQuery = {
  planId?: PlanId
  excludeClaimed?: boolean        // default true
}

type PlanQuery = {
  status?: PlanStatus | PlanStatus[]
  hasReadyTasks?: boolean
  origin?: Plan['origin']
  goalContains?: string
  limit?: number
}

interface PlanStore {
  // Read-side
  next(query: ReadyQuery, claimAs?: string): Promise<Task | null>  // atomic claim
  peek(query: ReadyQuery): Promise<Task | null>                    // no claim
  searchPlans(query: PlanQuery): Promise<Plan[]>
  getPlan(id: PlanId): Promise<Plan & { tasks: Task[] }>
  getTask(id: TaskId): Promise<Task>

  // Write-side (orchestrator only)
  savePlan(plan: Plan & { tasks: Task[] }): Promise<void>
  updateTask(id: TaskId, patch: Partial<Task>): Promise<void>
  releaseClaim(id: TaskId): Promise<void>
}
```

v0: beads-backed. Future: `fs-markdown` PlanStore.

### 8.3 HumanQueue

```ts
type QuestionQuery = {
  state?: QuestionState
  kind?: QuestionKind
  category?: QuestionCategory
  taskId?: TaskId
}

interface HumanQueue {
  ask(q: Omit<Question, 'id' | 'state' | 'raisedAt'>): Promise<string>
  list(query: QuestionQuery): Promise<Question[]>
  get(id: string): Promise<Question>
  answer(id: string, answer: string, rootCause?: RootCause,
         resolution?: Question['resolution']): Promise<void>
  dismiss(id: string, reason: string, rootCause?: RootCause): Promise<void>
}
```

v0: `fs-jsonl` at `.mars/questions.jsonl`.

### 8.4 VCS

```ts
interface VCS {
  // Worktrees for per-agent isolation
  createWorktree(handleId: string): Promise<string>            // returns path
  removeWorktree(handleId: string): Promise<void>

  // Checkpointing
  checkpoint(opts: {
    worktreePath: string
    hint: string                    // BuildResult.checkpointHint
    taskId: TaskId
  }): Promise<{ ref: string } | { conflict: ConflictInfo }>
}

type ConflictInfo = {
  files: string[]
  description: string
}
```

v0: git. A conflict yields a `resolve_conflict` question.

### 8.5 FS / Exec

```ts
interface FS {
  apply(edits: FileEdit[], rootDir: string): Promise<void>
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}

interface Exec {
  run(cmd: string, args: string[], opts?: { cwd?: string }): Promise<{
    stdout: string; stderr: string; exitCode: number
  }>
}
```

### 8.6 Compiler

```ts
type CompilerFinding = {
  severity: 'warn' | 'error'
  path: string
  line?: number
  message: string
}

interface Compiler {
  check(rootDir: string): Promise<CompilerFinding[]>
}
```

v0: markdown link-check + plan schema validation. Errors halt `mars build`.

### 8.7 Runner

```ts
type AgentRole = 'planner' | 'builder' | 'reviewer'

type AgentSpec = {
  role: AgentRole
  taskId?: TaskId
  tokenBudget: number
  context: ContextBundle
  worktreePath: string              // from VCS.createWorktree()
}

type AgentHandle = {
  id: string                        // also tmux session name suffix
  role: AgentRole
  taskId?: TaskId
  status: 'starting' | 'ready' | 'working' | 'done' | 'failed'
  pid?: number                      // captured for liveness checks
  tmuxSession: string               // e.g. "mars-builder-7f3a91c2"
  intentPath: string                // .mars/runs/<id>/intent.json
}

interface Runner {
  spawn(spec: AgentSpec): Promise<AgentHandle>
  status(id: string): Promise<AgentHandle>
  waitAny(handles: AgentHandle[]): Promise<AgentHandle>          // returns first to exit
  readIntent(handle: AgentHandle): Promise<AgentIntent>
  kill(id: string): Promise<void>
  list(): Promise<AgentHandle[]>
}
```

v0 implementation: **Pattern 3** — one tmux session per spawned agent, agent is a one-shot subprocess. Session naming: `mars-<role>-<handleId>`.

---

## 9. Orchestrator

Single centralized process owned by `mars build`. Agents are blind workers; only the orchestrator reads state for coordination purposes.

### 9.1 Loop sketch

```ts
class Orchestrator {
  constructor(private adapters: { runner; planStore; humanQueue; fs; vcs; compiler })

  async run(opts: {
    planId?: PlanId
    budget: number                  // total token cap for the run
    maxParallelAgents: number       // default 3
    maxParallelPlanners: number     // default 1
  }) {
    const live = new Map<string, AgentHandle>()
    const budget = new BudgetPool(opts.budget)

    while (!budget.exhausted()) {
      // 1. Spawn while there's room and ready work
      while (this.canSpawnMore(live, opts) && budget.canAffordAgent()) {
        const task = await this.adapters.planStore.next(
          { planId: opts.planId },
          claimAs(this.id),
        )
        if (!task) break
        const handle = await this.spawnFor(task, budget)
        live.set(handle.id, handle)
      }

      if (live.size === 0) break

      // 2. Wait for any one agent to finish
      const finished = await this.adapters.runner.waitAny([...live.values()])
      live.delete(finished.id)
      const intent = await this.adapters.runner.readIntent(finished)
      budget.charge(intent.tokensUsed ?? 0)
      await this.applyIntent(intent, finished)
    }
  }
}
```

### 9.2 Concurrency rules

- **`maxParallelAgents: 3`** — total live agents (any role).
- **`maxParallelPlanners: 1`** — at most one planner alive at a time.
- **Pipeline ordering** — sequential within a task (planner → builder → reviewer); parallel across tasks.
- **Reviewer** never runs alongside the builder it reviews.

### 9.3 Per-agent isolation

Each spawn gets its own git worktree under `.mars/worktrees/<handleId>/`. The agent edits there; the VCS adapter merges back to the main tree at checkpoint. Conflicts → `resolve_conflict` question.

### 9.4 Budget

A single shared pool, decremented as agents report `tokensUsed`. New spawns are gated when `remaining < perAgentAllocation`. Exhaustion → halt with summary.

### 9.5 Intent application

```ts
async applyIntent(intent: AgentIntent, handle: AgentHandle) {
  switch (intent.kind) {
    case 'plan':
      await this.planStore.savePlan(intent.plan)
      break

    case 'build': {
      const matched = this.evaluateQARules(intent.result.edits, handle.taskId)
      if (matched) {
        const qid = await this.humanQueue.ask({
          kind: 'approve_checkpoint',
          category: 'gate',
          taskIds: [handle.taskId!],
          prompt: matched.prompt,
          options: ['approve', 'reject'],
          context: { /* matched paths, diff hunks */ },
          raisedBy: handle.id,
        })
        await this.planStore.updateTask(handle.taskId!, {
          state: 'awaiting_human', pendingQuestionId: qid,
        })
        break
      }
      await this.fs.apply(intent.result.edits, handle.spec.worktreePath)
      const result = await this.vcs.checkpoint({
        worktreePath: handle.spec.worktreePath,
        hint: intent.result.checkpointHint ?? `task ${handle.taskId}`,
        taskId: handle.taskId!,
      })
      if ('conflict' in result) {
        const qid = await this.humanQueue.ask({
          kind: 'resolve_conflict', category: 'defect',
          taskIds: [handle.taskId!],
          prompt: 'Merge conflict on checkpoint',
          context: { files: result.conflict.files, agentNotes: result.conflict.description },
          raisedBy: handle.id,
        })
        await this.planStore.updateTask(handle.taskId!, {
          state: 'awaiting_human', pendingQuestionId: qid,
        })
      } else if (intent.result.done) {
        await this.planStore.updateTask(handle.taskId!, { state: 'done' })
      }
      break
    }

    case 'review':
      if (intent.review.verdict === 'pass') {
        await this.planStore.updateTask(handle.taskId!, { state: 'done' })
      } else {
        await this.planStore.updateTask(handle.taskId!, {
          state: 'to_refine',
          history: [...(/* prior */ []), {
            at: new Date().toISOString(),
            kind: 'reviewer_reject',
            by: handle.id,
            note: intent.review.findings.map(f => f.message).join('; '),
          }],
        })
      }
      break

    case 'question':
      const qid = await this.humanQueue.ask({
        ...intent.question,
        raisedBy: handle.id,
      })
      for (const tid of intent.question.taskIds) {
        await this.planStore.updateTask(tid, {
          state: 'awaiting_human', pendingQuestionId: qid,
        })
      }
      break
  }
}
```

(Pseudocode — for documentation.)

### 9.6 Failure policy

Halt-and-flag (per VISION). Any unhandled adapter error → orchestrator halts, prints summary, leaves state intact for inspection. Resume by re-running `mars build`.

### 9.7 Future choreography

Path is open: daemon-mode agents could loop on `next()` themselves, making the orchestrator optional. **Not in v0.** Every current decision (token pool, concurrency cap, QA evaluation) assumes the orchestrator.

---

## 10. Meta-loop: questions → retros → harness fixes

```
mars build (feature work)  ──raises──▶  Questions
mars retro                 ──creates──▶ Beads plans/tasks  (Plan.origin = 'retro')
mars build (harness work)  ──fixes────▶ root causes
                           ──reduces──▶ Question rate
```

The harness's improvement backlog **is** a plan in PlanStore. Dogfooding by construction.

### 10.1 `mars retro` behavior

```
mars retro              — dry run; print suggestions, write .mars/retros/<date>.md
mars retro --apply      — also create plans/tasks via PlanStore (beads)
mars retro --since 7d   — bound the analysis window
```

It clusters answered/dismissed questions by `kind` + `rootCause`, synthesizes one suggestion per cluster, and (with `--apply`) creates a plan whose tasks land in `to_refine` with `sourceQuestionIds[]` populated.

### 10.2 `mars audit` behavior

Reports a split metric:

```
questions/run (defects):   2.3   ⚠ target: 0
  refine_plan, unblock_task, resolve_conflict
questions/run (gates):     0.5   — informational
  approve_checkpoint
```

Plus token spend, success rates, and impact tracking ("did fixing harness-task X reduce questions of kind Y?").

---

## 11. CLI surface

| Command | Purpose |
|---|---|
| `mars plan "<goal>"` | Planner emits a `Plan`; PlanStore persists. |
| `mars build` | Orchestrator loop. |
| `mars review` | Standalone review pass over uncommitted edits. |
| `mars check` | Markdown compiler: link integrity, plan schema, reference graph. |
| `mars audit` | Harness/cost/health + question rates (defect/gate split). |
| `mars retro [--apply] [--since 7d]` | Cluster questions; create harness-fix plans. |
| `mars plans [--origin user|retro]` | List plans. |
| `mars next [--peek]` | Show next ready task (peek = no claim). |
| `mars agents [attach <id>]` | List/attach to live tmux sessions. |
| `mars ask` | List open questions. |
| `mars ask <qid>` | Show one question with full context. |
| `mars answer <qid> "<text>"` | Answer + auto-resume the parked task(s). |
| `mars dismiss <qid> --reason "<text>"` | Abandon question; tasks → `to_refine`. |
| `mars qa list` | Show configured QA checkpoint rules. |
| `mars qa test <task-or-build>` | Dry-run QA rules; show which would fire. |

---

## 12. Configuration

```ts
// mars.config.ts
import type { MarsConfig } from 'mars'

export default {
  // Provider
  provider: { kind: 'claude' },

  // PlanStore
  planStore: { kind: 'beads' },                  // future: 'fs-markdown'

  // HumanQueue
  humanQueue: { kind: 'fs-jsonl', path: '.mars/questions.jsonl' },

  // VCS
  vcs: { kind: 'git' },

  // Concurrency
  maxParallelAgents: 3,
  maxParallelPlanners: 1,

  // Budget
  tokenBudgetPerRun: 200_000,

  // Optional safety valve (off by default)
  runaway: { enabled: false, perAgentTokensCap: 50_000 },

  // QA gates
  qa: {
    checkpoints: [
      { name: 'schema-changes',
        when: { kind: 'paths', patterns: ['**/migrations/**', '**/*.sql'] },
        prompt: 'Schema migration in this checkpoint — review and approve?' },
      { name: 'harness-changes',
        when: { kind: 'planOrigin', origin: 'retro' },
        prompt: 'Harness change from retro — approve before checkpoint?' },
    ],
  },
} satisfies MarsConfig
```

---

## 13. Filesystem layout

```
<repo>/
  mars.config.ts                          ← user config
  VISION.md
  docs/CONTRACTS.md                       ← this file
  .mars/
    runs/<handleId>/
      intent.json                         ← agent output (one per spawn)
      stdout.log
    worktrees/<handleId>/                 ← per-agent git worktrees
    questions.jsonl                       ← HumanQueue (fs-jsonl backend)
    retros/<date>.md                      ← `mars retro` reports
  .beads/                                 ← PlanStore (beads backend)
```

---

## 14. Decision provenance

Every decision in this document was deliberately locked in conversation. Where a non-default was chosen, the rationale is preserved:

| Area | Decision | Rationale |
|---|---|---|
| Topology | Centralized orchestration | Lean; matches every other locked decision (token pool, claim atomicity, QA evaluation). Choreography path stays open. |
| Agent pattern | One-shot subprocess per task in tmux session | Stateless ✓, lean ✓, observable ✓, token-frugal ✓. |
| Liveness | PID check, no wall-clock timeout | No false positives on slow agents; instant recovery on crashes; no reaper infrastructure. |
| Claim | Atomic claim-on-fetch | Race-proof by construction; `next()` is one call. |
| Parallelism | Default on; cap 3 / planners 1 | Solo dev + Claude rate limits + edit-conflict surface; planning rarely benefits from concurrency. |
| Per-agent isolation | git worktree | Real concurrency safety without an in-process locking protocol. |
| Task states | 4 (no `needs_framework`, no `needs_rework`) | Harness-gap signals surface as `Question` → `mars retro`; reviewer rejection reuses `to_refine` + history. |
| Question category | `defect \| gate` | Prevents perverse incentive to remove QA gates to look better in audit. |
| QA checkpoints | Declarative rules in config, evaluated by orchestrator | Predictable, auditable, lean, token-frugal (no LLM call). |
| `mars retro` | Creates beads plans/tasks | Harness improves itself using its own machinery. |
| Intent transport | File at `.mars/runs/<id>/intent.json` | Stdout is for humans; intent is structured. |
