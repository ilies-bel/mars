import { createServer, type Server } from 'node:http'
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FAILURE_KINDS } from '../lib/failure-kinds'
import { getProvider } from '../lib/deployment/registry'
import type { PrimitiveWorkerProfile } from '../lib/primitive-catalog'
import type { RecipeCatalog } from '../lib/recipes'
import { buildOriginTree } from '../lib/origin-tree'
import type { DerivedActionQueueFilter } from './view/action-queue'
import {
  cursorAfter,
  TRACE_EVENT_KINDS,
  type TraceEventFilter,
  type TraceEventKind,
  type TraceEventPhase,
  type TraceEventSeverity,
  type TraceEventStore,
} from '../lib/trace-events-store'
import { type KpiKey } from './kpi-store'
import type { RestartTaskError } from './restart-task'
import { SelfUpdateError, SELF_UPDATE_ERRORS } from './self-update'
import type { ViewStreamHub } from './view/stream-hub'
import type { LoadCorpusOptions } from '../lib/reflect-query'
import type { ProposalSource } from '../proposals'
import type { AppServices } from '../app-services'
import {
  getSetting,
  setSetting,
  RELEASE_NOTES_LAST_VIEWED_KEY,
} from '../lib/settings'
import { resolveStateClient } from '../store/state-client'
import {
  getNotificationsEnabled,
  setNotificationsEnabled,
  readDaemonHeartbeat,
} from '../store/state-store'
import {
  createThread,
  forkThread,
  toThreadApiView,
  updateThreadTitle,
  setMessageFeedback,
  clearMessageFeedback,
  getThread,
  getPreloadedResponse,
  closeSubthread,
  archiveSubthread,
  unarchiveSubthread,
  setThreadStatus,
  appendMessage,
} from '../lib/chat-store'
import { classifyMarsVerb } from '../lib/chat-mars-verbs'
import {
  assembleDelta,
  clampWywaDeltaLimit,
} from './view/wywa-delta'
import { listStewardLedgerFor, listStewardLedgerSince } from '../steward-ledger'
import type { ChatRunner, AttachmentInfo } from './chat-runner'
import type { ChatStreamHub, SeqChunk } from './chat-contracts'
import { listTasksForThread } from './chat-thread-tasks'
import { getRepoRoot } from '../context'
import { z } from 'zod'

// ── Chat upload constants ─────────────────────────────────────────────────────

/** Maximum allowed upload size (50 MiB). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** MIME types accepted by the upload route. */
const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // Audio
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  // Video
  'video/mp4',
  'video/quicktime',
  'video/webm',
])

/** Fallback extension when the filename carries none. */
const MIME_TO_EXT = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/wav', '.wav'],
  ['audio/webm', '.webm'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
])

const ChatThreadsQuerySchema = z.object({
  parentThreadId: z.string().trim().min(1).optional(),
  hasParent: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
})

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
   * Promote a fully-shaped draft proposal: flip its status from `draft` →
   * `queued` and enqueue it as a task. Throws when the proposal is not fully
   * shaped (missing title/problem/solution/user-stories) or not in `draft`
   * status — let the error propagate to the existing `sendError` path so the
   * UI surfaces it.
   */
  promoteProposal: (id: string) => Promise<void>
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
   * Batch restart: re-queue every failed task that carries the daemon-killed
   * failure signature. Returns the IDs that were re-queued.
   */
  restartAllDaemonKilled: () => Promise<string[]>
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
   * Set selfEvolve.autoTrigger=true in the daemon config (persisted to
   * daemon.json), then close the open reflect-recommended action-queue row
   * so the level-trigger is immediately cleared.
   */
  enableAutoReflect: () => Promise<void>
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
   */
  stepDone: (id: string) => Promise<{ next: string | null }>
  /**
   * Snooze an action-queue item until the given ISO-8601 timestamp.
   * While snoozed the item is excluded from the open view and chat segments.
   * Once the timestamp is in the past the item reappears automatically.
   * No-op when the item does not exist. Throws when `until` is not a valid
   * ISO-8601 string.
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
}

export interface HttpServerHandle {
  /** The OS-assigned port the server is listening on. */
  port: number
  /** The address the server is bound to (always `'127.0.0.1'`). */
  address: string
  close: () => Promise<void>
}

/** Detect a {@link RestartTaskError} from any caller without requiring a
 * direct `instanceof` check (avoids coupling the handler to the module
 * identity). We match on the well-typed `code` field that
 * `RestartTaskError` always sets.
 */
const isRestartTaskError = (
  err: unknown,
): err is RestartTaskError & { code: 'NOT_FOUND' | 'WRONG_STATUS' } => {
  if (!(err instanceof Error)) return false
  const code = (err as unknown as Record<string, unknown>).code
  return code === 'NOT_FOUND' || code === 'WRONG_STATUS'
}

const sendJson = (
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Map a thrown error onto the right HTTP status + JSON envelope. */
const sendError = (
  res: import('node:http').ServerResponse,
  err: unknown,
): void => {
  if (isRestartTaskError(err)) {
    if (err.code === 'NOT_FOUND') {
      sendJson(res, 404, { ok: false, error: err.message, errorCode: 'NOT_FOUND' })
    } else {
      sendJson(res, 409, { ok: false, error: err.message, errorCode: 'WRONG_STATUS' })
    }
    return
  }
  if (err instanceof SelfUpdateError) {
    const status =
      err.code === SELF_UPDATE_ERRORS.DEV_INSTALL ||
      err.code === SELF_UPDATE_ERRORS.SHA256_MISMATCH
        ? 422
        : err.code === SELF_UPDATE_ERRORS.TASKS_IN_FLIGHT ||
            err.code === SELF_UPDATE_ERRORS.NO_UPDATE_AVAILABLE
          ? 409
          : err.code === SELF_UPDATE_ERRORS.DOWNLOAD_FAILED
            ? 502
            : 500
    sendJson(res, status, { ok: false, error: err.message, errorCode: err.code })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  sendJson(res, 500, { ok: false, error: message })
}

/**
 * The per-entity action routes, keyed by the `op` the error-kind registry
 * declares. Each maps `POST /actions/:op/:id` to the matching daemon handler.
 * `restart-daemon` is handled separately (it has no `:id`).
 */
type EntityOp =
  | 'restart'
  | 'remerge'
  | 'unblock'
  | 'purge'
  | 'prune-worktree'
  | 'dismiss'
  | 'promote'
  | 'validate'
  | 'reject'
  | 'land-work'
  | 'archive-subthread'
  | 'unarchive-subthread'

const TRACE_EVENT_KIND_SET = new Set<TraceEventKind>(TRACE_EVENT_KINDS)
const TRACE_EVENT_SEVERITIES: readonly TraceEventSeverity[] = [
  'info',
  'warn',
  'error',
]
const TRACE_EVENT_PHASES: readonly TraceEventPhase[] = [
  'setup',
  'code',
  'verify',
  'merge',
  'reflect',
]

/** Floor + ceiling on the page size. Defaults mirror the public API doc. */
const EVENTS_DEFAULT_LIMIT = 200
const EVENTS_MAX_LIMIT = 1000

const filterKinds = (raw: string[]): TraceEventKind[] =>
  raw.filter((v): v is TraceEventKind =>
    TRACE_EVENT_KIND_SET.has(v as TraceEventKind),
  )

const filterSeverities = (raw: string[]): TraceEventSeverity[] =>
  raw.filter((v): v is TraceEventSeverity =>
    (TRACE_EVENT_SEVERITIES as readonly string[]).includes(v),
  )

const filterPhases = (raw: string[]): TraceEventPhase[] =>
  raw.filter((v): v is TraceEventPhase =>
    (TRACE_EVENT_PHASES as readonly string[]).includes(v),
  )

/** Build the `TraceEventFilter` from a parsed URL's search params. */
const parseEventsFilter = (params: URLSearchParams): TraceEventFilter => {
  const filter: TraceEventFilter = {}
  const taskId = params.get('taskId')
  if (taskId) filter.taskId = taskId
  const originId = params.get('originId')
  if (originId) filter.originId = originId
  const kinds = filterKinds(params.getAll('kind'))
  if (kinds.length > 0) filter.kind = kinds
  const severities = filterSeverities(params.getAll('severity'))
  if (severities.length > 0) filter.severity = severities
  const phases = filterPhases(params.getAll('phase'))
  if (phases.length > 0) filter.phase = phases
  const since = params.get('since')
  if (since) filter.sinceMs = Date.parse(since)
  const until = params.get('until')
  if (until) filter.untilMs = Date.parse(until)
  const q = params.get('q')
  if (q) filter.q = q
  const cursor = params.get('cursor')
  if (cursor) filter.cursor = cursor
  const limitRaw = params.get('limit')
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      filter.limit = Math.min(parsed, EVENTS_MAX_LIMIT)
    }
  }
  if (filter.limit === undefined) {
    filter.limit = EVENTS_DEFAULT_LIMIT
  }
  return filter
}

/**
 * Handle a `GET /events?...` request. Reads from the trace store with the
 * parsed filter, then attaches `nextCursor` (the cursor pointing one past
 * the last row) when the page is full — signalling more rows are available.
 */
const handleEventsRequest = async (
  url: string,
  store: TraceEventStore,
): Promise<{ events: unknown[]; nextCursor: string | null }> => {
  // `url` is the path+query (e.g. `/events?taskId=abc`). Wrap with a base
  // so URLSearchParams can be derived without re-parsing manually.
  const parsed = new URL(url, 'http://localhost')
  const filter = parseEventsFilter(parsed.searchParams)
  const events = await store.query(filter)
  const limit = filter.limit ?? EVENTS_DEFAULT_LIMIT
  const last = events.length === limit ? events[events.length - 1] : null
  const nextCursor = last ? cursorAfter(last) : null
  return { events, nextCursor }
}

