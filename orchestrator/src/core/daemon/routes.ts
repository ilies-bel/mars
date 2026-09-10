/**
 * The daemon's local HTTP API route table: every `GET`/`POST`/`DELETE`
 * handler the daemon exposes over `127.0.0.1`, split out of `http-server.ts`
 * so the daemon's process/socket lifecycle (`startHttpServer` in
 * `http-server.ts`) and its web surface (this module, plus static-asset
 * serving in `ui-serve.ts`) are separately readable. `HttpServerDeps`, the
 * wire-shape interfaces, and `HttpServerHandle` remain in `http-server.ts`
 * as the public contract module; this file is a thin transport over them.
 *
 * Route registration is `registerRoutes(deps)`, which builds a plain request
 * listener matching each route sequentially by method + `req.url` and
 * returns it alongside the live-socket set `startHttpServer` needs: it binds
 * the listener with `createServer(listener)` and tracks connections itself
 * so shutdown can force-end keep-alive clients (e.g. `/view/stream`).
 */
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FAILURE_KINDS } from '../lib/failure-kinds'
import { getProvider } from '../lib/deployment/registry'
import { buildOriginTree } from '../lib/origin-tree'
import type { DerivedActionQueueFilter } from './view/action-queue'
import { groupActionQueueRows } from './view/action-queue-group'
import {
  cursorAfter,
  type TraceEventFilter,
  type TraceEventPhase,
  type TraceEventSeverity,
  type TraceEventStore,
} from '../lib/trace-events-store'
import { isUnifiedEventKind, type UnifiedEventKind } from '../../bus/emit.js'
import { type KpiKey } from './kpi-store'
import type { RestartTaskError } from './restart-task'
import { SelfUpdateError, SELF_UPDATE_ERRORS } from './self-update'
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
  closeSubject,
  archiveSubthread,
  unarchiveSubthread,
  deleteSubthread,
  startThreadForQueueItem,
  setThreadStatus,
  appendMessage,
} from '../lib/chat-store'
import { classifyMarsVerb } from '../lib/chat-mars-verbs'
import {
  persistLeverAutonomyLevel,
  readControlLevers,
  readPersistedPaused,
  loadDaemonConfig,
  persistPaused,
  writeControlLever,
  type ControlLevers,
  type DaemonCaps,
} from './config'
import type { DispatchPauseState } from './pause-state'
import { archiveEntry } from '../archive/insert.js'
import {
  assembleDelta,
  clampWywaDeltaLimit,
} from './view/wywa-delta'
import { wouldHaveFiredOnMany, type MatcherBreadth } from '../lib/matcher-breadth'
import { listStewardLedgerFor, listStewardLedgerSince } from '../steward-ledger'
import type { AttachmentInfo } from './chat-runner'
import type { SeqChunk } from './chat-contracts'
import { listTasksForThread } from './chat-thread-tasks'
import { getRepoRoot, getStateDir } from '../context'
import { z } from 'zod'
import type { HttpServerDeps } from './http-server'
import { streamPngAsset } from './ui-serve'
import {
  ActionQueueItemNotFoundError,
  recordNoticeDismissal,
  setActionQueueState,
} from '../lib/action-queue'
import {
  VerifyGateInputSchema,
  addVerifyGate,
  listVerifyGates,
  removeVerifyGate,
  restoreVerifyGate,
} from '../verify-gates'
import { getFlowByArcId } from '../domain-flow/store'
import { renderDomainFlow } from '../domain-flow/render'

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
  if (err instanceof ActionQueueItemNotFoundError) {
    sendJson(res, 404, { ok: false, error: err.message })
    return
  }
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
  const errCode = err instanceof Error ? (err as unknown as Record<string, unknown>).code : undefined
  if (errCode === 'NOT_IMPLEMENTED') {
    sendJson(res, 501, { ok: false, error: message })
    return
  }
  sendJson(res, 500, { ok: false, error: message })
}

/**
 * The per-entity action routes, keyed by the `op` the error-kind registry
 * declares. Each maps `POST /actions/:op/:id` to the matching daemon handler.
 * `restart-daemon` is handled separately (it has no `:id`).
 */
type EntityOp =
  | 'restart'
  | 'continue'
  | 'remerge'
  | 'unblock'
  | 'purge'
  | 'prune-worktree'
  | 'dismiss'
  | 'dismiss-daemon-died'
  | 'dismiss-uncovered'
  | 'validate'
  | 'reject'
  | 'land-work'
  | 'gate-restore'
  | 'add-gate'
  | 'enrich-retire'
  | 'stop-asking-reflect'
  | 'approve-step'
  | 'abort-release'

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

/**
 * Accept any kind in the unified union (bus `EventName` ∪ trace-only
 * `TraceEventKind`, see `bus/emit.ts`) — `GET /events` reads the unified
 * `trace_events` store, which now carries rows for both halves.
 */
const filterKinds = (raw: string[]): UnifiedEventKind[] =>
  raw.filter((v): v is UnifiedEventKind => isUnifiedEventKind(v))

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
 * Handle a `GET /events?...` request. Reads from the unified `trace_events`
 * store with the parsed filter — every `UnifiedEventKind` (bus `EventName`s
 * written by `emitEvent` alongside their `events` outbox row, plus the
 * trace-only kinds) is reachable here, not just the formerly bus-only kinds'
 * subscribers — then attaches `nextCursor` (the cursor pointing one past the
 * last row) when the page is full — signalling more rows are available.
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
 * The daemon's local HTTP API route table (a non-exhaustive highlight reel —
 * see the route dispatch below for the full, current list). Notably:
 *
 *   GET  /failure-kinds          → the signature-keyed Failure-kind registry
 *   GET  /recipes                → the resolved recovery-recipe catalog
 *   GET  /events?...             → unified trace events (taskId, kind, etc.)
 *   GET  /origins/:taskId        → the origin tree for a task
 *   GET  /alerts                 → the arc-rooted Alert list (read aggregate)
 *   GET  /alerts/next            → the top Alert for the hero next-action shortcut
 *   GET  /alerts/:arcId          → the single arc-rooted Alert (or 404)
 *   POST /alerts/:arcId/thread   → pull an Alert into a chat thread ({ threadId })
 *   POST /tasks/:id/question     → raise a task.question outbox event ({ question })
 *   POST /actions/restart/:id    → re-queue a failed/daemon-killed task
 *   POST /actions/continue/:id   → resume a failed task on its existing worktree
 *   POST /actions/resume-dispatch → resume dispatch (process-level, no entity id)
 *   POST /actions/unblock/:id    → phantom-recover a blocked task
 *   POST /actions/purge/:id      → drop a task + worktree
 *   POST /actions/prune-worktree/:id → remove a stale worktree
 *   POST /actions/dismiss/:id             → dismiss a draft proposal (draft → dismissed)
 *   POST /actions/dismiss-daemon-died/:id → acknowledge daemon-died (delete crash marker)
 *   POST /actions/promote/:id    → promote a draft → prd-ready + slice → { ok, taskIds }
 *   POST /actions/validate/:id   → approve a preview-gated task (→ merge)
 *   POST /actions/reject/:id     → reject a preview-gated task (→ failed)
 *   POST /actions/restart-daemon       → re-exec the daemon
 *   POST /actions/run-reflect          → run reflect flow + clear reflect-recommended row
 *   POST /actions/land-work/:id        → merge ahead commits onto integration branch
 *   GET  /view/verify-gates            → list all verify gates
 *   POST /verify-gates                 → add a verify gate ({ id })
 *   DELETE /verify-gates/:id           → remove a verify gate
 *   POST /verify-gates/:id/restore     → restore a quarantined gate (config write)
 *   POST /actions/dismiss-verify-uncovered/:id → dismiss open verify-uncovered AQ row
 *   POST /view/scorer-dismiss          → permanently dismiss a suggested scorer ({ scorer })
 *   POST /actions/stop-asking-reflect/:id → permanently dismiss reflect-recommended notice
 *   POST /gates                        → add a gate via app-service layer ({ ok, gate })
 *   DELETE /gates/:id                  → remove a gate via app-service layer
 *
 * Socket binding, listening, and the OS-assigned port are owned by
 * `startHttpServer` in `http-server.ts`, not this module.
 */

/** Signature Node's `http.createServer` accepts as its request listener. */
export type HttpRequestListener = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) => void

