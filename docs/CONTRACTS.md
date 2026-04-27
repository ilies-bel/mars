# CONTRACTS — Mars Framework

> **Status:** v0.2 — HumanInbox lock
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

- **Questions are bugs.** Every `question`-kind inbox item raised is a defect in the harness — missing context, ambiguous prompt, weak adapter. The harness's job is to drive the defect rate toward zero. Items with `category: 'gate'` (e.g. `approve_checkpoint`) are the deliberate-gate exemption.
- **One human inbox.** Every human-in-the-loop event (questions, actions, decisions) flows through a single `HumanInbox`. "What does mars need from me?" has one answer: `mars inbox`.
- **Centralized orchestration.** A single `mars build` process owns the loop. Agents are blind workers — they don't know other agents exist.
- **Parallelism by default.** Multiple agents run concurrently, gated by a configured cap.

---

## 2. Intent

An **intent** is a typed, structured value an agent returns to declare what it wants to happen — without doing it. It is the concrete embodiment of "declarative agents."

```ts
type AgentIntent =
  | { kind: 'feature';  feature: Feature }
  | { kind: 'build';    result: BuildResult }
  | { kind: 'review';   review: Review }
  | { kind: 'question'; question: Question }
```

**Transport.** Each spawned agent emits its intent by calling the built-in `mars.done` tool exactly once (see §8.8.1). The sidecar writes:

```
.mars/runs/<handleId>/intent.json
```

…and signals the agent to exit. The orchestrator reads the file, then routes through adapters. Agents do not write `intent.json` directly and do not self-terminate — `mars.done` is the only sanctioned exit path.

**An agent never:**
- writes files (returns `BuildResult.edits`; FS adapter writes)
- calls `git` (returns `BuildResult.checkpointHint`; VCS adapter commits)
- calls `bd` (returns a `Feature` or task update; PlanStore adapter persists)
- prompts the user (returns a `Question` payload; HumanInbox parks/asks)

The `question`-kind intent only carries `Question`-style payloads. `action` and `decision` inbox items originate from the orchestrator and `mars retro`, not from agent intents — agents ask, the system instructs.

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
  featureId: FeatureId
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
  pendingInboxItemId?: string       // when state = awaiting_human
  sourceInboxItemIds?: string[]     // for retro-spawned tasks (questions that motivated this task)

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

### 3.6 Task type checklists

Every task carries a **type** that selects a fixed checklist. The checklist is materialized into the beads issue's `--design` field at creation time and ticked off by agents as they work. Closing a task requires every box checked; an unchecked box at close = halt-and-flag (§9).

The mars feature facade injects the right checklist on `bd create` based on `--type`; agents update via `bd update <id> --design ...`. No hooks, no formulas — the facade is the single point of enforcement.

**Type: `frontend-change`**

```
- [ ] pencil design updated
- [ ] design change accepted
- [ ] implemented
- [ ] tsc build passes
- [ ] tests green
- [ ] ticket merged
```

**Type: `quick-fix`**

```
- [ ] bead traced
- [ ] worktree created
- [ ] implemented
- [ ] merged
```

Additional types are added by appending to this section — no code changes required, since the facade reads the checklist set from CONTRACTS.md.

---

## 4. Features

```ts
type FeatureId = string  // same scheme as TaskId
type FeatureStatus = 'draft' | 'ready' | 'in_progress' | 'done' | 'failed' | 'halted'

type Feature = {
  id: FeatureId
  goal: string
  status: FeatureStatus
  origin: 'user' | 'retro'          // 'retro' = spawned by `mars retro`
  taskCount: number
  readyTaskCount: number            // computed: tasks ready AND deps satisfied AND unclaimed
  createdAt: string
  updatedAt: string
}
```

**Canonical form.** Markdown-canonical (`features/<feature-id>.md` files). PlanStore adapters sync to/from beads if configured.

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

## 6. HumanInbox (questions, actions, decisions)

The single, prioritized stream of everything mars needs from the human. `Question` is one payload kind; `action` and `decision` are siblings. There is one inbox, one CLI namespace (`mars inbox`), one storage file.

### 6.1 InboxItem type

```ts
type InboxItemKind = 'question' | 'action' | 'decision'

type Priority = 'blocker' | 'high' | 'normal' | 'low'
// blocker = at least one task is parked (awaiting_human) referencing this item
// high    = unblocking soon would unblock work
// normal  = no immediate impact, but worth your time
// low     = informational; safe to skip

type InboxItemState = 'open' | 'resolved' | 'dismissed'

type InboxItemCategory = 'defect' | 'gate'
// defect = harness shouldn't have raised this; counted in retro/audit defect rate
// gate   = deliberate human checkpoint; informational only

type RootCause =
  | 'missing_context'
  | 'ambiguous_prompt'
  | 'weak_adapter'
  | 'feature_underspecified'
  | 'genuine_human_judgment'
  | 'context_bloat'                  // PreCompact fired — orchestrator carried too much state. See §16.5.

type InboxItem = {
  id: string                        // <uuid8>-<slug>
  kind: InboxItemKind
  category: InboxItemCategory
  priority: Priority                // computed; see 6.4
  title: string                     // one-line summary for list view
  body: string                      // full prompt / description

  context: {
    files?: string[]
    excerpts?: { path: string; lines: string }[]
    agentNotes?: string
    relatedFeatureIds?: FeatureId[]
    relatedTaskIds?: TaskId[]
  }

  state: InboxItemState
  raisedBy: string                  // agent handle id, "orchestrator", or "system"
  raisedAt: string
  resolvedAt?: string
  resolution?: string               // free text or chosen option id

  payload:
    | { kind: 'question'; question: Question }
    | { kind: 'action';   instruction: string; verifyHint?: string }
    | { kind: 'decision'; options: { id: string; label: string; consequence?: string }[] }

  // For retro/audit — filled on resolve/dismiss
  rootCause?: RootCause
  resolutionNote?: {
    kind: 'harness_fix' | 'one_off_answer'
    notes: string
    commitRef?: string              // VCS ref of harness change, if any
  }
}
```

### 6.2 Question payload

`Question` is the payload type for `kind: 'question'` items.

```ts
type QuestionKind =
  | 'refine_feature'      // planner needs scope/strategy decision
  | 'unblock_task'        // builder can't proceed; needs human input
  | 'resolve_conflict'    // VCS conflict that can't auto-merge
  | 'approve_checkpoint'  // QA gate fired; needs sign-off (always category 'gate')

type Question = {
  questionKind: QuestionKind
  taskIds: TaskId[]                 // one question can block multiple tasks
  featureId?: FeatureId
  prompt: string
  options?: string[]                // free-text choice list
  answer?: string
}
```

### 6.3 How items enter the inbox

| Source | Item shape |
|---|---|
| Agent emits `kind: 'question'` intent | `question` item; priority `blocker`; category `defect` (or `gate` for `approve_checkpoint`) |
| QA checkpoint rule fires (orchestrator) | `question` item; questionKind `approve_checkpoint`; category `gate`; priority `blocker` |
| VCS conflict (auto-detected) | `question` item; questionKind `resolve_conflict`; category `defect`; priority `blocker` |
| Orchestrator hits halt-and-flag | `action` item; priority `blocker` |
| `mars retro` finds a cluster needing a call | `decision` item; priority `normal` |
| `mars inbox add ...` (manual) | Any kind; priority defaulted by referenced tasks |

### 6.4 Priority computation

`priority` is **computed**, not declared:

- `blocker` — at least one task in `awaiting_human` references this item (`Task.pendingInboxItemId == item.id`).
- `high` — referenced by at least one ready/in-progress task but no `awaiting_human` task.
- `normal` — referenced only by `to_refine` or `done` tasks, or unreferenced but raised by orchestrator/agent.
- `low` — manually demoted, or stale (no related task touched in N days).

`HumanInbox.recomputePriorities(taskId)` is called by the orchestrator on every task state change.

### 6.5 Resolve / dismiss

