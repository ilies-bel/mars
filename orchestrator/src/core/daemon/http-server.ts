import { createServer, type Server } from 'node:http'
import { FAILURE_KINDS } from '../lib/failure-kinds'
import type { RecipeCatalog } from '../lib/recipes'
import { buildOriginTree } from '../lib/origin-tree'
import type { ActionQueueRow, DerivedActionQueueFilter } from './view/action-queue'
import type { TerminalEvent } from './view/terminal-events'
import type { Session } from './view/sessions'
import {
  cursorAfter,
  TRACE_EVENT_KINDS,
  type TraceEventFilter,
  type TraceEventKind,
  type TraceEventPhase,
  type TraceEventSeverity,
  type TraceEventStore,
} from '../lib/trace-events-store'
import {
  listKpis as defaultListKpis,
  listKpiArcs as defaultListKpiArcs,
  type KpiArcsResult,
  type KpiKey,
  type KpiRecord,
} from './kpi-store'
import { readKpiSeries, type KpiSeries } from '../lib/kpi-snapshots.js'
import type { RestartTaskError } from './restart-task'
import { SelfUpdateError, SELF_UPDATE_ERRORS } from './self-update'
import type { ProgressTask, ProposalNode } from './view/progress'
import type { ViewStreamHub } from './view/stream-hub'
import {
  loadRecentTaskCorpus,
  type ReflectCorpus,
  type LoadCorpusOptions,
} from '../lib/reflect-query'
import {
  listDeepReflectArcCandidates,
  type ArcCandidate,
} from '../lib/deep-reflect-query'
import type { Alert } from '../lib/alert'
import type { Proposal } from '../proposals'

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
   * Execute a daemon self-update: download the latest release binary, verify
   * sha256, atomically swap it for the current binary, and re-exec the daemon.
   * Throws {@link SelfUpdateError} on every non-happy path.
   */
  selfUpdate: () => Promise<void>
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
   * Query the current KPI vector. When omitted, the built-in {@link defaultListKpis}
   * from `kpi-store.ts` is used. Inject a replacement here in tests or once the
   * real persistence layer (proposal 9a2ab5f8) is wired in.
   */
  listKpis?: () => Promise<KpiRecord[]>
  /**
   * Return the KPI time-series for `GET /kpis/series`. When omitted, falls back
   * to {@link readKpiSeries} from `kpi-snapshots.ts`. Inject in tests to avoid
   * hitting the real store.
   */
  listKpisSeries?: (limit: number) => Promise<KpiSeries>
  /**
   * Return the per-arc breakdown for a single KPI key for `GET /kpis/:key/arcs`.
   * When omitted, falls back to {@link defaultListKpiArcs} from `kpi-store.ts`.
   * Inject in tests to avoid hitting the real store.
   */
  listKpiArcs?: (key: KpiKey) => Promise<KpiArcsResult>
  /**
   * Return the full task list from the daemon's DomainTaskStore.
   * Served by `GET /view/tasks` so the read-only UI renders only what the
   * daemon exposes — no direct DB access on the UI side.
   */
  viewTasks: () => Promise<{ tasks: unknown[] }>
  /**
   * Build the Progress-tab view: tasks with cluster tags + referenced proposals.
   * Called by GET /view/progress; the UI server proxies this endpoint rather
   * than reading the DB directly. All failed tasks are always in scope — there
   * is no recency gate on the Failed cluster.
   */
  viewProgress: () => Promise<{ tasks: ProgressTask[]; proposals: ProposalNode[] }>
  /**
   * Build the full arc-rooted Alert list (failed arcs + open stale worktrees).
   * Backs `GET /alerts`. The Alert read aggregate is a PURE derivation over arc
   * state (ADR-0054); this handler never writes to any store.
   */
  viewAlerts: () => Promise<Alert[]>
  /**
   * Build the single arc-rooted Alert for `arcId`, or null when no Alert
   * applies to that arc. Backs `GET /alerts/:arcId`. Pure read (ADR-0054).
   */
  viewAlert: (arcId: string) => Promise<Alert | null>
  /**
   * Return the framework update state from the poller cache (.mars/update.json).
   * When the cache file does not exist yet (e.g. before the first poll
   * completes), return a safe fallback where `available` is false and
   * `checkedAt` / `releaseUrl` are null rather than 404.
   */
  viewFrameworkUpdate: () => Promise<FrameworkUpdateState>
  /**
   * SSE hub for `GET /view/stream`. When provided, the stream endpoint
   * registers each connecting client here and delivers invalidation events
   * whenever the daemon mutates a store. Omitting this dep disables fan-out
   * (the endpoint still serves the greeting but broadcasts are no-ops).
   */
  viewStreamHub?: ViewStreamHub
  /**
   * Derive the full actionQueue action-queue view. Served by `GET /view/action-queue`.
   * The daemon builds this from its own database; the read-only UI proxies it.
   */
  viewActionQueue: (filter: DerivedActionQueueFilter) => Promise<ActionQueueRow[]>
  /**
   * Return a cursor-paged slice of resolved action-queue rows for the history
   * accordion. Served by `GET /view/action-queue/history?cursor=...&limit=...`.
   * Optional — when omitted the route returns an empty page (graceful degradation
   * for daemons built before this dep was added).
   */
  viewActionQueueHistory?: (opts: {
    cursor?: string | null
    limit?: number
  }) => Promise<{ rows: ActionQueueRow[]; nextCursor: string | null }>
  /**
   * Return the combined payload for GET /view/proposals: draft proposals + open
   * stale-worktree alerts. The daemon is the sole reader of its own DB; the
   * UI server proxies this endpoint instead of querying the DB directly.
   */
  viewProposals: () => Promise<{ drafts: DraftFeature[]; staleWorktrees: StaleWorktreeAlert[] }>
  /**
   * Return the full Proposal record for GET /view/proposal/:id, or null when
   * no proposal with that id exists. Serves the detail panel's lazy-load path
   * so the UI never needs to query state.db directly.
   * Optional for backward-compat with test fixtures; the route returns 501
   * when omitted and 404 when the proposal does not exist.
   */
  viewProposal?: (id: string) => Promise<Proposal | null>
  /**
   * Return the terminal-event feed from the daemon's DomainTaskStore.
   * Served by `GET /view/terminal-events` so the read-only UI renders only
   * what the daemon exposes — no direct DB access on the UI side.
   */
  viewTerminalEvents: () => Promise<{ events: TerminalEvent[] }>
  /**
   * Return step-span pairs for the given originId.
   * Served by GET /view/step-spans?originId=<id>. Lifts the step_started /
   * step_ended pairing logic that previously lived in ui/server/index.ts into
   * the daemon so the UI can proxy rather than opening the trace store directly.
   */
  viewStepSpans: (originId: string) => Promise<{ spans: StepSpan[] }>
  /**
   * Return the session feed for a given agentName, derived from
   * step_started / step_ended trace events. Served by
   * `GET /view/sessions?agentName=<name>` so the read-only UI proxies
   * this endpoint instead of opening the trace store directly.
   */
  viewSessions: (agentName: string) => Promise<{ sessions: Session[] }>
  /**
   * Return recent task corpus data for GET /view/reflect. Wraps
   * {@link loadRecentTaskCorpus} from reflect-query.ts. When omitted, the
   * built-in default is used. Accepts optional `limit` and `since` (ISO-8601)
   * query parameters.
   */
  viewReflect?: (opts?: LoadCorpusOptions) => Promise<ReflectCorpus>
  /**
   * Return arc candidates ranked by failure count and token spend, for
   * GET /view/arcs. Wraps {@link listDeepReflectArcCandidates} from
   * deep-reflect-query.ts. When omitted, the built-in default is used.
   * Accepts optional `limit` (number) and `withTranscriptOnly` (boolean,
   * default true) query parameters.
   */
  viewArcs?: (opts?: { limit?: number; withTranscriptOnly?: boolean }) => Promise<ArcCandidate[]>
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
type EntityOp = 'restart' | 'unblock' | 'purge' | 'prune-worktree' | 'dismiss'

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
 *   POST /actions/restart-daemon → re-exec the daemon
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
          const fn = deps.listKpiArcs ?? ((k: KpiKey) => defaultListKpiArcs(k))
          fn(key)
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
      const fn = deps.listKpisSeries ?? ((lim: number) => readKpiSeries({ limit: lim }))
      fn(limit)
        .then((series) => sendJson(res, 200, { series }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /kpis — the four-KPI vector (ADR-0040, the harness-health KPI ADR
    // that was originally numbered 0038 on main while this branch held that
    // number for the recovery-tasks-are-leaf-nodes ADR — renumbered to 0040
    // during the merge). Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/kpis') {
      const fn = deps.listKpis ?? defaultListKpis
      fn()
        .then((kpis) => sendJson(res, 200, { kpis }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/tasks — full task list from the daemon's DomainTaskStore.
    // The read-only UI proxies this endpoint instead of opening the DB
    // directly, so the daemon is the single reader of its own database.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/tasks') {
      deps
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

      const hub = deps.viewStreamHub
      if (hub) {
        const client = hub.add(res)
        const cleanup = (): void => {
          hub.remove(client)
        }
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
      deps
        .viewProgress()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/step-spans?originId=<id> — step timeline for a task arc.
    // Pairs step_started / step_ended events from the trace store by
    // (workflowInstanceId, stepName). Steps with no matching step_ended have
    // outcome='running'. Ordered by startedAt ascending (workflow order).
    // The daemon is the sole reader of the trace store; the UI proxies here
    // rather than opening the trace store directly. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/step-spans')) {
      const parsed = new URL(req.url, 'http://localhost')
      const originId = parsed.searchParams.get('originId')
      if (!originId) {
        sendJson(res, 400, { error: 'originId query parameter is required' })
        return
      }
      deps
        .viewStepSpans(originId)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
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
      deps
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
      deps
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
      deps
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
        if (!deps.viewProposal) {
          sendJson(res, 501, { ok: false, error: 'viewProposal not implemented' })
          return
        }
        const proposalId = decodeURIComponent(proposalMatch[1])
        deps.viewProposal(proposalId)
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
      const fn = deps.viewReflect ?? loadRecentTaskCorpus
      fn(opts)
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
      const fn = deps.viewArcs ?? listDeepReflectArcCandidates
      fn(opts)
        .then((candidates) => sendJson(res, 200, candidates))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/terminal-events — reverse-chronological feed of terminal-state
    // task moments (completed/failed/dropped). The read-only UI proxies this
    // endpoint instead of opening the DB directly, so the daemon is the single
    // reader of its own database. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/terminal-events') {
      deps
        .viewTerminalEvents()
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
      if (!deps.viewActionQueueHistory) {
        sendJson(res, 200, { rows: [], nextCursor: null })
        return
      }
      const parsed = new URL(req.url, 'http://localhost')
      const cursor = parsed.searchParams.get('cursor') ?? null
      const limitRaw = parsed.searchParams.get('limit')
      const limit =
        limitRaw !== null && Number.isFinite(Number.parseInt(limitRaw, 10))
          ? Math.min(Math.max(1, Number.parseInt(limitRaw, 10)), 200)
          : 50
      deps
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
      deps
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
        deps
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
      deps
        .viewAlerts()
        .then((alerts) => sendJson(res, 200, alerts))
        .catch((err: unknown) => sendError(res, err))
      return
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