/**
 * Start a local HTTP server bound to `127.0.0.1` only. Exposes:
 *
 *   GET  /failure-kinds          → the signature-keyed Failure-kind registry
 *   GET  /recipes                → the resolved recovery-recipe catalog
 *   GET  /events?...             → unified trace events (taskId, kind, etc.)
 *   GET  /origins/:taskId        → the origin tree for a task
 *   GET  /alerts                 → the arc-rooted Alert list (read aggregate)
 *   GET  /alerts/next            → the top Alert for the hero next-action shortcut
 *   GET  /alerts/:arcId          → the single arc-rooted Alert (or 404)
 *   POST /alerts/:arcId/thread   → pull an Alert into a chat thread ({ threadId })
 *   POST /actions/restart/:id    → re-queue a failed/daemon-killed task
 *   POST /actions/unblock/:id    → phantom-recover a blocked task
 *   POST /actions/purge/:id      → drop a task + worktree
 *   POST /actions/prune-worktree/:id → remove a stale worktree
 *   POST /actions/dismiss/:id    → dismiss a draft proposal (draft → dismissed)
 *   POST /actions/validate/:id   → approve a preview-gated task (→ merge)
 *   POST /actions/reject/:id     → reject a preview-gated task (→ failed)
 *   POST /actions/restart-daemon       → re-exec the daemon
 *   POST /actions/run-reflect          → run reflect flow + clear reflect-recommended row
 *   POST /actions/enable-auto-reflect  → set autoTrigger=true + clear reflect-recommended row
 *   POST /actions/land-work/:id        → merge ahead commits onto integration branch
 *
 * The server uses an OS-assigned port (port 0). Callers discover the port via
 * the returned {@link HttpServerHandle}, which the daemon also writes to
 * `.mars/http.port` for the read-only UI to read.
 */