- `mars answer <id> "<text>"` — resolves a `question` item; orchestrator sweeps referenced tasks back to `ready_for_execution`.
- `mars resolve <id> "<note>"` — resolves an `action` item; user has done the thing.
- `mars decide <id> <option-id>` — resolves a `decision` item; orchestrator may run a follow-up (e.g. `promote` on a retro decision creates a feature).
- `mars dismiss <id> --reason "<text>"` — dismisses any kind. Reason required. Surfaces in `mars retro` as the strongest signal: the system asked, the human said "you shouldn't have."

Tasks parked on a dismissed item return to `to_refine` with a `human_dismiss` history entry.

### 6.6 Loop behavior

- Orchestrator never blocks on the inbox. When an agent emits a question, the orchestrator parks the matching tasks in `awaiting_human` and **continues to the next ready task**.
- Resume:
  - **push**: `mars answer` / `mars resolve` / `mars decide` immediately re-spawn the relevant agents.
  - **pull**: next `mars build` invocation sweeps `awaiting_human` tasks whose pending item is `resolved`.
- `mars build` prints a one-line inbox footer at start and end: `inbox: N blockers, M high, K total open — mars inbox`.

### 6.7 Default backend

`fs-jsonl` at `.mars/inbox.jsonl`. Future: a beads-backed adapter that maps each `InboxItem` to an issue.

### 6.8 Out of scope for v0

- **Notifications** (desktop, file sentinel) — deferred.
- **Auto-dismiss** of stale items — deferred; explicit triage only.
- **Decision option callbacks in payload** — option choice is just recorded; any follow-up wiring lives in the orchestrator's resolve handler, not the data.

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
    | { kind: 'featureOrigin'; origin: 'user' | 'retro' }    // e.g. always gate retro features
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
      when: { kind: 'featureOrigin', origin: 'retro' },
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

  hooks: ProviderHooks                       // see §16
}

interface ProviderHooks {
  configPath(): string                       // e.g. '.claude/settings.local.json'
  installNativeForwarders(): Promise<void>   // writes provider config so its native hooks call `mars hook fire session.*`
  uninstall(): Promise<void>
  status(): Promise<ProviderHookStatus>
}

type ProviderHookStatus = {
  installed: boolean
  configPath: string
  forwardersWired: ('session.start' | 'session.prompt_submit' | 'session.pre_compact' | 'session.end')[]
  lastFireTimes?: Record<string, string>
}
```

The Provider adapter knows nothing about events beyond the four `session.*` it forwards. It writes its native hook config so the provider's lifecycle events become emissions on the Mars hook bus (§16). All other event handling lives at the bus level — the Provider has no opinion on what subscribers do with `session.*` events.

v0: Claude. Boundaries are drawn for future providers; not built. If a future provider exposes no hook surface, `installNativeForwarders()` is a no-op and Mars runs without provider-emitted events (correctness preserved; subscribers wired only to non-`session.*` events still work).

### 8.2 PlanStore

```ts
type ReadyQuery = {
  featureId?: FeatureId
  excludeClaimed?: boolean        // default true
}

type FeatureQuery = {
  status?: FeatureStatus | FeatureStatus[]
  hasReadyTasks?: boolean
  origin?: Feature['origin']
  goalContains?: string
  limit?: number
}

interface PlanStore {
  // Read-side
  next(query: ReadyQuery, claimAs?: string): Promise<Task | null>  // atomic claim
  peek(query: ReadyQuery): Promise<Task | null>                    // no claim
  searchFeatures(query: FeatureQuery): Promise<Feature[]>
  getFeature(id: FeatureId): Promise<Feature & { tasks: Task[] }>
  getTask(id: TaskId): Promise<Task>

  // Write-side (orchestrator only)
  saveFeature(feature: Feature & { tasks: Task[] }): Promise<void>
  updateTask(id: TaskId, patch: Partial<Task>): Promise<void>
  releaseClaim(id: TaskId): Promise<void>
}
```

v0: beads-backed. Future: `fs-markdown` PlanStore.

### 8.3 HumanInbox

```ts
type InboxQuery = {
  state?: InboxItemState
  kind?: InboxItemKind
  category?: InboxItemCategory
  priority?: Priority
  taskId?: TaskId
}

interface HumanInbox {
  add(item: Omit<InboxItem, 'id' | 'state' | 'raisedAt' | 'priority'>): Promise<string>
  list(query?: InboxQuery): Promise<InboxItem[]>
  get(id: string): Promise<InboxItem>

  // Resolution paths — one per item kind
  answer(id: string, answer: string,
         rootCause?: RootCause,
         resolutionNote?: InboxItem['resolutionNote']): Promise<void>          // question
  resolve(id: string, note: string,
          rootCause?: RootCause): Promise<void>                                // action
  decide(id: string, optionId: string,
         rootCause?: RootCause): Promise<void>                                 // decision

  dismiss(id: string, reason: string, rootCause?: RootCause): Promise<void>

