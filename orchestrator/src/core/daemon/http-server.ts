import { createServer, type Server } from 'node:http'
import type { PrimitiveWorkerProfile } from '../lib/primitive-catalog'
import type { RecipeCatalog } from '../lib/recipes'
import type { TraceEventStore } from '../lib/trace-events-store'
import type { ViewStreamHub } from './view/stream-hub'
import type { ViewInvalidationBus } from '../../bus/view-invalidation.js'
import type { ProposalSource } from '../proposals'
import type { AppServices } from '../app-services'
import type { DispatchPauseState, PauseReason } from './pause-state'
import type { ChatRunner } from './chat-runner'
import type { ChatStreamHub } from './chat-contracts'
import { registerRoutes } from './routes'

/** Wire shape for a single step span, returned by GET /view/step-spans. */
export interface StepSpan {
  stepName: string
  phase: string | null
  workflowInstanceId: string
  workerName: string | null
  outcome: string
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  taskId: string | null
  originId: string | null
  evalResults?: Array<{ label: string; value: number | string | null; warn: boolean }>
  /** Declared model tier for this step (populated by Phase 4B slice 1). */
  declaredTier: 'fast' | 'balanced' | 'flagship' | null
  /** Resolved native model id for this step (populated by Phase 4B slice 1). */
  resolvedModel: string | null
}

/** A single step within a run timeline, returned by GET /view/runs/:taskId. */
export interface RunTimelineStep {
  stepName: string
  phase: string | null
  workerName: string | null
  status: 'completed' | 'failed' | 'killed' | 'running'
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  /** Input tokens consumed by this step (LLM-backed steps only). */
  inputTokens: number | null
  /** Output tokens produced by this step (LLM-backed steps only). */
  outputTokens: number | null
  /** Cache-read tokens for this step (LLM-backed steps only). */
  cacheReadTokens: number | null
  /** Claude session ID — the transcript reference for LLM-backed steps. */
  claudeSessionId: string | null
  /** Failure reason when status is 'failed' or 'killed'. */
  failureReason: string | null
  /** JSON-serialised return value from the step function, or null when absent. */
  resultJson: string | null
  /** Human-readable one-line summary produced by non-LLM steps (e.g. reflect). */
  summary: string | null
  /** Declared model tier for this step (populated by Phase 4B slice 1). */
  declaredTier: 'fast' | 'balanced' | 'flagship' | null
  /** Resolved native model id for this step (populated by Phase 4B slice 1). */
  resolvedModel: string | null
}

/**
 * All steps for a single workflow run, identified by its workflowInstanceId.
 * A task can have multiple runs (resume / recovery), each with its own id.
 */
export interface RunTimelineEntry {
  /** The @mars/workflow workflowInstanceId for this run. */
  runId: string
  /** ISO-8601 timestamp of the earliest step_started event in this run. */
  startedAt: string
  /** ISO-8601 timestamp of the latest step_ended event in this run, or null if any step is still running. */
  endedAt: string | null
  steps: RunTimelineStep[]
}

/**
 * Full run timeline for a task — all workflow runs in chronological order,
 * each containing its ordered step list.
 *
 * Returned by GET /view/runs/:taskId.
 */
export interface RunTimeline {
  taskId: string
  runs: RunTimelineEntry[]
}

/**
 * Wire shape returned by GET /view/step-prompt — the composed prompt sent to
 * one step's worker, identified by (workflowInstanceId, stepName).
 *
 * `source` records provenance: 'persisted' when the prompt was written to the
 * step_started payload at emit time (all runs after prompt persistence
 * landed); 'recovered' when it was best-effort extracted from a stored or
 * on-disk transcript for a pre-persistence run; null (with prompt null) when
 * neither path produced anything — the UI must label recovered prompts and
 * render an explicit empty state for null, never invent data.
 */
export interface StepPromptView {
  workflowInstanceId: string
  stepName: string
  prompt: string | null
  source: 'persisted' | 'recovered' | null
}

/**
 * Wire shape for one primitive row, returned by GET /view/primitives and as
 * the identity section of GET /view/primitives/:name. `executor` states WHO
 * runs the primitive: an agent Worker, deterministic shell-outs, or a human.
 */
export interface PrimitiveSummary {
  name: string
  description: string
  /** Trace phase its Step spans carry, or null (awaitHuman emits no spans). */
  phase: string | null
  executor: 'agent' | 'shell' | 'human'
}

