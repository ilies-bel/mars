import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { loadAgents } from './agents.ts'
import { fetchKpis, proxyAction, proxyGet } from './daemonHttp.ts'
import { StateDb, TaskDb } from './db.ts'
import { listTerminalEvents } from './events.ts'
import { resolveRepo } from './repo.ts'
import { SseHub } from './sse.ts'
import { watchQueue } from './watch.ts'

interface CliArgs {
  repo?: string
  port: number
  host: string
  distDir?: string
}

const parseArgs = (argv: string[]): CliArgs => {
  const out: CliArgs = { port: 7777, host: '127.0.0.1' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--repo') out.repo = next()
    else if (a === '--port') out.port = Number(next())
    else if (a === '--host') out.host = next() ?? out.host
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
): Promise<ReturnType<typeof Bun.serve>> => {
  const ctx = resolveRepo(args.repo)
  const db = new TaskDb(ctx.queueDbPath)
  await db.init()
  const stateDb = new StateDb(ctx.stateDbPath)
  await stateDb.init()

  const hub = new SseHub()
  // queueDbPath and stateDbPath now resolve to the same `.mars/mars.db`
  // file (see resolveRepo), so a single watcher covers both task and
  // proposal/inbox mutations — broadcast every affected channel from it.
  watchQueue(ctx.queueDbPath, () => {
    hub.broadcast('tasks')
    hub.broadcast('todo')
  })

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
        return jsonResponse(200, { ok: true, repo: ctx.repoRoot })
      }

      if (path === '/api/tasks') {
        const r = await proxyGet(ctx.stateDir, '/view/tasks')
        return jsonResponse(r.status, r.body)
      }

      if (path === '/api/progress') {
        try {
          const failedWindowParam = url.searchParams.get('failedWindow')
          let windowMs: number | null = 24 * 60 * 60 * 1000
          if (failedWindowParam === 'all') {
            windowMs = null
          } else if (failedWindowParam !== null) {
            const parsed = Number(failedWindowParam)
            if (!Number.isNaN(parsed) && parsed > 0) windowMs = parsed
          }
          const tasks = await db.listProgressTasks(Date.now(), windowMs)
          // Collect unique proposal IDs referenced by in-scope tasks
          const proposalIds = [
            ...new Set(
              tasks.map((t) => t.parentProposalId).filter((id): id is string => id !== null),
            ),
          ]
          const proposals = await stateDb.listProposalsByIds(proposalIds)
          return jsonResponse(200, { tasks, proposals })
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
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

      if (path === '/api/agents') {
        try {
          const agents = await loadAgents(ctx.repoRoot)
          return jsonResponse(200, { agents })
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
      }

      if (path === '/api/inbox/action-queue') {
        const r = await proxyGet(ctx.stateDir, `/view/inbox${url.search}`)
        return jsonResponse(r.status, r.body)
      }

      if (
        (path === '/api/inbox/dismiss' ||
          path === '/api/inbox/ack' ||
          path === '/api/inbox/resolve') &&
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
            return jsonResponse(400, { error: `unknown inbox kind: ${kind}` })
          }
          if (path === '/api/inbox/ack') {
            await stateDb.ackInboxEntity(entityKind, entityId)
          } else if (path === '/api/inbox/resolve') {
            await stateDb.resolveInboxEntity(entityKind, entityId)
          } else {
            await stateDb.dismissInboxEntity(entityKind, entityId)
          }
          return jsonResponse(200, { ok: true })
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
        try {
          const events = await listTerminalEvents(db)
          return jsonResponse(200, { events })
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
      }

      // GET /api/failure-reasons — proxy the daemon's resolved failure-reason
      // catalog so the inbox detail panel can render `Reason: <userMessage>`.
      if (path === '/api/failure-reasons' && req.method === 'GET') {
        const result = await proxyGet(ctx.stateDir, '/failure-reasons')
        return jsonResponse(result.status, result.body)
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

      if (path === '/api/todo') {
        try {
          const proposalsExist = await stateDb.proposalsTableExists()
          const drafts = proposalsExist ? await stateDb.listDraftFeatures() : []
          const staleWorktrees = await stateDb.listOpenStaleWorktreeAlerts()
          return jsonResponse(200, { drafts, staleWorktrees })
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
      }

      if (path === '/api/kpis') {
        try {
          const kpis = await fetchKpis(ctx.stateDir)
          return jsonResponse(200, { kpis })
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
      }

      if (path === '/api/todo/dismiss' && req.method === 'POST') {
        try {
          const body = await req.json() as { id?: unknown; kind?: unknown }
          const { id, kind } = body
          if (!id || typeof id !== 'string') {
            return jsonResponse(400, { error: 'id is required and must be a string' })
          }
          if (kind !== 'draft' && kind !== 'stale') {
            return jsonResponse(400, { error: 'kind must be "draft" or "stale"' })
          }
          if (kind === 'draft') {
            await stateDb.dismissDraftFeature(id)
          } else {
            await stateDb.dismissStaleWorktree(id)
          }
          return jsonResponse(200, { ok: true })
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

      if (path.startsWith('/api/')) {
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
      let isOurServer = false
      try {
        const resp = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(500),
        })
        if (resp.ok) {
          const body = (await resp.json()) as { ok?: boolean }
          isOurServer = body.ok === true
        }
      } catch {
        // probe failed — not mars-ui or not responding
      }
      if (isOurServer) {
        console.log(
          `mars-ui: already running at ${baseUrl} — use \`mars ui stop\` to replace it`,
        )
        process.exit(0)
      }
      console.error(
        `mars-ui: port ${args.port} is in use by another process — pass --port <n> or stop it first`,
      )
      process.exit(1)
    }
    throw err
  }

  const url = `http://${server.hostname}:${server.port}`
  console.log(`mars-ui  repo=${ctx.repoRoot}`)
  console.log(`         db=${ctx.queueDbPath}`)
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
