import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { resolveContext } from '../context'
import {
  deleteTask,
  enqueueTask,
  getTask,
  hasIncompleteBlockers,
  initQueue,
  listTasks,
  updateTask,
  type Task,
} from '../queue'
import { promoteSuggestion } from '../queue-suggestions'
import { daemonPaths } from './paths'
import {
  readLines,
  writeLine,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStatusPayload,
} from './protocol'

const LOG_ROTATE_BYTES = 10 * 1024 * 1024

type DispatchKind = 'triage' | 'implement' | 'refine'

interface InFlightEntry {
  taskId: string
  kind: DispatchKind
}

export interface DaemonHandle {
  stop: (force?: boolean) => Promise<void>
  inFlightCount: () => number
}

export interface DaemonOptions {
  integrationBranch?: string
  log?: (line: string) => void
}

const writeLog = (logFile: string, line: string): void => {
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  try {
    if (existsSync(logFile)) {
      const size = statSync(logFile).size
      if (size > LOG_ROTATE_BYTES) {
        renameSync(logFile, `${logFile}.1`)
      }
    } else {
      mkdirSync(dirname(logFile), { recursive: true })
    }
    appendFileSync(logFile, stamped)
  } catch {
    // best-effort
  }
}

export const startDaemon = async (
  opts: DaemonOptions = {},
): Promise<DaemonHandle> => {
  const integrationBranch =
    opts.integrationBranch ?? process.env.INTEGRATION_BRANCH ?? 'integration'
  const { socket: socketPath, pidFile, logFile } = daemonPaths()
  const log = (line: string): void => {
    writeLog(logFile, line)
    opts.log?.(line)
  }

  // Stale-socket cleanup. We expect the client to have already reclaimed
  // a dead daemon's PID file; this just clears the socket inode.
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // best-effort
    }
  }

  await initQueue()

  const bus = new EventEmitter()
  bus.setMaxListeners(50)

  const inFlight = new Map<string, InFlightEntry>()
  const startedAt = new Date().toISOString()
  let shuttingDown = false

  const trackInFlight = (taskId: string, kind: DispatchKind): (() => void) => {
    inFlight.set(taskId, { taskId, kind })
    return () => inFlight.delete(taskId)
  }

  const dispatchTriage = async (taskId: string): Promise<void> => {
    if (inFlight.has(taskId)) return
    const release = trackInFlight(taskId, 'triage')
    log(`[triage] ${taskId} dispatching`)
    try {
      const { runTriage } = await import('../workflows/triage-workflow')
      const result = await runTriage(taskId)
      log(
        `[triage] ${taskId} -> actionable=${result.actionable} blockers=${result.blockerCount} suggestions=${result.suggestionCount}`,
      )
      if (result.actionable) {
        const t = await getTask(taskId)
        if (t?.status === 'queued') {
          if (await hasIncompleteBlockers(taskId)) {
            log(`[triage] ${taskId} actionable but has incomplete blockers; not dispatching`)
          } else {
            bus.emit('task.queued', { taskId })
          }
        }
      }
    } catch (err) {
      log(`[triage] ${taskId} failed: ${(err as Error).message}`)
    } finally {
      release()
    }
  }

  const dispatchImplement = async (task: Task): Promise<void> => {
    if (inFlight.has(task.id)) return
    const release = trackInFlight(task.id, 'implement')
    log(`[implement] ${task.id} dispatching`)
    try {
      const { mastra } = await import('../index')
      const wf = mastra.getWorkflow('implementWorkflow')
      const run = await wf.createRun()
      const result = await run.start({
        inputData: {
          taskId: task.id,
          prompt: task.prompt,
          plan: task.plan,
          integrationBranch,
        },
      })
      const { isBlockersAbortError } = await import('../workflows/implement-workflow')
      const resultError = 'error' in result && result.error instanceof Error ? result.error : null
      if (result.status === 'failed' && resultError && isBlockersAbortError(resultError)) {
        log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
        return
      }
      log(`[implement] ${task.id} -> ${result.status}`)
      bus.emit('task.completed', { taskId: task.id, status: result.status })
    } catch (err) {
      const message = (err as Error).message
      const { isBlockersAbortError } = await import('../workflows/implement-workflow')
      if (isBlockersAbortError(err)) {
        log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
      } else {
        log(`[implement] ${task.id} failed: ${message}`)
        try {
          await updateTask(task.id, { status: 'failed', error: message })
        } catch {
          // best-effort
        }
        bus.emit('task.failed', { taskId: task.id, error: message })
      }
    } finally {
      release()
    }
  }

  const dispatchRefine = async (
    taskId: string,
    refresh: boolean,
  ): Promise<void> => {
    if (inFlight.has(taskId)) return
    const release = trackInFlight(taskId, 'refine')
    log(`[refine] ${taskId} dispatching (refresh=${refresh})`)
    try {
      const { runPlan } = await import('../workflows/plan-workflow')
      const result = await runPlan(taskId, refresh)
      log(
        `[refine] ${taskId} -> questions=${result.questionCount} suggestions=${result.suggestionCount}`,
      )
    } catch (err) {
      log(`[refine] ${taskId} failed: ${(err as Error).message}`)
    } finally {
      release()
    }
  }

  bus.on('task.added', (e: { taskId: string }) => {
    void dispatchTriage(e.taskId)
  })

  bus.on('task.refine', (e: { taskId: string; refresh: boolean }) => {
    void dispatchRefine(e.taskId, e.refresh)
  })

  bus.on('task.queued', (e: { taskId: string }) => {
    void (async () => {
      const task = await getTask(e.taskId)
      if (task && task.status === 'queued') {
        if (await hasIncompleteBlockers(task.id)) {
          log(`[dispatch] ${task.id} blocked; deferring until blockers complete`)
          return
        }
        void dispatchImplement(task)
      }
    })()
  })

  // ── Wrappers around queue ops that emit the right events ──────────────────

  const handleAdd = async (
    prompt: string,
    plan?: Task['plan'],
    skipTriage?: boolean,
    author?: Task['author'],
  ): Promise<Task> => {
    const opts: Parameters<typeof enqueueTask>[2] = {}
    if (skipTriage) opts.skipTriage = true
    if (author) opts.author = author
    const task = await enqueueTask(
      prompt,
      plan ?? undefined,
      Object.keys(opts).length > 0 ? opts : undefined,
    )
    if (task.status === 'queued') {
      bus.emit('task.queued', { taskId: task.id })
    } else if (task.status === 'draft') {
      bus.emit('task.added', { taskId: task.id })
    }
    return task
  }

  const handleUpdate = async (
    id: string,
    patch: Parameters<typeof updateTask>[1],
  ): Promise<void> => {
    const before = await getTask(id)
    await updateTask(id, patch)
    const after = await getTask(id)

    if (after && before?.status !== after.status) {
      if (after.status === 'queued') {
        bus.emit('task.queued', { taskId: id })
      }
      if (after.status === 'done') {
        // updateTask already promoted any unblocked dependents; surface them.
        const queued = await listTasks('queued')
        for (const t of queued) {
          if (!inFlight.has(t.id)) bus.emit('task.queued', { taskId: t.id })
        }
      }
    }
  }

  const handleRetry = async (id: string): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    if (task.status !== 'failed' && task.status !== 'done') {
      throw new Error(`task ${id} is ${task.status}; only failed/done tasks can be retried`)
    }

    const { existsSync: exists } = await import('node:fs')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { removeWorktree } = await import('../lib/git')
    const { getRepoRoot } = await import('../context')

    const branch = task.branch ?? `task/${task.id}`
    if (task.worktreePath && exists(task.worktreePath)) {
      await removeWorktree({ path: task.worktreePath, branch }, true).catch(() => {})
    }
    await exec('git', ['branch', '-D', branch], { cwd: getRepoRoot() }).catch(() => {})

    await updateTask(id, {
      status: 'queued',
      branch: null,
      worktreePath: null,
      claudeSessionId: null,
      error: null,
    })
    bus.emit('task.queued', { taskId: id })
  }

  const handlePurge = async (id: string): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    if (task.status !== 'failed' && task.status !== 'done') {
      throw new Error(`task ${id} is ${task.status}; refuse to purge in-flight tasks`)
    }

    const { existsSync: exists } = await import('node:fs')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { removeWorktree } = await import('../lib/git')
    const { getRepoRoot } = await import('../context')

    const branch = task.branch ?? `task/${task.id}`
    if (task.worktreePath && exists(task.worktreePath)) {
      await removeWorktree({ path: task.worktreePath, branch }, true).catch(() => {})
    }
    await exec('git', ['branch', '-D', branch], { cwd: getRepoRoot() }).catch(() => {})
    await deleteTask(id)
  }

  const handleRefine = async (id: string, refresh: boolean): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    if (inFlight.has(id)) {
      throw new Error(`task ${id} already has a ${inFlight.get(id)?.kind} job in flight`)
    }
    bus.emit('task.refine', { taskId: id, refresh })
  }

  const handlePromote = async (suggestionId: string): Promise<{ taskId: string }> => {
    const r = await promoteSuggestion(suggestionId)
    if (!r) throw new Error(`suggestion ${suggestionId} not found or already promoted`)
    bus.emit('task.added', { taskId: r.taskId })
    return { taskId: r.taskId }
  }

  const handleStatus = async (): Promise<DaemonStatusPayload> => {
    const counts = {
      draft: (await listTasks('draft')).length,
      queued: (await listTasks('queued')).length,
      running: (await listTasks('running')).length,
      verifying: (await listTasks('verifying')).length,
      merging: (await listTasks('merging')).length,
    }
    return {
      pid: process.pid,
      startedAt,
      inFlight: Array.from(inFlight.values()),
      counts,
    }
  }

  // ── Reconcile on startup ──────────────────────────────────────────────────

  const reconcile = async (): Promise<void> => {
    const drafts = await listTasks('draft')
    for (const t of drafts) bus.emit('task.added', { taskId: t.id })

    const queued = await listTasks('queued')
    for (const t of queued) bus.emit('task.queued', { taskId: t.id })

    // Stale in-flight rows: the previous daemon died mid-work. Mark failed
    // so the user sees them; retry is a manual decision.
    for (const status of ['running', 'verifying', 'merging'] as const) {
      const stuck = await listTasks(status)
      for (const t of stuck) {
        log(`[reconcile] task ${t.id} was ${status} on prior daemon; marking failed`)
        await updateTask(t.id, {
          status: 'failed',
          error: `daemon restart while task was ${status}`,
        }).catch(() => {})
      }
    }
  }

  // ── Network: UDS server ───────────────────────────────────────────────────

  const handleRequest = async (req: DaemonRequest): Promise<DaemonResponse> => {
    try {
      switch (req.op) {
        case 'add': {
          const task = await handleAdd(
            req.prompt,
            req.plan,
            req.skipTriage,
            req.author,
          )
          return { ok: true, data: task }
        }
        case 'update': {
          await handleUpdate(req.id, req.patch)
          return { ok: true }
        }
        case 'retry': {
          await handleRetry(req.id)
          return { ok: true }
        }
        case 'purge': {
          await handlePurge(req.id)
          return { ok: true }
        }
        case 'promote': {
          const r = await handlePromote(req.suggestionId)
          return { ok: true, data: r }
        }
        case 'refine': {
          await handleRefine(req.id, req.refresh ?? false)
          return { ok: true }
        }
        case 'status': {
          return { ok: true, data: await handleStatus() }
        }
        case 'ping': {
          return { ok: true, data: { pid: process.pid } }
        }
        case 'shutdown': {
          if (!req.force && inFlight.size > 0) {
            return {
              ok: false,
              error: `${inFlight.size} task(s) in flight; pass force=true to override`,
            }
          }
          // Schedule shutdown after responding.
          queueMicrotask(() => {
            void shutdown(req.force === true)
          })
          return { ok: true }
        }
        default: {
          const _exhaustive: never = req
          return { ok: false, error: `unknown op: ${JSON.stringify(_exhaustive)}` }
        }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  const onClient = (sock: Socket): void => {
    sock.on('error', () => sock.destroy())
    readLines(sock, (line) => {
      let req: DaemonRequest
      try {
        req = JSON.parse(line) as DaemonRequest
      } catch {
        writeLine(sock, { ok: false, error: 'invalid JSON' })
        return
      }
      void handleRequest(req).then((res) => {
        writeLine(sock, res)
        sock.end()
      })
    })
  }

  const server: Server = createServer(onClient)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })

  writeFileSync(pidFile, String(process.pid), 'utf8')
  log(`daemon listening on ${socketPath} (pid ${process.pid}, repo ${resolveContext().repoRoot})`)

  // Boot reconcile after server is listening (so any reconcile-driven dispatch
  // is fully wired) — fire-and-forget; errors logged inside.
  void reconcile().catch((err) => log(`[reconcile] failed: ${(err as Error).message}`))

  // ── Shutdown ──────────────────────────────────────────────────────────────

  const shutdown = async (force = false): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log(`shutting down (force=${force}, inFlight=${inFlight.size})`)

    if (!force) {
      const start = Date.now()
      while (inFlight.size > 0 && Date.now() - start < 30_000) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const f of [socketPath, pidFile]) {
      if (existsSync(f)) {
        try {
          unlinkSync(f)
        } catch {
          // best-effort
        }
      }
    }
    log('daemon stopped')
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      log(`received ${sig}`)
      void shutdown(false).then(() => process.exit(0))
    })
  }

  return {
    stop: shutdown,
    inFlightCount: () => inFlight.size,
  }
}