/**
 * One shell tool observed for a deterministic primitive's phase, derived from
 * recent `tool_invoked` trace events (runTool writes one per invocation).
 * Empirical, never declared — absence means "not observed", not "forbidden".
 */
export interface PrimitiveObservedTool {
  tool: string
  count: number
  /** ISO-8601 timestamp of the most recent invocation in the window. */
  lastInvokedAt: string
}

/**
 * One Step span in a primitive's run history, returned newest-first by
 * GET /view/primitives/:name. A span that is a Session (runAgent /
 * behaviourVerify) carries workerName + claudeSessionId; non-LLM spans have
 * neither.
 */
export interface PrimitiveRun {
  stepName: string
  workflowInstanceId: string
  outcome: string
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  taskId: string | null
  originId: string | null
  workerName: string | null
  claudeSessionId: string | null
}

/**
 * One awaiting-human park — awaitHuman's history rows. It parks before any
 * span opens, so its history is action-queue rows, never fabricated spans.
 */
export interface PrimitivePark {
  taskId: string | null
  stepName: string | null
  parkedAt: string
  leaseOwner: string | null
}

/**
 * Wire shape returned by GET /view/primitives/:name — the per-primitive
 * facet: identity, tool surface (declared Worker profiles OR observed shell
 * tools, never conflated), honest caveats, and the recent-N run history.
 * Aggregates are window-scoped by design: `window` names the N the runs
 * cover ("last N runs", not all-time).
 */
export interface PrimitiveDetail {
  primitive: PrimitiveSummary
  workers: PrimitiveWorkerProfile[]
  observedTools: PrimitiveObservedTool[]
  caveats: string[]
  runs: PrimitiveRun[]
  parks: PrimitivePark[]
  window: number
}

/** Wire shape returned by GET /view/framework-update. */
export interface FrameworkUpdateState {
  installed: string
  latest: string
  available: boolean
  /** ISO-8601 timestamp of the last successful check, or null before the first poll completes. */
  checkedAt: string | null
  releaseUrl: string | null
  /**
   * True when the running mars is a compiled prod binary that can be replaced
   * in-place by the self-update endpoint. False for dev (tsx wrapper) installs
   * where the Update-now button should be disabled.
   */
  selfUpdatable: boolean
}

/** Wire shape returned by GET /view/proposals for a single draft proposal. */
export interface DraftFeature {
  id: string
  title: string
  problem: string
  solution: string
  status: string
  source: ProposalSource
  createdAt: number
  updatedAt: number
  acceptanceCount: number
  /** Ordered list of user story texts for this proposal. Empty when none have been added. */
  userStories: string[]
  /**
   * Structured lever binding from ADR-0092. Non-null only for reflection-
   * sourced proposals created after the binding feature. Null means the
   * proposal predates the binding feature or was created by another source.
   */
  suggestionOutcome: ReflectionSuggestionOutcome
}

/** Wire shape returned by GET /view/proposals for a single stale-worktree alert. */
export interface StaleWorktreeAlert {
  taskId: string
  status: string
  ageHours: number
  updatedAt: string
  prompt: string
  error: string | null
  branch: string | null
  blockerTaskId: string | null
}

/**
 * One dissonant tool call — a call whose stated intent diverged from its
 * actual outcome, flagged by the reflection pipeline.
 */
export interface ReflectionDissonantCall {
  taskId: string | null
  eventIndex: number
  tool: string
  statedIntent: string
  actualOutcome: string
  severity: string
  evidence: string
}

/** One verify mismatch — a task that claimed success but the verify step disagreed. */
export interface ReflectionVerifyMismatch {
  taskId: string
  claimed: string
  actual: string
  severity: string
}

/** One thrashing pattern detected in the arc. */
export interface ReflectionThrashingPattern {
  pattern: string
  occurrences: number
  evidence: string
}

/**
 * Summary row for GET /view/deep-reflections — one entry per arc report file,
 * newest-first. Includes only the headline counts so the list view is cheap.
 */
export interface DeepReflectionSummary {
  originId: string
  recordedAt: string
  status: string
  totalToolCalls: number
  dissonantCallCount: number
  verifyMismatchCount: number
  thrashingPatternCount: number
  verdictResult: { saved: number; absorbed: number; dropped: number }
}

/**
 * One record in the lever-apply history returned as part of an enriched lever
 * outcome. Persisted to .mars/lever-apply-history.jsonl by the HTTP
 * POST /lever-apply endpoint.
 */
