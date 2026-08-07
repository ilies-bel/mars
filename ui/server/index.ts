import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUploadPath } from './chatUploadPath.ts'
import { failureKindDecisions } from './actionQueueDecisions.ts'
import {
  ensureProjectRegistered,
  loadProjectRegistry,
} from '../../orchestrator/src/registry/projects.ts'
import {
  fetchKpis,
  fetchKpiSeries,
  type KpiSeries,
  type DaemonActionResult,
  proxyAction,
  proxyDelete,
  proxyGet as realProxyGet,
  proxyPost as realProxyPost,
  proxyStream,
  readDaemonHttpPort,
} from './daemonHttp.ts'
import { DAEMON_ERROR } from '../src/shared/daemonErrors.ts'
import {
  createProjectContextCache,
  readProjectAdr,
  readProjectMeta,
  type ProjectContextEntry,
} from './projectContext.ts'
import { probeDaemonHealth } from './projectHealth.ts'
import { resolveRepo, UnknownProjectError } from './repo.ts'
import { handleProjectStart, handleProjectRestart } from './spawnDaemon.ts'

interface CliArgs {
  repo?: string
  port: number
  host: string
  distDir?: string
  /** When true the server is in development mode: Vite serves the frontend
   *  on its own port so this server must not serve any static files. */
  dev?: boolean
}

/**
 * Injectable seams for {@link startServer}. Production passes nothing and the
 * real {@link realProxyGet} (forwarding to the running daemon) is used. Tests
 * inject a `proxyGet` stub so daemon-backed view endpoints
 * (`/view/action-queue`, `/origins/:id`, …) can be served from a seeded SQLite
 * fixture without spawning a daemon — keeping a single projection source of
 * truth (the daemon's `buildActionQueueView`) instead of forking it here.
 */
export interface ServerDeps {
  proxyGet?: (stateDir: string, path: string) => Promise<DaemonActionResult>
  proxyPost?: (stateDir: string, path: string, body: unknown, method?: 'POST' | 'PUT') => Promise<DaemonActionResult>
  /** SSE heartbeat interval in ms. Defaults to 15 000. Override in tests to avoid slow polls. */
  sseHeartbeatMs?: number
  /**
   * Called once at startup to register this repo in the project registry.
   * Defaults to {@link ensureProjectRegistered}. Override in tests to control
   * or observe registration without touching the real filesystem.
   */
  _registerProject?: (repoRoot: string) => void
}

const parseArgs = (argv: string[]): CliArgs => {
  const out: CliArgs = { port: 7777, host: '127.0.0.1' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--repo') out.repo = next()
    else if (a === '--port') {
      const raw = next()
      const n = Number(raw)
      if (isNaN(n) || n < 1 || n > 65535) {
        console.error(`mars-ui: invalid port "${raw}" — must be a number between 1 and 65535`)
        process.exit(1)
      }
      out.port = n
    }
    else if (a === '--host') {
      const val = next()
      if (val === undefined) {
        console.error('mars-ui: --host requires a value (e.g. --host 0.0.0.0)')
        process.exit(1)
      }
      out.host = val
    }
    else if (a === '--dist') out.distDir = next()
    else if (a === '--dev') out.dev = true
  }
  return out
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  // Media types served from chat-uploads/
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  })

const staticResponse = (root: string, urlPath: string): Response | null => {
  const safe = normalize(urlPath).replace(/^(\.\.[\\/])+/, '')
  const candidate = join(root, safe === '/' ? 'index.html' : safe)
  if (!candidate.startsWith(root)) return null
  let target = candidate
  if (!existsSync(target) || statSync(target).isDirectory()) {
    target = join(root, 'index.html')
    if (!existsSync(target)) return null
  }
  const mime = MIME[extname(target)] ?? 'application/octet-stream'
  return new Response(Bun.file(target), { headers: { 'Content-Type': mime } })
}

