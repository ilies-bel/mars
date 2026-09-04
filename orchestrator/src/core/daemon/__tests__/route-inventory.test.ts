/**
 * Route-inventory pin for the daemon's HTTP surface (modular-core slice 17:
 * "Split server.ts: extract HTTP route registration and UI serving").
 *
 * Route registration used to live inline in `http-server.ts`; it now lives
 * in `registerRoutes` (`routes.ts`), with the daemon's one piece of static-
 * asset serving split further into `ui-serve.ts`. This test guards against a
 * future refactor silently dropping a route in that move: it (1) statically
 * enumerates every route pattern declared in `routes.ts`'s source and (2)
 * boots a real server and fires a live request at a representative sample
 * covering every HTTP method and daemon subsystem, asserting each is
 * recognized (never falls through to the generic `{ ok: false, error: 'Not
 * found' }` 404 every unmatched request gets).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HttpServerDeps, HttpServerHandle } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

// The generic fallback body every request that matches no route at all
// receives (routes.ts, end of the POST /actions/:op/:id block). A route
// responding with anything else — including a domain 404 with a different
// message, a 405, a 501, or a 503 — proves it was recognized by dispatch.
const UNMATCHED_FALLBACK = { ok: false, error: 'Not found' }

const ROUTES_SOURCE = readFileSync(
  resolve(__dirname, '..', 'routes.ts'),
  'utf8',
)

/**
 * Every route pattern registered in `routes.ts`, as a source-text fragment
 * unique enough to identify that one route. Exact-match routes use their
 * literal path; parameterized routes use a stable slice of their regex
 * source. Asserting each is `.includes()`d in `ROUTES_SOURCE` is the
 * structural half of the inventory — it fails the instant a route is
 * deleted, regardless of whether any other test happens to cover it.
 */