export interface LeverApplyHistoryEntry {
  appliedAt: string
  leverId: string
  fromValue: string | null
  toValue: string
  findingId?: string
}

/**
 * Enriched outcome served to the UI. For a `lever` outcome the entry's
 * `family`, `gesture`, `scope`, `appliesWithoutRestart`, and `history` are
 * looked up from the live lever registry and history store at serve time. For
 * a `leverGap` outcome they come directly from the model output.
 * `null` means the suggestion predates the binding feature.
 */
export type ReflectionSuggestionOutcome =
  | {
      type: 'lever'
      lever: {
        id: string
        family: string
        scope: string
        currentValue: string | null
        proposedValue: string
        gesture: string | null
        appliesWithoutRestart: boolean
        /** History of prior applications of this lever, newest-first. */
        history: LeverApplyHistoryEntry[]
      }
    }
  | {
      type: 'leverGap'
      leverGap: {
        proposedLeverId: string
        family: string
        whatItWouldControl: string
      }
    }
  | null

/**
 * Full report returned by GET /view/deep-reflections/:originId — includes the
 * complete report body for the detail view. `report` is null when `status` is
 * not 'complete' (pending / error / partial reports).
 */
export interface DeepReflectionDetail extends DeepReflectionSummary {
  sourceTaskId: string | null
  autoRunReflect: 'on' | 'off'
  report: {
    summary: string
    rootCause: string
    toolCallStats: { total: number; byName: Record<string, number> }
    dissonantCalls: ReflectionDissonantCall[]
    verifyMismatch: ReflectionVerifyMismatch | null
    verifyMismatches: ReflectionVerifyMismatch[]
    thrashingPatterns: ReflectionThrashingPattern[]
    suggestions: Array<{
      title: string
      prompt: string
      rationale: string
      verdict: string
      targetId: string | null
      /** Structured lever binding — null means predates binding feature. */
      outcome: ReflectionSuggestionOutcome
    }>
  } | null
}

/**
 * Wire shape for GET /view/deep-reflections — the list response.
 */
export interface DeepReflectionsListResult {
  reports: DeepReflectionSummary[]
  /** Total number of .json files discovered in the deep-reflections directory, regardless of paging. */
  totalDiscovered: number
  /** Number of .json files that could not be read or parsed (malformed). */
  unreadableCount: number
  autoRunReflect: 'on' | 'off'
  lastReflectedAt: string | null
}

/**
 * Handlers the daemon supplies for each recovery verb the local HTTP server
 * exposes. Each should throw {@link RestartTaskError} (with `code` set to
 * `'NOT_FOUND'` or `'WRONG_STATUS'`) for known validation failures; any other
 * error surfaces as a 500.
 *
 * These back the `op`s declared in the error-kind registry: the read-only UI
 * resolves an action's `op` to one of these routes and the daemon — the single
 * writer — performs the state transition.
 */