  // Internal: orchestrator calls on every task state change
  recomputePriorities(taskId: TaskId): Promise<void>
}
```

v0: `fs-jsonl` at `.mars/inbox.jsonl`. Future: a beads-backed adapter.

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

v0 checks (errors halt `mars build`):
- Markdown link integrity across `VISION.md`, `docs/**`, `agents/**`, `features/**`.
- Feature schema validation.
- **Agent template validation** — see §15. Every `agents/<role>.md` must parse, contain all required sections, declare inputs/outputs matching the Intent contract, and reference only tools that exist in the `ToolRegistry` and sit in the role's allowlist.

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

#### 8.7.1 Why tmux

Three operational reasons, in order of weight:

1. **The agent is an interactive TUI, not a unix process.** Claude Code expects a real PTY and renders escape sequences. `child_process.spawn` either yields no output or forces a `node-pty` dependency. tmux supplies the PTY for free.
2. **Detached survival.** `-d` on `new-session` keeps the agent alive across orchestrator restarts. The orchestrator can crash, reattach, and resume liveness checks against the same PID.
3. **Free attach UX.** `mars agents attach <id>` is a thin wrapper over `tmux attach`; no extra plumbing.

These three benefits are what justify the tmux dependency. If they ever stop applying (e.g. Claude Code ships a non-TUI mode), revisit.

#### 8.7.2 tmux mechanics (locked)

These are operational invariants of the v0 Runner. They are easy to forget and painful to discover by debugging; lock here.

| Decision | Value | Rationale |
|---|---|---|
| Socket isolation | All commands use `-L mars` | Don't share state with the user's personal tmux. Their session list, their config, their key bindings stay untouched. Non-negotiable. |
| Session name | `mars-<role>-<handleId>`; sanitize `.` and `:` to `_` | tmux names reject dots/colons; matches §8.7 `AgentHandle.tmuxSession`. |
| Spawn flag | `tmux -L mars new-session -d -s <name> -c <worktreePath> /bin/bash -c '<wrapped>'` | `-d` for detach (survives orchestrator), `-c` for cwd (no shell `cd`), bash wrapper for env hygiene. |
| Env to unset before launch | `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT` | Otherwise the child agent inherits the orchestrator's Claude Code session identity and the runtime misbehaves silently. **This is the gotcha.** |
| PATH | Prepend `<repo>/.mars/bin` | Lets the sidecar tools (§8.8) shadow user PATH without polluting it. |
| Working directory | `-c <worktreePath>` from `VCS.createWorktree()` | Agent is born in its worktree. No `cd`, no path-relative tool calls. |
| Scrollback | `set-option -g history-limit 50000` immediately after `new-session` | tmux default of 2000 lines is too short for any non-trivial run. |
| Liveness | `tmux -L mars has-session -t <name>` then `display-message -p -t <name> "#{pane_pid}"` then `process.kill(pid, 0)` | Three-step probe. Feeds §3.5 `isClaimAlive`. |
| Output capture | `tmux -L mars capture-pane -t <name> -p -S -<N>` for snapshots | For `mars logs` / `mars trace` UX **only**. Never parse capture-pane to extract intent — `intent.json` is the source of truth. |
| Send input | `tmux -L mars send-keys -t <name> <keys> Enter` | Used by `mars agents nudge <id>` (debug only); orchestrator does not steer agents this way. |
| Exit detection | Poll `intent.json` mtime AND `has-session` returning false | More reliable than parsing TUI output for a "done" marker. |
| Cleanup order | SIGTERM pane PID → 5s grace → SIGKILL → `tmux kill-session -t <name>` | Tree teardown; avoids orphan subprocesses. |
| TUI readiness | `waitForTuiReady(name, detectReady, timeoutMs)` polls `capture-pane` for a startup marker before any input is sent | Claude Code's TUI takes seconds to initialize; sending too early loses keystrokes. |

#### 8.7.3 Headless fallback

The Runner adapter MAY expose a `headless: true` option that spawns the agent as a bare subprocess with stdout piped to `.mars/runs/<id>/stdout.log`. Used when:

- the runtime is not a TUI (future providers), or
- tmux is unavailable in the environment (CI, restricted hosts).

In headless mode, exit detection switches from `has-session` polling to standard `child.on('exit')`. All other contract surface (intent transport, claim semantics, budget) is identical. v0 ships tmux mode only; headless is a hook for later.

### 8.8 ToolRegistry

Per-agent and global tool injection. Tools are declarative, like every other adapter: agents call them through a sidecar channel; the registry decides whether the call is permitted, runs it, returns the result. Agents never import a tool module directly.

```ts
type ToolName = string                 // 'mars.done', 'rtk', 'ripgrep', 'fs-read', ...

interface Tool<I = unknown, O = unknown> {
  name: ToolName
  description: string                  // injected into prompt for callable tools only
  inputSchema: unknown                 // JSON Schema; validated before invoke
  invoke(input: I, ctx: ToolCtx): Promise<O>
}

type ToolCtx = {
  worktreePath: string                 // agent's sandbox (from VCS.createWorktree)
  taskId?: TaskId
  exec: Exec                           // reuse existing Exec adapter for shelling out
  role: AgentRole                      // for audit trail
  handleId: string
}

type ToolCall   = { callId: string; name: ToolName; input: unknown }
type ToolResult = { callId: string; ok: true; output: unknown }
                | { callId: string; ok: false; error: string }

interface ToolRegistry {
  // Resolution — orchestrator calls these to build the per-spawn registry
  callableFor(role: AgentRole): Tool[]            // global ∪ perRole[role].allow
  describe(role: AgentRole): { name: string; description: string; inputSchema: unknown }[]

  // Invocation — sidecar handler calls this for every tool call from an agent
  invoke(role: AgentRole, call: ToolCall, ctx: ToolCtx): Promise<ToolResult>
}
```

**Allowlist semantics.** Allow-only. No `deny`, no wildcards beyond the literal `'*'` meaning "every registered tool." A role's effective set is `union(global, perRole[role].allow)`. A call to a tool not in the effective set returns `{ ok: false, error: 'not_allowed' }` and is logged.

**Budget.** Tools do not charge the per-run token budget. They may be bounded by wall-time/quota inside the tool itself (e.g. an `exec` timeout) but the orchestrator's `BudgetPool` is unaffected.

**Invocation transport (Model B — sidecar).** Each spawned agent gets a Unix-domain socket at `.mars/runs/<handleId>/tools.sock`. The Runner injects `MARS_TOOLS_SOCK=<path>` into the agent's env before spawn. The agent process speaks newline-delimited JSON: one `ToolCall` per line in, one `ToolResult` per line out. The orchestrator owns the sidecar handler; it calls `ToolRegistry.invoke` for each line and writes the result. The agent's last call on this socket is `mars.done` (§8.8.1), which writes `intent.json` and ends the spawn — §2's invariant is preserved.

**Tool tiers.**
- **Built-in.** Ship in-tree with Mars. v0: `fs-read`, `ripgrep`, `mars.done`. Implemented as `Tool` instances.
- **External CLI wrapper.** A thin `Tool` whose `invoke` shells out via `Exec`. v0: `rtk` (~20 lines: name + schema + `exec.run('rtk', [...args], { cwd: ctx.worktreePath })`).
- **User-defined.** Declared inline in `mars.config.ts` using the same `Tool` shape. No plugin loader in v0.

**Prompt injection.** Only descriptions for tools in `callableFor(role)` are injected into the agent's prompt. A planner that can't call `rtk` never sees `rtk` in its tool menu — keeps prompts tight and prevents off-allowlist hallucination.

v0 implementation: in-process registry; UDS sidecar; `rtk` shipped as an external CLI wrapper.

#### 8.8.1 The `mars.done` tool — how an agent declares completion

`mars.done` is the single, mandatory tool every agent uses to signal "I'm finished with my work." It is the agent-facing surface of §2's intent transport: the agent does not write `intent.json` itself, and does not exit on its own — it calls `mars.done` exactly once with its typed intent payload, and the sidecar handler does both.

```ts
type MarsDoneInput =
  | { kind: 'feature';  feature: Feature }
  | { kind: 'build';    result: BuildResult }
  | { kind: 'review';   review: Review }
  | { kind: 'question'; question: Question }

type MarsDoneOutput = { ok: true; intentPath: string }
```

`MarsDoneInput` is structurally identical to `AgentIntent` (§2). The sidecar:

1. Validates the payload against the role's expected intent kind (`planner` → `feature`, `builder` → `build`, `reviewer` → `review`; any role may emit `question`).
2. Writes `.mars/runs/<handleId>/intent.json` atomically (write to `intent.json.tmp` + `rename`).
3. Returns `{ ok: true, intentPath }` to the agent.
4. Closes the tool socket and signals the runtime to terminate the agent process. The agent's job ends with that return value; any further tool calls would fail with `socket_closed`.

**Invariants.**
- **Exactly one call per spawn.** A second `mars.done` call returns `{ ok: false, error: 'already_done' }`. The first write wins; §2's "exactly one `intent.json`" stays true.
- **Allowlist.** `mars.done` is global by default — every role can call it, because every spawned agent must terminate through it. It cannot be removed from a role's effective set.
- **Kind/role match.** Wrong `kind` for the spawned role returns `{ ok: false, error: 'kind_role_mismatch' }`; the agent may retry with the correct payload.
- **No edits, no git, no bd.** Same boundaries as §2 — `mars.done` carries the declarative payload; FS/VCS/PlanStore adapters apply it after the agent exits.

**Why a tool, not a stdout convention.** The sidecar already mediates every other tool call; routing completion through it gives uniform validation, audit logging (`tools.log`), and a clean exit signal that doesn't depend on parsing the TUI. It also lets the orchestrator distinguish a clean finish (`mars.done` returned) from a crash or budget kill (process exited without a `mars.done` call ever arriving).

---

## 9. Orchestrator

Single centralized process owned by `mars build`. Agents are blind workers; only the orchestrator reads state for coordination purposes.

### 9.1 Loop sketch

```ts
class Orchestrator {
  constructor(private adapters: { runner; planStore; humanInbox; fs; vcs; compiler })

  async run(opts: {
    featureId?: FeatureId
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
          { featureId: opts.featureId },
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
    case 'feature':
      await this.planStore.saveFeature(intent.feature)
      break

    case 'build': {
      const matched = this.evaluateQARules(intent.result.edits, handle.taskId)
      if (matched) {
        const id = await this.humanInbox.add({
          kind: 'question', category: 'gate',
          title: `QA: ${matched.name}`, body: matched.prompt,
          context: { relatedTaskIds: [handle.taskId!] /* matched paths, hunks */ },
          payload: {
            kind: 'question',
            question: {
              questionKind: 'approve_checkpoint',
              taskIds: [handle.taskId!],
              prompt: matched.prompt,
              options: ['approve', 'reject'],
            },
          },
          raisedBy: handle.id,
        })
        await this.planStore.updateTask(handle.taskId!, {
          state: 'awaiting_human', pendingInboxItemId: id,
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
        const id = await this.humanInbox.add({
          kind: 'question', category: 'defect',
          title: 'Merge conflict on checkpoint',
          body: result.conflict.description,
          context: { files: result.conflict.files, relatedTaskIds: [handle.taskId!] },
          payload: {
            kind: 'question',
            question: {
              questionKind: 'resolve_conflict',
              taskIds: [handle.taskId!],
              prompt: 'Resolve this conflict and re-run mars build',
            },
          },
          raisedBy: handle.id,
        })
        await this.planStore.updateTask(handle.taskId!, {
          state: 'awaiting_human', pendingInboxItemId: id,
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

    case 'question': {
      const q = intent.question
      const id = await this.humanInbox.add({
        kind: 'question',
        category: q.questionKind === 'approve_checkpoint' ? 'gate' : 'defect',
        title: q.prompt.slice(0, 80),
        body: q.prompt,
        context: { relatedTaskIds: q.taskIds, relatedFeatureIds: q.featureId ? [q.featureId] : [] },
        payload: { kind: 'question', question: q },
        raisedBy: handle.id,
      })
      for (const tid of q.taskIds) {
        await this.planStore.updateTask(tid, {
          state: 'awaiting_human', pendingInboxItemId: id,
        })
      }
      break
    }
  }
}
```

(Pseudocode — for documentation.)

### 9.6 Failure policy

Halt-and-flag (per VISION). Any unhandled adapter error → orchestrator halts, prints summary, leaves state intact for inspection. Resume by re-running `mars build`.

### 9.7 Future choreography

Path is open: daemon-mode agents could loop on `next()` themselves, making the orchestrator optional. **Not in v0.** Every current decision (token pool, concurrency cap, QA evaluation) assumes the orchestrator.

---

## 10. Meta-loop: inbox → retros → harness fixes

```
mars build (feature work)  ──raises──▶  Inbox items (questions, actions)
mars retro                 ──creates──▶ Inbox decisions + (with --apply) beads features/tasks
mars build (harness work)  ──fixes────▶ root causes
                           ──reduces──▶ Defect rate
```

The harness's improvement backlog **is** a feature in PlanStore. Dogfooding by construction.

### 10.1 `mars retro` behavior

```
mars retro              — dry run; print suggestions, write .mars/retros/<date>.md
mars retro --apply      — also create features/tasks via PlanStore (beads)
mars retro --since 7d   — bound the analysis window
```

It clusters resolved/dismissed `question`-kind inbox items by `questionKind` + `rootCause`, synthesizes one suggestion per cluster. In dry-run it adds a `decision`-kind inbox item per cluster (priority `normal`, options: `promote` / `dismiss` / `defer`). With `--apply` it also creates a feature whose tasks land in `to_refine` with `sourceInboxItemIds[]` populated.

### 10.2 `mars audit` behavior

Reports a split metric over inbox items, plus the dimensions defined in §11.4:

```
items/run (defects):   2.3   ⚠ target: 0
  by questionKind:  refine_feature 1.4  unblock_task 0.6  resolve_conflict 0.3
  by rootCause:     ambiguous_prompt 1.1  weak_adapter 0.7  missing_context 0.5
items/run (gates):     0.5   — informational
  approve_checkpoint
budget:                exhausted 0/12 runs   p95 spend 142k / 200k cap
parked-task age:       p50 4.2h   p95 38h
defect-rate trend:     -28% vs prior 7d (refine_feature ↓0.6, unblock_task ↓0.2)
```

The defect/gate split is non-negotiable: the `category` field exists precisely so the metric cannot be gamed by removing QA gates (§6.1). `mars audit` MUST report them on separate lines.

Trend tracking ("did fixing harness-task X reduce items of kind Y?") relies on a small derived table written at end-of-run; see §11.5.

---

## 11. Observability

Mars's observability surface is deliberately small: two stores, two log lenses, one preflight, and the audit/retro loop already specified in §10. We do **not** ship a TUI dashboard, an AI triage tier, or a long-running monitor agent in v0 — see §11.7 for what is intentionally out of scope and why.

The principle: every observability primitive must serve the meta-loop (§10). Pure dashboards that don't feed `mars retro` or `mars audit` are out.

### 11.1 Two-store split

Two SQLite databases, both WAL mode, kept separate by purpose:

```
.mars/db/events.db    — append-only event log; queried by time/agent/type
.mars/db/metrics.db   — aggregations and trends; queried by dimension
```

**Rationale:** events are write-heavy and time-indexed; metrics are derived rollups recomputed at end-of-run. Conflating them forces a single schema to serve two access patterns badly. Keeping them separate keeps each schema tight.

### 11.2 Event store (`events.db`)

Every row is a hook fire (§16). The previous `EventKind` enum collapsed into the hook taxonomy — one schema, one writer, one query surface.

```ts
type Event = {
  id: number              // autoincrement; serves as the subscriber cursor (§16.6)
  ts: string              // ISO 8601
  runId: string           // one mars build invocation
  event: HookEvent        // see §16.3
  emitter: 'orchestrator' | 'agent' | 'provider' | 'mars-internal'
  emitterId?: string      // agent handleId when emitter = 'agent'
  taskId?: TaskId         // when applicable; pulled from payload at write time
  featureId?: FeatureId   // when applicable
  payload: unknown        // per-event schema, validated at the tool boundary (§16.4)
  durationMs?: number     // for paired start/end events
  error?: { message: string; stack?: string }
}
```

The `events.id` is the subscriber cursor. Subscribers persist the last `id` they processed; on (re)connect with `fromCursor`, the broadcaster replays from that row forward. See §16.6.

**Sanitization is mandatory before write.** A `sanitize(payload)` step redacts API keys, env vars matching common secret patterns (`*_TOKEN`, `*_KEY`, `*_SECRET`, `BEARER *`), and `.env`-style file contents. Cheap to add now; painful later.

**Retention.** Default 30 days; configurable. `mars logs --vacuum` prunes.

### 11.3 Metrics store (`metrics.db`)

Recomputed at end-of-run from `events.db`. Dimension-keyed rollups, never raw events.

```ts
type RunMetric = {
  runId: string
  startedAt: string
  endedAt: string
  status: 'completed' | 'halted' | 'budget_exhausted'

  // Cost (tokens only — see §16; the framework never tracks USD)
  tokensUsed: number
  tokensBudget: number
  tokensRemaining: number

  // Throughput
  tasksCompleted: number
  tasksRefined: number          // entered to_refine via reviewer_reject
  tasksParked: number           // ended run in awaiting_human

  // Inbox
  defectItems: number           // category='defect' raised this run
  gateItems: number             // category='gate' raised this run

  // Latency
  taskWallTimeMsP50: number
  taskWallTimeMsP95: number
}

type DimensionRollup = {
  runId: string
  dimension: 'agent' | 'role' | 'questionKind' | 'rootCause' | 'taskTag'
  key: string                   // e.g. 'builder' or 'refine_feature'
  tokensUsed: number
  count: number                 // events / items / tasks (kind-specific)
  successRate?: number          // tasks done / tasks attempted, where applicable
}

type DefectTrendPoint = {
  bucketStart: string           // day or run boundary
  questionKind: QuestionKind
  rootCause: RootCause
  perRun: number                // moving average
}
```

`DefectTrendPoint` is the table that answers "is mars getting better?" Every `mars audit --trend` reads it; every end-of-run writer appends to it.

### 11.4 Token accounting via transcript parsing

`tokensUsed` is captured from the provider's session transcript, not from agent self-reports. For Claude Code: parse the per-session JSONL written by the runtime; sum `usage.input_tokens + usage.output_tokens` per turn.

```ts
interface TranscriptParser {
  parse(transcriptPath: string): {
    inputTokens: number
    outputTokens: number
    turns: { ts: string; inputTokens: number; outputTokens: number }[]
  }
}
```

This feeds `BudgetPool.charge()` (§9.4). Self-reported `tokensUsed` in `BuildResult` / `Review` is a fallback used only when the transcript is unavailable.

### 11.5 Doctor & preflight

`mars audit` includes a preflight battery, modeled on overstory's `ov doctor` but scoped to Mars's contract.

```ts
type DoctorCheck = () => Promise<DoctorResult>

type DoctorResult = {
  name: string
  ok: boolean
  severity: 'info' | 'warn' | 'error'
  message: string
  fix?: string                  // suggested CLI command, if any
}
```

v0 ships these checks:

| Name | Verifies |
|---|---|
| `provider-creds` | `ANTHROPIC_API_KEY` set; basic auth probe |
| `planstore-reachable` | `bd` binary present, beads DB readable |
| `vcs-clean` | repo on a branch, no detached HEAD, worktree dir creatable |
| `db-migrations` | `events.db` + `metrics.db` schema versions current |
| `inbox-readable` | `.mars/inbox.jsonl` parseable |
| `budget-config` | `tokenBudgetPerRun` set; under hard ceiling |
| `parked-task-age` | no `awaiting_human` task older than configured threshold (default 7d) |
| `worktree-orphans` | no `.mars/worktrees/<id>` without a live agent |
| `compiler-clean` | `Compiler.check(rootDir)` returns no errors |

`mars audit` runs all checks, prints a summary, and exits non-zero on any `error`. `--fix` runs registered fixers where present; otherwise the suggestion is printed.

### 11.6 Log surface

Two commands. No more.

```
mars logs   [--run <id>] [--agent <id>] [--task <id>]
            [--kind <event-kind>...] [--errors-only]
            [--since <ts>] [--limit <n>] [--follow]

mars trace  <run-id>
            — chronological multi-agent interleaving for one run
```

`mars logs` is the general-purpose tail. `mars trace` is the post-mortem replay. Together they cover the use cases overstory fragments across `trace` / `replay` / `inspect` / `errors` / `feed`. We do not ship the other three.

`mars status` (already in §11 CLI surface) prints a snapshot — live agents, budget remaining, inbox blockers — for the running orchestrator. No live TUI.

### 11.7 Out of scope for v0 (with rationale)

| Deferred | Why |
|---|---|
| AI triage tier (overstory T1) | Mars's halt-and-flag + inbox `RootCause` capture covers diagnosis without spending tokens on a triage agent. |
| Long-running monitor agent (overstory T2) | A billed Claude session "watching the fleet" violates the token-cost anti-goal. Centralized orchestrator already sees every intent. |
| Watchdog daemon | PID liveness check (§3.5) + orchestrator `waitAny` covers it. No daemon process to manage. |
| Live TUI dashboard | `mars status` snapshot is sufficient for solo dev. Defer until a real second user asks. |
| Five-lens observation surface (`trace`/`replay`/`inspect`/`errors`/`feed`) | Two lenses (`mars logs` + `mars trace`) cover 95%. Fragmenting the surface is a tax on the user. |
| USD / dollar accounting of any kind | Framework is token-only (§16). Dollars are the provider's business; pricing tables, USD caps, and cost estimates are explicitly out of scope and out of the contract surface. |

### 11.8 Where overstory's source is worth reading

For implementers, these files in `jayminwest/overstory` are reference-quality and shape-aligned with §11. Read as documentation; do not vendor.

| Overstory file | Lifts to |
|---|---|
| `src/events/store.ts` | `events.db` schema layout |
| `src/metrics/store.ts` | `metrics.db` rollup pattern |
| `src/metrics/transcript.ts` | Claude Code JSONL parser → `TranscriptParser` (§11.4) |
| `src/logging/sanitizer.ts` | Secret-redaction patterns (§11.2) |
| `src/doctor/*` | Per-check module shape (§11.5) |

Everything else in overstory's observability surface is either out-of-scope (§11.7) or contradicts the contract (§§2, 3.5, 9 — see decision provenance).

---

## 12. CLI surface

| Command | Purpose |
|---|---|
| `mars feature plan <goal...>` | Register an idea as a `draft` feature. **Does not run the planner.** Persists `features/<feature-id>.md` with front-matter. |
| `mars feature refine <feature-id>` | Run the planner on a draft feature; emits tasks; status → `ready`. |
| `mars feature start <feature-id>` | Kick off the build loop for a refined feature. |
| `mars build` | Orchestrator loop. |
| `mars review` | Standalone review pass over uncommitted edits. |
| `mars check` | Markdown compiler: link integrity, feature schema, reference graph. |
| `mars audit` | Harness/cost/health + question rates (defect/gate split). |
| `mars retro [--apply] [--since 7d]` | Cluster questions; create harness-fix features. |
| `mars features [--origin user|retro]` | List features. |
| `mars next [--peek]` | Show next ready task (peek = no claim). |
| `mars agents [attach <id>]` | List/attach to live tmux sessions. |
| `mars inbox [--blockers \| --all]` | List open inbox items, sorted by priority. |
| `mars inbox <id>` | Show one inbox item with full context. |
| `mars inbox add ...` | Manually add an inbox item (rare; mostly for testing). |
| `mars answer <id> "<text>"` | Resolve a `question` item; auto-resume parked task(s). |
| `mars resolve <id> "<note>"` | Resolve an `action` item (user has done the thing). |
| `mars decide <id> <option-id>` | Resolve a `decision` item. |
| `mars dismiss <id> --reason "<text>"` | Dismiss any item; parked tasks → `to_refine`. |
| `mars qa list` | Show configured QA checkpoint rules. |
| `mars qa test <task-or-build>` | Dry-run QA rules; show which would fire. |
| `mars tools list [--role <role>]` | Show registered tools and which roles can call each. |
| `mars tools test <name> '<json-input>'` | Invoke a tool out-of-band against the current worktree. |
| `mars status` | Snapshot: live agents, budget remaining, inbox blockers (§11.6). |
| `mars logs [filters] [--follow]` | Tail/query event log; see §11.6 for filters. |
| `mars trace <run-id>` | Chronological multi-agent timeline for one run (§11.6). |

---

## 13. Configuration

```ts
// mars.config.ts
import type { MarsConfig } from 'mars'

export default {
  // Provider
  provider: { kind: 'claude' },

  // PlanStore
  planStore: { kind: 'beads' },                  // future: 'fs-markdown'

  // HumanInbox
  humanInbox: { kind: 'fs-jsonl', path: '.mars/inbox.jsonl' },

  // VCS
  vcs: { kind: 'git' },

  // Concurrency
  maxParallelAgents: 3,
  maxParallelPlanners: 1,

  // Budget
  tokenBudgetPerRun: 200_000,

  // Optional safety valve (off by default)
  runaway: { enabled: false, perAgentTokensCap: 50_000 },

  // Hooks (§16) — emission bus subscribers
  hooks: {
    subscribers: [
      { name: 'sqlite-mirror',
        command: './scripts/mirror.sh',
        events: ['task.done', 'review.*', 'feature.completed'] },
      { name: 'slack-notify',
        command: 'node ./scripts/slack.js',
        events: ['budget.exhausted', 'session.pre_compact', 'inbox.item_added'] },
    ],
  },

  // Observability (§11)
  observability: {
    eventRetentionDays: 30,                // events.db prune window
    parkedTaskMaxAgeDays: 7,               // doctor warns above this
    trendWindowDays: 7,                    // mars audit --trend default
  },

  // QA gates
  qa: {
    checkpoints: [
      { name: 'schema-changes',
        when: { kind: 'paths', patterns: ['**/migrations/**', '**/*.sql'] },
        prompt: 'Schema migration in this checkpoint — review and approve?' },
      { name: 'harness-changes',
        when: { kind: 'featureOrigin', origin: 'retro' },
        prompt: 'Harness change from retro — approve before checkpoint?' },
    ],
  },

  // Tools (allow-only; no token charging)
  tools: {
    global: ['fs-read', 'ripgrep', 'mars.done'], // mars.done is mandatory for every role (§8.8.1)
    perRole: {
      planner:  { allow: [] },               // only globals
      builder:  { allow: ['rtk', 'exec'] },  // builder gets rtk + exec on top of globals
      reviewer: { allow: ['ts-morph'] },
    },
    config: {
      rtk: { binary: 'rtk', defaultArgs: ['--no-color'] },
    },
  },
} satisfies MarsConfig
```

---

## 14. Filesystem layout

```
<repo>/
  mars.config.ts                          ← user config
  VISION.md
  docs/CONTRACTS.md                       ← this file
  agents/
    planner.md                            ← agent template (compiler-validated, §15)
    builder.md
    reviewer.md
  .mars/
    runs/<handleId>/
      intent.json                         ← agent output (one per spawn)
      stdout.log
      tools.sock                          ← UDS for ToolRegistry sidecar (Model B)
      tools.log                           ← NDJSON log of tool calls + results
    worktrees/<handleId>/                 ← per-agent git worktrees
    inbox.jsonl                           ← HumanInbox (fs-jsonl backend)
    retros/<date>.md                      ← `mars retro` reports
    db/
      events.db                           ← append-only event log; every row is a hook fire (§11.2, §16)
      metrics.db                          ← run + dimension rollups (§11.3)
    hooks.sock                            ← UDS pub/sub for live subscribers (§16.1)
    subscribers/<name>.log                ← stdout/stderr of config-spawned subscribers (§16.5)
  .beads/                                 ← PlanStore (beads backend)
