import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { hasRecipe } from '../../orchestrator/src/mastra/lib/fix-recipes.ts'
import { DAEMON_KILLED_SIGNATURE } from '../../orchestrator/src/mastra/lib/retry-budget.ts'
import { loadAgents } from './agents.ts'
import { fetchErrorKinds, fetchKpis, proxyAction, proxyGet } from './daemonHttp.ts'
import { StateDb, TaskDb } from './db.ts'
import { listTerminalEvents } from './events.ts'
import { resolveRepo } from './repo.ts'
import { SseHub } from './sse.ts'
import { watchQueue } from './watch.ts'

/** The three inbox row kinds the action-queue handler maps persisted rows to. */
type DerivedInboxKind = 'failed-task' | 'stale-worktree' | 'draft-proposal'

/** Filter parameter accepted by GET /api/inbox/action-queue. */
type DerivedInboxFilter = 'open' | 'dismissed' | 'all'

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
        try {
          const filterRaw = url.searchParams.get('filter')
          const filter: DerivedInboxFilter =
            filterRaw === 'dismissed' || filterRaw === 'all'
              ? filterRaw
              : 'open'

          // Fetch the action-menu registry from the daemon (empty if the
          // daemon is down — rows then render without buttons).
          const errorKinds = await fetchErrorKinds(ctx.stateDir)
          const registry = new Map(errorKinds.map((e) => [e.kind, e]))

          // Read all open inbox rows from the persisted store.
          // This replaces the on-demand derived scan (no .mars/worktrees readdir/stat).
          const persistedRows = await stateDb.listOpenInboxItems()
          const dismissalMap = await stateDb.listInboxDismissals()

          // Load tasks for DAG enrichment (still a DB query, not a disk scan).
          const tasksExist = await db.tableExists()
          const allTasks = tasksExist ? await db.listTasks() : []
          const taskById = new Map(allTasks.map((t) => [t.id, t]))
          const blockingMap = new Map<string, string[]>()
          for (const t of allTasks) {
            for (const blkId of t.blockedBy) {
              const arr = blockingMap.get(blkId) ?? []
              arr.push(t.id)
              blockingMap.set(blkId, arr)
            }
          }

          // Map a persisted InboxKind to the ActionQueueItem `kind` vocabulary.
          const toUiKind = (k: string): DerivedInboxKind => {
            if (k === 'stale-worktree') return 'stale-worktree'
            if (k === 'draft-proposal') return 'draft-proposal'
            return 'failed-task'
          }

          // Map a persisted InboxKind to the dismissal entity kind.
          const toEntityKind = (
            uiKind: DerivedInboxKind,
          ): 'task' | 'worktree' | 'proposal' =>
            uiKind === 'stale-worktree'
              ? 'worktree'
              : uiKind === 'draft-proposal'
                ? 'proposal'
                : 'task'

          // Extract the entity id (task id, worktree id, or proposal id) from
          // a raw inbox row. Prefers payload/context fields written by known
          // raisers; falls back to the stored signature, then the row id.
          const extractEntityId = (
            row: { kind: string; payload: Record<string, unknown>; context: Record<string, unknown>; id: string },
          ): string => {
            if (row.kind === 'stale-worktree') {
              if (typeof row.context.taskId === 'string') return row.context.taskId
            }
            if (row.kind === 'draft-proposal') {
              if (typeof row.payload.proposalId === 'string') return row.payload.proposalId
            }
            if (typeof row.payload.taskId === 'string') return row.payload.taskId
            if (typeof row.payload.originTaskId === 'string') return row.payload.originTaskId
            return row.id
          }

          // Map persisted priority to the ActionQueueItem three-tier vocabulary.
          const toUiPriority = (p: string): 'high' | 'normal' | 'low' => {
            if (p === 'urgent' || p === 'high') return 'high'
            if (p === 'low') return 'low'
            return 'normal'
          }

          // Resolve the errorKind key: 'failed' maps to 'failed-task' for
          // backwards compat with the action registry; all other kinds pass through.
          const toErrorKind = (k: string): string =>
            k === 'failed' ? 'failed-task' : k

          const noteToAckState = (
            note: string | null,
          ): 'ack' | 'resolved' | 'dismissed' => {
            if (note === 'ack') return 'ack'
            if (note === 'resolved') return 'resolved'
            return 'dismissed'
          }

          const toNode = (id: string) => {
            const t = taskById.get(id)
            const summarize = (prompt: string): string => {
              const oneLine = prompt.replace(/\s+/g, ' ').trim()
              return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 79)}…`
            }
            return {
              id,
              status: (t?.status ?? 'dropped') as string,
              summary: t ? summarize(t.prompt) : '(unknown task)',
            }
          }

          type StaleWorktreeDetail = {
            prompt: string | null
            status: string
            ageHours: number
            updatedAt: string
            branch: string | null
            empty: boolean
            investigation: string | null
          }

          type ActionQueueRow = {
            id: string
            kind: DerivedInboxKind
            entityId: string
            priority: 'high' | 'normal' | 'low'
            title: string
            body: string
            at: string
            dag: {
              blockers: ReturnType<typeof toNode>[]
              blocking: ReturnType<typeof toNode>[]
              descendants: ReturnType<typeof toNode>[]
              proposalId: string | null
            } | null
            dismissed: boolean
            ackState: 'ack' | 'resolved' | 'dismissed' | null
            errorKind: string
            actions: ReturnType<typeof registry.get> extends undefined
              ? never[]
              : { id: string; label: string; op: string }[]
            staleWorktreeDetail: StaleWorktreeDetail | null
            diagnosis: { text: string; diagnosedAt: string } | null
            /**
             * Failure-reason catalog code (`tasks.failure_reason_code` /
             * inbox-row payload). Null on non-failed rows and on legacy rows
             * landed before slice G started writing the typed code. The UI
             * looks the code up in the `/failure-reasons` catalog to render
             * `Reason: <userMessage>` in the detail panel.
             */
            failureReasonCode: string | null
          }

          const rows: ActionQueueRow[] = []

          for (const row of persistedRows) {
            const uiKind = toUiKind(row.kind)
            const entityId = extractEntityId(row)
            const entityKind = toEntityKind(uiKind)
            const dismissalKey = `${entityKind}:${entityId}`
            const ackState: 'ack' | 'resolved' | 'dismissed' | null =
              dismissalMap.has(dismissalKey)
                ? noteToAckState(dismissalMap.get(dismissalKey) ?? null)
                : null
            const dismissed =
              ackState === 'resolved' || ackState === 'dismissed'
            const errorKind = toErrorKind(row.kind)
            const allActions =
              (registry.get(errorKind)?.recoveryActions ?? []) as {
                id: string
                label: string
                op: string
              }[]

            // Gate the Investigate (diagnose-failure) action to unknown-signature
            // failures only. A signature with a registered recipe auto-recovers,
            // and a daemon-killed task just needs a requeue — neither warrants a
            // one-shot root-cause diagnosis. The signature lives on the task row.
            const gatedTask = taskById.get(entityId)
            const sig = gatedTask?.failureSignature ?? null
            const diagnosable =
              uiKind === 'failed-task' &&
              sig !== null &&
              sig !== DAEMON_KILLED_SIGNATURE &&
              !hasRecipe(sig)
            const actions = diagnosable
              ? allActions
              : allActions.filter((a) => a.op !== 'diagnose-failure')

            // DAG enrichment for task-backed rows.
            let dag: ActionQueueRow['dag'] = null
            if (uiKind === 'failed-task') {
              const task = taskById.get(entityId)
              if (task) {
                const blockers = task.blockedBy.map(toNode)
                const blocking = (blockingMap.get(entityId) ?? []).map(toNode)
                dag = {
                  blockers,
                  blocking,
                  descendants: [],
                  proposalId: task.parentProposalId,
                }
              }
            }

            // Stale-worktree enrichment: extract task context from payload and
            // compute a git-derived 'empty' flag (no diff vs merge-base with
            // main AND no untracked files). Conservative default: false.
            let staleWorktreeDetail: StaleWorktreeDetail | null = null
            if (uiKind === 'stale-worktree') {
              const task = taskById.get(entityId)
              const worktreePath = join(ctx.repoRoot, '.mars', 'worktrees', entityId)
              let empty = false
              if (existsSync(worktreePath)) {
                try {
                  const base = execFileSync(
                    'git',
                    ['-C', worktreePath, 'merge-base', 'HEAD', 'main'],
                    { encoding: 'utf8' },
                  ).trim()
                  let hasDiff = false
                  try {
                    execFileSync(
                      'git',
                      ['-C', worktreePath, 'diff', '--quiet', `${base}..HEAD`],
                      { encoding: 'utf8' },
                    )
                  } catch {
                    hasDiff = true
                  }
                  const porcelain = hasDiff
                    ? 'X'
                    : execFileSync(
                        'git',
                        ['-C', worktreePath, 'status', '--porcelain'],
                        { encoding: 'utf8' },
                      ).trim()
                  empty = !hasDiff && porcelain === ''
                } catch {
                  // git unavailable or worktree not a git repo — conservative
                  empty = false
                }
              }
              staleWorktreeDetail = {
                prompt:
                  typeof row.payload.prompt === 'string'
                    ? row.payload.prompt
                    : (task?.prompt ?? null),
                status:
                  task?.status ??
                  (typeof row.payload.status === 'string'
                    ? row.payload.status
                    : 'absent (no matching task)'),
                ageHours:
                  typeof row.payload.ageHours === 'number'
                    ? row.payload.ageHours
                    : 0,
                updatedAt:
                  task?.updatedAt ??
                  (typeof row.payload.updatedAt === 'string'
                    ? row.payload.updatedAt
                    : row.lastSeenAt),
                branch:
                  typeof row.payload.branch === 'string'
                    ? row.payload.branch
                    : (task?.branch ?? null),
                empty,
                investigation:
                  typeof row.payload.investigation === 'string'
                    ? row.payload.investigation
                    : null,
              }
            }

            // Diagnosis persisted by the diagnose-failure agent onto the inbox
            // payload as { text, diagnosedAt }.
            let diagnosis: { text: string; diagnosedAt: string } | null = null
            const rawDiagnosis = row.payload.diagnosis
            if (
              rawDiagnosis !== null &&
              typeof rawDiagnosis === 'object' &&
              typeof (rawDiagnosis as { text?: unknown }).text === 'string' &&
              typeof (rawDiagnosis as { diagnosedAt?: unknown }).diagnosedAt ===
                'string'
            ) {
              diagnosis = {
                text: (rawDiagnosis as { text: string }).text,
                diagnosedAt: (rawDiagnosis as { diagnosedAt: string }).diagnosedAt,
              }
            }

            // Pull the failure-reason catalog code from the inbox payload
            // (inbox-repopulator writes `failureReasonCode` on every
            // failed-task raise). For non-failure rows this stays null.
            const failureReasonCode =
              typeof row.payload.failureReasonCode === 'string'
                ? row.payload.failureReasonCode
                : null

            rows.push({
              id: row.id,
              kind: uiKind,
              entityId,
              priority: toUiPriority(row.priority),
              title: row.title,
              body: row.body,
              at: row.lastSeenAt,
              dag,
              dismissed,
              ackState,
              errorKind,
              actions,
              staleWorktreeDetail,
              diagnosis,
              failureReasonCode,
            })
          }

          const PRIORITY_RANK: Record<'high' | 'normal' | 'low', number> = {
            high: 0, normal: 1, low: 2,
          }
          const filtered =
            filter === 'all'
              ? rows
              : filter === 'dismissed'
                ? rows.filter((r) => r.dismissed)
                : rows.filter((r) => !r.dismissed)

          filtered.sort((a, b) => {
            const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
            return pr !== 0 ? pr : b.at.localeCompare(a.at)
          })

          // When ≥2 daemon-killed rows are visible, prepend a batch-restart row.
          const daemonKilledVisible = filtered.filter(
            (r) => r.errorKind === 'daemon-killed',
          )
          if (daemonKilledVisible.length >= 2) {
            const batchActions = (
              registry.get('daemon-killed-batch')?.recoveryActions ?? []
            ) as { id: string; label: string; op: string }[]
            const newest = daemonKilledVisible[0]!
            filtered.unshift({
              id: 'failed-task:__daemon-killed-batch__',
              kind: 'failed-task',
              entityId: '__daemon-killed-batch__',
              priority: 'high',
              title: `Restart all daemon-killed tasks (${daemonKilledVisible.length})`,
              body:
                `${daemonKilledVisible.length} tasks were in flight when the daemon was killed.\n` +
                `None of these failures are task faults — a fresh dispatch is very likely to succeed.`,
              at: newest.at,
              dag: null,
              dismissed: false,
              ackState: null,
              errorKind: 'daemon-killed-batch',
              actions: batchActions,
              staleWorktreeDetail: null,
              diagnosis: null,
              failureReasonCode: null,
            })
          }

          return jsonResponse(200, filtered)
        } catch (err) {
          return jsonResponse(500, { error: (err as Error).message })
        }
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