export interface HttpServerDeps {
  /** Tear down + re-queue a task from setup (the `restart`/`requeue` verb). */
  restartTask: (id: string) => Promise<void>
  /** Resume a failed task on its existing worktree (the `continue` verb). */
  continueTask: (id: string) => Promise<void>
  /** Create a new task inheriting the superseded task's branch and prompt. */
  supersedeTask?: (id: string) => Promise<{ taskId: string }>
  /**
   * Re-verify and merge a task's existing branch without re-running the coder.
   * The branch must exist and be ahead of the integration branch; otherwise
   * throws {@link RemergeTaskError}.
   */
  remergeTask: (id: string) => Promise<void>
  /** Phantom-recover a blocked task: clear edges and flip it to failed. */
  unblockTask: (id: string) => Promise<void>
  /** Drop a task and its worktree permanently. */
  purgeTask: (id: string) => Promise<void>
  /** Remove a leftover worktree by its id (terminal/absent task). */
  pruneWorktree: (id: string) => Promise<void>
  /**
   * Dismiss a draft proposal: flip its status from `draft` → `dismissed` and
   * emit `proposal.dismissed`, which causes the action-queue projection to drop
   * the row. Throws when the proposal has dependent tasks (let the error
   * propagate to the existing `sendError` path so the UI surfaces it).
   */
  dismissProposal: (id: string) => Promise<void>
  /**
   * Acknowledge a daemon-died alert by deleting the crash marker file. The
   * derived `daemon-died` condition row disappears on the next action-queue read
   * because the crash marker is gone. Optional — when absent the endpoint returns
   * 501 Not Implemented (safe for test stubs that do not exercise this path).
   */
  dismissDaemonDied?: () => Promise<void>
  /**
   * Promote a fully-shaped draft proposal: flip its status from `draft` →
   * `prd-ready`, run the slicer to create tasks, and return the resulting
   * task IDs. Throws when the proposal is not in `draft` status or the
   * slicer fails — let the error propagate to the existing `sendError` path
   * so the UI surfaces the message instead of swallowing it.
   */
  promoteProposal: (id: string) => Promise<{ taskIds: string[] }>
  /**
   * Enqueue a mockup task for a proposal: creates a task with `workflow:
   * 'mockup'` and `parentProposalId: id`. Returns the created task ID.
   * Any proposal status is accepted (unlike promote which requires draft).
   * Optional for backwards compatibility with test stubs; defaults to a
   * `not implemented` error when absent.
   */
  mockupProposal?: (id: string) => Promise<{ taskId: string }>
  /**
   * Enqueue the proposal's work as a live task (`workflow: 'live'`), parking
   * it awaiting-human for the operator to implement directly in the worktree.
   * Optional for backwards compatibility with test stubs; defaults to a
   * `not implemented` error when absent.
   */
  implementLiveProposal?: (id: string) => Promise<{ taskId: string }>
  /**
   * Validate a task parked at the preview gate (status 'awaiting-validation'):
   * kill its dev server, mark it validated, and re-queue so the merge
   * continuation runs. Throws when the task is not awaiting validation.
   */
  validateTask: (id: string) => Promise<void>
  /**
   * Reject a task parked at the preview gate: kill its dev server, fail the
   * task (worktree preserved), and resolve the awaiting-validation action-queue
   * row. Throws when the task is not awaiting validation.
   */
  rejectTask: (id: string) => Promise<void>
  /**
   * Fast-forward (or cherry-pick) a task branch's ahead commits onto the
   * integration branch, then resolve the worktree-ahead action-queue row.
   * Throws when the task is not found (code: 'NOT_FOUND') or there are no
   * commits ahead (code: 'NO_COMMITS_AHEAD').
   */
  landWork: (id: string) => Promise<void>
  /**
   * Run a cheap Haiku investigation over the worktree diff, persist the result
   * onto the actionQueue item payload, and return the explanation text. Read-only:
   * never mutates the worktree. Concurrent calls for the same id must be
   * guarded by the implementation (skip if already running).
   */
  investigateWorktree: (id: string) => Promise<{ explanation: string }>
  /**
   * Run a one-shot Sonnet root-cause diagnosis on a failed task whose failure
   * signature has no registered recipe. Reads the worktree (if it still exists)
   * and the session trace as needed, persists the diagnosis onto the actionQueue item
   * payload, and returns the diagnosis text. Read-only: never mutates the
   * worktree. Concurrent calls for the same id must be guarded by the
   * implementation (skip if already running).
   */
  diagnoseFailure: (id: string) => Promise<{ diagnosis: string }>
  /** Process-level: re-exec the daemon itself. Resolves once the re-exec is
   * scheduled; the current process exits shortly after. */
  restartDaemon: () => Promise<void>
  /**
   * Batch continue: resume every failed task that carries the daemon-killed
   * failure signature via the continue path, preserving existing worktrees
   * and commits. Tasks with no resumable state degrade to restart.
   * Returns a split of continued / degraded / skipped IDs.
   */
  continueAllDaemonKilled: () => Promise<{ continued: string[]; degraded: string[]; skipped: string[] }>
  /** Returns `true` while the daemon is accepting work (draining → `false`). */
  isAcceptingWork: () => boolean
  /** Returns the number of tasks currently dispatched and in flight. Used by the self-update drain gate. */
  inFlightCount: () => number
  /**
   * Run the reflect flow (load recent corpus, run reflector, persist
   * suggestions) and close the open reflect-recommended action-queue row.
   * Returns the number of proposals raised.
   */
  runReflect: () => Promise<{ proposalsRaised: number }>
  /**
   * Execute a daemon self-update: download the latest release binary, verify
   * sha256, atomically swap it for the current binary, and re-exec the daemon.
   * Throws {@link SelfUpdateError} on every non-happy path.
   */
  selfUpdate: () => Promise<void>
  /**
   * Complete the current manual step of a live workflow. Transitions the task
   * from `awaiting-human` → `queued` (keeping the lease so the pipeline can
   * re-grant it when it parks at the next manual step). Idempotent: if the task
   * is already past `awaiting-human` (queued, running, etc.), returns
   * `{next: null}` without mutating anything. Throws with `code='NOT_FOUND'`
   * when the task does not exist, or `code='WRONG_STATUS'` when it is in a
   * terminal or incompatible state.
   *
   * `degraded`/`anchorRef` mirror the CLI's `mars step done` surface (see
   * `handleStepDone` in server.ts): `degraded: true` means the step closed
   * via the Path 2 re-queue fallback (the daemon restarted between park and
   * this call) rather than resuming the in-process workflow, and
   * `anchorRef` — when non-null — names the branch-tip ref the fallback
   * anchored as a precaution before re-queuing. Both are optional so
   * existing stubs that only return `{next: null}` keep type-checking.
   */
  stepDone: (
    id: string,
  ) => Promise<{ next: string | null; degraded?: boolean; anchorRef?: string | null }>
  /**
   * Snooze an action-queue item until the given ISO-8601 timestamp.
   * While snoozed the item is excluded from the open view and chat segments.
   * Once the timestamp is in the past the item reappears automatically.
   * Throws `ActionQueueItemNotFoundError` when the id does not resolve to a
   * stored row (derived condition kinds have no stored row). Throws when
   * `until` is not a valid ISO-8601 string.
   */
  snoozeItem: (id: string, until: string) => Promise<void>
  /**
   * Resolved recovery-recipe catalog (built-in seed + `.mars/recipes/`
   * overrides), loaded once at daemon start. Served verbatim by
   * `GET /recipes` so the actionQueue UI can name which recipe a recovery task
   * was dispatched under.
   */
  recipeCatalog: RecipeCatalog
  /**
   * The unified trace-event store, used by `GET /events` to back the
   * per-task lifecycle view in the actionQueue detail panel (and broader filters
   * in the dedicated Events tab).
   */
  traceStore: TraceEventStore
  /**
   * SSE hub for `GET /view/stream`. When provided, the stream endpoint
   * registers each connecting client here and delivers invalidation events
   * whenever the daemon mutates a store. Omitting this dep disables fan-out
   * (the endpoint still serves the greeting but broadcasts are no-ops).
   *
   * Stream fan-out is a transport concern, not a read use-case, so it stays on
   * the HTTP transport's deps rather than on {@link AppServices}.
   */
  viewStreamHub?: ViewStreamHub
  /**
   * The daemon's in-process event bus, narrowed to the one gesture a transport
   * needs: asking for a view refresh. Mutation routes below emit a
   * `view.*-invalidated` kind rather than reaching into {@link viewStreamHub}
   * — `registerViewInvalidation` is the only thing that broadcasts.
   * Omitting this dep makes those refresh requests no-ops.
   */
  bus?: ViewInvalidationBus
  /**
   * The in-process application-service layer (ADR-0055). Every read route below
   * resolves to one named function on this object; the daemon constructs it once
   * (over its trace store + alert sources) and a future non-daemon consumer can
   * build its own. The HTTP server is a thin transport over these use-cases — it
   * never re-implements projection or enrichment logic.
   */
  appServices: AppServices
  /** Chat runner — manages in-flight `claude -p` runs for chat threads. */
  chatRunner: ChatRunner
  /**
   * Per-thread `UIMessageChunk` source backing `GET /chat/threads/:id/ui-stream`.
   * Optional so unit tests that build a bare deps object (and never exercise the
   * stream route) need not construct one — the route then serves 204. In the
   * daemon this is the SAME hub instance injected into the {@link ChatRunner}.
   */
  chatStreamHub?: ChatStreamHub
  /**
   * Returns the latest deployment record for the given task, or `null` when no
   * deployment has been written for it. Used by `GET /deployments/:taskId/logs`.
   * Optional: when omitted the endpoint returns 503 Service Unavailable.
   */
  getLatestDeployment?: (taskId: string) => Promise<import('../store/task-store').TaskDeployment | null>
  getLiveAgentsRoster?: () => import('./live-agents-roster').AgentRosterEntry[]
  /**
   * Returns the live implement-semaphore state the Steward page displays.
   * Optional — when absent the endpoint still serves DB-derived data and
   * marks liveCap / isPaused as -1 / false (daemon not wired up yet).
   */
  getStewardRuntimeState?: () => { liveCap: number; baselineCap: number; isPaused: boolean }
  /**
   * Set the implement worker-pool cap to `cap` in the live semaphore.
   * Called by the `steward-restore-worker-cap` preloaded-verb handler so
   * the operator can undo an autonomous dial from the Notice's revert offer.
   * Optional — when absent the verb handler returns 501 Not Implemented.
   */
  setImplementWorkerCap?: (cap: number) => void
  /**
   * Returns the daemon's git SHAs for the code-drift signal. Used by
   * `GET /view/daemon-version` so the UI server's skew detector can
   * distinguish "daemon running older code" from "route not found".
   *
   * Optional — when absent the endpoint returns `{ sourceSha: null, currentSha: null, isStale: false }`.
   * This keeps the behaviour safe on test setups that build a minimal deps object.
   */
  getDaemonShas?: () => { sourceSha: string | null; currentSha: string | null; isStale: boolean }
  /**
   * Return cost-per-merged-task KPI data for a given window.
   * Optional — when absent the `GET /kpi/cost-per-merged-task` endpoint
   * returns 503 Service Unavailable (daemon not wired up yet or running in
   * read-only test mode).
   */
  getCostPerMergedTaskKpi?: (opts: { windowDays: number }) => Promise<import('../lib/kpi/cost-per-merged-task').CostPerMergedTaskKpi>
  /**
   * Suspend dispatch for `reason`. First-cause wins: if dispatch is already
   * paused this returns false (preserving the original reason). Optional —
   * when absent, POST /operator/dispatch returns 503.
   */
  pauseDispatch?: (reason: PauseReason, detail?: string) => boolean
  /**
   * Resume dispatch. For a 'storm' pause this also clears the durable breaker
   * flag; for other pause kinds it simply un-pauses. Optional — when absent,
   * POST /operator/dispatch returns 503.
   */
  resumeDispatch?: () => void
  /** Read the live in-memory dispatch-pause state. When absent, GET /view/operator
   * falls back to reading the persisted `paused` flag from daemon.json. */
  getPauseState?: () => DispatchPauseState
  /**
   * Clear the persisted signature-storm `tripped` flag so a subsequent daemon
   * restart does not re-pause a queue the operator deliberately resumed.
   * Optional — omitted from test stubs.
   */
  resetSignatureStorm?: () => Promise<void>
  /**
   * Kick the drain loop after a resume so queued tasks are picked up immediately.
   * Optional — omitted from test stubs.
   */
  drainDispatch?: () => void
  /**
   * Raise a `task.question` outbox event for `id`, converted by the
   * question-raise subscriber into a `coder-question` action-queue item.
   * Backs `POST /tasks/:id/question` — the daemon-owned write path that lets
   * the CLI's `mars task ask` publish through the daemon's HTTP API instead
   * of opening a write transaction on the state client directly from the CLI
   * process (the daemon is meant to be the single writer). Optional — when
   * absent the endpoint returns 501 Not Implemented (safe for test stubs).
   */
  raiseTaskQuestion?: (id: string, question: string) => Promise<void>
}

