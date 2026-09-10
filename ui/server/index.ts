import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
  proxyAction as realProxyAction,
  proxyDelete,
  proxyGet as realProxyGet,
  proxyPost as realProxyPost,
  proxyStream,
  readDaemonHttpPort,
} from './daemonHttp.ts'
import { DAEMON_ERROR } from '../src/shared/daemonErrors.ts'

/**
 * Wrap a proxyGet function with stale-daemon-code detection. When the daemon
 * returns 404 or 405 for a route, check GET /view/daemon-version. If the
 * daemon reports that it is running older code than HEAD (isStale=true), return
 * a structured STALE_DAEMON_CODE error with both short SHAs instead of the raw
 * daemon body. The HTTP status is kept honest — the point is the payload, not
 * faking a 200.
 *
 * This wrapper is applied once at startup in {@link startServer} so every
 * /api/* route that proxies to the daemon gets the check automatically.
 *
 * @param rawProxyGet - The underlying proxyGet to wrap (and use for the
 *   daemon-version check to avoid infinite recursion through the wrapper).
 */
const withSkewDetection = (
  rawProxyGet: (stateDir: string, path: string) => Promise<import('./daemonHttp.ts').DaemonActionResult>,
): ((stateDir: string, path: string) => Promise<import('./daemonHttp.ts').DaemonActionResult>) =>
  async (stateDir, path) => {
    const r = await rawProxyGet(stateDir, path)
    if (r.status !== 404 && r.status !== 405) return r

    // Check if the daemon is stale (HEAD has advanced since it started).
    // Use rawProxyGet directly to avoid recursing through this wrapper.
    let versionResult: import('./daemonHttp.ts').DaemonActionResult | null = null
    try {
      versionResult = await rawProxyGet(stateDir, '/view/daemon-version')
    } catch {
      // Treat any error fetching daemon-version as "no info" — fall through.
    }
    if (versionResult?.status !== 200) return r

    const v = versionResult.body as {
      isStale?: boolean
      sourceSha?: string | null
      currentSha?: string | null
    }
    if (!v.isStale || !v.sourceSha || !v.currentSha) return r

    const src = v.sourceSha.slice(0, 7)
    const cur = v.currentSha.slice(0, 7)
    return {
      status: r.status,
      body: {
        ok: false,
        errorCode: DAEMON_ERROR.STALE_DAEMON_CODE,
        sourceSha: src,
        currentSha: cur,
        error: `Daemon is running older code (\`${src}\` vs \`${cur}\`). Run \`mars daemon restart\`.`,
      },
    }
  }
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
  /**
   * Root of the UI source tree (the directory containing `src/`, `index.html`,
   * `package.json`, `vite.config.ts`). When provided, `startServer` compares
   * the newest source mtime against `dist/index.html` mtime at startup and
   * throws if the bundle is stale. When omitted the check is skipped — tests
   * that do not care about staleness leave this unset.
   */
  srcDir?: string
}

