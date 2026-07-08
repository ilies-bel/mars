import { createServer, type Server } from 'node:http'
import { FAILURE_KINDS } from '../lib/failure-kinds'
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
import type { AppServices } from '../app-services'
import {
  getSetting,
  setSetting,
  RELEASE_NOTES_LAST_VIEWED_KEY,
} from '../lib/settings'
import { resolveStateClient } from '../store/state-client'

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
 * One Worker's Authorization profile (glossary term) as projected by
 * GET /view/primitives/:name — model, effort, permission mode, and the
 * forfeited tools (an empty list means the full tool surface).
 * `source` is 'built-in' for code-pinned WORKER_CONFIGS entries and
 * 'registry' for operator-declared Workers from .mars/worker-registry.json.
 */
export interface PrimitiveWorkerProfile {
  workerName: string
  model: string
  effort: string
  permissionMode: string
  forfeitedTools: string[]
  source: 'built-in' | 'registry'
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
  source: 'reflection' | 'human' | 'planner'
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
  /** Phantom-recover a blocked task: clear edges and flip it to failed. */
  unblockTask: (id: string) => Promise<void>
  /** Drop a task and its worktree permanently. */
  purgeTask: (id: string) => Promise<void>
  /** Remove a leftover worktree by its id (terminal/absent task). */
  pruneWorktree: (id: string) => Promise<void>
  /**
   * Reject a draft proposal: flip its status from `draft` → `dismissed` and
   * emit `proposal.dismissed`, which causes the action-queue projection to drop
   * the row. Throws when the proposal has dependent tasks (let the error
   * propagate to the existing `sendError` path so the UI surfaces it).
   */
  dismissProposal: (id: string) => Promise<void>
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
  | 'unblock'
  | 'purge'
  | 'prune-worktree'
  | 'dismiss'
  | 'validate'
  | 'reject'

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
  if (since) filter.sinceIso = since
  const until = params.get('until')
  if (until) filter.untilIso = until
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
 *   GET  /alerts/:arcId          → the single arc-rooted Alert (or 404)
 *   POST /actions/restart/:id    → re-queue a failed/daemon-killed task
 *   POST /actions/unblock/:id    → phantom-recover a blocked task
 *   POST /actions/purge/:id      → drop a task + worktree
 *   POST /actions/prune-worktree/:id → remove a stale worktree
 *   POST /actions/dismiss/:id    → reject a draft proposal (draft → dismissed)
 *   POST /actions/validate/:id   → approve a preview-gated task (→ merge)
 *   POST /actions/reject/:id     → reject a preview-gated task (→ failed)
 *   POST /actions/restart-daemon       → re-exec the daemon
 *   POST /actions/run-reflect          → run reflect flow + clear reflect-recommended row
 *   POST /actions/enable-auto-reflect  → set autoTrigger=true + clear reflect-recommended row
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
    unblock: deps.unblockTask,
    purge: deps.purgeTask,
    'prune-worktree': deps.pruneWorktree,
    dismiss: deps.dismissProposal,
    validate: deps.validateTask,
    reject: deps.rejectTask,
  }

  const server: Server = createServer((req, res) => {
    // GET /healthz — liveness probe. Pure read; no draining gate so the UI
    // correctly shows the daemon as live even while it is draining.
    if (req.method === 'GET' && req.url === '/healthz') {
      sendJson(res, 200, { ok: true })
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

    // GET /budget — the spend-meter status (observe-and-warn token-budget
    // alerting; explicitly NOT a fifth KPI). Configured thresholds, current
    // rolling-window spend + band, top live arcs vs the per-arc ceiling, and
    // any open budget-* rows. Unconfigured meters report configured:false —
    // never fake zeros. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/budget') {
      deps.appServices
        .budgetStatus()
        .then((status) => sendJson(res, 200, status))
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
    // DB; the UI server proxies this endpoint instead of querying state.db
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

  return {
    port,
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