export const startServer = async (
  args: CliArgs,
  deps: ServerDeps = {},
): Promise<Awaited<ReturnType<typeof Bun.serve>>> => {
  const proxyGet = deps.proxyGet ?? realProxyGet
  const proxyPost = deps.proxyPost ?? realProxyPost
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? 15_000
  // Resolve the default context once for startup logging and healthz.
  const defaultCtx = resolveRepo(args.repo)

  // Self-register this repo in the project registry so the ProjectSelector
  // shows it even when no daemon has run yet. ensureProjectRegistered is
  // idempotent — a repeat boot performs no I/O and cannot create duplicates.
  // Registration failure is non-fatal: a read-only home dir or a malformed
  // existing file must not prevent the UI from starting.
  const registerProject = deps._registerProject ?? ((repoRoot: string) => {
    ensureProjectRegistered({ repoRoot })
  })
  try {
    registerProject(defaultCtx.repoRoot)
  } catch (err) {
    console.warn(`mars-ui: could not register repo in project registry: ${(err as Error).message}`)
  }

  // Per-project handle cache: lazily opens TaskDb/StateDb/SseHub on first
  // request per project and reuses them on subsequent requests.
  const getProjectContext = createProjectContextCache(args.repo)

  // In dev mode Vite owns the frontend; this server must not serve static
  // files.  In production mode default to the built ui/dist beside this
  // server file so the server works whether invoked directly or via the
  // ui/bin/mars-ui.mjs launcher (which also passes --dist explicitly).
  const distDir = args.distDir
    ? resolve(args.distDir)
    : args.dev
    ? undefined
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

  let server: Awaited<ReturnType<typeof Bun.serve>>
  try {
    server = await Bun.serve({
      port: args.port,
      hostname: args.host,
      idleTimeout: 0,
      async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        })
      }

      if (path === '/healthz') {
        return jsonResponse(200, { ok: true, repo: defaultCtx.repoRoot })
      }

      // All API routes and the SSE endpoint need a per-project context.
      // ?project=<projectId> selects the project; omitting it uses the
      // default project (args.repo / MARS_REPO / git-detected root).
      if (path.startsWith('/api/') || path === '/events') {
        const projectId = url.searchParams.get('project') ?? undefined
        let pctx!: ProjectContextEntry
        try {
          pctx = await getProjectContext(projectId)
        } catch (e) {
          if (e instanceof UnknownProjectError) {
            return jsonResponse(404, { error: (e as Error).message })
          }
          throw e
        }
        const { ctx, hub } = pctx

        if (path === '/api/tasks') {
          const r = await proxyGet(ctx.stateDir, '/view/tasks')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/progress') {
          const r = await proxyGet(ctx.stateDir, `/view/progress${url.search}`)
          return jsonResponse(r.status, r.body)
        }

        if (path.startsWith('/api/tasks/')) {
          const id = decodeURIComponent(path.slice('/api/tasks/'.length))
          if (!id) {
            return jsonResponse(400, { error: 'id is required' })
          }
          const r = await proxyGet(ctx.stateDir, `/view/tasks/${encodeURIComponent(id)}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/action-queue — proxy the daemon's derived action-queue view.
        // The daemon's `buildActionQueueView` is the single source of truth for
        // the projection (kind/priority normalisation, entityId extraction,
        // daemon-killed-batch collapsing, stale-worktree git probe, diagnosis
        // pass-through). This server must NOT re-derive it: a forked copy here
        // (commit b89c57ce) drifted and emitted `entityId: ''` for non-task-
        // keyed rows, which made the UI fetch `/api/origins/?project=…` → 400.
        // Tests inject `deps.proxyGet` to serve this from a seeded SQLite
        // fixture via the same `buildActionQueueView`, so there is no daemon
        // dependency and no second projection to drift.
        if (path === '/api/action-queue') {
          const result = await proxyGet(
            ctx.stateDir,
            `/view/action-queue${url.search}`,
          )
          if (result.status === 200 && Array.isArray(result.body)) {
            const enriched = (result.body as Record<string, unknown>[]).map((item) => ({
              ...item,
              decisions: failureKindDecisions((item.errorKind ?? item.kind) as string),
            }))
            return jsonResponse(200, enriched)
          }
          return jsonResponse(result.status, result.body)
        }

        if (path === '/api/action-queue/history') {
          const r = await proxyGet(ctx.stateDir, `/view/action-queue/history${url.search}`)
          return jsonResponse(r.status, r.body)
        }

        if (
          (path === '/api/action-queue/dismiss' ||
            path === '/api/action-queue/ack' ||
            path === '/api/action-queue/resolve') &&
          req.method === 'POST'
        ) {
          try {
            const body = (await req.json()) as { id?: unknown }
            const id = body.id
            if (typeof id !== 'string' || !id.includes(':')) {
              return jsonResponse(400, {
                error: 'id is required and must be a "<kind>:<entityId>" string',
              })
            }
            const [kind, ...rest] = id.split(':')
            const entityId = rest.join(':')
            const entityKind: 'task' | 'worktree' | 'proposal' | null =
              kind === 'failed-task' ? 'task'
              : kind === 'stale-worktree' ? 'worktree'
              : kind === 'draft-proposal' ? 'proposal'
              : null
            if (entityKind === null) {
              return jsonResponse(400, { error: `unknown action-queue kind: ${kind}` })
            }
            const verb =
              path === '/api/action-queue/ack' ? 'ack'
              : path === '/api/action-queue/resolve' ? 'resolve'
              : 'dismiss'
            const result = await proxyPost(ctx.stateDir, `/view/action-queue/${verb}`, {
              kind: entityKind,
              entityId,
            })
            return jsonResponse(result.status, result.body)
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        // Recovery actions: the UI's only write path. Forwards a registry `op`
        // (and optional entity id) to the daemon, which performs the state
        // transition. `restart-daemon` is process-level and carries no entity id.
        if (path === '/api/actions' && req.method === 'POST') {
          try {
            const body = (await req.json()) as {
              op?: unknown
              entityId?: unknown
            }
            const { op, entityId } = body
            if (typeof op !== 'string' || op.length === 0) {
              return jsonResponse(400, { error: 'op is required and must be a string' })
            }
            if (entityId !== undefined && typeof entityId !== 'string') {
              return jsonResponse(400, { error: 'entityId must be a string when present' })
            }
            const result = await proxyAction(ctx.stateDir, op, entityId)
            return jsonResponse(result.status, result.body)
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        // POST /api/actions/snooze/:id — proxy the daemon's snooze endpoint.
        // Body: { preset: '1h' | '4h' | 'tomorrow-morning' | 'next-week' }
        // or   { restore: true } to un-snooze.
        if (path.startsWith('/api/actions/snooze/') && req.method === 'POST') {
          const rawId = path.slice('/api/actions/snooze/'.length)
          const id = decodeURIComponent(rawId)
          if (!id) {
            return jsonResponse(400, { error: 'id is required' })
          }
          try {
            const body = (await req.json()) as Record<string, unknown>
            const result = await proxyPost(
              ctx.stateDir,
              `/actions/snooze/${encodeURIComponent(id)}`,
              body,
            )
            return jsonResponse(result.status, result.body)
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        if (path === '/api/events') {
          const result = await proxyGet(ctx.stateDir, '/view/terminal-events')
          return jsonResponse(result.status, result.body)
        }

        if (path === '/api/release-notes') {
          const r = await proxyGet(ctx.stateDir, '/view/release-notes')
          if (r.status !== 200) return jsonResponse(r.status, r.body)
          const body = r.body as { entries?: unknown }
          return jsonResponse(200, body.entries ?? [])
        }

        // GET /api/trace-events — proxy the daemon's unified trace surface.
        // The path differs from the daemon's `/events` so it doesn't collide
        // with the UI server's existing `/events` SSE endpoint.
        if (path === '/api/trace-events' && req.method === 'GET') {
          const qs = url.search ?? ''
          const result = await proxyGet(ctx.stateDir, `/events${qs}`)
          return jsonResponse(result.status, result.body)
        }

        // GET /api/origins/:taskId — proxy the daemon's origin-tree endpoint.
        if (path.startsWith('/api/origins/') && req.method === 'GET') {
          const taskId = decodeURIComponent(path.slice('/api/origins/'.length))
          if (!taskId) {
            return jsonResponse(400, { error: 'taskId is required' })
          }
          const result = await proxyGet(
            ctx.stateDir,
            `/origins/${encodeURIComponent(taskId)}`,
          )
          return jsonResponse(result.status, result.body)
        }

        if (path === '/api/proposals') {
          // Forward the four supported filter/pagination params to the daemon.
          // Callers MUST pass what they need — no unfiltered default.
          const qs = new URLSearchParams()
          for (const param of ['source', 'status', 'limit', 'cursor'] as const) {
            const v = url.searchParams.get(param)
            if (v !== null) qs.set(param, v)
          }
          const daemonPath = qs.size > 0 ? `/view/proposals?${qs.toString()}` : '/view/proposals'
          const r = await proxyGet(ctx.stateDir, daemonPath)
          if (r.status !== 200) return jsonResponse(r.status, r.body)
          const body = r.body as { drafts?: unknown; total?: number; nextCursor?: string | null }
          return jsonResponse(200, {
            drafts: body.drafts ?? [],
            total: body.total ?? 0,
            nextCursor: body.nextCursor ?? null,
          })
        }

        // GET /api/proposals/:id — proxy the daemon's by-id proposal endpoint.
        if (path.startsWith('/api/proposals/') && req.method === 'GET') {
          const proposalId = decodeURIComponent(path.slice('/api/proposals/'.length))
          if (!proposalId) {
            return jsonResponse(400, { error: 'proposalId is required' })
          }
          const result = await proxyGet(
            ctx.stateDir,
            `/view/proposal/${encodeURIComponent(proposalId)}`,
          )
          return jsonResponse(result.status, result.body)
        }

        if (path === '/api/stale-worktrees') {
          const r = await proxyGet(ctx.stateDir, '/view/proposals')
          if (r.status !== 200) return jsonResponse(r.status, r.body)
          const body = r.body as { staleWorktrees?: unknown }
          return jsonResponse(200, { staleWorktrees: body.staleWorktrees ?? [] })
        }

        if (path === '/api/framework-update') {
          const r = await proxyGet(ctx.stateDir, '/view/framework-update')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/glossary' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/glossary')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/skills' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/skills')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/adrs' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/adrs')
          return jsonResponse(r.status, r.body)
        }

        if (path.startsWith('/api/project/adrs/') && req.method === 'GET') {
          const adrPath = decodeURIComponent(path.slice('/api/project/adrs/'.length))
          const content = readProjectAdr(ctx, adrPath)
          return content === null
            ? jsonResponse(404, { error: 'ADR not found' })
            : new Response(content, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
        }

        // GET /api/project/context — product vision and theme for the rail.
        if (path === '/api/project/context' && req.method === 'GET') {
          return jsonResponse(200, readProjectMeta(ctx))
        }

        if (path === '/api/project/meta/vision' && req.method === 'GET') {
          const content = readProjectMeta(ctx).vision
          return content === null
            ? jsonResponse(404, { error: 'Project vision not found' })
            : new Response(content, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
        }

        if (path === '/api/project/meta/theme' && req.method === 'GET') {
          const content = readProjectMeta(ctx).theme
          return content === null
            ? jsonResponse(404, { error: 'Project theme not found' })
            : new Response(content, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
        }

        // GET /api/vision — return raw VISION.md content for the focused project.
        // Reads directly from repoRoot (no daemon proxy needed — it is a plain file).
        // Returns { content: null } when VISION.md does not exist.
        if (path === '/api/vision' && req.method === 'GET') {
          const visionPath = join(ctx.repoRoot, 'docs', 'knowledge', 'vision.md')
          const content = existsSync(visionPath)
            ? readFileSync(visionPath, 'utf8')
            : null
          return jsonResponse(200, { content })
        }

        // GET /api/failure-kinds/learned-recipes — list all operator-taught
        // auto-run rules from the daemon. Used by the detail pane's un-teach
        // affordance and the WYWA panel.
        if (path === '/api/failure-kinds/learned-recipes' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/failure-kinds/learned-recipes')
          return jsonResponse(r.status, r.body)
        }

        // POST /api/failure-kinds/:signature/recipe — teach an auto-run op.
        // Body: { op: string }. Idempotent: re-posting replaces the existing op.
        {
          const teachMatch = path.match(/^\/api\/failure-kinds\/([^/?]+)\/recipe$/)
          if (teachMatch && teachMatch[1] && req.method === 'POST') {
            const signature = decodeURIComponent(teachMatch[1])
            const body = await req.json().catch(() => null)
            if (body === null || typeof (body as Record<string, unknown>).op !== 'string') {
              return jsonResponse(400, { error: 'op is required and must be a non-empty string' })
            }
            const r = await proxyPost(
              ctx.stateDir,
              `/failure-kinds/${encodeURIComponent(signature)}/recipe`,
              body,
            )
            return jsonResponse(r.status, r.body)
          }
        }

        // DELETE /api/failure-kinds/:signature/recipe — un-teach the stored
        // auto-run rule for a failure signature. No-op when no rule is stored.
        {
          const unlearnMatch = path.match(/^\/api\/failure-kinds\/([^/?]+)\/recipe$/)
          if (unlearnMatch && unlearnMatch[1] && req.method === 'DELETE') {
            const signature = decodeURIComponent(unlearnMatch[1])
            const r = await proxyDelete(
              ctx.stateDir,
              `/failure-kinds/${encodeURIComponent(signature)}/recipe`,
            )
            return jsonResponse(r.status, r.body)
          }
        }

        // GET /api/auto-recipe-runs?since=<ISO>&limit=<n> — recent auto-run
        // log entries from the daemon, newest-first. Used by the WYWA delta panel.
        if (path === '/api/auto-recipe-runs' && req.method === 'GET') {
          const qs = url.search
          const r = await proxyGet(ctx.stateDir, `/view/auto-recipe-runs${qs}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/steward-ledger?targetKind=<kind>&targetId=<id> — proxy the
        // daemon-owned, append-only intervention evidence into the UI.
        if (path === '/api/steward-ledger' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, `/view/steward-ledger${url.search}`)
          return jsonResponse(r.status, r.body)
        }

        // Steward and Watchtower projections are daemon-owned. Expose them
        // through /api so project selection and JSON error classification are
        // identical in the Vite client and the production UI server.
        if (path === '/api/steward' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/steward')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/loop-ledger' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, `/view/loop-ledger${url.search}`)
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/promotion-ledger' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, `/view/promotion-ledger${url.search}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/wywa-delta?since=<ISO>&limit=<n> — unified "while you were away"
        // delta (merges, recoveries, auto-recipes, throttle events, evaporated threads).
        if (path === '/api/wywa-delta' && req.method === 'GET') {
          const qs = url.search
          const r = await proxyGet(ctx.stateDir, `/view/wywa-delta${qs}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/release-notes-cursor — proxy the daemon's last-viewed
        // release-notes timestamp. POST marks it as viewed (server-clock now).
        if (path === '/api/release-notes-cursor' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/release-notes-cursor')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/release-notes-cursor' && req.method === 'POST') {
          const result = await proxyPost(ctx.stateDir, '/view/release-notes-cursor', {})
          return jsonResponse(result.status, result.body)
        }


        // GET /api/scorer-trend?workflow=<kind>&window=N — per-workflow scorer
        // score trend (median + p90 over a trailing window). Proxied to the
        // daemon's GET /view/scorer-trend. The UI's WatchtowerTrendChart reads
        // this to render the per-kind score history chart.
        if (path === '/api/scorer-trend' && req.method === 'GET') {
          const qs = url.search
          const r = await proxyGet(ctx.stateDir, `/view/scorer-trend${qs}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/scorer-workflows — distinct workflow kinds with at least one
        // scorer_result row, newest first. Proxied to the daemon's
        // GET /view/scorer-workflows. Used by WatchtowerSection to enumerate
        // which charts to render.
        if (path === '/api/scorer-workflows' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/scorer-workflows')
          return jsonResponse(r.status, r.body)
        }

        // GET /api/scorer-suggestions — suggested scorers not yet accepted or
        // dismissed. Proxied to the daemon's GET /view/scorer-suggestions. Used
        // by WatchtowerSection to surface pending suggestions when no results
        // exist yet.
        if (path === '/api/scorer-suggestions' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/scorer-suggestions')
          return jsonResponse(r.status, r.body)
        }

        // POST /api/scorer-accept — accept a suggested scorer by id. Proxied to
        // the daemon's POST /view/scorer-accept, which routes through the same
        // acceptScorer() path as `mars scorer accept <id>`. Body: { id: string }.
        if (path === '/api/scorer-accept' && req.method === 'POST') {
          try {
            const body = (await req.json()) as { id?: unknown }
            const result = await proxyPost(ctx.stateDir, '/view/scorer-accept', body)
            return jsonResponse(result.status, result.body)
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        // GET /api/deep-reflections/:originId — full detail for one arc reflection
        // report. Must be matched before /api/deep-reflections so the longer path wins.
        if (path.startsWith('/api/deep-reflections/') && req.method === 'GET') {
          const originId = decodeURIComponent(path.slice('/api/deep-reflections/'.length))
          if (!originId) {
            return jsonResponse(400, { error: 'originId is required' })
          }
          const r = await proxyGet(
            ctx.stateDir,
            `/view/deep-reflections/${encodeURIComponent(originId)}`,
          )
          return jsonResponse(r.status, r.body)
        }

        // GET /api/deep-reflections?limit=N — list arc reflection reports newest-first.
        if (path === '/api/deep-reflections' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, `/view/deep-reflections${url.search}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/kpis/:key/arcs — per-arc breakdown for a single KPI.
        // Must be matched before /api/kpis so the longer path wins.
        if (path.startsWith('/api/kpis/') && path.endsWith('/arcs') && req.method === 'GET') {
          const key = decodeURIComponent(path.slice('/api/kpis/'.length, -'/arcs'.length))
          if (!key) {
            return jsonResponse(400, { error: 'kpi key is required' })
          }
          try {
            const result = await proxyGet(ctx.stateDir, `/kpis/${encodeURIComponent(key)}/arcs`)
            return jsonResponse(result.status, result.body)
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        if (path === '/api/kpis') {
          try {
            const [kpis, series] = await Promise.all([
              fetchKpis(ctx.stateDir),
              fetchKpiSeries(ctx.stateDir),
            ])
            const seriesKeyMap: Record<string, keyof KpiSeries> = {
              failure_rate: 'failure_rate',
              autonomous_completion_rate: 'autonomous_completion_rate',
              recovery_success_rate: 'recovery_success_rate',
              cost_per_arc: 'cost_per_arc_p50',
            }
            const kpisWithSeries = kpis.map((kpi) => {
              const sk = seriesKeyMap[kpi.key]
              return { ...kpi, series: sk !== undefined ? series[sk] : [] }
            })
            return jsonResponse(200, { kpis: kpisWithSeries })
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        if (path === '/events') {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(encoder.encode(`event: hello\ndata: {}\n\n`))
              const client = hub.add(controller)
              const heartbeat = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(`: ping\n\n`))
                } catch {
                  // controller already closed
                }
              }, sseHeartbeatMs)
              req.signal.addEventListener('abort', () => {
                clearInterval(heartbeat)
                hub.remove(client)
                try {
                  controller.close()
                } catch {
                  // already closed
                }
              })
            },
          })
          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              'Access-Control-Allow-Origin': '*',
            },
          })
        }

        // GET /api/sessions?agentName=<name> — recent sessions for a Worker.
        // Proxied from daemon GET /view/sessions?agentName=<name>; the daemon
        // owns the trace-store query so schema drift is visible in one place.
        if (path === '/api/sessions' && req.method === 'GET') {
          const agentName = url.searchParams.get('agentName')
          if (!agentName) {
            return jsonResponse(400, { error: 'agentName query parameter is required' })
          }
          const r = await proxyGet(
            ctx.stateDir,
            `/view/sessions?agentName=${encodeURIComponent(agentName)}`,
          )
          return jsonResponse(r.status, r.body)
        }

        // GET /api/runs/:taskId — proxy the daemon's run-timeline endpoint.
        // Returns all workflow runs for the task with per-step status, duration,
        // token counts, and transcript references (claudeSessionId).
        if (path.startsWith('/api/runs/') && req.method === 'GET') {
          const taskId = decodeURIComponent(path.slice('/api/runs/'.length))
          if (!taskId) {
            return jsonResponse(400, { error: 'taskId is required' })
          }
          const result = await proxyGet(
            ctx.stateDir,
            `/view/runs/${encodeURIComponent(taskId)}`,
          )
          return jsonResponse(result.status, result.body)
        }

        // GET /api/agent-tool-calls?taskId=<id>&sessionId=<id> — the Coder's
        // own tool invocations for a specific Claude session, extracted from
        // stored transcript chunks. Proxied to the daemon's
        // GET /view/agent-tool-calls.
        if (path === '/api/agent-tool-calls' && req.method === 'GET') {
          const taskId = url.searchParams.get('taskId')
          const sessionId = url.searchParams.get('sessionId')
          if (!taskId || !sessionId) {
            return jsonResponse(400, {
              error: 'taskId and sessionId query parameters are required',
            })
          }
          const qs = `taskId=${encodeURIComponent(taskId)}&sessionId=${encodeURIComponent(sessionId)}`
          const r = await proxyGet(ctx.stateDir, `/view/agent-tool-calls?${qs}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/step-prompt?workflowInstanceId=<id>&stepName=<name> — the
        // composed prompt sent to one step's worker. Proxied to the daemon's
        // GET /view/step-prompt; fetched lazily by Studio's Input/Show-trace
        // panels, never as part of a span/timeline list fetch.
        if (path === '/api/step-prompt' && req.method === 'GET') {
          const workflowInstanceId = url.searchParams.get('workflowInstanceId')
          const stepName = url.searchParams.get('stepName')
          if (!workflowInstanceId || !stepName) {
            return jsonResponse(400, {
              error: 'workflowInstanceId and stepName query parameters are required',
            })
          }
          const qs = `workflowInstanceId=${encodeURIComponent(workflowInstanceId)}&stepName=${encodeURIComponent(stepName)}`
          const r = await proxyGet(ctx.stateDir, `/view/step-prompt?${qs}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/primitives — the fixed catalog of workflow primitives.
        // Proxied to the daemon's GET /view/primitives so the daemon remains
        // the single projection source for primitive identity.
        if (path === '/api/primitives' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/primitives')
          return jsonResponse(r.status, r.body)
        }

        // GET /api/primitives/:name?limit=N — the per-primitive facet
        // (identity, tool surface, recent-N run history). Proxied to the
        // daemon's GET /view/primitives/:name, mirroring /api/step-prompt.
        if (path.startsWith('/api/primitives/') && req.method === 'GET') {
          const name = decodeURIComponent(path.slice('/api/primitives/'.length))
          if (!name) {
            return jsonResponse(400, { error: 'primitive name is required' })
          }
          const limit = url.searchParams.get('limit')
          const qs = limit !== null ? `?limit=${encodeURIComponent(limit)}` : ''
          const r = await proxyGet(
            ctx.stateDir,
            `/view/primitives/${encodeURIComponent(name)}${qs}`,
          )
          return jsonResponse(r.status, r.body)
        }

        // GET /api/step-spans?taskId=<id> | ?originId=<id> — step timeline.
        // Proxied to the daemon's GET /view/step-spans so the daemon remains
        // the sole reader of the trace store. The drawer scopes by `taskId`
        // when showing a single task and by `originId` for a proposal/arc; the
        // daemon accepts either, so forward whichever is present rather than
        // demanding `originId` (which 400'd every task-scoped open).
        if (path === '/api/step-spans' && req.method === 'GET') {
          const taskId = url.searchParams.get('taskId')
          const originId = url.searchParams.get('originId')
          if (!taskId && !originId) {
            return jsonResponse(400, {
              error: 'taskId or originId query parameter is required',
            })
          }
          const qs = taskId
            ? `taskId=${encodeURIComponent(taskId)}`
            : `originId=${encodeURIComponent(originId!)}`
          const r = await proxyGet(ctx.stateDir, `/view/step-spans?${qs}`)
          return jsonResponse(r.status, r.body)
        }

        // GET /api/projects — return all registered projects with live health.
        if (path === '/api/projects' && req.method === 'GET') {
          try {
            const entries = loadProjectRegistry()
            const projects = await Promise.all(
              entries.map(async (e) => ({
                ...e,
                health: await probeDaemonHealth(e.repoRoot),
              })),
            )
            return jsonResponse(200, { projects })
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        // POST /api/projects/:id/start — start the daemon for a registered project.
        // The projectId is looked up in the registry; only its registered repoRoot
        // is ever passed to the spawner (no arbitrary path from the request body).
        if (
          path.startsWith('/api/projects/') &&
          path.endsWith('/start') &&
          req.method === 'POST'
        ) {
          const projectId = decodeURIComponent(
            path.slice('/api/projects/'.length, -'/start'.length),
          )
          const { status, body } = await handleProjectStart(projectId)
          return jsonResponse(status, body)
        }

        // POST /api/projects/:id/restart — restart the daemon for a registered project.
        // Works even when the daemon is dead: backs onto `mars daemon restart` (a fresh
        // OS process spawn), not an HTTP POST into the possibly-dead running daemon.
        // The projectId is looked up in the registry; only its registered repoRoot is
        // ever passed to the spawner (no arbitrary path from the request body).
        if (
          path.startsWith('/api/projects/') &&
          path.endsWith('/restart') &&
          req.method === 'POST'
        ) {
          const projectId = decodeURIComponent(
            path.slice('/api/projects/'.length, -'/restart'.length),
          )
          const { status, body } = await handleProjectRestart(projectId)
          return jsonResponse(status, body)
        }

        // ---------------------------------------------------------------------------
        // Chat proxy routes — forward to the daemon's chat-store endpoints.
        // GET  /api/chat/threads             → daemon /view/chat/threads
        // GET  /api/chat/thread/:id          → daemon /view/chat/thread/:id
        // GET  /api/chat/threads/:id/tasks   → daemon /chat/threads/:id/tasks
        // POST /api/chat/threads             → daemon /chat/threads (create)
        // POST /api/chat/subthreads          → daemon /chat/subthreads (create + send)
        // POST /api/chat/threads/:id/message → daemon /chat/threads/:id/message
        // POST /api/chat/threads/:id/stop    → daemon /chat/threads/:id/stop
        // POST /api/chat/threads/:id/title   → daemon /chat/threads/:id/title
        // POST /api/chat/threads/:id/end     → daemon /chat/threads/:id/end
        // ---------------------------------------------------------------------------

        if (path === '/api/chat/threads' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, `/view/chat/threads${url.search}`)
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/chat/conversation' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/chat/conversation')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/chat/history' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/chat/history')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/codex-auth' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/codex-auth')
          return jsonResponse(r.status, r.body)
        }

        // GET /api/chat/config — the chat agent's effective configuration
        // (model, system prompt, built-in tools, skills, MCP servers).
        if (path === '/api/chat/config' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/chat/config')
          return jsonResponse(r.status, r.body)
        }

        if (path === '/api/codex-auth/refresh' && req.method === 'POST') {
          const result = await proxyPost(ctx.stateDir, '/codex-auth/refresh', {})
          return jsonResponse(result.status, result.body)
        }

        if (path === '/api/chat/threads' && req.method === 'POST') {
          let body: unknown = {}
          try { body = await req.json() } catch { /* empty body fine */ }
          const result = await proxyPost(ctx.stateDir, '/chat/threads', body)
          return jsonResponse(result.status, result.body)
        }

        if (path === '/api/chat/subthreads' && req.method === 'POST') {
          let body: unknown = {}
          try { body = await req.json() } catch { /* daemon validates this */ }
          // The daemon endpoint is /chat/subthreads (not /chat/subjects — the old
          // server-side spelling was never updated when the vocabulary moved to Subthread).
          const result = await proxyPost(ctx.stateDir, '/chat/subthreads', body)
          return jsonResponse(result.status, result.body)
        }

        // GET /api/chat/thread/:id/ui-stream — stream the daemon's resumable
        // UIMessage-chunk SSE straight through (no JSON buffering). Must precede
        // the generic thread-detail GET below, which would otherwise treat
        // `<id>/ui-stream` as the thread id.
        if (
          path.startsWith('/api/chat/thread/') &&
          path.endsWith('/ui-stream') &&
          req.method === 'GET'
        ) {
          const rest = path.slice('/api/chat/thread/'.length, -'/ui-stream'.length)
          const threadId = decodeURIComponent(rest)
          if (!threadId) {
            return jsonResponse(400, { error: 'threadId is required' })
          }
          const port = await readDaemonHttpPort(ctx.stateDir)
          if (port === null) {
            return jsonResponse(503, {
              ok: false,
              error: 'daemon not running',
              errorCode: DAEMON_ERROR.NO_DAEMON,
            })
          }
          let daemonResp: Response
          try {
            daemonResp = await fetch(
              `http://127.0.0.1:${port}/chat/threads/${encodeURIComponent(threadId)}/ui-stream${url.search}`,
              { headers: { Accept: 'text/event-stream' }, signal: req.signal },
            )
          } catch (err) {
            return jsonResponse(502, {
              ok: false,
              error: (err as Error).message,
              errorCode: DAEMON_ERROR.PROXY_FAILED,
            })
          }
          // 204: no active run to attach to (resume mode) — relay verbatim.
          if (daemonResp.status === 204) return new Response(null, { status: 204 })
          if (!daemonResp.ok || daemonResp.body === null) {
            return jsonResponse(daemonResp.status, {
              ok: false,
              error: `daemon ui-stream responded ${daemonResp.status}`,
            })
          }
          return new Response(daemonResp.body, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              'Access-Control-Allow-Origin': '*',
            },
          })
        }

        if (path.startsWith('/api/chat/thread/') && req.method === 'GET') {
          const threadId = decodeURIComponent(path.slice('/api/chat/thread/'.length))
          if (!threadId) {
            return jsonResponse(400, { error: 'threadId is required' })
          }
          const r = await proxyGet(
            ctx.stateDir,
            `/view/chat/thread/${encodeURIComponent(threadId)}`,
          )
          return jsonResponse(r.status, r.body)
        }

        if (
          path.startsWith('/api/chat/threads/') &&
          path.endsWith('/tasks') &&
          req.method === 'GET'
        ) {
          const threadId = decodeURIComponent(
            path.slice('/api/chat/threads/'.length, -'/tasks'.length),
          )
          if (!threadId) {
            return jsonResponse(400, { error: 'threadId is required' })
          }
          const r = await proxyGet(
            ctx.stateDir,
            `/chat/threads/${encodeURIComponent(threadId)}/tasks`,
          )
          return jsonResponse(r.status, r.body)
        }

        // POST /api/chat/threads/:id/attachments — stream multipart upload to
        // daemon without buffering the file in memory. Must be checked before
        // the general thread-actions handler below.
        if (
          path.startsWith('/api/chat/threads/') &&
          path.endsWith('/attachments') &&
          req.method === 'POST'
        ) {
          const rest = path.slice('/api/chat/threads/'.length, -'/attachments'.length)
          const threadId = decodeURIComponent(rest)
          if (!threadId) {
            return jsonResponse(400, { error: 'threadId is required' })
          }
          const result = await proxyStream(
            ctx.stateDir,
            `/chat/threads/${encodeURIComponent(threadId)}/attachments`,
            req,
          )
          return jsonResponse(result.status, result.body)
        }

        // GET /api/chat/uploads/* — serve files from .mars/chat-uploads/ with
        // path-traversal protection (resolve + prefix check).
        if (path.startsWith('/api/chat/uploads/') && req.method === 'GET') {
          const rawSuffix = decodeURIComponent(path.slice('/api/chat/uploads/'.length))
          const uploadsRoot = resolve(ctx.stateDir, 'chat-uploads')
          const target = resolveUploadPath(uploadsRoot, rawSuffix)
          // Reject any path that escapes the uploads root.
          if (target === null) {
            return jsonResponse(400, { error: 'invalid path' })
          }
          if (!existsSync(target)) {
            return jsonResponse(404, { error: 'not found' })
          }
          const mimeType = MIME[extname(target)] ?? 'application/octet-stream'
          return new Response(Bun.file(target), {
            headers: { 'Content-Type': mimeType },
          })
        }

        if (path.startsWith('/api/chat/threads/') && req.method === 'POST') {
          // Parse: /api/chat/threads/:id/<action>
          const rest = path.slice('/api/chat/threads/'.length)
          const slashIdx = rest.indexOf('/')
          if (slashIdx === -1) {
            return jsonResponse(400, { error: 'missing action segment' })
          }
          const threadId = decodeURIComponent(rest.slice(0, slashIdx))
          const action = rest.slice(slashIdx + 1)
          if (!threadId) {
            return jsonResponse(400, { error: 'threadId is required' })
          }
          const allowed = ['message', 'stop', 'title', 'end']
          if (!allowed.includes(action)) {
            return jsonResponse(404, { error: 'not found' })
          }
          let body: unknown = {}
          try { body = await req.json() } catch { /* empty body fine */ }
          const result = await proxyPost(
            ctx.stateDir,
            `/chat/threads/${encodeURIComponent(threadId)}/${action}`,
            body,
          )
          return jsonResponse(result.status, result.body)
        }

        // POST /api/chat/messages/:id/feedback/clear — must be checked before
        // /feedback because the longer suffix also contains '/feedback'.
        if (
          path.startsWith('/api/chat/messages/') &&
          path.includes('/responses/') &&
          req.method === 'POST'
        ) {
          const rest = path.slice('/api/chat/messages/'.length)
          const [messageId, marker, responseId] = rest.split('/')
          if (!messageId || marker !== 'responses' || !responseId) {
            return jsonResponse(400, { error: 'message id and response id are required' })
          }
          const result = await proxyPost(
            ctx.stateDir,
            `/chat/messages/${encodeURIComponent(decodeURIComponent(messageId))}/responses/${encodeURIComponent(decodeURIComponent(responseId))}`,
            {},
          )
          return jsonResponse(result.status, result.body)
        }

        if (
          path.startsWith('/api/chat/messages/') &&
          path.endsWith('/feedback/clear') &&
          req.method === 'POST'
        ) {
          const id = decodeURIComponent(
            path.slice('/api/chat/messages/'.length, -'/feedback/clear'.length),
          )
          if (!id) {
            return jsonResponse(400, { error: 'message id is required' })
          }
          let body: unknown = {}
          try { body = await req.json() } catch { /* empty body fine */ }
          const result = await proxyPost(
            ctx.stateDir,
            `/chat/messages/${encodeURIComponent(id)}/feedback/clear`,
            body,
          )
          return jsonResponse(result.status, result.body)
        }

        // POST /api/chat/messages/:id/feedback
        if (
          path.startsWith('/api/chat/messages/') &&
          path.endsWith('/feedback') &&
          req.method === 'POST'
        ) {
          const id = decodeURIComponent(
            path.slice('/api/chat/messages/'.length, -'/feedback'.length),
          )
          if (!id) {
            return jsonResponse(400, { error: 'message id is required' })
          }
          let body: unknown = {}
          try { body = await req.json() } catch { /* empty body fine */ }
          const result = await proxyPost(
            ctx.stateDir,
            `/chat/messages/${encodeURIComponent(id)}/feedback`,
            body,
          )
          return jsonResponse(result.status, result.body)
        }

        // GET /api/preferences/notifications — proxy the daemon's desktop-
        // notification preference so the nav-bar toggle survives page reloads
        // and is visible to every connected client.
        if (path === '/api/preferences/notifications' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/preferences/notifications')
          return jsonResponse(r.status, r.body)
        }

        // PUT /api/preferences/notifications — update the desktop-notification
        // preference on the daemon (the single writer).
        if (path === '/api/preferences/notifications' && req.method === 'PUT') {
          let body: unknown = {}
          try { body = await req.json() } catch { /* empty body is fine */ }
          const result = await proxyPost(ctx.stateDir, '/preferences/notifications', body, 'PUT')
          return jsonResponse(result.status, result.body)
        }

        // POST /api/alerts/:arcId/thread — pull an Alert into a chat thread
        // (slice 4, ADR-0048). Checked before the bare GET /api/alerts so the
        // thread route matches first. The daemon is the sole writer (ADR-0035);
        // dedups by arc and does NOT clear the Alert from the Bell.
        if (
          path.startsWith('/api/alerts/') &&
          path.endsWith('/thread') &&
          req.method === 'POST'
        ) {
          const arcId = decodeURIComponent(
            path.slice('/api/alerts/'.length, -'/thread'.length),
          )
          if (!arcId) {
            return jsonResponse(400, { error: 'arc id is required' })
          }
          const result = await proxyPost(
            ctx.stateDir,
            `/alerts/${encodeURIComponent(arcId)}/thread`,
            {},
          )
          return jsonResponse(result.status, result.body)
        }

        // GET /api/alerts/next — proxy the daemon's hero next-action shortcut
        // target (the top Alert, or {} when none).
        if (path === '/api/alerts/next' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/alerts/next')
          return jsonResponse(r.status, r.body)
        }

        // GET /api/alerts — proxy the daemon's arc-rooted Alert list (ADR-0054).
        // The daemon derives these fresh on read (failed arcs + stale worktrees);
        // they are read-only and clear only by entity mutation (ADR-0048).
        if (path === '/api/alerts' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/alerts')
          return jsonResponse(r.status, r.body)
        }

        // POST /api/levers/:key — set the autonomy level for a lever. Body: { level: 'off'|'ask'|'tell' }.
        // Proxied to the daemon's /levers/:key endpoint. Setting 'off' mutes the
        // lever so subsequent Card creation from the same producer_key is suppressed.
        if (path.startsWith('/api/levers/') && req.method === 'POST') {
          const rawKey = path.slice('/api/levers/'.length)
          const key = decodeURIComponent(rawKey)
          if (!key) {
            return jsonResponse(400, { error: 'lever key is required' })
          }
          let body: unknown = {}
          try { body = await req.json() } catch { /* empty body — will be rejected by daemon */ }
          const result = await proxyPost(ctx.stateDir, `/levers/${encodeURIComponent(key)}`, body)
          return jsonResponse(result.status, result.body)
        }

        // Unknown API path (or /events was already handled above).
        return jsonResponse(404, { error: `no route for ${path}` })
      }

      if (distDir) {
        const r = staticResponse(distDir, path)
        if (r) return r
      }

      return new Response('not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      })
    },
  })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      const baseUrl = `http://${args.host}:${args.port}`
      let existingRepo: string | null = null
      try {
        const resp = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(500),
        })
        if (resp.ok) {
          const body = (await resp.json()) as { ok?: boolean; repo?: string }
          if (body.ok === true) existingRepo = body.repo ?? null
        }
      } catch {
        // probe failed — not mars-ui or not responding
      }
      if (existingRepo !== null) {
        if (existingRepo === defaultCtx.repoRoot) {
          console.log(
            `mars-ui: already running at ${baseUrl} — use \`mars ui stop\` to replace it`,
          )
          process.exit(0)
        }
        console.error(
          `mars-ui: port ${args.port} is in use by mars-ui for a different project (${existingRepo}) — pass --port <n> to use another port`,
        )
        process.exit(1)
      }
      console.error(
        `mars-ui: port ${args.port} is in use by another process — pass --port <n> or stop it first`,
      )
      process.exit(1)
    }
    throw err
  }

  const url = `http://${server.hostname}:${server.port}`
  console.log(`mars-ui  repo=${defaultCtx.repoRoot}`)
  console.log(`         db=${defaultCtx.queueDbPath}`)
  console.log(`         listening on ${url}`)
  return server
}