const DECLARED_ROUTE_MARKERS: string[] = [
  // Exact-match routes.
  "req.url === '/healthz'",
  "req.url === '/liveness'",
  "req.url === '/failure-kinds'",
  "req.url === '/failure-kinds/learned-recipes'",
  "req.url === '/agents/live'",
  "req.url === '/view/daemon-version'",
  "req.url === '/recipes'",
  "req.url === '/kpis'",
  "req.url === '/view/tasks'",
  "req.url === '/view/operator'",
  "req.url === '/operator/dispatch'",
  "req.url === '/operator/recovery'",
  "req.url === '/view/glossary'",
  "req.url === '/view/skills'",
  "req.url === '/view/adrs'",
  "req.url === '/view/stream'",
  "req.url === '/view/counts'",
  "req.url === '/view/status-counts'",
  "req.url === '/view/primitives'",
  "req.url === '/view/framework-update'",
  "req.url === '/view/verify-gates'",
  "req.url === '/view/steward'",
  "req.url === '/view/scorer-workflows'",
  "req.url === '/view/scorer-suggestions'",
  "req.url === '/view/scorer-accept'",
  "req.url === '/view/scorer-dismiss'",
  "req.url === '/view/terminal-events'",
  "req.url === '/view/release-notes'",
  "req.url === '/view/release-notes-cursor'",
  "req.url === '/presence'",
  "req.url === '/preferences/notifications'",
  "req.url === '/view/chat/history'",
  "req.url === '/view/chat/conversation'",
  "req.url === '/view/codex-auth'",
  "req.url === '/view/chat/config'",
  "req.url === '/codex-auth/refresh'",
  "req.url === '/chat/subthreads'",
  "req.url === '/chat/threads/from-queue-item'",
  "req.url === '/chat/threads'",
  "req.url === '/lever-apply'",
  "req.url === '/main-thread/ask'",
  "req.url === '/actions/restart-daemon'",
  "req.url === '/actions/continue-all-daemon-killed'",
  "req.url === '/actions/run-reflect'",
  "req.url === '/actions/self-update'",
  // Prefix (startsWith) routes.
  "req.url.startsWith('/events')",
  "req.url.startsWith('/kpi/cost-per-merged-task')",
  "req.url.startsWith('/view/tasks/')",
  "req.url.startsWith('/view/task/')",
  "req.url.startsWith('/view/progress')",
  "req.url.startsWith('/view/step-spans')",
  "req.url.startsWith('/view/step-prompt')",
  "req.url.startsWith('/view/agent-tool-calls')",
  "req.url.startsWith('/view/sessions')",
  "req.url.startsWith('/view/reflect')",
  "req.url.startsWith('/view/scorer-trend')",
  "req.url.startsWith('/view/workflow-configs')",
  "req.url.startsWith('/view/promotion-ledger')",
  "req.url.startsWith('/view/loop-ledger')",
  "req.url.startsWith('/view/arcs')",
  "req.url.startsWith('/view/deep-reflections')",
  "req.url.startsWith('/view/auto-recipe-runs')",
  "req.url.startsWith('/view/steward-ledger')",
  "req.url.startsWith('/view/wywa-delta')",
  "req.url.startsWith('/view/action-queue')",
  "req.url.startsWith('/archive')",
  "req.url.startsWith('/alerts')",
  "req.url.startsWith('/lever-apply-history')",
  // Regex-matched (parameterized) routes.
  '/^\\/failure-kinds\\/([^/?]+)\\/recipe$/',
  '/^\\/origins\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/kpis\\/([^/?]+)\\/arcs(\\?.*)?$/',
  '/^\\/view\\/runs\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/view\\/primitives\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/view\\/proposal\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/arc\\/([^/?]+)\\/qa\\/screenshot\\/([^/?]+)\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/arc\\/([^/?]+)\\/qa(?:\\?.*)?$/',
  '/^\\/view\\/deep-reflections\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/alerts\\/next(?:\\?.*)?$/',
  '/^\\/alerts\\/([^/?]+)\\/thread(?:\\?.*)?$/',
  '/^\\/alerts\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/view\\/chat\\/thread\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/chat\\/threads\\/([^/?]+)\\/tasks(?:\\?.*)?$/',
  "/^\\/chat\\/threads\\/([^/?]+)\\/end$/",
  '/^\\/chat\\/threads\\/([^/?]+)\\/(un)?archive$/',
  '/^\\/chat\\/threads\\/([^/?]+)$/',
  '/^\\/chat\\/threads\\/([^/?]+)\\/ui-stream(?:\\?.*)?$/',
  "/^\\/chat\\/threads\\/([^/?]+)\\/fork$/",
  "/^\\/chat\\/threads\\/([^/?]+)\\/title$/",
  "/^\\/chat\\/threads\\/([^/?]+)\\/attachments$/",
  "/^\\/chat\\/threads\\/([^/?]+)\\/message$/",
  "/^\\/chat\\/threads\\/([^/?]+)\\/stop$/",
  '/^\\/chat\\/messages\\/([^/?]+)\\/responses\\/([^/?]+)$/',
  "/^\\/chat\\/messages\\/([^/?]+)\\/feedback$/",
  "/^\\/chat\\/messages\\/([^/?]+)\\/feedback\\/clear$/",
  '/^\\/deployments\\/([^/?]+)\\/logs(?:\\?.*)?$/',
  '/^\\/levers\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/step\\/done\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/actions\\/snooze\\/([^/?]+)(?:\\?.*)?$/',
  '/^\\/tasks\\/([^/?]+)\\/question(?:\\?.*)?$/',
  '/^\\/actions\\/([^/]+)\\/([^/]+)$/',
]