```

---

## 15. Agent templates

Each agent role has a markdown definition at `agents/<role>.md`. The file is the **editable source of truth** for the agent's prompt and contract. The runtime (single generic loader) reads it on spawn to build the system prompt; the compiler (§8.6) validates its structure on every `mars check` and on `mars build` startup.

There is no per-instance code per role. Adding or modifying an agent = editing markdown.

### 15.1 Required structure

```markdown
---
role: planner | builder | reviewer       # required, must be unique across agents/
inputs: Goal | Task | BuildResult        # required, must match the Intent contract for role
outputs: Feature | BuildResult | Review  # required, must match the Intent contract for role
tools: [<toolName>, ...]                 # required (may be empty); names resolved against ToolRegistry
---

# <Role title>

## Goal
<one-sentence purpose; non-empty>

## Definition of Done
- <objectively checkable bullet>
- <objectively checkable bullet>
...

## Non-Goals          (optional but recommended)
- <scope drift fence>
...
```

### 15.2 Contract binding (compiler-enforced)

| role       | inputs        | outputs        |
|------------|---------------|----------------|
| `planner`  | `Goal`        | `Feature`      |
| `builder`  | `Task`        | `BuildResult`  |
| `reviewer` | `BuildResult` | `Review`       |

These three rows are the entire allowed matrix. Any other combination is a compiler error.

### 15.3 Compiler checks

The Compiler (§8.6) emits an `error` finding for any of:

1. Missing file: `agents/planner.md`, `agents/builder.md`, or `agents/reviewer.md` not present.
2. Frontmatter missing required keys (`role`, `inputs`, `outputs`, `tools`).
3. `role` value duplicated across files, or doesn't match filename.
4. `inputs`/`outputs` don't match the §15.2 row for the declared role.
5. `## Goal` section missing or empty.
6. `## Definition of Done` section missing or contains zero bullets.
7. A bullet under Definition of Done is empty or only whitespace.
8. Any name in `tools[]` is not registered in the `ToolRegistry`.
9. Any name in `tools[]` is not in the role's effective allowlist (`global ∪ perRole[role].allow` — see §8.8).

