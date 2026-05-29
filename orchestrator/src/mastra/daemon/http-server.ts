import { createServer, type Server } from 'node:http'
import { listErrorKinds } from '../lib/error-kinds'
import type { FailureReasonCatalog } from '../lib/failure-reasons'
import type { RecipeCatalog } from '../lib/recipes'
import { buildOriginTree } from '../lib/origin-tree'
import type { ActionQueueRow, DerivedInboxFilter } from './view/inbox'
import {
  cursorAfter,
  TRACE_EVENT_KINDS,
  type TraceEventFilter,
  type TraceEventKind,
  type TraceEventPhase,
  type TraceEventSeverity,
  type TraceEventStore,
} from '../lib/trace-events-store'
import { listKpis as defaultListKpis, type KpiRecord } from './kpi-store'
import type { RestartTaskError } from './restart-task'

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
   * Run a cheap Haiku investigation over the worktree diff, persist the result
   * onto the inbox item payload, and return the explanation text. Read-only:
   * never mutates the worktree. Concurrent calls for the same id must be
   * guarded by the implementation (skip if already running).
   */
  investigateWorktree: (id: string) => Promise<{ explanation: string }>
  /**
   * Run a one-shot Sonnet root-cause diagnosis on a failed task whose failure
   * signature has no registered recipe. Reads the worktree (if it still exists)
   * and the session trace as needed, persists the diagnosis onto the inbox item
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
  /**
   * Resolved failure-reason catalog (built-in seed + `.mars/failure-reasons/`
   * overrides), loaded once at daemon start. Served verbatim by
   * `GET /failure-reasons` for the inbox UI.
   */
  failureReasonCatalog: FailureReasonCatalog
  /**
   * Resolved recovery-recipe catalog (built-in seed + `.mars/recipes/`
   * overrides), loaded once at daemon start. Served verbatim by
   * `GET /recipes` so the inbox UI can name which recipe a recovery task
   * was dispatched under.
   */
  recipeCatalog: RecipeCatalog
  /**
   * The unified trace-event store, used by `GET /events` to back the
   * per-task lifecycle view in the inbox detail panel (and broader filters
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
   * Return the full task list from the daemon's DomainTaskStore.
   * Served by `GET /view/tasks` so the read-only UI renders only what the
   * daemon exposes — no direct DB access on the UI side.
   */
  viewTasks: () => Promise<{ tasks: unknown[] }>
  /**
   * Derive the full inbox action-queue view. Served by `GET /view/inbox`.
   * The daemon builds this from its own database; the read-only UI proxies it.
   */
  viewInbox: (filter: DerivedInboxFilter) => Promise<ActionQueueRow[]>
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
  const message = err instanceof Error ? err.message : String(err)
  sendJson(res, 500, { ok: false, error: message })
}

/**
 * The per-entity action routes, keyed by the `op` the error-kind registry
 * declares. Each maps `POST /actions/:op/:id` to the matching daemon handler.
 * `restart-daemon` is handled separately (it has no `:id`).
 */
type EntityOp = 'restart' | 'unblock' | 'purge' | 'prune-worktree'

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
 *   GET  /error-kinds            → the error-kind registry (action menus)
 *   GET  /failure-reasons        → the resolved failure-reason catalog
 *   GET  /recipes                → the resolved recovery-recipe catalog
 *   GET  /events?...             → unified trace events (taskId, kind, etc.)
 *   GET  /origins/:taskId        → the origin tree for a task
 *   POST /actions/restart/:id    → re-queue a failed/daemon-killed task
 *   POST /actions/unblock/:id    → phantom-recover a blocked task
 *   POST /actions/purge/:id      → drop a task + worktree
 *   POST /actions/prune-worktree/:id → remove a stale worktree
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
  }

  const server: Server = createServer((req, res) => {
    // GET /error-kinds — the action-menu registry. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/error-kinds') {
      sendJson(res, 200, { ok: true, errorKinds: listErrorKinds() })
      return
    }

    // GET /failure-reasons — the resolved failure-reason catalog. The
    // catalog is loaded once at daemon start (built-in seed + per-repo
    // overrides under `.mars/failure-reasons/`); consumers re-`mars daemon
    // reload` to pick up edits. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/failure-reasons') {
      sendJson(res, 200, deps.failureReasonCatalog.list())
      return
    }

    // GET /recipes — the resolved recovery-recipe catalog. Same lifecycle
    // as /failure-reasons: loaded once at boot from
    // `src/mastra/recipes/built-in/*.md` plus `.mars/recipes/*.md`
    // overrides; consumers re-`mars daemon reload` to pick up edits. Pure
    // read; no draining gate. No recipes are dispatched in slice E — this
    // endpoint exists for symmetry and so the inbox UI can name them.
    if (req.method === 'GET' && req.url === '/recipes') {
      sendJson(res, 200, deps.recipeCatalog.list())
      return
    }

    // GET /events — unified trace events. Supports multi-filter querying
    // (taskId, originId, kind[], severity[], phase[], since, until, q) plus
    // cursor pagination. Newest-first ordering. The per-task inbox panel
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

    // GET /view/inbox?filter=open|dismissed|all — the full derived inbox view.
    // The daemon builds this from its own database and is the sole source of
    // truth; the read-only UI proxies this endpoint instead of re-deriving it.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/inbox')) {
      const parsed = new URL(req.url, 'http://localhost')
      const filterRaw = parsed.searchParams.get('filter')
      const filter: DerivedInboxFilter =
        filterRaw === 'dismissed' || filterRaw === 'all' ? filterRaw : 'open'
      deps
        .viewInbox(filter)
        .then((rows) => sendJson(res, 200, rows))
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