/**
 * Build the daemon's local HTTP API route table as a plain request listener,
 * decoupled from binding/listening a socket. This is the seam that splits
 * the daemon's transport concerns apart: route registration (this module),
 * static-asset serving (`ui-serve.ts`), and socket lifecycle
 * (`startHttpServer` in `http-server.ts`, which additionally owns
 * listen()/close() and the open-socket tracking needed for a clean
 * shutdown — pass its returned `openSockets` to `server.on('connection', ...)`
 * so shutdown can force-end keep-alive clients like `/view/stream`).
 */
export const registerRoutes = (
  deps: HttpServerDeps,
): { listener: HttpRequestListener; openSockets: Set<import('node:net').Socket> } => {
  const entityHandlers: Record<EntityOp, (id: string) => Promise<void>> = {
    restart: deps.restartTask,
    continue: deps.continueTask,
    remerge: deps.remergeTask,
    unblock: deps.unblockTask,
    purge: deps.purgeTask,
    'prune-worktree': deps.pruneWorktree,
    dismiss: deps.dismissProposal,
    'dismiss-daemon-died': async (_id) => {
      if (!deps.dismissDaemonDied) {
        throw Object.assign(new Error('dismiss-daemon-died not implemented'), { code: 'NOT_IMPLEMENTED' as const })
      }
      await deps.dismissDaemonDied()
    },
    'dismiss-uncovered': async (id) => {
      if (!deps.dismissUncovered) {
        throw Object.assign(new Error('dismiss-uncovered not implemented'), { code: 'NOT_IMPLEMENTED' as const })
      }
      await deps.dismissUncovered(id)
    },
    validate: deps.validateTask,
    reject: deps.rejectTask,
    'land-work': deps.landWork,
    'gate-restore': async (id) => {
      if (!deps.handleGateRestore) {
        throw Object.assign(new Error('gate-restore not implemented'), { code: 'NOT_IMPLEMENTED' as const })
      }
      await deps.handleGateRestore(id)
    },
    'add-gate': async (id) => {
      if (!deps.addGateFromItem) {
        throw Object.assign(new Error('add-gate not implemented'), { code: 'NOT_IMPLEMENTED' as const })
      }
      await deps.addGateFromItem(id)
    },
    'enrich-retire': async (id) => {
      if (!deps.handleEnrichRetire) {
        throw Object.assign(new Error('enrich-retire not implemented'), { code: 'NOT_IMPLEMENTED' as const })
      }
      await deps.handleEnrichRetire(id)
    },
    'stop-asking-reflect': async (id) => {
      if (!deps.stopAskingReflect) {
        throw Object.assign(new Error('stop-asking-reflect not implemented'), { code: 'NOT_IMPLEMENTED' as const })
      }
      await deps.stopAskingReflect(id)
    },
    'approve-step': async (id) => {
      if (!deps.approveStep) {
        throw Object.assign(new Error('approve-step not implemented'), { code: 'NOT_IMPLEMENTED' as const })
      }
      await deps.approveStep(id)
    },
    'abort-release': async (id) => {
      if (!deps.abortRelease) {
        throw Object.assign(new Error('abort-release not implemented'), { code: 'NOT_IMPLEMENTED' as const })
      }
      await deps.abortRelease(id)
    },
  }

  // Track live sockets so close() can force-end long-lived connections (e.g.
  // the /view/stream SSE channel) instead of hanging forever: Node's
  // server.close() stops accepting new connections but only invokes its
  // callback once every existing connection ends on its own, and a
  // keep-alive SSE client never ends one voluntarily. Ownership of this set
  // is handed back to the caller (see {@link startHttpServer}) because only
  // the listen()/close() owner can register the 'connection' listener that
  // populates it.
  const openSockets = new Set<import('node:net').Socket>()
  const listener: HttpRequestListener = (req, res) => {
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
    // WYWA delta. Each row carries `autoRunCount` (past actual firings) and
    // `breadth` (ADR-0099 MatcherBreadth: past failures this signature would
    // have exactly/family-matched, computed by `listLearnedRecipes()` itself)
    // — both flow through verbatim, no extra shaping needed here. Pure read;
    // no draining gate.
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

    // GET /view/daemon-version — expose the daemon's git SHAs so the UI server
    // can detect "daemon running older code" and return a structured remedy
    // instead of forwarding a raw 404/405. Pure read; no draining gate.
    // Returns { sourceSha, currentSha, isStale } — null SHAs on prod installs
    // or when git was unavailable at startup.
    if (req.method === 'GET' && req.url === '/view/daemon-version') {
      const shas = deps.getDaemonShas?.() ?? { sourceSha: null, currentSha: null, isStale: false }
      sendJson(res, 200, shas)
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

    // GET /events — unified event surface (bus + trace). Supports multi-filter
    // querying (taskId, originId, kind[], severity[], phase[], since, until,
    // q) plus cursor pagination. `kind` accepts any `UnifiedEventKind` — a
    // bus `EventName` (e.g. 'step.started') or a trace-only kind — since
    // `emitEvent` (bus/emit.ts) writes both into the same `trace_events`
    // table. Newest-first ordering. The per-task actionQueue panel always
    // passes `?taskId=...&limit=50`; the dedicated Events tab uses the
    // broader filter surface. Pure read; no draining gate.
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

    // GET /kpi/cost-per-merged-task?days=30 — cache-weighted token usage and
    // provider cost aggregated per completed (status='done') task for the
    // given rolling window (Phase 4A, PRD 74d76a78). Returns current aggregate
    // plus a 30-day trend series. Pure read; no draining gate.
    // Returns 503 when the dep is not wired up (test / read-only environments).
    if (req.method === 'GET' && req.url && req.url.startsWith('/kpi/cost-per-merged-task')) {
      if (!deps.getCostPerMergedTaskKpi) {
        sendJson(res, 503, { ok: false, error: 'getCostPerMergedTaskKpi not available' })
        return
      }
      const parsed = new URL(req.url, 'http://localhost')
      const daysRaw = parsed.searchParams.get('days')
      const windowDays =
        daysRaw !== null && Number.isFinite(Number.parseInt(daysRaw, 10)) && Number.parseInt(daysRaw, 10) > 0
          ? Number.parseInt(daysRaw, 10)
          : 30
      deps.getCostPerMergedTaskKpi({ windowDays })
        .then((kpi) => sendJson(res, 200, kpi))
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

    // GET /view/domain-flow/:arcId — Domain Flow for an Arc.
    // Returns { flow: DomainFlow, rendered: string } when a flow exists for the arc.
    // Returns 404 { error: 'no flow' } when no flow has been recorded.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/domain-flow/')) {
      const arcId = decodeURIComponent(req.url.slice('/view/domain-flow/'.length))
      if (!arcId) {
        sendJson(res, 400, { error: 'arcId is required' })
        return
      }
      getFlowByArcId(resolveStateClient(), arcId)
        .then((flow) => {
          if (flow === null) {
            sendJson(res, 404, { error: 'no flow' })
          } else {
            const rendered = renderDomainFlow(flow)
            sendJson(res, 200, { flow, rendered })
          }
        })
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/task/:id/live — live-task panel data for awaiting-human tasks.
    // Returns { stepGuide, doneCriteria, notes } or 404 when the task is not
    // found or is not in status='awaiting-human'. Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/task/') && req.url.endsWith('/live')) {
      const urlPart = req.url.slice('/view/task/'.length, -'/live'.length)
      const id = decodeURIComponent(urlPart)
      if (!id) {
        sendJson(res, 400, { error: 'id is required' })
        return
      }
      import('./view/live-task.js')
        .then((m) => m.buildLiveTaskView(id))
        .then((result) => {
          if (result === null) {
            sendJson(res, 404, { error: 'not_found_or_not_parked', id })
          } else {
            sendJson(res, 200, result)
          }
        })
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/task/:id/changes — per-file diff summary, patch, and commits for
    // a task. Works for live tasks (computes merge-base to HEAD) and done tasks
    // (reads the worktree tombstone for the landed sha). Returns the
    // branch-gone shape with 200 when the diff cannot be computed. Pure read;
    // no draining gate.
    if (
      req.method === 'GET' &&
      req.url &&
      req.url.startsWith('/view/task/') &&
      req.url.endsWith('/changes')
    ) {
      const urlPart = req.url.slice('/view/task/'.length, -'/changes'.length)
      const id = decodeURIComponent(urlPart)
      if (!id) {
        sendJson(res, 400, { error: 'id is required' })
        return
      }
      deps.appServices
        .viewTaskChanges(id)
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/hot-paths?window=30d|90d|all&group=file|dir — per-file or
    // per-directory change frequency over a rolling window. Ranked list of the
    // 60 most-touched paths with task attribution. Results are cached on the
    // integration branch's HEAD sha so they stay free within one commit and
    // invalidate automatically on the next commit.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/hot-paths')) {
      const urlObj = new URL(req.url, 'http://localhost')
      const rawWindow = urlObj.searchParams.get('window') ?? '90d'
      const rawGroup = urlObj.searchParams.get('group') ?? 'file'
      const window =
        rawWindow === '30d' || rawWindow === '90d' || rawWindow === 'all'
          ? (rawWindow as '30d' | '90d' | 'all')
          : ('90d' as const)
      const group = rawGroup === 'dir' ? ('dir' as const) : ('file' as const)
      deps.appServices
        .viewHotPaths({ window, group })
        .then((body) => sendJson(res, 200, body))
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

    // GET /view/operator — live operator-control state: dispatch-pause state,
    // control levers (recovery/scoring/memoryCapture/autoRunReflect), and
    // concurrency caps. All fields are readable without a draining gate.
    //
    // dispatch: the live in-memory PauseState when deps.getPauseState is wired
    // (daemon process); falls back to { paused: <persisted>, reason: null, … }
    // for read-only consumers (UI server, test stubs).
    if (req.method === 'GET' && req.url === '/view/operator') {
      try {
        const pauseState: DispatchPauseState = deps.getPauseState
          ? deps.getPauseState()
          : {
              paused: readPersistedPaused(),
              reason: null,
              since: null,
              detail: null,
            }
        const controlLevers: ControlLevers = readControlLevers()
        const cfg = loadDaemonConfig()
        const caps: DaemonCaps = cfg.caps
        sendJson(res, 200, { dispatch: pauseState, controlLevers, caps })
      } catch (err: unknown) {
        sendError(res, err)
      }
      return
    }

    // GET /view/verify-gates — full list of verify gate rows, ordered by scope
    // then creation time. Returns { gates: VerifyGate[] }. Bypasses the draining
    // gate — read-only, no side effects.
    if (req.method === 'GET' && req.url === '/view/verify-gates') {
      listVerifyGates()
        .then((gates) => sendJson(res, 200, { gates }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /operator/dispatch — toggle dispatch on or off. Body: { value: 'on' | 'off' }.
    // Persists the choice to daemon.json (survives restarts) and applies it to
    // the live in-memory pause controller. Mirrors `mars operator set dispatch <on|off>`.
    // Returns 503 when not wired in test/read-only mode.
    if (req.method === 'POST' && req.url === '/operator/dispatch') {
      if (!deps.pauseDispatch || !deps.resumeDispatch) {
        sendJson(res, 503, { ok: false, error: 'dispatch control not available in this context' })
        return
      }
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
        const schema = z.object({ value: z.enum(['on', 'off']) })
        const result = schema.safeParse(parsed)
        if (!result.success) {
          sendJson(res, 400, { ok: false, error: "value is required and must be 'on' or 'off'" })
          return
        }
        const { value } = result.data
        try {
          if (value === 'off') {
            persistPaused(true)
            deps.pauseDispatch!('operator', 'http operator set dispatch off')
            const state = deps.getPauseState ? deps.getPauseState() : { paused: true, reason: 'operator' as const, since: null, detail: null }
            sendJson(res, 200, { ok: true, data: { paused: true, reason: state.reason } })
          } else {
            persistPaused(false)
            deps.resumeDispatch!()
            const resetStorm = deps.resetSignatureStorm ? deps.resetSignatureStorm() : Promise.resolve()
            resetStorm
              .then(() => {
                deps.drainDispatch?.()
                sendJson(res, 200, { ok: true, data: { paused: false } })
              })
              .catch((err: unknown) => sendError(res, err))
          }
        } catch (err: unknown) {
          sendError(res, err)
        }
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // POST /operator/recovery — toggle the recovery kill-switch on or off.
    // Body: { value: 'on' | 'off' }. Persists to daemon.json and applies to
    // the running process env. Mirrors `mars operator set recovery <on|off>`.
    if (req.method === 'POST' && req.url === '/operator/recovery') {
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
        const schema = z.object({ value: z.enum(['on', 'off']) })
        const result = schema.safeParse(parsed)
        if (!result.success) {
          sendJson(res, 400, { ok: false, error: "value is required and must be 'on' or 'off'" })
          return
        }
        const { value } = result.data
        try {
          // Persisting is the whole apply: consumers resolve the lever from
          // daemon.json on each use, so the change is live immediately.
          writeControlLever('recovery', value)
          sendJson(res, 200, { ok: true, data: { recovery: value } })
        } catch (err: unknown) {
          sendError(res, err)
        }
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // POST /operator/:lever — generic control-lever write. Handles all named
    // boolean control levers: recovery, scoring, memory-capture, auto-run-reflect,
    // operator-auto-commit. Each maps to a ControlLevers key in daemon.json via
    // writeControlLever(). Rejects unknown lever names with 400 (naming the valid
    // set) and invalid values with 400. `dispatch` is intentionally excluded —
    // it requires live in-memory state manipulation handled by the dedicated
    // POST /operator/dispatch route above (which is matched first for that path).
    {
      const operatorLeverMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/operator\/([^/?]+)(?:\?.*)?$/)
          : null
      if (operatorLeverMatch && operatorLeverMatch[1]) {
        const leverName = decodeURIComponent(operatorLeverMatch[1])

        /**
         * Mapping from CLI-style kebab-case lever names to ControlLevers keys.
         * Derived from the same mapping the CLI's `operator set` command uses
         * (src/cli/commands/operator.ts), so the two surfaces cannot drift.
         */
        const LEVER_KEY_MAP: Record<string, keyof ControlLevers> = {
          recovery: 'recovery',
          scoring: 'scoring',
          'memory-capture': 'memoryCapture',
          'auto-run-reflect': 'autoRunReflect',
          'operator-auto-commit': 'operatorAutoCommit',
        }

        if (!(leverName in LEVER_KEY_MAP)) {
          sendJson(res, 400, {
            ok: false,
            error: `unknown lever '${leverName}'; valid levers: ${Object.keys(LEVER_KEY_MAP).join(', ')}`,
          })
          return
        }

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
          const schema = z.object({ value: z.enum(['on', 'off']) })
          const result = schema.safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, { ok: false, error: "value is required and must be 'on' or 'off'" })
            return
          }
          try {
            const configKey = LEVER_KEY_MAP[leverName]!
            writeControlLever(configKey, result.data.value)
            sendJson(res, 200, { ok: true, data: { [leverName]: result.data.value } })
          } catch (err: unknown) {
            sendError(res, err)
          }
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
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

    // GET /view/adrs — list docs/knowledge/decisions/*.md as {number,title,slug}, newest first.
    // Returns { adrs: [] } when docs/knowledge/decisions/ does not exist. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/adrs') {
      const adrDir = join(getRepoRoot(), 'docs', 'knowledge', 'decisions')
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

    // GET /view/counts — unified count of all task lifecycle buckets plus
    // proposals, so every UI surface reads from one source. Extends
    // /view/status-counts with verifying, merging, queued, blocked, and
    // proposals.{draft,total}. needsYou is sourced from the action queue feed
    // (same predicate as /view/status-counts) to include derived conditions.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/counts') {
      deps.appServices
        .viewCounts()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /view/status-counts — canonical operational counts in one query.
    // Returns { running, recovering, needYou, failed, doneToday } so every
    // UI surface that renders these numbers fetches from one source instead
    // of computing per-page. Pure read; no draining gate.
    if (req.method === 'GET' && req.url === '/view/status-counts') {
      deps.appServices
        .viewStatusCounts()
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

    // GET /view/primitives — all public-facing registered primitives (those
    // with a description), including operator-registered ones. Returns name,
    // one-line description, trace phase, and executor. Pure read; no draining gate.
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

    // GET /view/proposals[?source=…&status=…&limit=…&cursor=…] — paginated
    // proposals + open stale-worktree alerts for the proposals/alerts surface.
    // Accepts query parameters: `source` (ProposalSource), `status` (proposal
    // lifecycle status), `limit` (1–200, default 50), and `cursor` (opaque
    // offset string returned as `nextCursor` in the previous page). The
    // response always includes `total` (matching count before pagination) and
    // `nextCursor` (null when the last page has been reached).
    // The daemon is the sole reader of its own DB; the UI server proxies this
    // endpoint instead of querying the database directly. Pure read; no drain.
    if (req.method === 'GET' && req.url && /^\/view\/proposals(?:\?|$)/.test(req.url)) {
      const parsed = new URL(req.url, 'http://localhost')
      const viewProposalsOpts: Parameters<AppServices['viewProposals']>[0] = {}
      const sourceParam = parsed.searchParams.get('source')
      if (sourceParam !== null) viewProposalsOpts.source = sourceParam as ProposalSource
      const statusParam = parsed.searchParams.get('status')
      if (statusParam !== null) viewProposalsOpts.status = statusParam
      const limitRaw = parsed.searchParams.get('limit')
      if (limitRaw !== null) {
        const n = Number.parseInt(limitRaw, 10)
        if (Number.isFinite(n) && n > 0) viewProposalsOpts.limit = n
      }
      const cursorParam = parsed.searchParams.get('cursor')
      if (cursorParam !== null) viewProposalsOpts.cursor = cursorParam
      deps.appServices
        .viewProposals(viewProposalsOpts)
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

    // GET /view/steward — capability summary for the Steward page:
    // runtimeTuning (executing), workflowPatches (built/never invoked),
    // signatureStorm (live, currently tripped), agentSpec (declared/unbuilt),
    // and gateHealth (the read-only verify-gate registry projection).
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

    // GET /view/scorer-suggestions — suggested scorers not yet accepted or dismissed.
    // Returns { scorers: Scorer[] } ordered by created_at desc. Pure read; no drain.
    if (req.method === 'GET' && req.url === '/view/scorer-suggestions') {
      deps.appServices
        .viewScorerSuggestions()
        .then((body) => sendJson(res, 200, body))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // POST /view/scorer-accept — accept a suggested scorer by id. Body: { id: string }.
    // Routes through the same acceptScorer() path as `mars scorer accept <id>`.
    if (req.method === 'POST' && req.url === '/view/scorer-accept') {
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
        const parsed = z.object({ id: z.string().min(1) }).safeParse(body)
        if (!parsed.success) {
          sendJson(res, 400, { error: 'id is required' })
          return
        }
        deps.appServices
          .acceptScorerById(parsed.data.id)
          .then((result) => sendJson(res, 200, result))
          .catch((err: unknown) => sendError(res, err))
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // POST /view/scorer-dismiss — permanently dismiss a suggested scorer by id.
    // Body: { id: string }. Routes through dismissScorerById() which sets the
    // scorer's status to 'dismissed', preventing the same fingerprint from being
    // re-suggested ("stop asking me that" for scorer-suggested items).
    if (req.method === 'POST' && req.url === '/view/scorer-dismiss') {
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
        const parsed = z.object({ id: z.string().min(1) }).safeParse(body)
        if (!parsed.success) {
          sendJson(res, 400, { error: 'id is required' })
          return
        }
        deps.appServices
          .dismissScorerById(parsed.data.id)
          .then((result) => sendJson(res, 200, result))
          .catch((err: unknown) => sendError(res, err))
      })
      req.on('error', (err: unknown) => sendError(res, err))
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

    // GET /arc/:originId/qa/screenshot/:criterionIndex/:stepIndex — stream a
    // single PNG screenshot captured during a behaviour-verification walk.
    // The file lives at .mars/arc-qa/<originId>/<criterionIndex>/<stepIndex>.png.
    // criterionIndex and stepIndex must be non-negative integers (all-digit
    // strings); anything else — including `.` / `..` / slashes — is rejected
    // with 400 to prevent path traversal. Returns 404 when the file is absent.
    // Must be matched BEFORE the /arc/:originId/qa manifest route because its
    // path is a strict prefix extension of that route.
    // The actual byte-streaming lives in ui-serve.ts (the daemon's one static-
    // asset surface); this block only matches the route and validates params.
    {
      const screenshotMatch =
        req.method === 'GET' && req.url
          ? req.url.match(
              /^\/arc\/([^/?]+)\/qa\/screenshot\/([^/?]+)\/([^/?]+)(?:\?.*)?$/,
            )
          : null
      if (screenshotMatch && screenshotMatch[1] && screenshotMatch[2] && screenshotMatch[3]) {
        const originId = decodeURIComponent(screenshotMatch[1])
        const criterionIndex = screenshotMatch[2]
        const stepIndex = screenshotMatch[3]

        // Reject path-traversal attempts: originId must not contain `..` or `/`;
        // criterionIndex and stepIndex must be all-digit strings.
        if (
          originId.includes('..') ||
          originId.includes('/') ||
          originId.startsWith('\0') ||
          !/^\d+$/.test(criterionIndex) ||
          !/^\d+$/.test(stepIndex)
        ) {
          sendJson(res, 400, { error: 'invalid path parameter' })
          return
        }

        const filePath = join(
          getStateDir(),
          'arc-qa',
          originId,
          criterionIndex,
          `${stepIndex}.png`,
        )
        streamPngAsset(res, filePath)
        return
      }
    }

    // GET /arc/:originId/qa — per-Arc QA manifest JSON. Reads the manifest
    // written by the behaviour-verification step from
    // .mars/arc-qa/<originId>/manifest.json. Returns { error: 'no manifest' }
    // with 404 when no pass has run yet for the arc.
    // originId must not contain `..` or `/` to prevent path traversal (400).
    {
      const arcQaMatch =
        req.method === 'GET' && req.url
          ? req.url.match(/^\/arc\/([^/?]+)\/qa(?:\?.*)?$/)
          : null
      if (arcQaMatch && arcQaMatch[1]) {
        const originId = decodeURIComponent(arcQaMatch[1])
        if (originId.includes('..') || originId.includes('/') || originId.startsWith('\0')) {
          sendJson(res, 400, { error: 'invalid originId' })
          return
        }
        import('../lib/arc-qa-manifest.js')
          .then((m) => m.loadArcQaManifest(originId, getStateDir()))
          .then((manifest) => {
            if (manifest === null) {
              sendJson(res, 404, { error: 'no manifest' })
            } else {
              sendJson(res, 200, manifest)
            }
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /view/deep-reflections/:originId — full detail for one arc reflection
    // report, including the complete report body, dissonant calls, verify
    // mismatches, and thrashing patterns. Returns 404 when no matching report
    // file is found. Pure read; no draining gate.
    // The optional `?at=<recordedAt>` parameter disambiguates when multiple
    // report files share the same originId.
    {
      const drMatch = req.method === 'GET' && req.url
        ? req.url.match(/^\/view\/deep-reflections\/([^/?]+)(?:\?.*)?$/)
        : null
      if (drMatch && drMatch[1]) {
        const originId = decodeURIComponent(drMatch[1])
        const parsedUrl = new URL(req.url!, 'http://localhost')
        const at = parsedUrl.searchParams.get('at') ?? undefined
        deps.appServices
          .viewDeepReflection(originId, at)
          .then((detail) => {
            if (detail === null) {
              sendJson(res, 404, { ok: false, error: 'report not found' })
            } else {
              sendJson(res, 200, detail)
            }
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /view/deep-reflections?limit=N — list all arc reflection reports,
    // newest-first, with headline counts. Reads from .mars/deep-reflections/.
    // Pure read; no draining gate.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/deep-reflections')) {
      const parsed = new URL(req.url, 'http://localhost')
      const opts: { limit?: number } = {}
      const limitRaw = parsed.searchParams.get('limit')
      if (limitRaw !== null) {
        const n = Number.parseInt(limitRaw, 10)
        if (Number.isFinite(n) && n > 0) opts.limit = n
      }
      deps.appServices
        .viewDeepReflections(opts)
        .then((result) => sendJson(res, 200, result))
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
    // `recovery.spawned` trace events, auto-recipe runs, throttled chat threads, and
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
          kind: ['recovery.spawned'],
          ...(since !== null ? { sinceMs: Date.parse(since) } : {}),
          limit: 200,
        }),
        import('../lib/learned-recipes.js').then((m) =>
          m.listAutoRecipeRuns({ since: since ?? undefined, limit: 200 }),
        ),
        import('../lib/chat-store.js').then((m) =>
          Promise.all([m.listClosedSubjects(), m.listThreads()]),
        ),
        listStewardLedgerSince(since ?? '0001-01-01T00:00:00.000Z'),
      ])
        .then(async ([releaseNotes, recoveryEvents, autoRuns, [closedRaw, allThreads], stewardLedger]) => {
          const throttledThreads = allThreads
            .filter((t) => t.status === 'throttled')
            .map((t) => ({ id: t.id, updatedAt: new Date(t.updated_at).toISOString() }))

          const closedSubthreads = closedRaw
            .filter((t): t is typeof t & { closed_at: number } => t.closed_at !== null)
            .map((t) => ({ id: t.id, closedAt: new Date(t.closed_at).toISOString() }))

          // ADR-0099 breadth: one batched query over the distinct auto-recipe
          // signatures in this page, rather than one query per row.
          const distinctSignatures = [...new Set(autoRuns.map((run) => run.signature))]
          const autoRunBreadth = await wouldHaveFiredOnMany(distinctSignatures).catch(
            () => new Map<string, MatcherBreadth>(),
          )

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
            autoRunBreadth,
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

    // GET /view/action-queue?filter=open|all[&kinds=csv] — the full derived
    // actionQueue view. The action queue is a pure projection of entity state;
    // the Invalidator is the sole row-closer. Pure read; no draining gate.
    // `kinds` is an optional comma-separated list of action-queue kinds to
    // return; when present, only matching rows are enriched and returned.
    if (req.method === 'GET' && req.url && req.url.startsWith('/view/action-queue')) {
      const parsed = new URL(req.url, 'http://localhost')
      const filterRaw = parsed.searchParams.get('filter')
      const filter: DerivedActionQueueFilter =
        filterRaw === 'all' ? filterRaw : 'open'
      const kindsRaw = parsed.searchParams.get('kinds')
      const kinds: ReadonlySet<string> | undefined =
        kindsRaw
          ? new Set(kindsRaw.split(',').map((k) => k.trim()).filter(Boolean))
          : undefined
      deps.appServices
        .viewActionQueue(filter, kinds ? { kinds } : undefined)
        .then((rows) => groupActionQueueRows(rows))
        .then((grouped) => sendJson(res, 200, grouped))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // GET /archive — archive entries ordered by occurred_at DESC. Returns all
    // resolved alerts, ack'd notices, and silently-completed tasks. Pure read.
    if (req.method === 'GET' && req.url && req.url.startsWith('/archive')) {
      resolveStateClient()
        .execute(
          `SELECT id, kind, source_kind, source_id, occurred_at, provenance
             FROM archive_entries
            ORDER BY occurred_at DESC`,
        )
        .then((result) => sendJson(res, 200, { entries: result.rows }))
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

    // POST /presence — UI client heartbeat. Records the last-seen timestamp in
    // `presence_pings` and writes one row to `presence_transitions` when the
    // gap since the previous ping meets or exceeds `thresholdMs` (default
    // 300 000 ms / 5 min). Returns { ok: true, ts }. Bypasses the draining
    // gate — lightweight presence write, not task work.
    if (req.method === 'POST' && req.url === '/presence') {
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        let parsed: unknown = {}
        try {
          if (rawBody.trim().length > 0) parsed = JSON.parse(rawBody)
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const presenceSchema = z.object({
          ts: z.number().int().optional(),
          thresholdMs: z.number().int().min(1).optional(),
        })
        const result = presenceSchema.safeParse(parsed)
        if (!result.success) {
          sendJson(res, 400, { ok: false, error: 'invalid body' })
          return
        }
        const ts = result.data.ts ?? Date.now()
        const thresholdMs = result.data.thresholdMs ?? 300_000
        import('../presence/tracker.js')
          .then((m) => m.recordPing(resolveStateClient(), ts, thresholdMs))
          .then(() => sendJson(res, 200, { ok: true, ts }))
          .catch((err: unknown) => sendError(res, err))
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
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
      deps.chatRunner.clearAuthFailure(getRepoRoot(), deps.bus)
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
            await closeSubject(id)
            deps.bus?.emit('view.chat-invalidated')
            sendJson(res, 200, { ok: true })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }
    // POST /chat/threads/:id/archive   — stamp archived_at; hides the Subthread
    // POST /chat/threads/:id/unarchive — clear archived_at; restores the Subthread
    {
      const archiveMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)\/(un)?archive$/)
          : null
      if (archiveMatch && archiveMatch[1]) {
        const id = decodeURIComponent(archiveMatch[1])
        const isUnarchive = archiveMatch[2] === 'un'
        const action = isUnarchive
          ? unarchiveSubthread(id)
          : archiveSubthread(id)
        action
          .then(() => {
            deps.bus?.emit('view.chat-invalidated')
            sendJson(res, 200, { ok: true })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // DELETE /chat/threads/:id — remove a Subthread and its messages for good.
    // Archiving only hides a thread; the rail still accumulates one row per
    // alert and grill forever, so cleanup needs a verb that actually removes.
    {
      const deleteMatch =
        req.method === 'DELETE' && req.url
          ? req.url.match(/^\/chat\/threads\/([^/?]+)$/)
          : null
      if (deleteMatch && deleteMatch[1]) {
        const id = decodeURIComponent(deleteMatch[1])
        deleteSubthread(id)
          .then(() => {
            deps.bus?.emit('view.chat-invalidated')
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
          .then((situation) => createThread(
            undefined,
            undefined,
            undefined,
            situation,
            { content: result.data.message, segments: userSegments },
          ))
          .then(async (thread) => {
            const run = await deps.chatRunner.sendMessage(
              thread.id,
              result.data.message,
              getRepoRoot(),
              deps.bus,
              result.data.attachments,
              { userMessagePersisted: true },
            )
            if (run.alreadyRunning) throw new Error('new Subthread unexpectedly has an active run')
            deps.bus?.emit('view.chat-invalidated')
            sendJson(res, 202, toThreadApiView(thread))
          })
          .catch((err: unknown) => sendError(res, err))
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // POST /chat/threads/from-queue-item — open the thread for an action-queue
    // row, seeded with a proactive opener. Deduped on the row id, so a repeat
    // click reuses the conversation instead of minting another one.
    if (req.method === 'POST' && req.url === '/chat/threads/from-queue-item') {
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        let parsed: unknown = {}
        try {
          parsed = rawBody.trim().length > 0 ? JSON.parse(rawBody) : {}
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const schema = z.object({
          itemId: z.string().min(1),
          title: z.string(),
          seed: z.string().min(1),
        })
        const result = schema.safeParse(parsed)
        if (!result.success) {
          sendJson(res, 400, {
            ok: false,
            error: 'body must be { itemId: string, title: string, seed: string }',
          })
          return
        }
        deps.appServices
          .buildSituationReport()
          .then((situation) =>
            startThreadForQueueItem(
              result.data.itemId,
              result.data.title,
              result.data.seed,
              situation,
            ),
          )
          .then((thread) => {
            deps.bus?.emit('view.chat-invalidated')
            sendJson(res, 200, toThreadApiView(thread))
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
          .then((situation) => createThread(result.data.title, undefined, undefined, situation))
          .then((thread) => {
            deps.bus?.emit('view.chat-invalidated')
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
              deps.bus?.emit('view.chat-invalidated')
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
              deps.bus?.emit('view.chat-invalidated')
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
            .sendMessage(id, result.data.content, getRepoRoot(), deps.bus, result.data.attachments)
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
            // `client` and `reference` targets are resolved by the browser —
            // navigation, not mutation. Reaching the daemon means the caller
            // is confused, so say so rather than half-executing something.
            if (response.target.type === 'client' || response.target.type === 'reference') {
              sendJson(res, 400, {
                ok: false,
                error: `response target '${response.target.type}' is resolved client-side and must not be posted`,
              })
              return
            }
            if (response.target.type === 'lever' || response.target.type === 'ack') {
              if (response.target.type === 'lever') {
                persistLeverAutonomyLevel(response.target.name, response.target.level)
              }
              await appendMessage(
                message.thread_id,
                'user',
                response.label,
                [{ type: 'text', text: response.label }],
                { kind: 'acknowledgment', contextScope: 'main' },
              )
              if (response.target.type === 'ack') {
                // Notice-ack: silently archive the acknowledged notice message.
                // Errors here must never surface to the user or block the response.
                archiveEntry(resolveStateClient(), {
                  kind: 'acked',
                  sourceKind: 'notice',
                  sourceId: message.id,
                  provenance: { responseId: response.id, label: response.label },
                }).catch(() => {
                  // intentionally silent — archive is non-fatal by contract
                })
              }
              deps.bus?.emit('view.chat-invalidated')
              sendJson(res, 200, { ok: true })
              return
            }
            if (response.target.type === 'verb') {
              if (classifyMarsVerb(response.target.op) !== 'safe') {
                sendJson(res, 400, { ok: false, error: `response verb is not safe: ${response.target.op}` })
                return
              }
              let ackLabel = response.label
              if (response.target.op === 'run-reflect') {
                await deps.runReflect()
              } else if (response.target.op === 'diagnose') {
                if (!response.target.entityId) throw new Error('diagnose response requires an entityId')
                await deps.diagnoseFailure(response.target.entityId)
              } else if (response.target.op === 'archive-subthread') {
                if (!response.target.entityId) throw new Error('archive-subthread response requires an entityId')
                await archiveSubthread(response.target.entityId)
              } else if (response.target.op === 'unarchive-subthread') {
                if (!response.target.entityId) throw new Error('unarchive-subthread response requires an entityId')
                await unarchiveSubthread(response.target.entityId)
              } else if (response.target.op === 'revert-auto-commit') {
                if (!response.target.entityId) throw new Error('revert-auto-commit response requires an entityId')
                if (!deps.revertAutoCommit) throw new Error('revertAutoCommit not available')
                const { commitSha, files } = JSON.parse(response.target.entityId) as { commitSha: string; files: string[] }
                const result = await deps.revertAutoCommit({ commitSha, files })
                if (result.reverted) {
                  ackLabel = `Restored ${files.length} file${files.length === 1 ? '' : 's'} as uncommitted edits`
                } else {
                  ackLabel = `Revert could not be applied: ${result.reason ?? 'unknown reason'}`
                }
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
                ackLabel,
                [{ type: 'text', text: ackLabel }],
                { kind: 'acknowledgment', contextScope: 'main' },
              )
              deps.bus?.emit('view.chat-invalidated')
              sendJson(res, 200, { ok: true })
              return
            }
            if (response.target.type === 'dismiss-notice') {
              await recordNoticeDismissal(response.target.noticeKey, null)
              await appendMessage(
                message.thread_id,
                'user',
                response.label,
                [{ type: 'text', text: response.label }],
                { kind: 'acknowledgment', contextScope: 'main' },
              )
              deps.bus?.emit('view.chat-invalidated')
              sendJson(res, 200, { ok: true })
              return
            }
            const subthread = await deps.appServices.openSubthread({
              title: response.target.title,
              acknowledgment: response.label,
            })
            deps.bus?.emit('view.chat-invalidated')
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
              deps.bus?.emit('view.chat-invalidated')
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
            deps.bus?.emit('view.chat-invalidated')
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

    // POST /levers/:key — set the autonomy level for a lever key. Body: { level: 'off'|'ask'|'tell' }.
    // Bypasses the draining gate (config operation, not task work). Setting 'off' mutes the
    // lever so subsequent createCard calls for the same key return null (no Card raised).
    {
      const leverMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/levers\/([^/?]+)(?:\?.*)?$/)
          : null
      if (leverMatch && leverMatch[1]) {
        const key = decodeURIComponent(leverMatch[1])
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
          const result = z
            .object({ level: z.enum(['off', 'ask', 'tell']) })
            .safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, {
              ok: false,
              error: "level is required and must be 'off', 'ask', or 'tell'",
            })
            return
          }
          try {
            persistLeverAutonomyLevel(key, result.data.level)
            sendJson(res, 200, { ok: true, key, level: result.data.level })
          } catch (err: unknown) {
            sendError(res, err)
          }
        })
        req.on('error', (err: unknown) => sendError(res, err))
        return
      }
    }

    // GET /lever-apply-history[?leverId=<id>] — history of operator-applied
    // lever changes (written by POST /lever-apply). Newest-first. Bypasses the
    // draining gate — pure read.
    if (req.method === 'GET' && req.url && req.url.startsWith('/lever-apply-history')) {
      try {
        const parsed = new URL(req.url, 'http://localhost')
        const leverId = parsed.searchParams.get('leverId') ?? undefined
        import('../lib/lever-apply.js')
          .then((m) => {
            const history = m.readLeverApplyHistory(leverId)
            sendJson(res, 200, { ok: true, history })
          })
          .catch((err: unknown) => sendError(res, err))
      } catch (err: unknown) {
        sendError(res, err)
      }
      return
    }

    // POST /lever-apply — apply one lever value through the same persistence
    // path as the matching CLI command. Body: { leverId: string; proposedValue:
    // string; findingId?: string }. Bypasses the draining gate — config writes
    // are not task work. Records the apply to the history JSONL file.
    if (req.method === 'POST' && req.url === '/lever-apply') {
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
        const bodySchema = z.object({
          leverId: z.string().min(1),
          proposedValue: z.string(),
          findingId: z.string().optional(),
        })
        const bodyResult = bodySchema.safeParse(parsed)
        if (!bodyResult.success) {
          sendJson(res, 400, {
            ok: false,
            error: 'body must be { leverId: string; proposedValue: string; findingId?: string }',
          })
          return
        }
        const { leverId, proposedValue, findingId } = bodyResult.data
        import('../lib/lever-apply.js')
          .then((m) => {
            const result = m.applyLeverValue(leverId, proposedValue)
            const appliedAt = new Date().toISOString()
            m.appendLeverApplyHistory({
              appliedAt,
              leverId,
              fromValue: result.fromValue,
              toValue: result.appliedValue,
              ...(findingId ? { findingId } : {}),
            })
            sendJson(res, 200, {
              ok: true,
              leverId,
              fromValue: result.fromValue,
              appliedValue: result.appliedValue,
              requiresRestart: result.requiresRestart,
              appliedAt,
            })
          })
          .catch((err: unknown) => {
            if (err instanceof Error && err.name === 'LeverApplyError') {
              const code = (err as { code?: string }).code ?? 'APPLY_ERROR'
              const status =
                code === 'NOT_FOUND' ? 404 : code === 'INVALID_VALUE' ? 400 : 422
              sendJson(res, status, { ok: false, error: err.message, code })
            } else {
              sendError(res, err)
            }
          })
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // POST /main-thread/ask — read-only Q&A path for the main thread.
    // Accepts free text and returns a static inline answer; never enqueues a
    // task, opens a Subject, or mutates any domain entity beyond writing one
    // `main_thread_entries` row of kind='answer'. Bypasses the draining gate —
    // this is a lightweight informational write, not orchestrator work.
    if (req.method === 'POST' && req.url === '/main-thread/ask') {
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
        const bodySchema = z.object({ text: z.string().min(1) })
        const result = bodySchema.safeParse(parsed)
        if (!result.success) {
          sendJson(res, 400, {
            ok: false,
            error: 'body must be { text: string } with at least one character',
          })
          return
        }
        import('../mainthread/ask.js')
          .then((m) => m.ask(resolveStateClient(), result.data.text))
          .then((entry) => sendJson(res, 200, { ok: true, entry }))
          .catch((err: unknown) => sendError(res, err))
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // ── Verify-gate management ────────────────────────────────────────────────
    //
    // These four routes cover the full gate lifecycle that the three consumer
    // slices need:
    //
    //   POST   /verify-gates                            → add a gate
    //   DELETE /verify-gates/:id                        → remove a gate
    //   POST   /verify-gates/:id/restore                → restore a quarantined gate
    //   POST   /actions/dismiss-verify-uncovered/:id    → dismiss open AQ row
    //
    // All four bypass the draining gate — they are operator config writes, not
    // task-dispatch work.

    // POST /verify-gates — register a new verify gate. Body conforms to
    // VerifyGateInput. Returns 201 { ok: true, id } on success, 400 on schema
    // error, 409 when a gate with the same (scope, name) already exists.
    // Calling addVerifyGate() already calls resolveCoveredVerifyAlerts()
    // internally, so any open verify-uncovered rows whose coverage gap this gate
    // fills are marked resolved automatically; emitting
    // 'view.action-queue-invalidated' ensures clients pick up that change.
    if (req.method === 'POST' && req.url === '/verify-gates') {
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        let body: unknown
        try {
          body = JSON.parse(rawBody)
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const parsed = VerifyGateInputSchema.safeParse(body)
        if (!parsed.success) {
          const msg = parsed.error.issues[0]?.message ?? 'invalid body'
          sendJson(res, 400, { ok: false, error: msg })
          return
        }
        addVerifyGate(parsed.data)
          .then((id) => {
            deps.bus?.emit('view.action-queue-invalidated')
            sendJson(res, 201, { ok: true, id })
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.toLowerCase().includes('unique')) {
              sendJson(res, 409, {
                ok: false,
                error: 'a gate with that name already exists in this scope',
                errorCode: 'CONFLICT',
              })
              return
            }
            sendError(res, err)
          })
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // DELETE /verify-gates/:id — remove a verify gate. Returns 200 { ok: true }
    // on success, 404 when no gate with that id exists. Bypasses the draining
    // gate (config write). Emits 'view.action-queue-invalidated' so the Steward
    // gateHealth panel and any open alert rows reflect the removal.
    {
      const removeGateMatch =
        req.method === 'DELETE' && req.url
          ? req.url.match(/^\/verify-gates\/([^/?]+)(?:\?.*)?$/)
          : null
      if (removeGateMatch && removeGateMatch[1]) {
        const id = decodeURIComponent(removeGateMatch[1])
        removeVerifyGate(id)
          .then((removed) => {
            if (!removed) {
              sendJson(res, 404, { ok: false, error: `verify gate '${id}' not found` })
              return
            }
            deps.bus?.emit('view.action-queue-invalidated')
            sendJson(res, 200, { ok: true })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /verify-gates/:id/restore — restore a quarantined gate to active.
    // Idempotent: calling restore on an already-active gate is a no-op (returns
    // 200 { ok: true }). Returns 404 when the gate id is unknown. Bypasses the
    // draining gate (config write). Emits 'view.action-queue-invalidated' so
    // any open gate-broken action-queue rows can be reflected as resolved.
    {
      const restoreGateMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/verify-gates\/([^/?]+)\/restore(?:\?.*)?$/)
          : null
      if (restoreGateMatch && restoreGateMatch[1]) {
        const id = decodeURIComponent(restoreGateMatch[1])
        restoreVerifyGate(id)
          .then((_restored) => {
            // restoreVerifyGate returns false for both "unknown id" and "already
            // active" — both are acceptable outcomes here (idempotent by design).
            // The consumer slice "Gate-restore end-to-end" can refine this to a
            // proper 404 for unknown ids if the UX demands it.
            deps.bus?.emit('view.action-queue-invalidated')
            sendJson(res, 200, { ok: true })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // POST /actions/dismiss-verify-uncovered/:id — dismiss an open
    // verify-uncovered action-queue row by marking it resolved. Used by the
    // "dismiss" verb in the verify-uncovered recipe (consumer slice
    // "verify-uncovered recipe: add dismiss and copy-add-gate verbs"). Idempotent
    // (setActionQueueState is a no-op when the row does not exist or is already
    // resolved). Bypasses the draining gate (config write, not task work).
    {
      const dismissUncoveredMatch =
        req.method === 'POST' && req.url
          ? req.url.match(/^\/actions\/dismiss-verify-uncovered\/([^/?]+)(?:\?.*)?$/)
          : null
      if (dismissUncoveredMatch && dismissUncoveredMatch[1]) {
        const id = decodeURIComponent(dismissUncoveredMatch[1])
        setActionQueueState(id, 'resolved', { by: 'operator', resolution: 'dismissed' })
          .then(() => {
            deps.bus?.emit('view.action-queue-invalidated')
            sendJson(res, 200, { ok: true })
          })
          .catch((err: unknown) => sendError(res, err))
        return
      }
    }

    // ── /gates — app-service layer gate management ────────────────────────────
    //
    // These two routes mirror /verify-gates but delegate through the app-service
    // layer (deps.addGate / deps.removeGate) and return the full gate row on
    // creation. Both bypass the draining gate — they are operator config writes.
    //
    //   POST   /gates      → add a gate, returns 201 { ok, gate }
    //   DELETE /gates/:id  → remove a gate, returns 200 { ok } or 404

    // POST /gates — register a new verify gate via the app-service layer.
    // Body conforms to VerifyGateInput (validated via VerifyGateInputSchema).
    // Returns 201 { ok: true, gate } on success, 400 on validation failure,
    // 409 when a gate with the same (scope, name) already exists.
    if (req.method === 'POST' && req.url === '/gates') {
      if (!deps.addGate) {
        sendJson(res, 501, { ok: false, error: 'addGate not implemented' })
        return
      }
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        let body: unknown
        try {
          body = JSON.parse(rawBody)
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const parsed = VerifyGateInputSchema.safeParse(body)
        if (!parsed.success) {
          const msg = parsed.error.issues[0]?.message ?? 'invalid body'
          sendJson(res, 400, { ok: false, error: msg })
          return
        }
        deps.addGate!(parsed.data)
          .then((gate) => {
            deps.bus?.emit('view.action-queue-invalidated')
            sendJson(res, 201, { ok: true, gate })
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.toLowerCase().includes('unique')) {
              sendJson(res, 409, {
                ok: false,
                error: 'a gate with that name already exists in this scope',
                errorCode: 'CONFLICT',
              })
              return
            }
            sendError(res, err)
          })
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // DELETE /gates/:id — remove a verify gate via the app-service layer.
    // Returns 200 { ok: true } on success, 404 when the gate does not exist.
    // Bypasses the draining gate (config write). Emits view invalidation so
    // the Steward gateHealth panel reflects the removal.
    {
      const removeGateMatch =
        req.method === 'DELETE' && req.url
          ? req.url.match(/^\/gates\/([^/?]+)(?:\?.*)?$/)
          : null
      if (removeGateMatch && removeGateMatch[1]) {
        if (!deps.removeGate) {
          sendJson(res, 501, { ok: false, error: 'removeGate not implemented' })
          return
        }
        const id = decodeURIComponent(removeGateMatch[1])
        deps.removeGate(id)
          .then(({ removed }) => {
            if (!removed) {
              sendJson(res, 404, { ok: false, error: `gate '${id}' not found` })
              return
            }
            deps.bus?.emit('view.action-queue-invalidated')
            sendJson(res, 200, { ok: true })
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
    // {ok:true,next:null,degraded:false,anchorRef:null} without mutating anything.
    // `degraded`/`anchorRef` mirror the CLI's `mars step done` surface: when
    // `degraded` is true the step closed via the Path 2 re-queue fallback
    // (the daemon restarted between park and this call) rather than resuming
    // the in-process workflow, and `anchorRef` — when non-null — names the
    // branch-tip ref anchored as a precaution before re-queuing.
    {
      const stepDoneMatch = req.url?.match(/^\/step\/done\/([^/?]+)(?:\?.*)?$/)
      if (stepDoneMatch && stepDoneMatch[1]) {
        const id = decodeURIComponent(stepDoneMatch[1])
        deps
          .stepDone(id)
          .then(({ next, degraded, anchorRef }) =>
            sendJson(res, 200, {
              ok: true,
              next,
              degraded: degraded ?? false,
              anchorRef: anchorRef ?? null,
            }),
          )
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

    // POST /actions/continue-all-daemon-killed — batch continue, no :id.
    if (req.url === '/actions/continue-all-daemon-killed') {
      deps
        .continueAllDaemonKilled()
        .then((result) => sendJson(res, 200, { ok: true, ...result }))
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

    // POST /actions/resume-dispatch — resume dispatch regardless of pause
    // reason (operator, storm, or quota). Process-level: no entity id.
    if (req.url === '/actions/resume-dispatch') {
      if (!deps.resumeDispatch) {
        sendJson(res, 501, { ok: false, error: 'resume-dispatch not implemented' })
        return
      }
      deps.resumeDispatch()
      sendJson(res, 200, { ok: true })
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

    // POST /tasks/:id/question — raise a task.question outbox event. Body:
    // { question: string }. The daemon-owned counterpart to the CLI's
    // `mars task ask`, so that command can publish through this HTTP route
    // instead of writing to the outbox directly from the CLI process.
    {
      const questionMatch = req.url?.match(/^\/tasks\/([^/?]+)\/question(?:\?.*)?$/)
      if (req.method === 'POST' && questionMatch && questionMatch[1]) {
        if (!deps.raiseTaskQuestion) {
          sendJson(res, 501, { ok: false, error: 'raiseTaskQuestion not implemented' })
          return
        }
        const id = decodeURIComponent(questionMatch[1])
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
          const questionSchema = z.object({ question: z.string().min(1) })
          const result = questionSchema.safeParse(parsed)
          if (!result.success) {
            sendJson(res, 400, { ok: false, error: 'Body must be { question: non-empty string }' })
            return
          }
          deps
            .raiseTaskQuestion!(id, result.data.question)
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

    if (op === 'supersede') {
      if (!deps.supersedeTask) {
        sendJson(res, 501, { ok: false, error: 'supersede not implemented' })
        return
      }
      deps
        .supersedeTask(id)
        .then(({ taskId }) => sendJson(res, 200, { ok: true, taskId }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // promote returns task ids — handled separately so the ids are surfaced in
    // the response body. Errors propagate via sendError so the UI drawer shows
    // them instead of silently swallowing them.
    if (op === 'promote') {
      deps
        .promoteProposal(id)
        .then(({ taskIds }) => sendJson(res, 200, { ok: true, taskIds }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // proposal.slice — trigger slicing on a prd-ready proposal that previously
    // failed. This is the "Slice again" action on slice-failed rows.
    if (op === 'proposal.slice') {
      if (!deps.sliceProposal) {
        sendJson(res, 501, { ok: false, error: 'proposal.slice not implemented' })
        return
      }
      deps
        .sliceProposal(id)
        .then(({ taskIds }) => sendJson(res, 200, { ok: true, taskIds }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // proposal.mockup enqueues a read-only mockup task and returns the task id.
    if (op === 'proposal.mockup') {
      if (!deps.mockupProposal) {
        sendJson(res, 501, { ok: false, error: 'proposal.mockup not implemented' })
        return
      }
      deps
        .mockupProposal(id)
        .then(({ taskId }) => sendJson(res, 200, { ok: true, taskId }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // proposal.implement-live enqueues the proposal as a live task and returns the task id.
    if (op === 'proposal.implement-live') {
      if (!deps.implementLiveProposal) {
        sendJson(res, 501, { ok: false, error: 'proposal.implement-live not implemented' })
        return
      }
      deps
        .implementLiveProposal(id)
        .then(({ taskId }) => sendJson(res, 200, { ok: true, taskId }))
        .catch((err: unknown) => sendError(res, err))
      return
    }

    // proposal.set-field — edit a single proposal field in-place.
    // Body: { field: string, value: string }
    // Returns: { ok: true } or 400/404/422/501 on error.
    if (op === 'proposal.set-field') {
      if (!deps.setProposalField) {
        sendJson(res, 501, { ok: false, error: 'proposal.set-field not implemented' })
        return
      }
      const VALID_PROPOSAL_FIELDS = ['title', 'problem', 'solution', 'out-of-scope', 'notes', 'status']
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
        const body = parsed as { field?: unknown; value?: unknown }
        if (typeof body.field !== 'string' || body.field.length === 0) {
          sendJson(res, 400, { ok: false, error: 'body must include { field: string, value: string }' })
          return
        }
        if (!VALID_PROPOSAL_FIELDS.includes(body.field)) {
          sendJson(res, 422, {
            ok: false,
            error: `invalid field '${body.field}'; expected one of ${VALID_PROPOSAL_FIELDS.join(', ')}`,
          })
          return
        }
        if (typeof body.value !== 'string') {
          sendJson(res, 400, { ok: false, error: 'body must include { field: string, value: string }' })
          return
        }
        deps.setProposalField!(id, body.field, body.value)
          .then(() => sendJson(res, 200, { ok: true }))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('not found')) {
              sendJson(res, 404, { ok: false, error: msg })
            } else if (msg.includes('invalid proposal status') || msg.includes('cannot be moved')) {
              sendJson(res, 422, { ok: false, error: msg })
            } else {
              sendError(res, err)
            }
          })
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // proposal.add-story — append a user story to a proposal.
    // Body: { story: string }
    // Returns: { ok: true, id: string } where id is the new story's position index.
    if (op === 'proposal.add-story') {
      if (!deps.addProposalUserStory) {
        sendJson(res, 501, { ok: false, error: 'proposal.add-story not implemented' })
        return
      }
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
        const body = parsed as { story?: unknown }
        if (typeof body.story !== 'string' || body.story.length === 0) {
          sendJson(res, 400, { ok: false, error: 'body must include { story: non-empty string }' })
          return
        }
        deps.addProposalUserStory!(id, body.story)
          .then(({ id: storyId }) => sendJson(res, 200, { ok: true, id: storyId }))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('not found')) sendJson(res, 404, { ok: false, error: msg })
            else sendError(res, err)
          })
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // proposal.remove-story — remove a user story at the given position index.
    // Body: { index: number }
    // Returns: { ok: true }
    if (op === 'proposal.remove-story') {
      if (!deps.removeProposalUserStory) {
        sendJson(res, 501, { ok: false, error: 'proposal.remove-story not implemented' })
        return
      }
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
        const body = parsed as { index?: unknown }
        if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
          sendJson(res, 400, { ok: false, error: 'body must include { index: non-negative integer }' })
          return
        }
        deps.removeProposalUserStory!(id, body.index)
          .then(() => sendJson(res, 200, { ok: true }))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('not found') || msg.includes('no user story at index')) {
              sendJson(res, 404, { ok: false, error: msg })
            } else {
              sendError(res, err)
            }
          })
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // proposal.delete — permanently delete a proposal and its user stories.
    // No body required.
    // Returns: { ok: true }
    if (op === 'proposal.delete') {
      if (!deps.deleteProposal) {
        sendJson(res, 501, { ok: false, error: 'proposal.delete not implemented' })
        return
      }
      deps.deleteProposal(id)
        .then(() => sendJson(res, 200, { ok: true }))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('not found')) sendJson(res, 404, { ok: false, error: msg })
          else sendError(res, err)
        })
      return
    }

    // POST /actions/drop/:id — drop a task regardless of status.
    // Body (optional): { force?: boolean } — bypasses the commits-ahead guard.
    if (op === 'drop') {
      if (!deps.dropTask) {
        sendJson(res, 501, { ok: false, error: 'drop not implemented' })
        return
      }
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        let force = false
        try {
          const parsed = JSON.parse(rawBody || '{}') as { force?: unknown }
          if (parsed.force === true) force = true
        } catch {}
        deps.dropTask!(id, force)
          .then(() => sendJson(res, 200, { ok: true }))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('not found')) {
              sendJson(res, 404, { ok: false, error: msg })
            } else if (msg.includes('is in flight') || msg.includes('refusing to drop')) {
              sendJson(res, 409, { ok: false, error: msg })
            } else {
              sendError(res, err)
            }
          })
      })
      req.on('error', (err: unknown) => sendError(res, err))
      return
    }

    // POST /actions/set-blockers/:id — add/remove blocker edges atomically.
    // Body: { add?: string[], remove?: string[] }
    if (op === 'set-blockers') {
      if (!deps.setBlockers) {
        sendJson(res, 501, { ok: false, error: 'set-blockers not implemented' })
        return
      }
      let rawBody = ''
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString() })
      req.on('end', () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(rawBody || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const body = parsed as { add?: unknown; remove?: unknown }
        const add = Array.isArray(body.add)
          ? body.add.filter((x): x is string => typeof x === 'string')
          : []
        const remove = Array.isArray(body.remove)
          ? body.remove.filter((x): x is string => typeof x === 'string')
          : []
        deps.setBlockers!(id, add, remove)
          .then((result) => sendJson(res, 200, { ok: true, ...result }))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes('not found')) {
              sendJson(res, 404, { ok: false, error: msg })
            } else if (msg.includes('cannot block itself') || msg.includes('no blocker edge')) {
              sendJson(res, 409, { ok: false, error: msg })
            } else {
              sendError(res, err)
            }
          })
      })
      req.on('error', (err: unknown) => sendError(res, err))
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
  }

  return { listener, openSockets }
}