const UI_USAGE = `usage: mars-ui [--port <n>] [--host <h>] [--repo <path>] [--dist <path>] [--dev]

Launch the Mars read-only Kanban + trace dashboard.

Options:
  --port <n>     HTTP port to bind on (default: 7777)
  --host <h>     bind address (default: 127.0.0.1)
  --repo <path>  override the Mars repository root (default: git-detected)
  --dist <path>  serve static files from this directory
  --dev          development mode: Vite serves the frontend, this server
                 serves no static files`

if (import.meta.main) {
  const argv = Bun.argv.slice(2)
  // Check --help / -h before any side effect (parsing, the frontend-built
  // check, server bind, project registration). Checked against the raw argv
  // rather than after parseArgs so --help is honoured regardless of flag
  // order (e.g. --port 9000 --help) and even when the frontend is unbuilt.
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(UI_USAGE + '\n')
    process.exit(0)
  }
  const cliArgs = parseArgs(argv)
  if (!cliArgs.dev) {
    // In production mode verify the frontend is built before binding a port.
    // Defence-in-depth for direct invocations; ui/bin/mars-ui.mjs already
    // performs the same check before spawning this server.
    const serverDir = dirname(fileURLToPath(import.meta.url))
    const effectiveDistDir = cliArgs.distDir
      ? resolve(cliArgs.distDir)
      : resolve(serverDir, '..', 'dist')
    if (!existsSync(join(effectiveDistDir, 'index.html'))) {
      process.stderr.write(
        `mars-ui: frontend is not built.\n` +
          `  Run \`npm --prefix ${resolve(serverDir, '..')} run build\` first, then retry.\n`,
      )
      process.exit(1)
    }
  }
  startServer(cliArgs).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
