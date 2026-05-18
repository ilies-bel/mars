# Context note — rework too-hard child into GSD-style structured diagnosis (mars-7dbd72db)

> Produced by the context-gathering chain
> `mars-7dbd72db → mars-5ceaeb55 → mars-eab84df7 → mars-95e3ccc2`.
> Three context-gathering implementors in a row were SIGKILLed by the
> read-span watcher (`too_hard:no-action-after-reads`) while orienting in
> this exact code. This note pre-digests every region/signature the real
> task needs so its implementor can act inside the 5-read budget — read
> THIS file, then edit. Do not re-grep the tree.

## TL;DR of the degenerate recursion (why this note exists)

`mars-7dbd72db` is the *fix* for the very bug that keeps killing its own
context-gathering children: the too-hard child prompt is free-form
("note OR surgical change OR `mars idea add`") with no required output
shape, so each child reads ~5 files orienting, never produces a
structured artifact, trips the watcher, and spawns another child. The
loop has run ≥3 levels deep. Implementing `mars-7dbd72db` terminates the
class of bug. The recursion has self-collapsed one level (parent
`mars-eab84df7` is `done`, `mars-5ceaeb55` is back to `queued`); an inbox
item has been raised so a human can collapse the rest if it re-spawns.

## Exact code locations (verified, file = orchestrator/src/mastra/...)

### 1. `workflows/implement-workflow.ts`

- **L57–64** — sentinel helpers (keep as-is, the dispatcher keys on them):
  ```ts
  export const TOO_HARD_ABORT_MESSAGE = (taskId: string): string =>
    `task ${taskId} aborted by read/grep span watcher; task parked in blocked`
  export const isTooHardAbortError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('aborted by read/grep span watcher')
  }
  ```
- **L262** — `export const TOO_HARD_PREFIX = 'too_hard:no-action-after-reads'`
  (used in `errorSummary` at L741; leave the constant, it is fine).
- **L275–278** — `formatTrace(trace)` helper (reuse verbatim in the new prompt).
- **L280–303** — `buildTooHardChildPrompt(parentTaskId, parentPrompt, trace)`.
  THIS is the function to rewrite. Current body emits the free-form
  `## What this task must do` paragraph with the "(a) note / (b) surgical
  change / `mars idea add`" wording (L292–294). Replace that section with
  the **DIAGNOSE-ONLY** contract: child must NOT fix, must NOT attempt the
  parent task, must end by writing exactly one of the two fixed-heading
  markdown blocks (`## ROOT CAUSE FOUND` / `## INVESTIGATION INCONCLUSIVE`,
  schema in the parent prompt) to a note file in the parent repo AND
  printing it as the final message. Keep the existing `## Parent prompt`
  (`parentPrompt.trim()`) and `## Read trail before abort`
  (`formatTrace(trace)`) sections unchanged. State explicitly: pick
  exactly one verdict heading.
- **L730–773** — the too-hard branch inside the `run-claude-code` step
  (`if (tooHardTrip !== null) { ... }`). Current flow:
  ```ts
  const childPrompt = buildTooHardChildPrompt(inputData.taskId, inputData.prompt, trip.trace)
  const errorSummary = `${TOO_HARD_PREFIX}: ${trip.limit} reads without action; trace=...`.slice(0, 1000)
  const child = await enqueueTask(childPrompt, undefined, { skipTriage: true, originId })
  await updateTask(inputData.taskId, { status: 'blocked', error: errorSummary, failedPhase: 'code' })
  await addBlockers(inputData.taskId, [child.id])
  // ... console.log(`[span] ... spawned ${child.id} as blocker; parent → blocked`)
  // catch → fallback updateTask(status:'failed', ...)
  throw new Error(TOO_HARD_ABORT_MESSAGE(inputData.taskId))
  ```
  This still spawns the diagnose-only child the same way (enqueueTask +
  skipTriage + same originId, parent → blocked, addBlockers([child.id]),
  throw the sentinel). **The verdict branch does NOT live here** — the
  child runs asynchronously and this step has already thrown. The branch
  must be applied **when the diagnose-only child completes**, i.e. wire it
  into the child-completion path (see §3) — NOT inline in this step.

### 2. `daemon/server.ts` — dispatcher (`dispatchImplement`, L306–371)

- **L317–322** — runs `implementWorkflow`.
- **L339–351** — result-path: imports `{ isBlockersAbortError, isTooHardAbortError }`,
  and at **L345–348**:
  ```ts
  if (result.status === 'failed' && resultError && isTooHardAbortError(resultError)) {
    log(`[implement] ${task.id} parked in blocked: read/grep span watcher tripped; spawned context-gathering child task`)
    return
  }
  ```
- **L353–366** — catch-path mirror: **L356–357**
  ```ts
  } else if (isTooHardAbortError(err)) {
    log(`[implement] ${task.id} parked in blocked: read/grep span watcher tripped; spawned context-gathering child task`)
  }
  ```
  Both `return`/short-circuit BEFORE the generic failure handler
  (**L358–366**: `updateTask(status:'failed')` + `bus.emit('task.failed')`).
  Task 3 of the parent prompt = update these two log lines to say
  "spawned diagnosis child; fix-worker conditional on verdict" and keep
  the early-return so the parent stays parked (do NOT route through the
  L358 generic failure handler).

### 3. Where the verdict branch belongs (child-completion, NOT the abort step)