Warnings (non-halting): missing `## Non-Goals` section.

### 15.4 Runtime use

The agent runtime is a single generic loader (one TS module). On spawn:

1. Read `agents/<role>.md`.
2. Compose the system prompt from `Goal` + `Definition of Done` + (`Non-Goals` if present) + Intent schema for the declared `outputs`.
3. Inject only the descriptions of tools listed in frontmatter `tools[]` (cross-checked against the registry's `callableFor(role)`).
4. Call Provider; parse output into the Intent kind matching `outputs`; emit it via the `mars.done` tool (§8.8.1); the sidecar writes `intent.json` and ends the spawn.

The loader never branches on role. Role-specific behavior lives entirely in the markdown + the Intent contract.

### 15.5 Editing surface

- **Human edits.** Direct file edits to `agents/<role>.md`. `mars check` validates.
- **`mars retro` edits.** When a retro produces a harness-improvement feature, builder tasks may emit `BuildResult.edits` against `agents/*.md`. The QA gate `harness-changes` (§7.2) fires by default for retro-origin features, so a human approves before checkpoint.

### 15.6 Out of scope for v0

- Versioning agent templates. The git history of `agents/*.md` is the version log.
- Per-task agent overrides. One template per role, period.
- Multiple agents per role (e.g. "fast builder" vs "careful builder"). Adding role variants is post-v0; until then, the dial is the prompt content, not the count.

---

## 16. Hooks: the emission bus

Mars exposes one tool — `hook` — that every emitter calls. Agents emit, the orchestrator emits, the provider emits (via native-hook forwarders). Each emission becomes a row in `events.db` and is broadcast to any subscriber currently listening for that event. Subscribers are independent processes that decide for themselves what to do — write to a database, send a notification, no-op, anything. **Mars ingests and broadcasts; it never runs user commands per event.** The handler-execution model from earlier drafts is gone.

This makes hooks the universal observation + extension point. Anyone can emit; anyone can listen; Mars never blocks emitters on subscribers.

### 16.1 Architecture

Three layers:

```
emitters (agents / orchestrator / provider)
       │  call `mars hook fire <event>` (CLI) or the `hook` tool (agent)
       ▼
┌────────────────────────────────────────────────┐
│ ingest path                                    │
│  1. validate event name (closed taxonomy)      │
│  2. validate payload (per-event schema)        │
│  3. APPEND to events.db (durable)              │
│  4. PUBLISH on .mars/hooks.sock (best-effort)  │
└────────────────────────────────────────────────┘
       │
       ├──▶ events.db    (durable log; subscribers replay by cursor)
       │
       └──▶ hooks.sock   (live UDS pub/sub; subscribers connect with a filter)
                ▼
            subscribers (config-spawned, CLI, or programmatic)
            — each receives only events matching its filter
            — each persists its own cursor for replay on reconnect
```

Steps 1–3 are synchronous and durable. Step 4 is best-effort. The emitter never blocks on subscriber state.

Two transport layers because:
- `events.db` alone forces subscribers to poll — laggy, expensive.
- `hooks.sock` alone is fragile — restarts lose events, slow subscribers drop messages.
- Together: durable + live. Subscribers get pushed events while attached; on (re)connect they replay from the DB using a stored cursor.

### 16.2 The `hook` tool

Single emission API, two forms.

**CLI form:**

```
mars hook fire <event> [--payload <json>]
mars hook fire <event> < payload.json          # stdin alternative
```

**Tool form (agents):** `hook` is a built-in global tool in the ToolRegistry (§8.8), available to every role. Sidecar dispatches to the same internal function `mars hook fire` uses.

```json
{ "tool": "hook", "input": { "event": "agent.blocked", "payload": { ... } } }
```

The tool's input schema is generated at `mars build` start from the recognized event taxonomy (§16.3) plus per-event payload schemas (§16.4). Invalid event names or malformed payloads are rejected at the tool boundary — agents cannot invent event names.

### 16.3 Recognized event taxonomy

Closed enum. Adding an event is a one-line change here plus a payload schema entry; the tool's input schema regenerates on next `mars build`. Free-form names would break subscriber portability; the discipline is non-negotiable.

```ts
type HookEvent =
  // session.* — provider lifecycle (forwarded by Provider native hooks)
  | 'session.start' | 'session.prompt_submit' | 'session.pre_compact' | 'session.end'
  // run.* — orchestrator-level
  | 'run.start' | 'run.end' | 'run.halted'
  // agent.* — emitted by agents themselves
  | 'agent.spawned' | 'agent.phase_started' | 'agent.blocked'
  | 'agent.intent_emitted' | 'agent.exited'
  // task.* — emitted by orchestrator on PlanStore mutations
  | 'task.created' | 'task.claimed' | 'task.released'
  | 'task.state_changed' | 'task.refined' | 'task.done'
  // feature.*
  | 'feature.created' | 'feature.completed'
  // intent.*
  | 'intent.applied'
  // review.*
  | 'review.passed' | 'review.failed'
  // qa.* / vcs.* / budget.*
  | 'qa.gate_matched'
  | 'vcs.checkpoint' | 'vcs.conflict'
  | 'budget.charged' | 'budget.exhausted'
  // inbox.* / retro.* / harness.*
  | 'inbox.item_added' | 'inbox.item_resolved' | 'inbox.item_dismissed'
  | 'retro.completed' | 'harness.fixed'
  // subscriber.* — Mars-emitted observability of the bus itself
  | 'subscriber.connected' | 'subscriber.exited' | 'subscriber.dropped'
```

**Emitter-class permissions** (enforced at the tool boundary):

| Event prefix | Permitted emitters |
|---|---|
| `session.*` | Provider native-hook forwarders only |
| `run.*` | Orchestrator only |
| `agent.*` | Agents only (the agent that fires must own the `handleId` in the payload) |
| `intent.*`, `task.*`, `feature.*`, `review.*`, `qa.*`, `vcs.*`, `budget.*`, `inbox.*`, `retro.*`, `harness.*` | Orchestrator only |
| `subscriber.*` | Mars internal (the bus itself) |

Out-of-class emissions are rejected. This keeps the contract honest — subscribers know that `task.done` always came from the orchestrator and reflects authoritative state, not an agent's wish.

### 16.4 Per-event payload contracts

Every event has a typed payload, validated at the tool boundary against the schema for the named event. Same discipline as `AgentIntent` (§2). Excerpt:

```ts
type HookPayload = {
  'session.start':         { runId: string; sessionId: string; ts: string }
  'session.pre_compact':   { runId: string; tokensAtFire: number; ts: string }
  'session.end':           { runId: string; ts: string }
  'run.start':             { runId: string; featureId?: FeatureId; budget: number }
  'run.end':               { runId: string; status: 'completed' | 'halted' | 'budget_exhausted' }
  'run.halted':            { runId: string; reason: string }
  'agent.spawned':         { handleId: string; role: AgentRole; taskId?: TaskId }
  'agent.phase_started':   { handleId: string; phase: string; note?: string }
  'agent.blocked':         { handleId: string; reason: string }
  'agent.intent_emitted':  { handleId: string; intentKind: AgentIntent['kind'] }
  'agent.exited':          { handleId: string; exitCode: number }
  'task.done':             { taskId: TaskId; featureId: FeatureId; tokensUsed: number; durationMs: number }
  'task.state_changed':    { taskId: TaskId; from: TaskState; to: TaskState; by: string }
  'review.failed':         { taskId: TaskId; verdict: Verdict; findings: Finding[] }
  'budget.charged':        { handleId: string; tokens: number; remaining: number }
  'budget.exhausted':      { runId: string; budget: number }
  'qa.gate_matched':       { taskId: TaskId; ruleName: string }
  'vcs.checkpoint':        { taskId: TaskId; ref: string }
  'vcs.conflict':          { taskId: TaskId; files: string[] }
  'inbox.item_added':      { itemId: string; kind: InboxItemKind; category: InboxItemCategory; priority: Priority; title: string }
  'inbox.item_resolved':   { itemId: string; rootCause?: RootCause }
  'retro.completed':       { reportPath: string; defectsClustered: number; trend: number }
  'harness.fixed':         { itemId: string; commitRef?: string }
  'subscriber.connected':  { name: string; events: string[]; fromCursor?: string }
  'subscriber.exited':     { name: string; reason: 'clean' | 'crashed' | 'killed' }
  'subscriber.dropped':    { name: string; count: number }
  // ...
}
```

Full schema lives in source as `hook-events.ts`. The tool refuses payloads that don't match.

### 16.5 Subscribers

Three ways to attach:

**1. Configured (production surface).** `mars build` reads `hooks.subscribers[]` from `mars.config.ts`, spawns each as a child process, and connects each to the socket. Subscriber stdout/stderr is piped to `.mars/subscribers/<name>.log`. If a subscriber dies, Mars emits `subscriber.exited` and does **not** restart — restart policy is the user's call (their script can wrap itself in a supervisor).

```ts
// mars.config.ts
hooks: {
  subscribers: [
    { name: 'sqlite-mirror', command: './scripts/mirror.sh',
      events: ['task.done', 'review.*', 'feature.completed'] },
    { name: 'slack-notify',  command: 'node ./scripts/slack.js',
      events: ['budget.exhausted', 'session.pre_compact', 'inbox.item_added'] },
  ],
}
```

**2. CLI (interactive).** `mars hook listen` for live debugging:

```
mars hook listen [--events <pattern>...] [--from <cursor>] [--follow]
```

**3. Programmatic.** Any process opens `.mars/hooks.sock` (UDS) and sends a JSON filter on connect:

```json
{ "events": ["task.done", "review.failed", "agent.*"], "fromCursor": "events:1492" }
```

The broadcaster fans out matching events as JSON lines, one per emission. Filters use `*` as a trailing-segment wildcard (`agent.*` matches `agent.blocked`, `agent.spawned`, etc.).

### 16.6 Cursors and replay

Each subscriber receives a cursor (the `events.id` of the last delivered row) on every push. Subscribers persist the cursor however they like.

On (re)connect with `fromCursor`, the broadcaster reads `events.db` from that cursor forward, streams the backlog, then transitions to live. Without `fromCursor`, the subscriber receives only events from connect time onward.

This gives subscribers two delivery modes:
- **at-most-once** (live only, no cursor) — for ephemeral observers.
- **exactly-once** (cursor + replay) — for systems that must not lose events (DB mirrors, billing, audit).

### 16.7 Failure model

Mars's contract with subscribers is one-way and best-effort:

| Subscriber state | Mars behavior |
|---|---|
| Dies | Emit `subscriber.exited`. Do not restart. User-managed supervisor restarts; subscriber reconnects with stored cursor. |
| Slow consumer (queue overflow, default 1000 events) | Drop oldest queued events. Emit `subscriber.dropped { name, count }`. Subscriber detects gap by cursor jump and replays from `events.db` if it cares. |
| Clean disconnect | Emit `subscriber.exited { reason: 'clean' }`. No event loss; cursor preserved. |

The bus **never blocks emitters on subscribers**. This is the load-bearing decision: a flaky user subscriber cannot stall the orchestrator. Subscribers must be tolerant of drops; if they need exactly-once, they replay.

### 16.8 The orchestrator is also a subscriber

Reactive orchestrator behavior is modeled as the orchestrator subscribing to its own events, not as inline reactive code. Same shape, same bus.

Examples:
- `inbox.item_resolved` → sweep parked tasks back to `ready_for_execution`.
- `agent.exited` → drive the main loop's "wait for next agent" (replaces polling `Runner.waitAny` in §9).
- `vcs.conflict` → add an `inbox.item_added { questionKind: 'resolve_conflict' }`.

This dogfoods the bus — Mars's own behavior is just another subscriber. Same wiring shape user subscribers use. New orchestrator reactions are added by registering new internal subscribers, not by editing the loop.

### 16.9 `session.pre_compact` handling

Per VISION anti-goal: compaction is failure. `session.pre_compact` is a normal event with no special infrastructure — but Mars ships **one default subscriber** for it, named `mars-internal-compaction-halter`, which:

1. Calls `mars hook fire inbox.item_added` with payload describing the run state at fire time, `category: 'defect'`, `rootCause: 'context_bloat'`.
2. Calls `mars hook fire run.halted { reason: 'context_bloat' }`.
3. Prints to its log: `MARS COMPACTION DETECTED — run halted. See: mars inbox <id>.`

The orchestrator's own subscription to `run.halted` (§16.8) stops further agent spawns and drives a clean exit.

Users may wire additional subscribers to `session.pre_compact` (Slack page, dashboard alert, etc.). The halt logic is a Mars-shipped subscriber, not special-cased — same shape as everything else. **Recovery (bundle injection, checkpoint replay, summary handoff) is forbidden** per VISION; no subscriber may attempt it.

### 16.10 CLI

```
# Provider wiring (writes provider native config to forward session.* to mars hook fire)
mars hooks install [--provider <name>]
mars hooks status
mars hooks uninstall

# Bus
mars hook fire <event> [--payload <json>]            # emission (also the agent tool)
mars hook listen [--events <pat>...] [--from <c>] [--follow]   # subscribe interactively
mars hook events                                     # list recognized event names + payload schemas
mars hook subscribers                                # list configured subscribers + connection state
```

Plural `mars hooks` = provider wiring. Singular `mars hook` = bus operations. Different concerns, different namespaces.

### 16.11 Doctor checks (§11.5 additions)

| Name | Verifies |
|---|---|
| `hooks-installed` | All four `session.*` forwarders present in active provider's config. Missing `session.pre_compact` is an `error` — without it, compaction failures are silent. |
| `context-headroom` | Orchestrator session below configurable safety threshold (default 70% of provider's compaction limit). Warns at threshold, errors above. Pre-emptive — fires before `session.pre_compact` would. |
| `subscribers-healthy` | All configured subscribers connected; none have emitted `subscriber.dropped` in the last hour. |
| `event-schema-valid` | Every event in the taxonomy has a payload schema; every payload schema is reachable from the taxonomy. No drift. |

### 16.12 Out of scope for v0

| Deferred | Why |
|---|---|
| Subscriber retry / restart policy | User-managed. Mars logs `subscriber.exited`; supervisors are not Mars's job. |
| Cross-host bus | Single-host UDS only in v0. Multi-host requires real broker — out of scope until §3.4 `claimedHost` is exercised. |
| Free-form event names | Closed taxonomy is non-negotiable for subscriber portability (§16.3 rationale). |
| `PreCompact` recovery handlers | Forbidden by VISION anti-goal. Compaction is a defect; the only recognized response is halt + retro defect. |
| Bundle templating in user config | Bundle shape is part of the contract. Users extend by adding subscribers, not by editing core emissions. |

---

## 17. Decision provenance

Every decision in this document was deliberately locked in conversation. Where a non-default was chosen, the rationale is preserved:

| Area | Decision | Rationale |
|---|---|---|
| Topology | Centralized orchestration | Lean; matches every other locked decision (token pool, claim atomicity, QA evaluation). Choreography path stays open. |
| Agent pattern | One-shot subprocess per task in tmux session | Stateless ✓, lean ✓, observable ✓, token-frugal ✓. |
| Liveness | PID check, no wall-clock timeout | No false positives on slow agents; instant recovery on crashes; no reaper infrastructure. |
| Claim | Atomic claim-on-fetch | Race-proof by construction; `next()` is one call. |
| Parallelism | Default on; cap 3 / planners 1 | Solo dev + Claude rate limits + edit-conflict surface; refining a feature rarely benefits from concurrency. |
| Per-agent isolation | git worktree | Real concurrency safety without an in-process locking protocol. |
| Task states | 4 (no `needs_framework`, no `needs_rework`) | Harness-gap signals surface as `Question` → `mars retro`; reviewer rejection reuses `to_refine` + history. |
| Question category | `defect \| gate` | Prevents perverse incentive to remove QA gates to look better in audit. |
| Human-in-the-loop surface | Single `HumanInbox` (questions, actions, decisions) with computed priority | One place to look — "what does mars need from me?" has one answer. Fragmenting across "open questions / halted runs / pending retros" would erode the autonomy story. |
| Planner output format | `mars-canonical` only | Lean (no normalizer); forces prompt quality; preserves parallelism (no accidental linear-deps collapse). Output is a `Feature`. |
| QA checkpoints | Declarative rules in config, evaluated by orchestrator | Predictable, auditable, lean, token-frugal (no LLM call). |
| `mars retro` | Creates beads features/tasks | Harness improves itself using its own machinery. |
| Intent transport | File at `.mars/runs/<id>/intent.json` | Stdout is for humans; intent is structured. |
| Tool injection | Sixth adapter (`ToolRegistry`); allow-only allowlist; sidecar UDS during spawn; tools don't charge token budget | Same declarative posture as every other adapter. Allow-only keeps semantics trivial. Sidecar preserves §2's one-spawn-one-intent invariant. No token charging because tool cost is wall-time, not LLM calls. |
| Observability stores | Two SQLite WAL DBs: `events.db` (append-only) + `metrics.db` (rollups) | Different access patterns; conflating forces one schema to serve both badly. Pattern lifted from overstory's `src/events/` + `src/metrics/`. |
| Token accounting | Provider transcript parsing, not agent self-report | Self-reports are unreliable and game-able. Transcripts are ground truth. Self-report is fallback only. |
| Triage / monitor agents | Out of scope for v0 | Halt-and-flag + `RootCause` capture in inbox covers diagnosis without a billed Claude session "watching the fleet." Violates token-cost anti-goal. |
| Observation lenses | Two: `mars logs` + `mars trace` (no live TUI in v0) | Solo-dev surface; fragmenting into trace/replay/inspect/errors/feed (overstory) is a tax on the user. |
| Defect-rate trend | Tracked in `metrics.db`, surfaced by `mars audit --trend` | Single number that answers "is mars getting better." Without it, the meta-loop is anecdotal. |
| tmux socket isolation | All commands use `-L mars` | Mars's agent sessions never touch the user's personal tmux server, config, or session list. Operationally critical; locked here so it isn't lost in implementation. |
| tmux env hygiene | Unset `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT` before spawn | Without this the child Claude Code agent inherits the orchestrator's session identity and misbehaves silently. The gotcha you only discover by debugging — pin it. |
| Exit detection | Poll `intent.json` mtime + `has-session` going false; do not parse capture-pane | TUI output is for humans and `mars logs`. The intent file is the source of truth (§2). Two unrelated failure modes (no intent / dead session) cover all cases. |
| Headless runner | Out of v0 default; interface stub only | Claude Code is a TUI; tmux is the right shape. Headless mode is reserved for non-TUI providers / CI hosts and ships when needed. |
| Agent definitions | Markdown at `agents/<role>.md`, validated by the compiler; one generic runtime loader | Same posture as feature-canonical and the rest of the harness. Editable without recompiling. Single source of truth for prompt + contract. `mars retro` can write to it (closes the meta-loop). One loader avoids drift across roles. |
| Hooks as pure emission bus | Mars ingests + broadcasts; subscribers react. Mars never runs user commands per event. | Inverts the typical "framework hooks = framework reactions" pattern. Removes blocking/timeout/failure semantics from the bus. Subscribers crash, Mars doesn't notice; subscribers fall behind, Mars doesn't slow down. Load-bearing decision: emitters are never blocked by subscribers. |
| `hook` is a global tool | Every agent role gets it via the ToolRegistry | Universal because emission is a universal capability. Same code path used by orchestrator, agents, and provider native-hook forwarders. One emission API, three sources. |
| Closed event taxonomy + typed payloads | Same discipline as `AgentIntent` (§2). Free-form names rejected at the tool boundary. | Without it, subscribers can't reliably wire against events — every emitter rename breaks every subscriber. Closed taxonomy makes the bus a contract, not a free-for-all. |
| Two-layer transport: `events.db` + `hooks.sock` | Durable log + live pub/sub | events.db alone forces polling (laggy). Sockets alone lose events on restart. Together: subscribers get pushed events live, replay from DB on (re)connect via cursor. |
| At-most-once live, exactly-once via replay | Slow subscribers drop messages; cursor-based replay from `events.db` for systems that need every event | The standard pub/sub trade-off, made explicit. Choosing "never block emitters on subscribers" is the load-bearing constraint; subscribers needing exactly-once persist a cursor and replay. |
| `session.pre_compact` halt is a Mars-shipped subscriber | Same shape user subscribers use; not a special-cased handler | Dogfoods the bus. The halt logic is just a subscriber Mars ships by default. New orchestrator reactions are added by registering subscribers, not by editing the loop. |
| Orchestrator is also a subscriber | Reactive orchestrator behavior modeled as subscriptions to its own events | Replaces inline reactive code in `applyIntent` and `Runner.waitAny` polling. Same shape, same bus. New reactions = new internal subscribers, not loop edits. |
| `events.db` rows are hook fires | Every row is `kind: 'hook_fired'`, with `event` and `payload` | Collapses the previous `EventKind` enum into the hook taxonomy. One schema, one writer, one query surface. |
| `mars hooks` vs `mars hook` | Plural for provider wiring; singular for bus operations | Different concerns, different namespaces. `hooks install` writes `.claude/settings.local.json`; `hook fire` emits to the bus. |
| `context-headroom` doctor check | Early-warning sibling of the `session.pre_compact` detector | Gives the loop a chance to halt cleanly *before* the threshold instead of at it. Cheaper to catch than `context_bloat` defects after the fact. |
| Cost unit | Tokens only; no USD anywhere in the framework | Decouples Mars from any provider's pricing model. Tokens are what providers report; the framework adds, caps, and halts. Dollars are the provider's business — surface them in the provider's own tooling, not in `mars audit` / `RunMetric` / config. Avoids speculative pricing-table abstraction; matches VISION principle 5 (no abstraction without a second real implementation). |
