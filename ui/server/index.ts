import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { loadAgents } from './agents.ts'
import { StateDb, TaskDb } from './db.ts'
import { listTerminalEvents } from './events.ts'
import { aggregateInbox } from './inbox.ts'
import { listInboxItems, parseSourceParam } from './inboxItems.ts'
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
  watchQueue(ctx.queueDbPath, () => {
    hub.broadcast('tasks')
    hub.broadcast('todo')
  })
  watchQueue(ctx.stateDbPath, () => {
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
        try {
          const exists = await db.tableExists()
          const tasks = exists ? await db.listTasks() : []
          return jsonResponse(200, { tasks })
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
      }

      if (path === '/api/progress') {
        try {
          const tasks = await db.listProgressTasks()
          return jsonResponse(200, { tasks })
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
        try {
          const items = await stateDb.listOpenInboxItems()
          return jsonResponse(200, items)
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
      }

      if (path === '/api/inbox') {
        try {
          const inbox = await aggregateInbox(db, stateDb)
          return jsonResponse(200, inbox)
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
      }

      if (path === '/api/inbox/items') {
        try {
          const source = parseSourceParam(url.searchParams.get('source'))
          if (source === 'invalid') {
            return jsonResponse(400, {
              error: "source must be one of 'draft', 'blocked', 'failed'",
            })
          }
          const items = await listInboxItems(db, stateDb, source)
          return jsonResponse(200, items)
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
