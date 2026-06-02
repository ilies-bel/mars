import { createServer, type Server } from 'node:http'
import { listErrorKinds } from '../lib/error-kinds'
import type { FailureReasonCatalog } from '../lib/failure-reasons'
import type { RecipeCatalog } from '../lib/recipes'
import { buildOriginTree } from '../lib/origin-tree'
import type { ActionQueueRow, DerivedActionQueueFilter } from './view/action-queue'
import type { TerminalEvent } from './view/terminal-events'
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
import type { ProgressTask, ProposalNode } from './view/progress'
import type { ViewStreamHub } from './view/stream-hub'

/** Wire shape returned by GET /view/framework-update. */
export interface FrameworkUpdateState {
  installed: string
  latest: string
  available: boolean
  /** ISO-8601 timestamp of the last successful check, or null before the first poll completes. */
  checkedAt: string | null
  releaseUrl: string | null
}

/** Wire shape returned by GET /view/todo for a single draft proposal. */
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
}

/** Wire shape returned by GET /view/todo for a single stale-worktree alert. */
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
  /**
   * Resolved failure-reason catalog (built-in seed + `.mars/failure-reasons/`
   * overrides), loaded once at daemon start. Served verbatim by
   * `GET /failure-reasons` for the actionQueue UI.
   */
  failureReasonCatalog: FailureReasonCatalog
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
   * Return the full task list from the daemon's DomainTaskStore.
   * Served by `GET /view/tasks` so the read-only UI renders only what the
   * daemon exposes — no direct DB access on the UI side.
   */
  viewTasks: () => Promise<{ tasks: unknown[] }>
  /**
   * Build the Progress-tab view: tasks with cluster tags + referenced proposals.
   * Called by GET /view/progress; the UI server proxies this endpoint rather
   * than reading the DB directly.
   *
   * `failedWindowMs` controls the Failed cluster recency window:
   * - positive number → include failed tasks updated within the last N ms
   * - null → all failed tasks regardless of age ("all" mode)
   */
  viewProgress: (q: {
    failedWindowMs: number | null
  }) => Promise<{ tasks: ProgressTask[]; proposals: ProposalNode[] }>
  /**
   * Acknowledge an actionQueue row for the given entity: marks it as seen without
   * hiding it from the open filter. Backed by `POST /view/action-queue/ack`.
   */
  actionQueueAck: (kind: 'task' | 'worktree' | 'proposal', id: string) => Promise<void>
  /**
   * Resolve an actionQueue row for the given entity: hides it from the open filter
   * and marks it as operator-resolved. Backed by `POST /view/action-queue/resolve`.
   */
  actionQueueResolve: (kind: 'task' | 'worktree' | 'proposal', id: string) => Promise<void>
  /**
   * Dismiss an actionQueue row for the given entity: hides it until the entity's
   * state changes. Backed by `POST /view/action-queue/dismiss`.
   */
  actionQueueDismiss: (kind: 'task' | 'worktree' | 'proposal', id: string) => Promise<void>
  /**
   * Dismiss a Todo-tab item: mark a draft proposal as dismissed, or record a
   * stale-worktree dismissal so the sweep skips it on subsequent passes.
   * Backed by `POST /view/todo/dismiss`.
   */
  todoDismiss: (kind: 'draft' | 'stale', id: string) => Promise<void>
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
   * Return the combined payload for GET /view/todo: draft proposals + open
   * stale-worktree alerts. The daemon is the sole reader of its own DB; the
   * UI server proxies this endpoint instead of querying the DB directly.
   */
  viewTodo: () => Promise<{ drafts: DraftFeature[]; staleWorktrees: StaleWorktreeAlert[] }>
  /**
   * Return the terminal-event feed from the daemon's DomainTaskStore.
   * Served by `GET /view/terminal-events` so the read-only UI renders only
   * what the daemon exposes — no direct DB access on the UI side.
   */
  viewTerminalEvents: () => Promise<{ events: TerminalEvent[] }>
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
    // named event per channel ('tasks'|'progress'|'action-queue'|'todo'|'kpis')
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

    // GET /view/progress?failedWindow=<ms>|all — Progress-tab view.
    // Returns { tasks: ProgressTask[], proposals: ProposalNode[] } with
    // cluster tags already attached. The UI server proxies this endpoint
    // rather than computing the view locally. Pure read; no draining gate.
    //
    // failedWindow parsing (mirrors ui/server/index.ts:130-137):
    //   - absent or invalid → default 24 h
    //   - "all"             → null (every failed task in scope)
    //   - positive number   → that many ms
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/progress')) {
      const parsedUrl = new URL(req.url, 'http://localhost')
      const failedWindowParam = parsedUrl.searchParams.get('failedWindow')
      let failedWindowMs: number | null = 24 * 60 * 60 * 1000
      if (failedWindowParam === 'all') {
        failedWindowMs = null
      } else if (failedWindowParam !== null) {
        const parsed = Number(failedWindowParam)
        if (!Number.isNaN(parsed) && parsed > 0) failedWindowMs = parsed
      }
      deps
        .viewProgress({ failedWindowMs })
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

    // GET /view/todo — draft proposals + open stale-worktree alerts for the
    // Todo tab. The daemon is the sole reader of its own DB; the UI server
    // proxies this endpoint instead of querying state.db directly. Pure read;
    // no draining gate.
    if (req.method === 'GET' && req.url === '/view/todo') {
      deps
        .viewTodo()
        .then((body) => sendJson(res, 200, body))
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

    // GET /view/action-queue?filter=open|dismissed|all — the full derived actionQueue view.
    // The daemon builds this from its own database and is the sole source of
    // truth; the read-only UI proxies this endpoint instead of re-deriving it.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/action-queue')) {
      const parsed = new URL(req.url, 'http://localhost')
      const filterRaw = parsed.searchParams.get('filter')
      const filter: DerivedActionQueueFilter =
        filterRaw === 'dismissed' || filterRaw === 'all' ? filterRaw : 'open'
      deps
        .viewActionQueue(filter)
        .then((rows) => sendJson(res, 200, rows))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /view/action-queue/{ack,resolve,dismiss} — actionQueue mutation verbs. These
    // are UI-state writes (operator opinion), not work-dispatch actions, so
    // they are NOT gated by isAcceptingWork(). Accepted body:
    //   { kind: 'task' | 'worktree' | 'proposal', entityId: string }
    {
      const actionQueueVerbMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/view\/action-queue\/(ack|resolve|dismiss)$/)
          : null
      if (actionQueueVerbMatch && actionQueueVerbMatch[1]) {
        const verb = actionQueueVerbMatch[1] as 'ack' | 'resolve' | 'dismiss'
        let rawBody: string = ''
        req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
        req.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(rawBody)
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const body = parsed as Record<string, unknown>
          const kind = body.kind
          const entityId = body.entityId
          if (kind !== 'task' && kind !== 'worktree' && kind !== 'proposal') {
            sendJson(res, 400, {
              ok: false,
              error: `kind must be 'task', 'worktree', or 'proposal'; got: ${String(kind)}`,
            })
            return
          }
          if (typeof entityId !== 'string' || entityId.length === 0) {
            sendJson(res, 400, { ok: false, error: 'entityId must be a non-empty string' })
            return
          }
          const handler =
            verb === 'ack' ? deps.actionQueueAck
            : verb === 'resolve' ? deps.actionQueueResolve
            : deps.actionQueueDismiss
          handler(kind, entityId)
            .then(() => sendJson(res, 200, { ok: true }))
            .catch((err: unknown) => sendError(res, err))
        })
        return
      }
    }

    // POST /view/todo/dismiss — dismiss a Todo-tab item (draft proposal or
    // stale worktree). UI-state write, NOT gated by isAcceptingWork().
    // Accepted body: { kind: 'draft' | 'stale', id: string }
    if (req.method === 'POST' && req.url === '/view/todo/dismiss') {
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
        const body = parsed as Record<string, unknown>
        const kind = body.kind
        const id = body.id
        if (kind !== 'draft' && kind !== 'stale') {
          sendJson(res, 400, {
            ok: false,
            error: `kind must be 'draft' or 'stale'; got: ${String(kind)}`,
          })
          return
        }
        if (typeof id !== 'string' || id.length === 0) {
          sendJson(res, 400, { ok: false, error: 'id must be a non-empty string' })
          return
        }
        deps.todoDismiss(kind, id)
          .then(() => sendJson(res, 200, { ok: true }))
          .catch((err: unknown) => sendError(res, err))
      })
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