const presetToIso = (preset: string): string | null => {
  const now = Date.now()
  switch (preset) {
    case '1h': return new Date(now + 60 * 60 * 1000).toISOString()
    case '4h': return new Date(now + 4 * 60 * 60 * 1000).toISOString()
    case 'tomorrow-morning': {
      const d = new Date(now)
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      return d.toISOString()
    }
    case 'next-week': {
      const d = new Date(now)
      d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
      d.setHours(9, 0, 0, 0)
      return d.toISOString()
    }
    default: return null
  }
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
  /**
   * Injectable seam for the POST /api/actions endpoint. Defaults to the real
   * {@link realProxyAction} which forwards to the running daemon. Tests inject
   * a stub to control daemon responses without starting a real daemon.
   */
  proxyAction?: (stateDir: string, op: string, entityId?: string, body?: Record<string, unknown>) => Promise<DaemonActionResult>
  /** SSE heartbeat interval in ms. Defaults to 15 000. Override in tests to avoid slow polls. */
  sseHeartbeatMs?: number
  /**
   * Called once at startup to register this repo in the project registry.
   * Defaults to {@link ensureProjectRegistered}. Override in tests to control
   * or observe registration without touching the real filesystem.
   */
  _registerProject?: (repoRoot: string) => void
  /**
   * Called when a stale bundle is detected at boot, on SIGHUP, or via the
   * /rebuild admin route. Defaults to spawning `npm run build` in the ui
   * directory, streaming output to the parent process. Override in tests to
   * avoid running a real build.
   */
  _runBuild?: (uiDir: string) => Promise<void>
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

/**
 * Return the newest mtime (in ms) across all files under `dir`, recursively.
 * Returns 0 when the directory is missing, empty, or unreadable.
 */
const maxMtimeMs = (dir: string): number => {
  let max = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return max
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        max = Math.max(max, maxMtimeMs(full))
      } else {
        max = Math.max(max, st.mtimeMs)
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  return max
}

/**
 * True when a request is for the app shell rather than a build asset.
 *
 * The SPA serves index.html for `/` and for every client-side route (which
 * carry no file extension), while Vite emits every real asset with an
 * extension (`.js`, `.css`, `.svg`, …). Testing for a missing extension is
 * therefore an exact split, not a heuristic, and keeps the freshness check off
 * the hot asset path.
 */
export const isDocumentRequest = (method: string, urlPath: string): boolean => {
  if (method !== 'GET' && method !== 'HEAD') return false
  if (urlPath === '/') return true
  const ext = extname(urlPath)
  return ext === '' || ext === '.html'
}

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
  // Wrap proxyGet with stale-daemon-code detection so every proxied /api/*
  // route automatically gets a structured STALE_DAEMON_CODE error when the
  // daemon returns 404/405 AND reports that it is running older code than HEAD.
  const rawProxyGet = deps.proxyGet ?? realProxyGet
  const proxyGet = withSkewDetection(rawProxyGet)
  const proxyPost = deps.proxyPost ?? realProxyPost
  const proxyAction = deps.proxyAction ?? realProxyAction
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? 15_000

  // Build runner: spawn npm run build in the ui directory.
  // Overridden in tests via deps._runBuild to avoid running a real build.
  const runBuild = deps._runBuild ?? (async (uiDir: string): Promise<void> => {
    console.log('mars-ui: bundle is stale — rebuilding (npm run build)…')
    const proc = Bun.spawn(['npm', 'run', 'build'], {
      cwd: uiDir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`npm run build exited with code ${exitCode}`)
    }
  })
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

  // Staleness guard — only runs when a srcDir was provided (production startup
  // passes the UI root; tests that don't care omit srcDir to skip this).
  if (distDir && args.srcDir) {
    const srcDir = resolve(args.srcDir)
    // Collect the newest mtime across tracked source files.
    let newestSrc = maxMtimeMs(join(srcDir, 'src'))
    for (const f of ['index.html', 'package.json', 'vite.config.ts']) {
      try {
        newestSrc = Math.max(newestSrc, statSync(join(srcDir, f)).mtimeMs)
      } catch { /* file may not exist */ }
    }
    // Compare against dist/index.html which is the canonical build output.
    let distBuiltAtMs = 0
    try {
      distBuiltAtMs = statSync(join(distDir, 'index.html')).mtimeMs
    } catch { /* missing dist — handled by the not-built check above */ }

    if (newestSrc > distBuiltAtMs) {
      // Bundle is stale — auto-rebuild before serving so the operator doesn't
      // have to run a manual build step. Hard error only if the build fails.
      const srcDate = newestSrc > 0 ? new Date(newestSrc).toISOString() : 'unknown'
      const distDate = distBuiltAtMs > 0 ? new Date(distBuiltAtMs).toISOString() : 'never built'
      try {
        await runBuild(srcDir)
      } catch (buildErr) {
        throw new Error(
          `mars-ui: frontend bundle is stale — source is newer than the last build.\n` +
          `  dist built: ${distDate}\n` +
          `  src newest: ${srcDate}\n` +
          `  Build failed: ${(buildErr as Error).message}\n` +
          `  Run \`npm --prefix <ui-dir> run build\` to rebuild, then retry.`,
        )
      }
    }
  }

  // Bundle provenance — read once at startup so /healthz and the startup log
  // both report the same build timestamp without re-statting on every request.
  let bundleBuiltAt: string | null = null
  if (distDir) {
    try {
      bundleBuiltAt = new Date(statSync(join(distDir, 'index.html')).mtimeMs).toISOString()
    } catch { /* dist not present — the not-built check above will surface this */ }
  }

  // Re-check staleness and rebuild if needed. Called by the SIGHUP handler, the
  // /rebuild admin route, and every document (app-shell) request.
  //
  // Concurrent callers JOIN the in-flight build rather than being turned away.
  // Turning them away would defeat the point: a page load that arrives during a
  // rebuild would be served the very stale bundle the rebuild exists to replace.
  let rebuildInFlight: Promise<'fresh' | 'rebuilt'> | null = null
  const rebuildIfStale = async (): Promise<'fresh' | 'rebuilt'> => {
    if (!distDir || !args.srcDir) return 'fresh'
    if (rebuildInFlight) return rebuildInFlight
    const uiDir = resolve(args.srcDir)
    let newestSrc = maxMtimeMs(join(uiDir, 'src'))
    for (const f of ['index.html', 'package.json', 'vite.config.ts']) {
      try { newestSrc = Math.max(newestSrc, statSync(join(uiDir, f)).mtimeMs) } catch {}
    }
    let distMs = 0
    try { distMs = statSync(join(distDir, 'index.html')).mtimeMs } catch {}
    if (newestSrc <= distMs) return 'fresh'
    const run = (async (): Promise<'fresh' | 'rebuilt'> => {
      await runBuild(uiDir)
      try { bundleBuiltAt = new Date(statSync(join(distDir, 'index.html')).mtimeMs).toISOString() } catch {}
      return 'rebuilt'
    })()
    rebuildInFlight = run
    try {
      return await run
    } finally {
      rebuildInFlight = null
    }
  }

  let server: Awaited<ReturnType<typeof Bun.serve>>
  try {
    server = await Bun.serve({
      port: args.port,
      hostname: args.host,
      idleTimeout: 0,
      async fetch(req): Promise<Response> {
      // Outer guard: a malformed percent-encoded segment (e.g. GET /api/tasks/%)
      // would propagate the URIError from decodeURIComponent as an unhandled
      // rejection.  Catch it here and return a plain 400 instead.
      try {
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
        const healthBody: Record<string, unknown> = { ok: true, repo: defaultCtx.repoRoot }
        if (args.dev) {
          healthBody.servedFrom = 'vite-dev'
        } else if (bundleBuiltAt !== null) {
          healthBody.bundleBuiltAt = bundleBuiltAt
          healthBody.servedFrom = 'dist'
        }
        return jsonResponse(200, healthBody)
      }

      // POST|GET /rebuild — admin trigger: re-check bundle freshness and rebuild
      // if dist is older than src. Lets a long-running server pick up merges
      // without a manual bounce. Idempotent and serialised (concurrent requests
      // return 'in-progress').
      if (path === '/rebuild' && (req.method === 'GET' || req.method === 'POST')) {
        try {
          const action = await rebuildIfStale()
          return jsonResponse(200, { ok: true, action })
        } catch (err) {
          return jsonResponse(500, { ok: false, error: (err as Error).message })
        }
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

        if (path === '/api/status-counts') {
          const r = await proxyGet(ctx.stateDir, '/view/status-counts')
          return jsonResponse(r.status, r.body)
        }

        // GET /api/counts — board-level count summary (tasks by status + proposals).
        // Proxied from the daemon's /view/counts so every project-selector context
        // uses the same projection. The UI calls this path (not /api/status-counts)
        // for the board header badges.
        if (path === '/api/counts') {
          const r = await proxyGet(ctx.stateDir, '/view/counts')
          return jsonResponse(r.status, r.body)
        }

        // GET /api/hot-paths — per-file/dir change frequency over a rolling
        // window. Proxies GET /view/hot-paths on the daemon.
        if (path === '/api/hot-paths') {
          const r = await proxyGet(ctx.stateDir, `/view/hot-paths${url.search}`)
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

        // GET /api/task/:id/live — live-task panel data for awaiting-human tasks.
        // Proxies GET /view/task/:id/live on the daemon.
        if (req.method === 'GET' && path.startsWith('/api/task/') && path.endsWith('/live')) {
          const urlPart = path.slice('/api/task/'.length, -'/live'.length)
          const id = decodeURIComponent(urlPart)
          if (!id) {
            return jsonResponse(400, { error: 'id is required' })
          }
          const r = await proxyGet(ctx.stateDir, `/view/task/${encodeURIComponent(id)}/live`)
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
            const rawBody = (await req.json()) as Record<string, unknown>
            const { op, entityId, ...rest } = rawBody
            if (typeof op !== 'string' || op.length === 0) {
              return jsonResponse(400, { error: 'op is required and must be a string' })
            }
            if (entityId !== undefined && typeof entityId !== 'string') {
              return jsonResponse(400, { error: 'entityId must be a string when present' })
            }
            // Forward any extra body keys (e.g. field/value for proposal.set-field,
            // story for proposal.add-story, index for proposal.remove-story) to the
            // daemon so mutation ops can receive their parameters end-to-end.
            const extraBody = Object.keys(rest).length > 0 ? rest : undefined
            const result = await proxyAction(ctx.stateDir, op, entityId, extraBody)
            return jsonResponse(result.status, result.body)
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        // POST /api/actions/snooze/:id — proxy the daemon's snooze endpoint.
        // Body: { preset: '1h' | '4h' | 'tomorrow-morning' | 'next-week' }
        // or   { restore: true } to un-snooze.
        // The daemon expects { until: ISO-timestamp }, so the server converts
        // the preset to an absolute timestamp before proxying.
        if (path.startsWith('/api/actions/snooze/') && req.method === 'POST') {
          const rawId = path.slice('/api/actions/snooze/'.length)
          const id = decodeURIComponent(rawId)
          if (!id) {
            return jsonResponse(400, { error: 'id is required' })
          }
          try {
            const body = (await req.json()) as Record<string, unknown>
            let daemonBody: Record<string, unknown>
            if (typeof body.preset === 'string') {
              const until = presetToIso(body.preset)
              if (!until) {
                return jsonResponse(400, { error: `unknown snooze preset: ${body.preset}` })
              }
              daemonBody = { until }
            } else if (body.restore === true) {
              daemonBody = { restore: true }
            } else if (typeof body.until === 'string') {
              daemonBody = body
            } else {
              return jsonResponse(400, { error: 'Body must be { preset } or { until } or { restore: true }' })
            }
            const result = await proxyPost(
              ctx.stateDir,
              `/actions/snooze/${encodeURIComponent(id)}`,
              daemonBody,
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

        // POST /api/proposals/:id/thread — open a Grill chat thread seeded for
        // this proposal. Checked before the GET handler so the `/thread` suffix
        // matches before the bare `/:id` form. Following the same pattern as
        // POST /api/alerts/:id/thread: fetch the proposal, create a chat thread
        // with the proposal title, seed it with the proposal context, return { threadId }.
        if (
          path.startsWith('/api/proposals/') &&
          path.endsWith('/thread') &&
          req.method === 'POST'
        ) {
          const rawId = path.slice('/api/proposals/'.length, -'/thread'.length)
          const proposalId = decodeURIComponent(rawId)
          if (!proposalId) {
            return jsonResponse(400, { error: 'proposal id is required' })
          }
          try {
            const proposalResult = await proxyGet(
              ctx.stateDir,
              `/view/proposal/${encodeURIComponent(proposalId)}`,
            )
            if (proposalResult.status !== 200) {
              return jsonResponse(proposalResult.status, proposalResult.body)
            }
            const proposal = proposalResult.body as {
              title?: string
              problem?: string
              solution?: string
              userStories?: string[]
              outOfScope?: string
            }
            const threadTitle = `Grill: ${String(proposal.title ?? proposalId)}`
            const threadResult = await proxyPost(ctx.stateDir, '/chat/threads', { title: threadTitle })
            if (threadResult.status !== 200) {
              return jsonResponse(threadResult.status, threadResult.body)
            }
            const thread = threadResult.body as { id?: string }
            const threadId = String(thread.id ?? '')

            // Seed the thread with proposal context so Grill starts with full background.
            // Each non-empty field gets its own labeled ## section; empty sections
            // are omitted entirely. Sections are joined with a blank line between them.
            const contextParts: string[] = []
            const problem = (proposal.problem ?? '').trim()
            if (problem) contextParts.push(`## Problem\n${problem}`)
            const solution = (proposal.solution ?? '').trim()
            if (solution) contextParts.push(`## Solution\n${solution}`)
            if (Array.isArray(proposal.userStories) && proposal.userStories.length > 0) {
              const storiesText = proposal.userStories.map((s, i) => `${i + 1}. ${s}`).join('\n')
              contextParts.push(`## User Stories\n${storiesText}`)
            }
            const outOfScope = (proposal.outOfScope ?? '').trim()
            if (outOfScope) contextParts.push(`## Out of Scope\n${outOfScope}`)

            if (contextParts.length > 0 && threadId) {
              // Non-fatal: thread is already created. A seed-message failure is cosmetic.
              await proxyPost(
                ctx.stateDir,
                `/chat/threads/${encodeURIComponent(threadId)}/message`,
                { role: 'context', content: contextParts.join('\n\n') },
              ).catch(() => { /* swallow — seed failure must not fail thread creation */ })
            }

            return jsonResponse(200, { threadId })
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        // PUT /api/proposals/:id/fields — update one or more top-level fields on
        // a proposal. Body: { field: string; value: unknown } (single field) or
        // { fields: Record<string, unknown> } (batch). Checked before the generic
        // GET /api/proposals/:id handler so the `/fields` suffix wins.
        // Proxied to daemon PUT /proposals/:id/fields.
        if (
          path.startsWith('/api/proposals/') &&
          path.endsWith('/fields') &&
          req.method === 'PUT'
        ) {
          const rawId = path.slice('/api/proposals/'.length, -'/fields'.length)
          const proposalId = decodeURIComponent(rawId)
          if (!proposalId) {
            return jsonResponse(400, { error: 'proposal id is required' })
          }
          let body: unknown = {}
          try { body = await req.json() } catch { /* daemon validates shape */ }
          const result = await proxyPost(
            ctx.stateDir,
            `/proposals/${encodeURIComponent(proposalId)}/fields`,
            body,
            'PUT',
          )
          return jsonResponse(result.status, result.body)
        }

        // PUT /api/proposals/:id/user-stories/:storyId — update a user story.
        // Checked before the POST /user-stories handler (more-specific path wins).
        // Body: { title?: string; description?: string }. Proxied to daemon PUT.
        if (
          path.startsWith('/api/proposals/') &&
          path.includes('/user-stories/') &&
          req.method === 'PUT'
        ) {
          const afterPrefix = path.slice('/api/proposals/'.length)
          const splitIdx = afterPrefix.indexOf('/user-stories/')
          const proposalId = decodeURIComponent(afterPrefix.slice(0, splitIdx))
          const storyId = decodeURIComponent(
            afterPrefix.slice(splitIdx + '/user-stories/'.length),
          )
          if (!proposalId || !storyId) {
            return jsonResponse(400, { error: 'proposal id and story id are required' })
          }
          let body: unknown = {}
          try { body = await req.json() } catch { /* daemon validates shape */ }
          const result = await proxyPost(
            ctx.stateDir,
            `/proposals/${encodeURIComponent(proposalId)}/user-stories/${encodeURIComponent(storyId)}`,
            body,
            'PUT',
          )
          return jsonResponse(result.status, result.body)
        }

        // DELETE /api/proposals/:id/user-stories/:storyId — remove a user story.
        if (
          path.startsWith('/api/proposals/') &&
          path.includes('/user-stories/') &&
          req.method === 'DELETE'
        ) {
          const afterPrefix = path.slice('/api/proposals/'.length)
          const splitIdx = afterPrefix.indexOf('/user-stories/')
          const proposalId = decodeURIComponent(afterPrefix.slice(0, splitIdx))
          const storyId = decodeURIComponent(
            afterPrefix.slice(splitIdx + '/user-stories/'.length),
          )
          if (!proposalId || !storyId) {
            return jsonResponse(400, { error: 'proposal id and story id are required' })
          }
          const result = await proxyDelete(
            ctx.stateDir,
            `/proposals/${encodeURIComponent(proposalId)}/user-stories/${encodeURIComponent(storyId)}`,
          )
          return jsonResponse(result.status, result.body)
        }

        // POST /api/proposals/:id/user-stories — add a new user story to a proposal.
        // Body: { title: string; description?: string }. Proxied to daemon POST.
        // Checked before the generic GET /api/proposals/:id so the suffix wins.
        if (
          path.startsWith('/api/proposals/') &&
          path.endsWith('/user-stories') &&
          req.method === 'POST'
        ) {
          const rawId = path.slice('/api/proposals/'.length, -'/user-stories'.length)
          const proposalId = decodeURIComponent(rawId)
          if (!proposalId) {
            return jsonResponse(400, { error: 'proposal id is required' })
          }
          let body: unknown = {}
          try { body = await req.json() } catch { /* daemon validates shape */ }
          const result = await proxyPost(
            ctx.stateDir,
            `/proposals/${encodeURIComponent(proposalId)}/user-stories`,
            body,
          )
          return jsonResponse(result.status, result.body)
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

        // GET /api/operator — live operator-control state: dispatch pause, control
        // levers, and concurrency caps. Proxied from the daemon's /view/operator.
        if (path === '/api/operator' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/operator')
          return jsonResponse(r.status, r.body)
        }

        // POST /api/operator/dispatch — toggle dispatch on or off.
        // Body: { value: 'on' | 'off' }. Proxied to the daemon's POST /operator/dispatch.
        if (path === '/api/operator/dispatch' && req.method === 'POST') {
          const body = await req.json().catch(() => null)
          const r = await proxyPost(ctx.stateDir, '/operator/dispatch', body ?? {})
          return jsonResponse(r.status, r.body)
        }

        // POST /api/operator/recovery — toggle the recovery kill-switch on or off.
        // Body: { value: 'on' | 'off' }. Proxied to the daemon's POST /operator/recovery.
        if (path === '/api/operator/recovery' && req.method === 'POST') {
          const body = await req.json().catch(() => null)
          const r = await proxyPost(ctx.stateDir, '/operator/recovery', body ?? {})
          return jsonResponse(r.status, r.body)
        }

        // POST /api/operator/:lever — generic control-lever write.
        // Proxied to the daemon's POST /operator/:lever. Handles all named boolean
        // control levers (recovery, scoring, memory-capture, auto-run-reflect,
        // operator-auto-commit). The daemon rejects unknown names with 400.
        // dispatch and recovery have dedicated routes above that are matched first.
        {
          const operatorLeverMatch =
            req.method === 'POST'
              ? path.match(/^\/api\/operator\/([^/]+)$/)
              : null
          if (operatorLeverMatch && operatorLeverMatch[1]) {
            const lever = decodeURIComponent(operatorLeverMatch[1])
            const body = await req.json().catch(() => null)
            const r = await proxyPost(ctx.stateDir, `/operator/${encodeURIComponent(lever)}`, body ?? {})
            return jsonResponse(r.status, r.body)
          }
        }

        // GET /api/verify-gates — full list of verify gates. Proxied from the
        // daemon's GET /view/verify-gates. Returns { gates: VerifyGate[] }.
        if (path === '/api/verify-gates' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, '/view/verify-gates')
          return jsonResponse(r.status, r.body)
        }

        // POST /api/verify-gates/:id/restore — restore a quarantined gate to
        // active. Proxied to the daemon's POST /verify-gates/:id/restore.
        {
          const restoreMatch =
            req.method === 'POST'
              ? path.match(/^\/api\/verify-gates\/([^/]+)\/restore$/)
              : null
          if (restoreMatch && restoreMatch[1]) {
            const id = decodeURIComponent(restoreMatch[1])
            const r = await proxyPost(
              ctx.stateDir,
              `/verify-gates/${encodeURIComponent(id)}/restore`,
              {},
            )
            return jsonResponse(r.status, r.body)
          }
        }

        // DELETE /api/verify-gates/:id — remove or quarantine a verify gate.
        // Proxied to the daemon's DELETE /verify-gates/:id.
        {
          const removeMatch =
            req.method === 'DELETE'
              ? path.match(/^\/api\/verify-gates\/([^/]+)$/)
              : null
          if (removeMatch && removeMatch[1]) {
            const id = decodeURIComponent(removeMatch[1])
            const r = await proxyDelete(
              ctx.stateDir,
              `/verify-gates/${encodeURIComponent(id)}`,
            )
            return jsonResponse(r.status, r.body)
          }
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
        // The `?at=<recordedAt>` query parameter is forwarded to the daemon so it can
        // select the exact report file when multiple share the same originId.
        if (path.startsWith('/api/deep-reflections/') && req.method === 'GET') {
          const originId = decodeURIComponent(path.slice('/api/deep-reflections/'.length))
          if (!originId) {
            return jsonResponse(400, { error: 'originId is required' })
          }
          const at = url.searchParams.get('at')
          const daemonQs = at ? `?at=${encodeURIComponent(at)}` : ''
          const r = await proxyGet(
            ctx.stateDir,
            `/view/deep-reflections/${encodeURIComponent(originId)}${daemonQs}`,
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

        // GET /api/kpi/cost-per-merged-task?days=N — cost-per-merged-task trend.
        // Proxies to the daemon's /kpi/cost-per-merged-task endpoint.
        if (path === '/api/kpi/cost-per-merged-task' && req.method === 'GET') {
          try {
            const r = await proxyGet(
              ctx.stateDir,
              `/kpi/cost-per-merged-task${url.search}`,
            )
            return jsonResponse(r.status, r.body)
          } catch (err) {
            return jsonResponse(500, { error: (err as Error).message })
          }
        }

        // GET /api/workflow-configs?workflow=<kind> — versioned workflow config
        // records. Proxies to the daemon's /view/workflow-configs endpoint.
        if (path === '/api/workflow-configs' && req.method === 'GET') {
          const workflow = url.searchParams.get('workflow')
          if (!workflow) {
            return jsonResponse(400, { error: 'workflow query param is required' })
          }
          try {
            const r = await proxyGet(
              ctx.stateDir,
              `/view/workflow-configs${url.search}`,
            )
            return jsonResponse(r.status, r.body)
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

        // GET /api/task/:id/changes — per-file diff summary, unified patch, and
        // commits for a task. Proxied to the daemon's GET /view/task/:id/changes.
        // Always returns 200 (even for the branch-gone shape), never 404.
        {
          const changesMatch =
            req.method === 'GET'
              ? path.match(/^\/api\/task\/([^/]+)\/changes$/)
              : null
          if (changesMatch && changesMatch[1]) {
            const taskId = decodeURIComponent(changesMatch[1])
            const r = await proxyGet(
              ctx.stateDir,
              `/view/task/${encodeURIComponent(taskId)}/changes`,
            )
            return jsonResponse(r.status, r.body)
          }
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
        // DELETE /api/chat/threads/:id       → daemon DELETE /chat/threads/:id
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

        // POST /api/chat/threads/from-queue-item — open (or reuse) the thread
        // for an action-queue row. Must precede the DELETE/:id matcher below.
        if (path === '/api/chat/threads/from-queue-item' && req.method === 'POST') {
          let body: unknown = {}
          try { body = await req.json() } catch { /* daemon validates this */ }
          const result = await proxyPost(ctx.stateDir, '/chat/threads/from-queue-item', body)
          return jsonResponse(result.status, result.body)
        }

        // DELETE /api/chat/threads/:id — remove a Subthread for good.
        if (path.startsWith('/api/chat/threads/') && req.method === 'DELETE') {
          const threadId = decodeURIComponent(path.slice('/api/chat/threads/'.length))
          if (!threadId || threadId.includes('/')) {
            return jsonResponse(400, { ok: false, error: 'thread id required' })
          }
          const result = await proxyDelete(
            ctx.stateDir,
            `/chat/threads/${encodeURIComponent(threadId)}`,
          )
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

        // POST /api/lever-apply — apply one lever value through the daemon's
        // persistence path. Body: { leverId: string; proposedValue: string; findingId?: string }.
        // Proxied to the daemon's /lever-apply endpoint so a single writer owns daemon.json.
        if (path === '/api/lever-apply' && req.method === 'POST') {
          let body: unknown = {}
          try { body = await req.json() } catch { /* empty body — rejected by daemon */ }
          const result = await proxyPost(ctx.stateDir, '/lever-apply', body)
          return jsonResponse(result.status, result.body)
        }

        // GET /api/lever-apply-history[?leverId=<id>] — history of applied lever changes.
        // Proxied to the daemon's /lever-apply-history endpoint, newest-first.
        if (path === '/api/lever-apply-history' && req.method === 'GET') {
          const r = await proxyGet(ctx.stateDir, `/lever-apply-history${url.search}`)
          return jsonResponse(r.status, r.body)
        }

        // Unknown API path (or /events was already handled above).
        return jsonResponse(404, { error: `no route for ${path}` })
      }

      // GET|HEAD /mockups/<id>.html — serve a generated mockup file from
      // <stateDir>/mockups/<id>.html. The mockup workflow writes the HTML here
      // via finalizeMockup; the ProposalDetailDrawer and ProposalCard both
      // probe with HEAD to decide whether to show the "View mockup" affordance.
      // Uses the default project's stateDir (mockup IDs are globally unique
      // proposal IDs so no per-project routing is needed).
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        path.startsWith('/mockups/') &&
        path.endsWith('.html')
      ) {
        let fileName: string
        try {
          fileName = decodeURIComponent(path.slice('/mockups/'.length))
        } catch {
          return jsonResponse(400, { error: 'invalid URL encoding in mockup path' })
        }
        const mockupsDir = resolve(defaultCtx.stateDir, 'mockups')
        const mockupPath = resolve(mockupsDir, fileName)
        // Safety: prevent path-traversal outside stateDir/mockups/.
        // Guard runs on the decoded path so percent-encoded traversal sequences
        // (e.g. %2F..%2F) are resolved before the check.
        if (!mockupPath.startsWith(mockupsDir + '/') && mockupPath !== mockupsDir) {
          return jsonResponse(400, { error: 'invalid mockup path' })
        }
        if (!existsSync(mockupPath)) {
          return new Response('mockup not found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          })
        }
        // For HEAD requests return headers only — no body.
        if (req.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }
        return new Response(Bun.file(mockupPath), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      if (distDir) {
        // Serve-time freshness. The boot-time staleness guard runs exactly once,
        // so a server left running across a merge kept serving the bundle it
        // booted with — silently, and indefinitely. Re-checking here means any
        // full page load picks up merged source.
        //
        // Scoped to document requests (the app shell) so the src/ mtime walk
        // runs once per navigation, not once per hashed asset.
        if (isDocumentRequest(req.method, path)) {
          try {
            const action = await rebuildIfStale()
            if (action === 'rebuilt') {
              console.log('mars-ui: bundle rebuilt on page load — source had advanced past the last build')
            }
          } catch (err) {
            // Never fail the page load over a rebuild: serving the stale bundle
            // beats serving nothing. The error is logged so the operator can see
            // why the UI still looks old.
            console.error(`mars-ui: rebuild on page load failed: ${(err as Error).message}`)
          }
        }
        const r = staticResponse(distDir, path)
        if (r) return r
      }

      return new Response('not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      })
      } catch (err) {
        if (err instanceof URIError) {
          return jsonResponse(400, { error: 'malformed URL encoding in request path' })
        }
        throw err
      }
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
  if (args.dev) {
    console.log(`         serving via vite dev server`)
  } else if (bundleBuiltAt) {
    console.log(`         serving dist (built ${bundleBuiltAt})`)
  }

  // On SIGHUP, re-check bundle freshness and rebuild if src has advanced.
  // Lets an operator trigger a pick-up of merged UI changes without a full
  // server bounce: `kill -HUP $(lsof -ti TCP:7777)`.
  const sighupHandler = () => {
    rebuildIfStale().then((action) => {
      console.log(`mars-ui: SIGHUP rebuild — ${action}`)
    }).catch((err: unknown) => {
      console.error(`mars-ui: rebuild failed (SIGHUP): ${(err as Error).message}`)
    })
  }
  process.on('SIGHUP', sighupHandler)

  // Wrap stop() so the SIGHUP listener is removed when the server shuts down.
  // Prevents MaxListenersExceededWarning in tests that start multiple instances.
  const originalStop = server.stop.bind(server)
  server.stop = (...args: Parameters<typeof server.stop>) => {
    process.removeListener('SIGHUP', sighupHandler)
    return originalStop(...args)
  }

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
    // Pass the UI root so startServer can detect a stale bundle at boot.
    cliArgs.srcDir = resolve(serverDir, '..')
  }
  startServer(cliArgs).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