describe('daemon HTTP route inventory', () => {
  it('every declared route pattern is still present in routes.ts', () => {
    const missing = DECLARED_ROUTE_MARKERS.filter(
      (marker) => !ROUTES_SOURCE.includes(marker),
    )
    expect(missing).toEqual([])
  })

  it('route registration no longer lives inline in http-server.ts', () => {
    const httpServerSource = readFileSync(
      resolve(__dirname, '..', 'http-server.ts'),
      'utf8',
    )
    // The route table used to be a ~2800-line sequential if-chain inline in
    // this file; now it's a single delegation to routes.ts.
    expect(httpServerSource).toContain("from './routes'")
    expect(httpServerSource).not.toContain("req.url === '/healthz'")
    expect(httpServerSource).not.toContain("req.method === 'GET' && req.url === '/recipes'")
  })

  it('static PNG-asset streaming lives in ui-serve.ts, not routes.ts', () => {
    const uiServeSource = readFileSync(
      resolve(__dirname, '..', 'ui-serve.ts'),
      'utf8',
    )
    expect(uiServeSource).toContain('createReadStream')
    expect(ROUTES_SOURCE).not.toContain('createReadStream')
  })
})

describe('daemon HTTP route inventory — live responses', () => {
  let recipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>>
  let handle: HttpServerHandle
  let baseUrl: string

  beforeAll(async () => {
    recipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-route-inventory-rec-')),
    )
    const deps: HttpServerDeps = {
      restartTask: async () => {},
      remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => ({ taskIds: [] }),
      continueTask: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
      landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      stepDone: async () => ({ next: null }),
      snoozeItem: async () => {},
      recipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
      chatRunner: stubChatRunner(),
      raiseTaskQuestion: async () => {},
      getPauseState: () => ({ paused: false, reason: null, since: null, detail: null }),
      pauseDispatch: () => true,
      resumeDispatch: () => {},
    }
    handle = await import('../http-server').then((m) => m.startHttpServer(deps))
    baseUrl = `http://127.0.0.1:${handle.port}`
  })

  afterAll(async () => {
    await handle.close()
  })

  /** GET routes with no path params — the prefix routes and exact-match reads. */
  const simpleGetPaths = [
    '/healthz',
    '/liveness',
    '/failure-kinds',
    '/failure-kinds/learned-recipes',
    '/agents/live',
    '/view/daemon-version',
    '/recipes',
    '/kpis',
    '/view/tasks',
    '/view/operator',
    '/view/glossary',
    '/view/skills',
    '/view/adrs',
    '/view/counts',
    '/view/status-counts',
    '/view/primitives',
    '/view/framework-update',
    '/view/steward',
    '/view/scorer-workflows',
    '/view/scorer-suggestions',
    '/view/terminal-events',
    '/view/release-notes',
    '/view/release-notes-cursor',
    '/view/chat/history',
    '/view/chat/conversation',
    '/view/codex-auth',
    '/view/chat/config',
    '/preferences/notifications',
    '/events',
    '/kpi/cost-per-merged-task',
    '/view/tasks/x',
    '/view/task/x/live',
    '/view/progress',
    '/view/step-spans',
    '/view/step-prompt',
    '/view/agent-tool-calls',
    '/view/sessions',
    '/view/reflect',
    '/view/scorer-trend',
    '/view/workflow-configs',
    '/view/promotion-ledger',
    '/view/loop-ledger',
    '/view/arcs',
    '/view/deep-reflections',
    '/view/auto-recipe-runs',
    '/view/steward-ledger',
    '/view/wywa-delta',
    '/view/action-queue',
    '/archive',
    '/alerts',
    '/lever-apply-history',
    // Regex-matched GET routes with a dummy id/param.
    '/origins/x',
    '/kpis/failure_rate/arcs',
    '/view/runs/x',
    '/view/primitives/x',
    '/view/proposal/x',
    '/arc/x/qa',
    '/view/deep-reflections/x',
    '/alerts/next',
    '/alerts/x',
    '/view/chat/thread/x',
    '/chat/threads/x/tasks',
    '/deployments/x/logs',
  ]

  it.each(simpleGetPaths)('GET %s is recognized by route dispatch', async (path) => {
    const res = await fetch(`${baseUrl}${path}`)
    // Every GET route is matched (and returns) before the shared "POST only
    // past this point" gate further down the dispatch chain. A path that no
    // GET route recognizes falls all the way through to that gate and gets
    // 405 — the negative-control signal for a dropped/mistyped GET route.
    expect(res.status).not.toBe(405)
    if (res.status === 404) {
      const body = await res.json()
      expect(body).not.toEqual(UNMATCHED_FALLBACK)
    }
  })

  it('GET /arc/:originId/qa/screenshot/:c/:s is recognized (streams or 404s by name)', async () => {
    const res = await fetch(`${baseUrl}/arc/x/qa/screenshot/0/0`)
    // A missing screenshot file 404s with a route-specific body, never the
    // generic dispatch fallback — proving the route itself was matched.
    if (res.status === 404) {
      const body = await res.json()
      expect(body).not.toEqual(UNMATCHED_FALLBACK)
      expect(body).toMatchObject({ error: 'screenshot not found' })
    }
  })

  it('GET /view/stream opens an SSE connection (not the 404 fallback)', async () => {
    const res = await fetch(`${baseUrl}/view/stream`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body?.cancel()
  })

  it('GET /chat/threads/:id/ui-stream is recognized (204 with no stream hub configured)', async () => {
    const res = await fetch(`${baseUrl}/chat/threads/x/ui-stream`)
    // No chatStreamHub in this deps stub → the route's own documented 204,
    // not the dispatch-wide 404 fallback.
    expect(res.status).toBe(204)
  })

  /** POST routes that need no request body to be recognized. */
  const simplePostPaths = [
    '/operator/dispatch',
    '/operator/recovery',
    '/view/scorer-accept',
    '/view/scorer-dismiss',
    '/presence',
    '/codex-auth/refresh',
    '/chat/subthreads',
    '/chat/threads/from-queue-item',
    '/chat/threads',
    '/lever-apply',
    '/main-thread/ask',
    '/actions/restart-daemon',
    '/actions/continue-all-daemon-killed',
    '/actions/run-reflect',
    '/actions/self-update',
    '/alerts/x/thread',
    '/levers/x',
    '/step/done/x',
    '/actions/snooze/x',
    '/tasks/x/question',
    // Final POST /actions/:op/:id catch-all — an unrecognized op still hits
    // this route (proving it dispatched), just with a different error body.
    '/actions/some-made-up-op/x',
  ]

  it.each(simplePostPaths)('POST %s is recognized by route dispatch', async (path) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (res.status === 404) {
      const body = await res.json()
      expect(body).not.toEqual(UNMATCHED_FALLBACK)
    } else {
      expect(res.status).not.toBe(404)
    }
  })

  it('POST /failure-kinds/:signature/recipe (teach) is recognized', async () => {
    const res = await fetch(`${baseUrl}/failure-kinds/some-signature/recipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'restart' }),
    })
    expect(res.status).not.toBe(404)
  })

  it('DELETE /failure-kinds/:signature/recipe (unlearn) is recognized', async () => {
    const res = await fetch(`${baseUrl}/failure-kinds/some-signature/recipe`, {
      method: 'DELETE',
    })
    expect(res.status).not.toBe(404)
  })

  it('DELETE /chat/threads/:id is recognized', async () => {
    const res = await fetch(`${baseUrl}/chat/threads/x`, { method: 'DELETE' })
    if (res.status === 404) {
      const body = await res.json()
      expect(body).not.toEqual(UNMATCHED_FALLBACK)
    } else {
      expect(res.status).not.toBe(404)
    }
  })

  it('an actually-unmatched path falls through to the generic 404 fallback', async () => {
    // GET reaches the shared "POST only past this point" gate first (405),
    // so this must be a POST to actually reach the /actions/:op/:id
    // catch-all and prove UNMATCHED_FALLBACK is reachable at all (i.e. that
    // the earlier assertions distinguishing "not this" are meaningful).
    const res = await fetch(`${baseUrl}/this-route-does-not-exist`, { method: 'POST' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual(UNMATCHED_FALLBACK)
  })
})