export const startHttpServer = async (
  deps: HttpServerDeps,
): Promise<HttpServerHandle> => {
  const entityHandlers: Record<EntityOp, (id: string) => Promise<void>> = {
    restart: deps.restartTask,
    remerge: deps.remergeTask,
    unblock: deps.unblockTask,
    purge: deps.purgeTask,
    'prune-worktree': deps.pruneWorktree,
    dismiss: deps.dismissProposal,
    promote: deps.promoteProposal,
    validate: deps.validateTask,
    reject: deps.rejectTask,
    'land-work': deps.landWork,
    // The entityId here is the Subthread's own thread id, not a task or
    // proposal — these two verbs are how the archive prompt's chips act.
    'archive-subthread': archiveSubthread,
    'unarchive-subthread': unarchiveSubthread,
  }

  // Track live sockets so close() can force-end long-lived connections (e.g.
  // the /view/stream SSE channel) instead of hanging forever: Node's
  // server.close() stops accepting new connections but only invokes its
  // callback once every existing connection ends on its own, and a
  // keep-alive SSE client never ends one voluntarily.
  const openSockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((req, res) => {
    // GET /healthz — liveness probe. Pure read; no draining gate so the UI
    // correctly shows the daemon as live even while it is draining.
    if (req.method === 'GET' && req.url === '/healthz') {
      sendJson(res, 200, { ok: true })
      return
    }

    // GET /liveness — operator uptime probe. Returns { pid, bootTs, lastBeatTs,
    // uptimeMs, staleMs } when the heartbeat row exists so operators can confirm
    // the daemon is alive, how long it has been up, and how fresh its last beat is.
    // Returns 503 { reason: 'no-heartbeat' } before the heartbeat writer has
    // written its first row (daemon still starting, or heartbeat writer failed).
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/liveness') {
      readDaemonHeartbeat(resolveStateClient())
        .then((hb) => {
          if (hb === null) {
            sendJson(res, 503, { reason: 'no-heartbeat' })
            return
          }
          const now = Date.now()
          sendJson(res, 200, {
            pid: hb.pid,
            bootTs: hb.bootTs,
            lastBeatTs: hb.lastBeatTs,
            uptimeMs: now - hb.bootTs,
            staleMs: now - hb.lastBeatTs,
          })
        })
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /failure-kinds — the signature-keyed Failure-kind registry (ADR-0042,
    // superseding ADR-0035's `/error-kinds`). Serves one record per known
    // `<failingStep>/<error-class>` signature bundling its human reason, recipe
    // reference, and recovery action menu. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/failure-kinds') {
      sendJson(res, 200, { ok: true, failureKinds: FAILURE_KINDS })
      return
    }

    // GET /failure-kinds/learned-recipes — list all operator-taught auto-run
    // rules (signature → op). Used by the UI's un-teach affordance and the
    // WYWA delta. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/failure-kinds/learned-recipes') {
      import('../lib/learned-recipes.js')
        .then((m) => m.listLearnedRecipes())
        .then((recipes) => sendJson(res, 200, { ok: true, learnedRecipes: recipes }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /agents/live — live-agents roster built from in-flight task snapshots
    // and reflector lifecycle entries. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/agents/live') {
      const agents = deps.getLiveAgentsRoster?.() ?? []
      sendJson(res, 200, { agents })
      return
    }

    // POST /failure-kinds/:signature/recipe — teach an auto-run op for a
    // failure signature. Body: { op: string }. The op is stored globally; the
    // next occurrence of the same signature auto-runs it instead of raising a
    // card. Idempotent: re-posting replaces the existing op.
    {
      const teachMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/failure-kinds\/([^/?]+)\/recipe$/)
          : null
      if (teachMatch && teachMatch[1]) {
        const signature = decodeURIComponent(teachMatch[1])
        let rawBody = ''
        req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
        req.on('end', () => {
          let body: unknown
          try {
            body = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const parsed = z.object({ op: z.string().min(1) }).safeParse(body)
          if (!parsed.success) {
            sendJson(res, 400, { error: 'op is required and must be a non-empty string' })
            return
          }
          import('../lib/learned-recipes.js')
            .then((m) => m.teachRecipe(signature, parsed.data.op))
            .then(() => sendJson(res, 200, { ok: true }))
            .catch((err: unknown) => sendError(res, err))
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }

    // DELETE /failure-kinds/:signature/recipe — remove the taught auto-run rule
    // for a failure signature (un-teach). No-op when no rule is stored. Used
    // by the detail-pane un-teach affordance.
    {
      const unlearnMatch =
        req.method === 'DELETE' && req.url
          ? req.url.match(/^\/failure-kinds\/([^/?]+)\/recipe$/)
          : null
      if (unlearnMatch && unlearnMatch[1]) {
        const signature = decodeURIComponent(unlearnMatch[1])
        import('../lib/learned-recipes.js')
          .then((m) => m.unlearnRecipe(signature))
          .then(() => sendJson(res, 200, { ok: true }))
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /recipes — the resolved recovery-recipe catalog. Same lifecycle
    // as /failure-reasons: loaded once at boot from
    // `src/core/recipes/built-in/*.md` plus `.mars/recipes/*.md`
    // overrides; consumers re-`mars daemon reload` to pick up edits. Pure
    // read; no draining gate. No recipes are dispatched in slice E — this
    // endpoint exists for symmetry and so the actionQueue UI can name them.
    if (req.method === 'GET' && req.url === '/recipes') {
      sendJson(res, 200, deps.recipeCatalog.list())
      return
    }

    // GET /events — unified trace events. Supports multi-filter querying
    // (taskId, originId, kind[], severity[], phase[], since, until, q) plus
    // cursor pagination. Newest-first ordering. The per-task actionQueue panel
    // always passes `?taskId=...&limit=50`; the dedicated Events tab uses
    // the broader filter surface. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/events')) {
      handleEventsRequest(req.url, deps.traceStore)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /origins/:taskId — origin tree for a task. Single-node tree when
    // the task has no known ancestry. Pure read; no draining gate.
    {
      const originsMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/origins\/([^/?]+)(?:\?.*)?$/)
          : null
      if (originsMatch && originsMatch[1]) {
        const taskId = decodeURIComponent(originsMatch[1])
        buildOriginTree(taskId)
          .then((tree) => sendJson(res, 200, tree))
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /kpis/:key/arcs — per-arc breakdown for a single KPI key. Uses the
    // same window as the latest persisted snapshot so the arc list reconciles
    // with the headline value. Pure read; no draining gate. Must be matched
    // before /kpis/series and /kpis so the more-specific path wins.
    {
      const kpiArcsMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/kpis\/([^/?]+)\/arcs(\?.*)?$/)
          : null
      if (kpiArcsMatch && kpiArcsMatch[1]) {
        const key = decodeURIComponent(kpiArcsMatch[1]) as KpiKey
        const validKeys: readonly string[] = [
          'cost_per_arc',
          'failure_rate',
          'autonomous_completion_rate',
          'recovery_success_rate',
        ]
        if (!validKeys.includes(key)) {
          sendJson(res, 400, { error: `Unknown KPI key: ${key}` })
        } else {
          deps.appServices
            .listKpiArcs(key)
            .then((result) => sendJson(res, 200, result))
            .catch((err: unknown) => sendError(res, err))
        }
        return
      }
    }

    // GET /kpis/series?limit=N — per-column KPI time-series (oldest-first, last N
    // snapshots). Pure read; no draining gate. Must be matched before /kpis so
    // the more-specific path wins.
    if (req.method === 'GET' && /^\/kpis\/series(\?.*)?$/.test(req.url ?? '')) {
      const qs = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : ''
      const rawLimit = new URLSearchParams(qs).get('limit')
      const parsedLimit = rawLimit !== null ? Number(rawLimit) : 90
      const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.floor(parsedLimit) : 90
      deps.appServices
        .listKpisSeries(limit)
        .then((series) => sendJson(res, 200, { series }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /kpis — the four-KPI vector (ADR-0040, the harness-health KPI ADR
    // that was originally numbered 0038 on main while this branch held that
    // number for the recovery-tasks-are-leaf-nodes ADR — renumbered to 0040
    // during the merge). Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/kpis') {
      deps.appServices
        .listKpis()
        .then((kpis) => sendJson(res, 200, { kpis }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/tasks/:id — single task by id. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/tasks/')) {
      const id = decodeURIComponent(req.url.slice('/view/tasks/'.length))
      if (!id) {
        sendJson(res, 400, { error: 'id is required' })
        return
      }
      deps.appServices
        .viewTask(id)
        .then((result) => {
          if (result) {
            sendJson(res, 200, result)
          } else {
            sendJson(res, 404, { error: 'not_found', id })
          }
        })
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/tasks — full task list from the daemon's DomainTaskStore.
    // The read-only UI proxies this endpoint instead of opening the DB
    // directly, so the daemon is the single reader of its own database.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/tasks') {
      deps.appServices
        .viewTasks()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/glossary — the repo's domain glossary (CONTEXT.md), parsed and
    // returned as a structured term list. Each term includes its definition and
    // any avoid-aliases. Returns { terms: [{ term, definition, avoid }] }. Empty
    // terms array when CONTEXT.md does not exist. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/glossary') {
      deps.appServices
        .viewGlossary()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/skills — the consumer repo's .claude/skills/* catalog. Each
    // skill is represented by name, one-line description (from SKILL.md
    // frontmatter), and path. Skills whose SKILL.md is malformed are included
    // with an empty description rather than causing the route to fail. Returns
    // { skills: [{ name, description, path }] }. Empty array when no skills
    // directory exists. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/skills') {
      deps.appServices
        .viewSkills()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/adrs — list docs/adr/*.md as {number,title,slug}, newest first.
    // Returns { adrs: [] } when docs/adr/ does not exist. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/adrs') {
      const adrDir = join(getRepoRoot(), 'docs', 'adr')
      const ADR_FILENAME_RE = /^(\d{4})-([a-z0-9-]+)\.md$/
      readdir(adrDir)
        .then(async (entries) => {
          const adrFiles = entries.filter((n) => ADR_FILENAME_RE.test(n)).sort().reverse()
          const adrs: Array<{ number: number; title: string; slug: string }> = []
          for (const name of adrFiles) {
            const match = ADR_FILENAME_RE.exec(name)
            if (!match) continue
            const number = Number.parseInt(match[1], 10)
            const slug = match[2] ?? name
            const text = await readFile(join(adrDir, name), 'utf8').catch(() => '')
            const firstLine = text.split('\n', 1)[0] ?? ''
            const title = firstLine.replace(/^#\s*/, '').trim() || slug
            adrs.push({ number, title, slug })
          }
          sendJson(res, 200, { adrs })
        })
        .catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            sendJson(res, 200, { adrs: [] })
            return
          }
          sendError(res, err)
        })
      return
    }

    // GET /view/stream — long-lived Server-Sent Events channel. Emits one
    // named event per channel ('tasks'|'progress'|'action-queue'|'proposals'|'kpis')
    // whenever the daemon mutates the corresponding store. The UI subscribes
    // to avoid polling and to get the same liveness it previously had from
    // watching the DB file. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Send the hello greeting so the client knows the stream is live.
      res.write('event: hello\ndata: {}\n\n')

      // Send a periodic SSE comment (`: ping`) every 30 s so clients can
      // distinguish "healthy but quiet" from a half-open / dead socket.
      const heartbeatInterval = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(heartbeatInterval)
        }
      }, 30_000)

      const hub = deps.viewStreamHub
      if (hub) {
        const client = hub.add(res)
        const cleanup = (): void => {
          hub.remove(client)
          clearInterval(heartbeatInterval)
        }
        req.on('close', cleanup)
        req.on('error', cleanup)
      } else {
        const cleanup = (): void => clearInterval(heartbeatInterval)
        req.on('close', cleanup)
        req.on('error', cleanup)
      }
      return
    }

    // GET /view/progress — Progress-tab view.
    // Returns { tasks: ProgressTask[], proposals: ProposalNode[] } with
    // cluster tags already attached. All failed tasks are always in scope.
    // The UI server proxies this endpoint rather than computing the view
    // locally. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/progress')) {
      deps.appServices
        .viewProgress()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/runs/:taskId — full run timeline for a task: all workflow runs
    // (identified by workflowInstanceId) in chronological order, each with its
    // ordered step list. Each step surfaces status, duration, token usage, the
    // Claude session id (transcript reference), and failure reason. Pure read;
    // no draining gate.
    {
      const runsMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/view\/runs\/([^/?]+)(?:\?.*)?$/)
          : null
      if (runsMatch && runsMatch[1]) {
        const taskId = decodeURIComponent(runsMatch[1])
        deps.appServices
          .viewRunTimeline(taskId)
          .then((timeline) => sendJson(res, 200, timeline))
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /view/step-spans?originId=<id>&taskId=<id> — step timeline for a task arc.
    // Pairs step_started / step_ended events from the trace store by
    // (workflowInstanceId, stepName). Steps with no matching step_ended have
    // outcome='running'. Ordered by startedAt ascending (workflow order).
    // At least one of originId or taskId must be supplied; both may be supplied
    // together to narrow results further. The daemon is the sole reader of the
    // trace store; the UI proxies here rather than opening the trace store
    // directly. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/step-spans')) {
      const parsed = new URL(req.url, 'http://localhost')
      const originId = parsed.searchParams.get('originId') ?? undefined
      const taskId = parsed.searchParams.get('taskId') ?? undefined
      if (originId === '') {
        sendJson(res, 400, { error: 'originId must not be empty when supplied' })
        return
      }
      if (taskId === '') {
        sendJson(res, 400, { error: 'taskId must not be empty when supplied' })
        return
      }
      if (!originId && !taskId) {
        sendJson(res, 400, { error: 'at least one of originId or taskId query parameters is required' })
        return
      }
      deps.appServices
        .viewStepSpans({ originId, taskId })
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/step-prompt?workflowInstanceId=<id>&stepName=<name> — the
    // composed prompt sent to one step's worker. Persisted prompts come from
    // the step_started payload; pre-persistence runs fall back to best-effort
    // transcript recovery (source='recovered'). Fetched lazily by the Studio
    // Show-trace panel — never inlined into span/timeline lists. Pure read;
    // no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/step-prompt')) {
      const parsed = new URL(req.url, 'http://localhost')
      const workflowInstanceId = parsed.searchParams.get('workflowInstanceId')
      const stepName = parsed.searchParams.get('stepName')
      if (!workflowInstanceId) {
        sendJson(res, 400, { error: 'workflowInstanceId query parameter is required' })
        return
      }
      if (!stepName) {
        sendJson(res, 400, { error: 'stepName query parameter is required' })
        return
      }
      deps.appServices
        .viewStepPrompt({ workflowInstanceId, stepName })
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/agent-tool-calls?taskId=<id>&sessionId=<id> — the Coder's own
    // tool invocations for a specific Claude session, extracted from the stored
    // task_transcripts chunks. Used by the Studio step card to surface agent
    // tool activity alongside the orchestrator's shell invocations. Pure read;
    // no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/agent-tool-calls')) {
      const parsed = new URL(req.url, 'http://localhost')
      const taskId = parsed.searchParams.get('taskId')
      const sessionId = parsed.searchParams.get('sessionId')
      if (!taskId) {
        sendJson(res, 400, { error: 'taskId query parameter is required' })
        return
      }
      if (!sessionId) {
        sendJson(res, 400, { error: 'sessionId query parameter is required' })
        return
      }
      deps.appServices
        .viewAgentToolCalls(taskId, sessionId)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/primitives — the fixed catalog of workflow primitives
    // (setupWorktree, runAgent, verify, behaviourVerify, merge, awaitHuman):
    // name, one-line description, trace phase, and executor. Pure read; no
    // draining gate.
    if (req.method === 'GET' && req.url === '/view/primitives') {
      deps.appServices
        .viewPrimitives()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/primitives/:name?limit=N — the per-primitive facet: identity,
    // tool surface (declared Worker Authorization profiles for agent
    // primitives, observed tool_invoked shell tools for deterministic ones,
    // an explicit "human step" shape for awaitHuman), and the recent-N run
    // history of Step spans (default 50, newest first). 404 on an unknown
    // primitive name. Pure read; no draining gate.
    {
      const primitiveMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/view\/primitives\/([^/?]+)(?:\?.*)?$/)
          : null
      if (primitiveMatch && primitiveMatch[1]) {
        const name = decodeURIComponent(primitiveMatch[1])
        const parsed = new URL(req.url!, 'http://localhost')
        const limitRaw = parsed.searchParams.get('limit')
        const limit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : undefined
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          sendJson(res, 400, { error: 'limit must be a positive integer' })
          return
        }
        deps.appServices
          .viewPrimitive({ name, limit })
          .then((detail) => {
            if (detail === null) {
              sendJson(res, 404, { ok: false, error: `Unknown primitive '${name}'` })
            } else {
              sendJson(res, 200, detail)
            }
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /view/sessions?agentName=<name> — session feed for a given worker,
    // derived from step_started / step_ended trace events. The read-only UI
    // proxies this endpoint instead of opening the trace store directly.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/sessions')) {
      const parsed = new URL(req.url, 'http://localhost')
      const agentName = parsed.searchParams.get('agentName')
      if (!agentName) {
        sendJson(res, 400, { error: 'agentName query parameter is required' })
        return
      }
      deps.appServices
        .viewSessions(agentName)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/framework-update — returns the update-poller cache from
    // .mars/update.json, or a safe fallback when the file does not exist yet.
    // The daemon is the sole writer of this cache; nothing else calls GitHub.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/framework-update') {
      deps.appServices
        .viewFrameworkUpdate()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/proposals — draft proposals + open stale-worktree alerts for
    // the proposals/alerts surface. The daemon is the sole reader of its own
    // DB; the UI server proxies this endpoint instead of querying mars.db
    // directly. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/proposals') {
      deps.appServices
        .viewProposals()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/proposal/:id — full Proposal record for the detail panel
    // lazy-load path. Returns 404 when the proposal does not exist.
    // Pure read; no draining gate.
    {
      const proposalMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/view\/proposal\/([^/?]+)(?:\?.*)?$/)
          : null
      if (proposalMatch && proposalMatch[1]) {
        const proposalId = decodeURIComponent(proposalMatch[1])
        deps.appServices.viewProposal(proposalId)
          .then((proposal) => {
            if (proposal === null) {
              sendJson(res, 404, { ok: false, error: `Proposal ${proposalId} not found` })
            } else {
              sendJson(res, 200, proposal)
            }
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /view/reflect?limit=N&since=ISO — recent task corpus data (entries +
    // cost summary). Wraps loadRecentTaskCorpus from reflect-query.ts so the
    // UI/daemon can surface what the CLI `mars reflect` reads. Pure read; no
    // draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/reflect')) {
      const parsed = new URL(req.url, 'http://localhost')
      const opts: LoadCorpusOptions = {}
      const limitRaw = parsed.searchParams.get('limit')
      if (limitRaw !== null) {
        const n = Number.parseInt(limitRaw, 10)
        if (Number.isFinite(n) && n > 0) opts.limit = n
      }
      const since = parsed.searchParams.get('since')
      if (since) opts.sinceIso = since
      deps.appServices
        .viewReflect(opts)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/steward — four-lane capability summary for the Steward page:
    // runtimeTuning (executing), workflowPatches (built/never invoked),
    // signatureStorm (live, currently tripped), agentSpec (declared/unbuilt).
    // Live semaphore state is injected by the daemon via getStewardRuntimeState.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/steward') {
      const runtime = deps.getStewardRuntimeState?.() ?? { liveCap: -1, baselineCap: -1, isPaused: false }
      deps.appServices
        .viewSteward(runtime)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/scorer-trend?workflow=<kind>&window=N — per-workflow Scorer
    // score trend (median + p90 over a trailing window, never a bare mean)
    // plus recent scorer_results rows (PRD 6cf85bc9). This is the queryable
    // surface Studio/the UI read for per-instance scores; rendering internals
    // stay out of scope. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/scorer-trend')) {
      const parsed = new URL(req.url, 'http://localhost')
      const opts: { workflow?: string; window?: number } = {}
      const workflow = parsed.searchParams.get('workflow')
      if (workflow) opts.workflow = workflow
      const windowRaw = parsed.searchParams.get('window')
      if (windowRaw !== null) {
        const n = Number.parseInt(windowRaw, 10)
        if (Number.isFinite(n) && n > 0) opts.window = n
      }
      deps.appServices
        .viewScorerTrend(opts)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/scorer-workflows — distinct workflow kinds that have at least one
    // recorded scorer_result, newest first (PRD 41aa2fb2). Pure read; no drain.
    if (req.method === 'GET' && req.url === '/view/scorer-workflows') {
      deps.appServices
        .viewScorerWorkflows()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/workflow-configs?workflow=<kind> — versioned workflow config
    // records for a given workflow kind (PRD 5b73d277). Returns {configs}
    // ordered by version desc. Missing workflow param → 400. Pure read.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/workflow-configs')) {
      const parsed = new URL(req.url, 'http://localhost')
      const workflow = parsed.searchParams.get('workflow')
      if (!workflow) {
        sendJson(res, 400, { error: 'workflow query param is required' })
        return
      }
      deps.appServices
        .viewWorkflowConfigs(workflow)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/promotion-ledger?workflow=<kind> — promotion gate decision
    // history (PRD 5b73d277). Omitting workflow returns entries across all
    // workflows, ordered by createdAt desc. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/promotion-ledger')) {
      const parsed = new URL(req.url, 'http://localhost')
      const workflow = parsed.searchParams.get('workflow') ?? undefined
      deps.appServices
        .viewPromotionLedger(workflow)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/loop-ledger?workflow=<kind>&limit=N — per-run score history
    // joining scorer_results with promotion-gate decisions (PRD 41aa2fb2,
    // Watchtower slice 6). workflow is required (400 if absent); limit is
    // clamped [1, 200], default 50. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/loop-ledger')) {
      const parsed = new URL(req.url, 'http://localhost')
      const workflow = parsed.searchParams.get('workflow')
      if (!workflow) {
        sendJson(res, 400, { error: 'workflow query param is required' })
        return
      }
      const limitRaw = parsed.searchParams.get('limit')
      let limit = 50
      if (limitRaw !== null) {
        const n = Number.parseInt(limitRaw, 10)
        if (Number.isFinite(n)) limit = Math.min(200, Math.max(1, n))
      }
      deps.appServices
        .viewLoopLedger(workflow, limit)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/arcs?limit=N&withTranscriptOnly=true|false — ranked arc
    // candidates for deep reflection. Wraps listDeepReflectArcCandidates from
    // deep-reflect-query.ts so the UI/daemon can surface what `mars arc reflect`
    // would operate on. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/arcs')) {
      const parsed = new URL(req.url, 'http://localhost')
      const opts: { limit?: number; withTranscriptOnly?: boolean } = {}
      const limitRaw = parsed.searchParams.get('limit')
      if (limitRaw !== null) {
        const n = Number.parseInt(limitRaw, 10)
        if (Number.isFinite(n) && n > 0) opts.limit = n
      }
      const withTranscriptOnlyRaw = parsed.searchParams.get('withTranscriptOnly')
      if (withTranscriptOnlyRaw !== null) {
        opts.withTranscriptOnly =
          withTranscriptOnlyRaw !== 'false' && withTranscriptOnlyRaw !== '0'
      }
      deps.appServices
        .viewArcs(opts)
        .then((candidates) => sendJson(res, 200, candidates))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/terminal-events — reverse-chronological feed of terminal-state
    // task moments (completed/failed/dropped). The read-only UI proxies this
    // endpoint instead of opening the DB directly, so the daemon is the single
    // reader of its own database. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/terminal-events') {
      deps.appServices
        .viewTerminalEvents()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/release-notes — reverse-chronological arc-grouped feed of
    // landed tasks (status='done'). Recovery/fix tasks are folded into their
    // origin arc entry. The UI server proxies this endpoint rather than
    // querying the DB directly. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/release-notes') {
      deps.appServices
        .viewReleaseNotes()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/auto-recipe-runs?since=<ISO>&limit=<n> — recent auto-executed
    // learned recipe runs, newest-first. Used by the WYWA delta panel to surface
    // actions the orchestrator took automatically while the operator was away.
    // `since` is an ISO-8601 lower bound (exclusive). `limit` defaults to 50.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/auto-recipe-runs')) {
      const parsed = new URL(req.url, 'http://localhost')
      const since = parsed.searchParams.get('since') ?? undefined
      const limitRaw = parsed.searchParams.get('limit')
      const limit =
        limitRaw !== null && Number.isFinite(Number.parseInt(limitRaw, 10))
          ? Math.min(Math.max(1, Number.parseInt(limitRaw, 10)), 200)
          : 50
      import('../lib/learned-recipes.js')
        .then((m) => m.listAutoRecipeRuns({ since, limit }))
        .then((runs) => sendJson(res, 200, { ok: true, autoRecipeRuns: runs }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/steward-ledger?targetKind=<kind>&targetId=<id> — immutable
    // Steward intervention evidence, newest first. Supplying a target pair
    // scopes the result to that exact task/arc/primitive; omitting both reads
    // the full ledger for the global timeline.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/steward-ledger')) {
      const parsed = new URL(req.url, 'http://localhost')
      const targetKind = parsed.searchParams.get('targetKind')
      const targetId = parsed.searchParams.get('targetId')
      if ((targetKind === null) !== (targetId === null)) {
        sendJson(res, 400, { error: 'targetKind and targetId must be supplied together' })
        return
      }
      const entries = targetKind !== null && targetId !== null
        ? listStewardLedgerFor(targetKind, targetId)
        : listStewardLedgerSince('0001-01-01T00:00:00.000Z')
      entries
        .then((rows) => sendJson(res, 200, { ok: true, entries: rows }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/wywa-delta?since=<ISO>&limit=<n> — unified "while you were away"
    // delta assembled from six existing stores: merged arcs (release notes),
    // recovery_spawned trace events, auto-recipe runs, throttled chat threads, and
    // evaporated chat threads, and Steward interventions. Newest-first, capped at
    // `limit` (default 30, max 100)
    // with `andMore` count. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/wywa-delta')) {
      const parsedUrl = new URL(req.url, 'http://localhost')
      const since = parsedUrl.searchParams.get('since') ?? null
      const limitRaw = parsedUrl.searchParams.get('limit')
      const limit = clampWywaDeltaLimit(
        limitRaw !== null ? Number.parseInt(limitRaw, 10) : null,
      )
      Promise.all([
        deps.appServices.viewReleaseNotes(),
        deps.traceStore.query({
          kind: ['recovery_spawned'],
          ...(since !== null ? { sinceMs: Date.parse(since) } : {}),
          limit: 200,
        }),
        import('../lib/learned-recipes.js').then((m) =>
          m.listAutoRecipeRuns({ since: since ?? undefined, limit: 200 }),
        ),
        import('../lib/chat-store.js').then((m) =>
          Promise.all([m.listClosedSubthreads(), m.listThreads()]),
        ),
        listStewardLedgerSince(since ?? '0001-01-01T00:00:00.000Z'),
      ])
        .then(([releaseNotes, recoveryEvents, autoRuns, [closedRaw, allThreads], stewardLedger]) => {
          const throttledThreads = allThreads
            .filter((t) => t.status === 'throttled')
            .map((t) => ({ id: t.id, updatedAt: new Date(t.updated_at).toISOString() }))

          const closedSubthreads = closedRaw
            .filter((t): t is typeof t & { closed_at: number } => t.closed_at !== null)
            .map((t) => ({ id: t.id, closedAt: new Date(t.closed_at).toISOString() }))

          const delta = assembleDelta({
            releaseNotes: releaseNotes.entries,
            recoveryEvents: recoveryEvents.map((ev) => ({
              timestamp: ev.timestamp,
              taskId: ev.taskId,
              originId: ev.originId,
            })),
            autoRuns,
            throttledThreads,
            closedSubthreads,
            stewardLedger,
            since,
            limit,
          })
          sendJson(res, 200, { ok: true, ...delta })
        })
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/action-queue/history?cursor=...&limit=... — resolved rows,
    // cursor-paged newest-first. Pure read; no draining gate.
    if (
      req.method === 'GET' &&
      req.url &&
      req.url.startsWith('/view/action-queue/history')
    ) {
      const parsed = new URL(req.url, 'http://localhost')
      const cursor = parsed.searchParams.get('cursor') ?? null
      const limitRaw = parsed.searchParams.get('limit')
      const limit =
        limitRaw !== null && Number.isFinite(Number.parseInt(limitRaw, 10))
          ? Math.min(Math.max(1, Number.parseInt(limitRaw, 10)), 200)
          : 50
      deps.appServices
        .viewActionQueueHistory({ cursor, limit })
        .then((result) => sendJson(res, 200, result))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/action-queue?filter=open|all — the full derived actionQueue view.
    // The action queue is a pure projection of entity state; the Invalidator is
    // the sole row-closer. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/action-queue')) {
      const parsed = new URL(req.url, 'http://localhost')
      const filterRaw = parsed.searchParams.get('filter')
      const filter: DerivedActionQueueFilter =
        filterRaw === 'all' ? filterRaw : 'open'
      deps.appServices
        .viewActionQueue(filter)
        .then((rows) => sendJson(res, 200, rows))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /alerts/next — the single top Alert the hero "next action" shortcut
    // grabs, or `{}` when none. Checked BEFORE the `/alerts/:arcId` param route
    // so the literal `next` segment is not captured as an arc id.
    if (req.method === 'GET' && req.url && req.url.match(/^\/alerts\/next(?:\?.*)?$/)) {
      deps.appServices
        .nextActionAlert()
        .then((alert) => sendJson(res, 200, alert ?? {}))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /alerts/:arcId/thread — pull an Alert into a chat thread (slice 4,
    // ADR-0048). Human-triggered: the operator clicked the Alert in the Bell or
    // the hero next-action shortcut. Dedups by arc (a re-click reuses the same
    // thread). Picking an Alert does NOT clear it from the Bell. Placed before
    // the POST-only guard / draining gate so it behaves like the notice ack — an
    // operator gesture on the read aggregate, not orchestrator work. Returns
    // `{ threadId }`, or 404 `{ threadId: null }` when the arc has no Alert.
    {
      const threadMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/alerts\/([^/?]+)\/thread(?:\?.*)?$/)
          : null
      if (threadMatch && threadMatch[1]) {
        const arcId = decodeURIComponent(threadMatch[1])
        deps.appServices
          .startThreadFromAlert(arcId)
          .then((result) => {
            if (result === null) {
              sendJson(res, 404, { threadId: null })
              return
            }
            sendJson(res, 200, result)
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /alerts/:arcId — the single arc-rooted Alert for one arc, or 404 when
    // no Alert applies. The Alert read aggregate is a PURE derivation over arc
    // state (ADR-0054); this handler never writes. Checked before the bare
    // `/alerts` so the `:arcId` form matches first.
    {
      const alertMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/alerts\/([^/?]+)(?:\?.*)?$/)
          : null
      if (alertMatch && alertMatch[1]) {
        const arcId = decodeURIComponent(alertMatch[1])
        deps.appServices
          .viewAlert(arcId)
          .then((alert) => {
            if (alert === null) {
              sendJson(res, 404, {
                ok: false,
                error: `no alert for arc ${arcId}`,
                errorCode: 'NOT_FOUND',
              })
              return
            }
            sendJson(res, 200, alert)
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /alerts — the full arc-rooted Alert list (failed arcs + open stale
    // worktrees). Pure derivation over arc state (ADR-0054); no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/alerts')) {
      deps.appServices
        .viewAlerts()
        .then((alerts) => sendJson(res, 200, alerts))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/release-notes-cursor — returns the last-viewed-release-notes
    // timestamp stored in app_settings, or null when never viewed.
    // POST /view/release-notes-cursor — stamps "now" as the last-viewed
    // timestamp (mark-viewed gesture). Handled here (before the POST-only
    // guard below) so both verbs are adjacent and the POST bypasses the
    // draining gate — this is a lightweight preference write, not task work.
    if (req.url === '/view/release-notes-cursor') {
      if (req.method === 'GET') {
        getSetting(resolveStateClient(), RELEASE_NOTES_LAST_VIEWED_KEY)
          .then((lastViewedAt) => sendJson(res, 200, { lastViewedAt }))
          .catch((err: unknown) => sendError(res, err))
        return
      }
      if (req.method === 'POST') {
        const now = new Date().toISOString()
        setSetting(resolveStateClient(), RELEASE_NOTES_LAST_VIEWED_KEY, now)
          .then(() => sendJson(res, 200, { lastViewedAt: now }))
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /preferences/notifications — returns { enabled: boolean } reflecting the
    // stored value (default true when unset). PUT /preferences/notifications —
    // accepts { enabled: boolean }, persists via setNotificationsEnabled, returns
    // the new state. Both verbs bypass the draining gate — lightweight preference
    // writes, not task work.
    if (req.url === '/preferences/notifications') {
      if (req.method === 'GET') {
        getNotificationsEnabled(resolveStateClient())
          .then((enabled) => sendJson(res, 200, { enabled }))
          .catch((err: unknown) => sendError(res, err))
        return
      }
      if (req.method === 'PUT') {
        let rawBody = ''
        req.on('data', (chunk: Buffer) => {
          rawBody += chunk.toString()
        })
        req.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const schema = z.object({ enabled: z.boolean() })
          const result = schema.safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, { ok: false, error: 'body must be { enabled: boolean }' })
            return
          }
          const { enabled } = result.data
          setNotificationsEnabled(resolveStateClient(), enabled)
            .then(() => sendJson(res, 200, { enabled }))
            .catch((err: unknown) => sendError(res, err))
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /view/chat/threads — list all threads newest-first with last-message preview.
    // GET /view/chat/thread/:id — fetch a single thread with all messages ordered by
    //   created_at ASC, or 404 when the thread does not exist.
    // GET /chat/threads/:id/tasks — list task IDs linked to one chat thread.
    // POST /chat/threads — create a new thread. Body: { title?: string }.
    // POST /chat/subthreads — atomically create and seed a Subthread, then start
    //   its first chat run. Body: { message: string, attachments?: AttachmentInfo[] }.
    // POST /chat/threads/:id/title — rename a thread. Body: { title: string }.
    // POST /chat/threads/:id/end — explicitly close an open-ended Subthread.
    // All chat routes bypass the draining gate (lightweight user-data writes,
    // not task work). SSE channel 'chat' is broadcast after every write.
    const chatThreadsUrl = req.method === 'GET' && req.url
      ? new URL(req.url, 'http://localhost')
      : null
    if (chatThreadsUrl?.pathname === '/view/chat/threads') {
      const query = ChatThreadsQuerySchema.safeParse({
        parentThreadId: chatThreadsUrl.searchParams.get('parentThreadId') ?? undefined,
        hasParent: chatThreadsUrl.searchParams.get('hasParent') ?? undefined,
      })
      if (!query.success) {
        sendJson(res, 400, { ok: false, error: 'Invalid chat thread filters', errorCode: 'VALIDATION_ERROR' })
        return
      }
      deps.appServices
        .viewChatThreads(query.data)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }
    if (req.method === 'GET' && req.url === '/view/chat/history') {
      deps.appServices
        .viewChatHistory()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }
    if (req.method === 'GET' && req.url === '/view/chat/conversation') {
      deps.appServices
        .viewChatConversation()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }
    if (req.method === 'GET' && req.url === '/view/codex-auth') {
      sendJson(res, 200, { needsAuth: deps.chatRunner.isAuthFailed() })
      return
    }
    // GET /view/chat/config — the chat agent's effective configuration: model,
    // resolved system prompt (+ source), built-in tools, skills, MCP servers.
    if (req.method === 'GET' && req.url === '/view/chat/config') {
      deps.chatRunner
        .describeConfig(getRepoRoot())
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }
    if (req.method === 'POST' && req.url === '/codex-auth/refresh') {
      deps.chatRunner.clearAuthFailure(getRepoRoot(), deps.viewStreamHub)
      sendJson(res, 200, { ok: true })
      return
    }
    {
      const threadViewMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/view\/chat\/thread\/([^/?]+)(?:\?.*)?$/)
          : null
      if (threadViewMatch && threadViewMatch[1]) {
        const id = decodeURIComponent(threadViewMatch[1])
        deps.appServices
          .viewChatThread(id)
          .then((result) => {
            if (result === null) {
              sendJson(res, 404, { ok: false, error: `thread ${id} not found`, errorCode: 'NOT_FOUND' })
              return
            }
            sendJson(res, 200, result)
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }
    {
      const threadTasksMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/tasks(?:\?.*)?$/)
          : null
      if (threadTasksMatch && threadTasksMatch[1]) {
        const threadId = decodeURIComponent(threadTasksMatch[1])
        listTasksForThread(threadId)
          .then((links) => sendJson(res, 200, { tasks: links.map((link) => link.taskId) }))
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }
    {
      const endSubthreadMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/end$/)
          : null
      if (endSubthreadMatch && endSubthreadMatch[1]) {
        const id = decodeURIComponent(endSubthreadMatch[1])
        getThread(id)
          .then(async (detail) => {
            if (detail === null) {
              sendJson(res, 404, { ok: false, error: `thread ${id} not found`, errorCode: 'NOT_FOUND' })
              return
            }
            if (detail.thread.terminal_event_type != null) {
              sendJson(res, 409, { ok: false, error: 'Subthread closes when its declared terminal event arrives', errorCode: 'TERMINAL_EVENT_DECLARED' })
              return
            }
            await closeSubthread(id)
            deps.viewStreamHub?.broadcast('chat')
            sendJson(res, 200, { ok: true })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }
    // POST /chat/threads/:id/archive   — file an ended Subthread away.
    // POST /chat/threads/:id/unarchive — put it back in the list.
    //
    // Unlike `/end`, archiving accepts a Subthread with a declared terminal
    // event: the operator is filing it, not overriding how it closes, and
    // `archiveSubthread` stamps `closed_at` only when it is still null.
    {
      const archiveMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/(archive|unarchive)$/)
          : null
      if (archiveMatch && archiveMatch[1] && archiveMatch[2]) {
        const id = decodeURIComponent(archiveMatch[1])
        const restoring = archiveMatch[2] === 'unarchive'
        getThread(id)
          .then(async (detail) => {
            if (detail === null) {
              sendJson(res, 404, { ok: false, error: `thread ${id} not found`, errorCode: 'NOT_FOUND' })
              return
            }
            await (restoring ? unarchiveSubthread(id) : archiveSubthread(id))
            deps.viewStreamHub?.broadcast('chat')
            sendJson(res, 200, { ok: true })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }
    // GET /chat/threads/:id/ui-stream — resumable UIMessage-chunk stream for one
    // thread's active run. This is the daemon-native replacement for the old
    // client-side `chat-delta` → `UIMessageChunk` mapping: the daemon maps and
    // buffers chunks (see chat-stream-hub.ts) and this route replays + follows
    // them over a small versioned JSON-lines-over-SSE contract.
    //
    //   frames:  event: protocol\ndata: {"v":1}\n\n   (once, first)
    //            id: <gen>.<seq>\ndata: <UIMessageChunk JSON>\n\n
    //            : ping\n\n                            (heartbeat)
    //   query:   mode=send|resume (default resume)
    //            lastEventId=<gen>.<seq>  (resume dedup cursor)
    //
    // mode=send   → always stream the current/next run (used right after POST
    //               /message; buffer replay covers a fast run that finished
    //               before the client connected).
    // mode=resume → stream only when a run is currently ACTIVE, else 204 (there
    //               is nothing to resume). Backs the transport's reconnectToStream.
    {
      const uiStreamMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/ui-stream(?:\?.*)?$/)
          : null
      if (uiStreamMatch && uiStreamMatch[1]) {
        const threadId = decodeURIComponent(uiStreamMatch[1])
        const parsed = new URL(req.url!, 'http://localhost')
        const mode = parsed.searchParams.get('mode') === 'send' ? 'send' : 'resume'
        const lastEventId = parsed.searchParams.get('lastEventId')
        const hub = deps.chatStreamHub
        if (!hub) {
          res.writeHead(204).end()
          return
        }

        const snapshot = hub.snapshot(threadId)
        // Resume has nothing to attach to unless a run is actively streaming.
        if (mode === 'resume' && (!snapshot || !snapshot.active)) {
          res.writeHead(204).end()
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write('event: protocol\ndata: {"v":1}\n\n')

        // Parse the resume cursor. It only suppresses replay of chunks the client
        // already holds when its generation matches the live run's generation.
        let lastWritten: { gen: number; seq: number } | null = null
        if (lastEventId) {
          const dot = lastEventId.indexOf('.')
          const g = Number.parseInt(lastEventId.slice(0, dot), 10)
          const s = Number.parseInt(lastEventId.slice(dot + 1), 10)
          if (Number.isInteger(g) && Number.isInteger(s)) lastWritten = { gen: g, seq: s }
        }
        // A cursor from a different (older) generation is stale — replay in full.
        if (snapshot && lastWritten && lastWritten.gen !== snapshot.gen) lastWritten = null

        const writeChunk = (sc: SeqChunk): void => {
          const newer =
            lastWritten === null ||
            sc.gen > lastWritten.gen ||
            (sc.gen === lastWritten.gen && sc.seq > lastWritten.seq)
          if (!newer) return
          lastWritten = { gen: sc.gen, seq: sc.seq }
          try {
            res.write(`id: ${sc.gen}.${sc.seq}\ndata: ${JSON.stringify(sc.chunk)}\n\n`)
          } catch {
            // Dead socket — cleanup runs on the 'close' handler.
          }
        }

        // Subscribe BEFORE replaying the snapshot so no chunk published between
        // the two can slip through the gap (the dedup in writeChunk makes an
        // overlap harmless). Both run synchronously here — no publish interleaves.
        let heartbeat: ReturnType<typeof setInterval> | null = null
        const closeStream = (): void => {
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
          unsubscribe()
          try { res.end() } catch { /* already closed */ }
        }
        const unsubscribe = hub.subscribe(threadId, {
          onChunk: writeChunk,
          onEnd: closeStream,
        })

        if (snapshot) {
          for (const sc of snapshot.buffer) writeChunk(sc)
          // A run that already sealed replays fully, then closes immediately.
          if (!snapshot.active) {
            closeStream()
            return
          }
        }

        heartbeat = setInterval(() => {
          try { res.write(': ping\n\n') } catch { closeStream() }
        }, 30_000)

        req.on('close', () => {
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
          unsubscribe()
        })
        req.on('error', () => {
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
          unsubscribe()
        })
        return
      }
    }

    if (req.method === 'POST' && req.url === '/chat/subthreads') {
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(rawBody)
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const attachmentSchema = z.object({
          id: z.string(), path: z.string(), mimeType: z.string(), name: z.string(), size: z.number(),
        })
        const result = z.object({
          message: z.string(),
          attachments: z.array(attachmentSchema).optional(),
          /** Why this Subthread exists. Drives the archive prompt. */
          objective: z.string().optional(),
          /** Where it was spawned from: 'alert', 'reflection', 'operator', ... */
          origin: z.string().optional(),
        }).refine(
          (data) => data.message.length > 0 || (data.attachments?.length ?? 0) > 0,
          { message: 'message or at least one attachment is required', path: ['message'] },
        ).safeParse(parsed)
        if (!result.success) {
          sendJson(res, 400, { ok: false, error: 'body must be { message: string, attachments?: AttachmentInfo[] }' })
          return
        }
        const userSegments = [
          { type: 'text', text: result.data.message },
          ...(result.data.attachments ?? []).map((attachment) => ({
            type: 'attachment', path: attachment.path, mimeType: attachment.mimeType,
            name: attachment.name, size: attachment.size,
            kindHint: attachment.mimeType.startsWith('image/') ? 'image' : attachment.mimeType.startsWith('audio/') ? 'audio' : 'video',
          })),
        ]
        deps.appServices.buildSituationReport()
          .then((situation) => createThread(undefined, {
            situationReport: situation,
            // Absent an explicit objective, the opening message is the closest
            // honest statement of why the operator opened this Subthread.
            objective: result.data.objective ?? result.data.message,
            ...(result.data.origin !== undefined ? { origin: result.data.origin } : {}),
            firstUserMessage: { content: result.data.message, segments: userSegments },
          }))
          .then(async (thread) => {
            const run = await deps.chatRunner.sendMessage(
              thread.id,
              result.data.message,
              getRepoRoot(),
              deps.viewStreamHub,
              result.data.attachments,
              { userMessagePersisted: true },
            )
            if (run.alreadyRunning) throw new Error('new Subthread unexpectedly has an active run')
            deps.viewStreamHub?.broadcast('chat')
            sendJson(res, 202, toThreadApiView(thread))
          })
          .catch((err: unknown) => sendError(res, err))
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    if (req.method === 'POST' && req.url === '/chat/threads') {
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        let parsed: unknown = {}
        if (rawBody.trim().length > 0) {
          try {
            parsed = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
        }
        const schema = z.object({
          title: z.string().optional(),
          objective: z.string().optional(),
          origin: z.string().optional(),
        })
        const result = schema.safeParse(parsed)
        if (!result.success) {
          sendJson(res, 400, { ok: false, error: 'body must be { title?: string, objective?: string, origin?: string }' })
          return
        }
        deps.appServices.buildSituationReport()
          .then((situation) => createThread(result.data.title, {
            situationReport: situation,
            // Fall back to the title: a Subthread named "Fix the slicer" has
            // stated its objective, even if nobody filled a separate field.
            ...(result.data.objective ?? result.data.title
              ? { objective: result.data.objective ?? result.data.title! }
              : {}),
            ...(result.data.origin !== undefined ? { origin: result.data.origin } : {}),
          }))
          .then((thread) => {
            deps.viewStreamHub?.broadcast('chat')
            sendJson(res, 200, toThreadApiView(thread))
          })
          .catch((err: unknown) => sendError(res, err))
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }
    {
      const chatForkMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/fork$/)
          : null
      if (chatForkMatch && chatForkMatch[1]) {
        const sourceThreadId = decodeURIComponent(chatForkMatch[1])
        let rawBody = ''
        req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
        req.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const schema = z.object({
            goal: z.string(),
            idempotencyKey: z.string(),
            files: z.array(z.object({ path: z.string(), note: z.string().optional() })).optional(),
          })
          const result = schema.safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, { ok: false, error: 'body must be { goal: string, idempotencyKey: string, files?: {path:string;note?:string}[] }' })
            return
          }
          forkThread({ sourceThreadId, goal: result.data.goal, idempotencyKey: result.data.idempotencyKey, files: result.data.files })
            .then(({ thread }) => {
              deps.viewStreamHub?.broadcast('chat')
              sendJson(res, 200, { threadId: thread.id })
            })
            .catch((err: unknown) => sendError(res, err))
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }
    {
      const chatTitleMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/title$/)
          : null
      if (chatTitleMatch && chatTitleMatch[1]) {
        const id = decodeURIComponent(chatTitleMatch[1])
        let rawBody = ''
        req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
        req.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const schema = z.object({ title: z.string() })
          const result = schema.safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, { ok: false, error: 'body must be { title: string }' })
            return
          }
          updateThreadTitle(id, result.data.title)
            .then(() => {
              deps.viewStreamHub?.broadcast('chat')
              sendJson(res, 200, { ok: true })
            })
            .catch((err: unknown) => sendError(res, err))
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }
    // POST /chat/threads/:id/attachments — upload a file (multipart/form-data).
    // Stores the file under .mars/chat-uploads/<threadId>/<uuid>.<ext>.
    // Allowed types: png/jpg/gif/webp, mp3/m4a/wav/webm (audio), mp4/mov/webm (video).
    // Size cap: 50 MiB. Returns { id, path, mimeType, name, size }.
    {
      const chatAttachMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/attachments$/)
          : null
      if (chatAttachMatch && chatAttachMatch[1]) {
        const threadId = decodeURIComponent(chatAttachMatch[1])
        const contentType = (req.headers['content-type'] ?? '') as string
        const boundaryMatch = contentType.match(/multipart\/form-data;\s*boundary=([^\s;]+)/i)
        if (!boundaryMatch) {
          sendJson(res, 400, { ok: false, error: 'expected multipart/form-data with boundary' })
          return
        }
        // Strip optional quotes from boundary value.
        const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '')

        // Reject by Content-Length before reading the body.
        const clHeader = req.headers['content-length']
        if (clHeader && parseInt(clHeader, 10) > MAX_UPLOAD_BYTES) {
          sendJson(res, 413, { ok: false, error: 'file too large (max 50 MB)' })
          // Destroy the socket so the server does not wait for the body
          // that it will never read, allowing close() to complete quickly.
          req.destroy()
          return
        }

        const chunks: Buffer[] = []
        let received = 0
        let overflowed = false

        req.on('data', (chunk: Buffer) => {
          if (overflowed) return
          received += chunk.length
          if (received > MAX_UPLOAD_BYTES) {
            overflowed = true
            sendJson(res, 413, { ok: false, error: 'file too large (max 50 MB)' })
            req.destroy()
            return
          }
          chunks.push(chunk)
        })

        req.on('end', () => {
          if (overflowed) return

          const body = Buffer.concat(chunks)

          // ── Inline multipart parser ────────────────────────────────────────
          // Finds a byte sequence inside a Buffer (naive O(n·m) scan — fine
          // for files up to 50 MiB since m is at most a boundary string).
          const indexOf = (hay: Buffer, needle: Buffer, from = 0): number => {
            for (let i = from; i <= hay.length - needle.length; i++) {
              let found = true
              for (let j = 0; j < needle.length; j++) {
                if (hay[i + j] !== needle[j]) { found = false; break }
              }
              if (found) return i
            }
            return -1
          }

          const CRLF = Buffer.from('\r\n')
          const DOUBLE_CRLF = Buffer.from('\r\n\r\n')
          const firstBound = Buffer.from(`--${boundary}`)

          let pos = indexOf(body, firstBound)
          if (pos === -1 || !body.slice(pos + firstBound.length, pos + firstBound.length + 2).equals(CRLF)) {
            sendJson(res, 400, { ok: false, error: 'malformed multipart body' })
            return
          }
          pos += firstBound.length + 2 // skip --boundary\r\n

          // Find header/body separator.
          const headerEnd = indexOf(body, DOUBLE_CRLF, pos)
          if (headerEnd === -1) {
            sendJson(res, 400, { ok: false, error: 'malformed multipart body (no header end)' })
            return
          }
          const headerText = body.slice(pos, headerEnd).toString('utf8')
          const bodyStart = headerEnd + 4

          // Find where the part data ends (before next boundary).
          const nextDelimBuf = Buffer.from(`\r\n--${boundary}`)
          const dataEnd = indexOf(body, nextDelimBuf, bodyStart)
          const fileData = body.slice(bodyStart, dataEnd === -1 ? body.length : dataEnd)

          // Parse headers from the part.
          const headers: Record<string, string> = {}
          for (const line of headerText.split('\r\n')) {
            const colon = line.indexOf(':')
            if (colon !== -1) {
              headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
            }
          }

          const cd = headers['content-disposition'] ?? ''
          const fnMatch = cd.match(/filename="([^"]*)"/)
          const filename = fnMatch ? fnMatch[1] : 'upload'
          const mimeType = headers['content-type'] ?? ''

          if (!ALLOWED_MIME_TYPES.has(mimeType)) {
            sendJson(res, 415, { ok: false, error: `file type not allowed: ${mimeType}` })
            return
          }

          const ext = extname(filename) || MIME_TO_EXT.get(mimeType) || ''
          const id = randomUUID()
          const uploadDir = join(getRepoRoot(), '.mars', 'chat-uploads', threadId)
          const filePath = join(uploadDir, `${id}${ext}`)

          mkdir(uploadDir, { recursive: true })
            .then(() => writeFile(filePath, fileData))
            .then(() => {
              const response: AttachmentInfo = { id, path: filePath, mimeType, name: filename, size: fileData.length }
              sendJson(res, 200, response)
            })
            .catch((err: unknown) => sendError(res, err))
        })

        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /chat/threads/:id/message — persist the user message then spawn a
    // `claude -p` run. Segments stream live over the `chat` SSE channel; the
    // assistant reply is persisted when the run completes. 409 when a run is
    // already active for this thread. Bypasses the draining gate (chat is not
    // orchestrator work).
    {
      const chatMessageMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/message$/)
          : null
      if (chatMessageMatch && chatMessageMatch[1]) {
        const id = decodeURIComponent(chatMessageMatch[1])
        let rawBody = ''
        req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
        req.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const attachmentSchema = z.object({
            id: z.string(),
            path: z.string(),
            mimeType: z.string(),
            name: z.string(),
            size: z.number(),
          })
          const schema = z
            .object({
              content: z.string(),
              attachments: z.array(attachmentSchema).optional(),
            })
            .refine(
              (d) => d.content.length > 0 || (d.attachments?.length ?? 0) > 0,
              { message: 'content or at least one attachment is required', path: ['content'] },
            )
          const result = schema.safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, { ok: false, error: 'body must be { content: string, attachments?: AttachmentInfo[] }' })
            return
          }
          deps.chatRunner
            .sendMessage(id, result.data.content, getRepoRoot(), deps.viewStreamHub, result.data.attachments)
            .then(({ alreadyRunning }) => {
              if (alreadyRunning) {
                sendJson(res, 409, { ok: false, error: 'thread already has an active run', errorCode: 'ALREADY_RUNNING' })
                return
              }
              sendJson(res, 202, { ok: true })
            })
            .catch((err: unknown) => sendError(res, err))
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /chat/threads/:id/stop — kill the active run for the thread and
    // finalise the partial assistant message with what streamed so far.
    // When no live run exists but the row still says 'running' (stale orphan
    // from a prior daemon crash), reconcile the row to 'idle' so the UI's
    // Stop button is a real escape hatch rather than a dead end.
    {
      const chatStopMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/stop$/)
          : null
      if (chatStopMatch && chatStopMatch[1]) {
        const id = decodeURIComponent(chatStopMatch[1])
        const stopped = deps.chatRunner.stop(id)
        const reconcileStale = async (): Promise<void> => {
          if (stopped) return
          const td = await getThread(id)
          if (td?.thread.status === 'running') {
            await setThreadStatus(id, 'idle')
          }
        }
        reconcileStale()
          .then(() => sendJson(res, 200, { ok: true, stopped }))
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /chat/messages/:id/feedback — upsert thumbs-up / thumbs-down for an
    // assistant message. Body: { rating: 'up'|'down', note?: string }.
    // 400 on missing/invalid rating; 404 when the message does not exist.
    // Bypasses the draining gate (user-data write, not orchestrator work).
    {
      const preloadedResponseMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/messages\/([^/?]+)\/responses\/([^/?]+)$/)
          : null
      if (preloadedResponseMatch?.[1] && preloadedResponseMatch[2]) {
        const messageId = decodeURIComponent(preloadedResponseMatch[1])
        const responseId = decodeURIComponent(preloadedResponseMatch[2])
        getPreloadedResponse(messageId, responseId)
          .then(async (selected) => {
            if (selected === null) {
              sendJson(res, 404, { ok: false, error: 'preloaded response not found', errorCode: 'NOT_FOUND' })
              return
            }
            const { message, response } = selected
            if (response.target.type === 'verb') {
              if (classifyMarsVerb(response.target.op) !== 'safe') {
                sendJson(res, 400, { ok: false, error: `response verb is not safe: ${response.target.op}` })
                return
              }
              if (response.target.op === 'run-reflect') {
                await deps.runReflect()
              } else if (response.target.op === 'enable-auto-reflect') {
                await deps.enableAutoReflect()
              } else if (response.target.op === 'diagnose') {
                if (!response.target.entityId) throw new Error('diagnose response requires an entityId')
                await deps.diagnoseFailure(response.target.entityId)
              } else {
                const handler = entityHandlers[response.target.op as EntityOp]
                if (!handler || !response.target.entityId) {
                  sendJson(res, 400, { ok: false, error: `unsupported preloaded verb: ${response.target.op}` })
                  return
                }
                await handler(response.target.entityId)
              }
              await appendMessage(
                message.thread_id,
                'user',
                response.label,
                [{ type: 'text', text: response.label }],
                { kind: 'acknowledgment', contextScope: 'main' },
              )
              deps.viewStreamHub?.broadcast('chat')
              sendJson(res, 200, { ok: true })
              return
            }
            const subthread = await deps.appServices.openSubthread({
              title: response.target.title,
              acknowledgment: response.label,
            })
            deps.viewStreamHub?.broadcast('chat')
            sendJson(res, 200, { ok: true, threadId: subthread.threadId })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /chat/messages/:id/feedback — upsert thumbs-up / thumbs-down for an
    // assistant message. Body: { rating: 'up'|'down', note?: string }.
    // 400 on missing/invalid rating; 404 when the message does not exist.
    // Bypasses the draining gate (user-data write, not orchestrator work).
    {
      const chatFeedbackMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/messages\/([^/?]+)\/feedback$/)
          : null
      if (chatFeedbackMatch && chatFeedbackMatch[1]) {
        const messageId = decodeURIComponent(chatFeedbackMatch[1])
        let rawBody = ''
        req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
        req.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const schema = z.object({
            rating: z.enum(['up', 'down']),
            note: z.string().max(2000).optional(),
          })
          const result = schema.safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, { ok: false, error: 'body must be { rating: "up"|"down", note?: string }' })
            return
          }
          const note = result.data.note !== undefined ? result.data.note.trim() : null
          setMessageFeedback(messageId, result.data.rating, note === '' ? null : note)
            .then((feedback) => {
              deps.viewStreamHub?.broadcast('chat')
              sendJson(res, 200, { ok: true, feedback })
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err)
              if (msg.includes('not found')) {
                sendJson(res, 404, { ok: false, error: msg, errorCode: 'NOT_FOUND' })
              } else {
                sendError(res, err)
              }
            })
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /chat/messages/:id/feedback/clear — remove feedback for a message.
    // 200 either way (idempotent). Bypasses the draining gate.
    {
      const chatFeedbackClearMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/messages\/([^/?]+)\/feedback\/clear$/)
          : null
      if (chatFeedbackClearMatch && chatFeedbackClearMatch[1]) {
        const messageId = decodeURIComponent(chatFeedbackClearMatch[1])
        clearMessageFeedback(messageId)
          .then((cleared) => {
            deps.viewStreamHub?.broadcast('chat')
            sendJson(res, 200, { ok: true, cleared })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /deployments/:taskId/logs — fetch provider logs for the latest
    // deployment on a task. Returns text/plain with raw log output; 404 when no
    // deployment exists for the task; 500 when the provider's logs() call fails.
    // Pure read; no draining gate.
    {
      const deployLogsMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/deployments\/([^/?]+)\/logs(?:\?.*)?$/)
          : null
      if (deployLogsMatch && deployLogsMatch[1]) {
        const taskId = decodeURIComponent(deployLogsMatch[1])
        if (!deps.getLatestDeployment) {
          sendJson(res, 503, { ok: false, error: 'deployment support not configured' })
          return
        }
        deps.getLatestDeployment(taskId)
          .then((row) => {
            if (row === null) {
              sendJson(res, 404, { ok: false, error: `no deployment found for task ${taskId}` })
              return
            }
            const provider = getProvider(row.provider)
            if (provider === undefined) {
              sendJson(res, 500, { ok: false, error: `provider '${row.provider}' is not registered` })
              return
            }
            return provider.logs(row.deploymentId).then((logs) => {
              res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end(logs)
            })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' })
      return
    }

    // Every mutating verb is refused while the daemon is draining.
    if (!deps.isAcceptingWork()) {
      sendJson(res, 503, {
        ok: false,
        error: 'daemon draining; new work refused',
        errorCode: 'DRAINING',
      })
      return
    }

    // POST /step/done/:id — complete the current manual step of a live task.
    // Idempotent: if the task has already advanced past awaiting-human, returns
    // {ok:true,next:null} without mutating anything.
    {
      const stepDoneMatch = req.url?.match(/^\/step\/done\/([^/?]+)(?:\?.*)?$/)
      if (stepDoneMatch && stepDoneMatch[1]) {
        const id = decodeURIComponent(stepDoneMatch[1])
        deps
          .stepDone(id)
          .then(({ next }) => sendJson(res, 200, { ok: true, next }))
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /actions/restart-daemon — process-level, no :id.
    if (req.url === '/actions/restart-daemon') {
      deps
        .restartDaemon()
        .then(() => sendJson(res, 200, { ok: true }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /actions/restart-all-daemon-killed — batch re-queue, no :id.
    if (req.url === '/actions/restart-all-daemon-killed') {
      deps
        .restartAllDaemonKilled()
        .then((restarted) => sendJson(res, 200, { ok: true, restarted }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /actions/run-reflect — run the reflect flow over the recent task
    // corpus, persist suggestions as draft proposals, and clear the open
    // reflect-recommended action-queue row (level-trigger off). Global op: no
    // entity id. Responds with { ok: true, proposalsRaised: N } after the
    // reflect run completes (may take O(seconds) while the LLM runs).
    if (req.url === '/actions/run-reflect') {
      deps
        .runReflect()
        .then(({ proposalsRaised }) =>
          sendJson(res, 200, { ok: true, proposalsRaised }),
        )
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /actions/enable-auto-reflect — persist selfEvolve.autoTrigger=true
    // to daemon.json and clear the open reflect-recommended row so the
    // level-trigger is immediately cleared. Global op: no entity id.
    if (req.url === '/actions/enable-auto-reflect') {
      deps
        .enableAutoReflect()
        .then(() => sendJson(res, 200, { ok: true }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /actions/self-update — replace the running binary with the latest
    // release, then re-exec the daemon. Gated on prod binary + no in-flight
    // tasks (in addition to the isAcceptingWork drain check above).
    if (req.url === '/actions/self-update') {
      deps
        .selfUpdate()
        .then(() => sendJson(res, 200, { ok: true, status: 'started' }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /actions/snooze/:id — snooze an action-queue item until a given
    // ISO-8601 timestamp. Body: { until: string }.
    // Presets (e.g. "1 hour", "tomorrow") are handled client-side.
    {
      const snoozeMatch = req.url?.match(/^\/actions\/snooze\/([^/?]+)(?:\?.*)?$/)
      if (snoozeMatch && snoozeMatch[1]) {
        const id = decodeURIComponent(snoozeMatch[1])
        let rawBody = ''
        req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
        req.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
            return
          }
          const snoozeSchema = z.object({ until: z.string() })
          const result = snoozeSchema.safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, {
              ok: false,
              error: 'Body must be { until: string }',
            })
            return
          }
          deps
            .snoozeItem(id, result.data.until)
            .then(() => sendJson(res, 200, { ok: true }))
            .catch((err: unknown) => sendError(res, err))
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /actions/:op/:id — per-entity verbs.
    const match = req.url?.match(/^\/actions\/([^/]+)\/([^/]+)$/)
    if (!match || !match[1] || !match[2]) {
      sendJson(res, 404, { ok: false, error: 'Not found' })
      return
    }
    const op = match[1]
    const id = decodeURIComponent(match[2])

    // investigate returns a payload — handled separately so the explanation
    // is surfaced in the response body rather than discarded.
    if (op === 'investigate') {
      deps
        .investigateWorktree(id)
        .then(({ explanation }) => sendJson(res, 200, { ok: true, explanation }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // diagnose-failure returns a payload too — surface the diagnosis text.
    if (op === 'diagnose-failure') {
      deps
        .diagnoseFailure(id)
        .then(({ diagnosis }) => sendJson(res, 200, { ok: true, diagnosis }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    const handler = entityHandlers[op as EntityOp]
    if (!handler) {
      sendJson(res, 404, { ok: false, error: `Unknown action op: ${op}` })
      return
    }

    handler(id)
      .then(() => sendJson(res, 200, { ok: true }))
      .catch((err: unknown) => sendError(res, err))
  })

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