The diagnose-only child is a normal task; when it reaches `done` the
parent is unblocked by the existing blocker machinery
(`onBlockerTaskCompleted` / `recoverBlockedTasks`, see CLAUDE.md
"Blockers"; `queue.ts` promotes blocked→queued when every blocker is
`done`). The parent prompt wants: on the child's completion, read the
child's verdict (final message / note file) and:
- **`## ROOT CAUSE FOUND`** → `enqueueTask(parentPrompt + '\n\n## Diagnosis
  from context-gathering\n' + rootCauseBlock + '\n\n<apply the fix and
  Save your work>', undefined, { skipTriage: true, originId })`, then
  `addBlockers(parentTaskId, [fixWorker.id])` so the *fix-worker*
  (not the diagnose child) is the parent's blocker. Diagnose child just
  completes normally.
- **`## INVESTIGATION INCONCLUSIVE`** (or NEITHER heading present — fail
  safe) → NO fix worker. Raise an inbox item (see §4) summarizing the
  inconclusive result + parent task id + read trail, leave the parent
  parked. Match the existing exhausted-retry shape for consistency.

Find the blocker-completion hook the implementor must extend:
`rg -n "onBlockerTaskCompleted|recoverBlockedTasks|promoteBlockedToQueued|task_blockers" src/mastra/queue.ts src/mastra/daemon/server.ts`.
The verdict parse + fix-worker dispatch is a new helper invoked there
(gated on the completed task being a diagnose-only child — detect via the
`# Context-gathering for <id>` prompt prefix or a stored marker; the
child's prompt is the canonical signal since `buildTooHardChildPrompt`
emits that header).

## API signatures (verified — use exactly these, do not re-read source)

```ts
// queue.ts L780
enqueueTask(prompt: string, plan?: TaskPlan, opts?: EnqueueTaskOptions): Promise<Task>
//   opts: { skipTriage?: boolean; originId?: string; tag?: TaskTag;
//           priority?: number; spec?: ...; author?: {kind,name}; ... }
//   skipTriage:true => status starts at 'queued' (not 'draft'); set originId
//   to the original task's originId to keep the lineage.

// queue.ts L1150
addBlockers(taskId: string, blockerIds: readonly string[]): Promise<void>
//   self-edges and dupes are filtered; every id must already exist.

// queue.ts — updateTask(taskId, { status, error, failedPhase, ... })

// lib/inbox.ts L289 — raiseInboxItem(item: RaiseInboxItem): Promise<string>
interface RaiseInboxItem {
  kind: string                       // dedup key part; e.g. `too-hard-inconclusive(${parentId})`
  category: 'orchestrator'|'reflector'|'daemon'|'user' | string  // use 'orchestrator'
  priority: 'urgent'|'high'|'normal'|'low'                       // 'high'
  title: string
  body: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  raisedBy: string                   // e.g. 'orchestrator:too-hard-diagnosis'
  signature: string                  // dedup with kind; key to parentId
  occurrence?: Record<string, unknown>
}
```
Reference impl to copy the inbox shape from: `queue-retry.ts`
`raiseRetryBudgetExhaustedInbox` (L92–119) and
`TASK_BLOCKED_INBOX_KIND_PREFIX` (L6). For the CLI path that dispatched
agents must use, see AGENTS.md: `mars inbox raise --from -` (JSON on
stdin) — do NOT write one-shot `.ts` scripts under `orchestrator/scripts/`.

## §4 — inbox shape for INVESTIGATION INCONCLUSIVE

Mirror `raiseRetryBudgetExhaustedInbox`:
`kind: 'too-hard-inconclusive(<parentId>)'`, `category:'orchestrator'`,
`priority:'high'`, `signature:'<parentId>'`, payload includes parentId +
read trail + the child's `## INVESTIGATION INCONCLUSIVE` block,
`raisedBy:'orchestrator:too-hard-diagnosis'`. Server-side dedup on
`(kind, signature)` bumps `seen_count` instead of duplicating.

## Tests

`rg -l "Context-gathering|buildTooHardChildPrompt|TOO_HARD|isTooHardAbortError"
src/**/__tests__/**` returns **NOTHING** — this path is currently
**untested**. So "update existing assertions" is a no-op; the implementor
must **create** the tests. Existing `__tests__` dirs for placement:
`src/mastra/__tests__/`, `src/mastra/workflows/__tests__/`,
`src/mastra/daemon/__tests__/`, `src/mastra/lib/__tests__/`. Add (per the
parent prompt's Verify section):
1. `buildTooHardChildPrompt` emits the diagnose-only contract + both
   verdict headings + keeps `## Parent prompt` / `## Read trail` sections.
2. A `## ROOT CAUSE FOUND` child → a fix-worker becomes the parent's
   blocker (assert `addBlockers(parentId, [fixWorkerId])`, fix-worker
   prompt contains the `## Diagnosis from context-gathering` section).
3. A `## INVESTIGATION INCONCLUSIVE` child (and a no-heading child) → an
   inbox item raised, NO fix worker spawned.
Test runner: vitest. Build first.

## Verify (run from `orchestrator/`)

```
cd orchestrator && npm run build
cd orchestrator && npm test     # touched __tests__ only if scoped; new tests above
```

## Hard-cut reminder

No back-compat with the old free-form child prompt. Delete the
"(a)/(b)/`mars idea add`" wording entirely, update every call site and
test in the same change (CLAUDE.md "Project status": every change is a
hard cut). `git add -A && git commit` — the orchestrator does not commit
for the agent.
