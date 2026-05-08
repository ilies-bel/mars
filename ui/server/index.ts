import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { StateDb, TaskDb } from './db.ts'
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

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(json)
}

const serveStatic = (root: string, urlPath: string, res: ServerResponse): boolean => {
  const safe = normalize(urlPath).replace(/^(\.\.[\\/])+/, '')
  const candidate = join(root, safe === '/' ? 'index.html' : safe)
  if (!candidate.startsWith(root)) return false
  let target = candidate
  if (!existsSync(target) || statSync(target).isDirectory()) {
    target = join(root, 'index.html')
    if (!existsSync(target)) return false
  }
  const mime = MIME[extname(target)] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime })
  createReadStream(target).pipe(res)
  return true
}

export const startServer = async (args: CliArgs): Promise<void> => {
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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/'
    const qIdx = rawUrl.indexOf('?')
    const url = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    if (url === '/healthz') {
      sendJson(res, 200, { ok: true, repo: ctx.repoRoot })
      return
    }

    if (url === '/api/tasks') {
      try {
        const exists = await db.tableExists()
        const tasks = exists ? await db.listTasks() : []
        sendJson(res, 200, { tasks })
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message })
      }
      return
    }

    if (url === '/api/todo') {
      try {
        const ideasExist = await stateDb.ideasTableExists()
        const drafts = ideasExist ? await stateDb.listDraftFeatures() : []
        const suggExist = await db.suggestionsTableExists()
        const suggestions = suggExist ? await db.listProposedSuggestions() : []
        sendJson(res, 200, { drafts, suggestions })
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message })
      }
      return
    }

    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(`event: hello\ndata: {}\n\n`)
      hub.add(res)
      return
    }

    if (url.startsWith('/api/') || url === '/events') {
      sendJson(res, 404, { error: `no route for ${url}` })
      return
    }

    if (distDir) {
      if (serveStatic(distDir, url, res)) return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  server.listen(args.port, args.host, () => {
    const url = `http://${args.host}:${args.port}`
    console.log(`mars-ui  repo=${ctx.repoRoot}`)
    console.log(`         db=${ctx.queueDbPath}`)
    console.log(`         listening on ${url}`)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2))
  startServer(args).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