export interface HttpServerHandle {
  /** The OS-assigned port the server is listening on. */
  port: number
  /** The address the server is bound to (always `'127.0.0.1'`). */
  address: string
  close: () => Promise<void>
}

/**
 * Start a local HTTP server bound to `127.0.0.1` only. Route registration
 * (every `GET`/`POST`/`DELETE` handler) lives in `registerRoutes`
 * (`routes.ts`); this function owns only the socket lifecycle — binding an
 * OS-assigned port, listening, and a clean close() that force-ends any
 * still-open keep-alive connections (e.g. `/view/stream` SSE clients).
 *
 * Callers discover the port via the returned {@link HttpServerHandle}, which
 * the daemon also writes to `.mars/http.port` for the read-only UI to read.
 */
export const startHttpServer = async (
  deps: HttpServerDeps,
): Promise<HttpServerHandle> => {
  const { listener, openSockets } = registerRoutes(deps)
  const server: Server = createServer(listener)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Bind to 127.0.0.1 — loopback only; never reachable from another host.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('unexpected HTTP server address type after listen()')
  }

  const port = addr.port
  const address = addr.address

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.once('close', () => openSockets.delete(socket))
  })

  return {
    port,
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        // Force-end any still-open sockets (e.g. keep-alive /view/stream
        // clients) so close() resolves promptly instead of waiting for a
        // client that will never disconnect on its own.
        for (const socket of openSockets) socket.end()
      }),
  }
}
