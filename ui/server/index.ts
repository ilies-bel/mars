import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { loadProjectRegistry } from '../../orchestrator/src/registry/projects.ts'
import {
  fetchKpis,
  fetchKpiSeries,
  type KpiSeries,
  type DaemonActionResult,
  proxyAction,
  proxyGet as realProxyGet,
  proxyPost,
} from './daemonHttp.ts'
import { createProjectContextCache, type ProjectContextEntry } from './projectContext.ts'
import { probeDaemonHealth } from './projectHealth.ts'
import { resolveRepo, UnknownProjectError } from './repo.ts'
import { handleProjectStart, handleProjectRestart } from './spawnDaemon.ts'

interface CliArgs {
  repo?: string
  port: number
  host: string
  distDir?: string
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
): Promise<ReturnType<typeof Bun.serve>> => {
  const proxyGet = deps.proxyGet ?? realProxyGet
  // Resolve the default context once for startup logging and healthz.
  const defaultCtx = resolveRepo(args.repo)
  // Per-project handle cache: lazily opens TaskDb/StateDb/SseHub on first
  // request per project and reuses them on subsequent requests.
  const getProjectContext = createProjectContextCache(args.repo)

  const distDir = args.distDir ? resolve(args.distDir) : undefined

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port: args.port,
      hostname: args.host,
      async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
        const { ctx, db, hub } = pctx

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
          try {
            const task = await db.findTaskById(id)
            if (!task) {
              return jsonResponse(404, { error: 'not_found', id })
            }
            return jsonResponse(200, { task })
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
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
          const r = await proxyGet(ctx.stateDir, '/view/proposals')
          if (r.status !== 200) return jsonResponse(r.status, r.body)
          const body = r.body as { drafts?: unknown }
          return jsonResponse(200, { drafts: body.drafts ?? [] })
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

        // GET /api/budget — spend-meter status (observe-and-warn token-budget
        // alerting; NOT a fifth KPI). Proxied to the daemon's GET /budget so
        // the daemon stays the single reader of its own database.
        if (path === '/api/budget' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/budget')
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
              req.signal.addEventListener('abort', () => {
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

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2))
  startServer(args).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
