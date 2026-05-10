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
  addBlockers,
  deleteTask,
  enqueueTask,
  getTask,
  hasIncompleteBlockers,
  initQueue,
  listTasks,
  removeBlocker,
  setTaskPriority,
  unblockTask,
  updateTask,
  type Task,
  type UnblockTaskResult,
} from '../queue'
import { promoteIdea } from '../ideas'
import {
  onBlockerTaskCompleted,
  recoverBlockedTasks,
} from '../blocker-resolution'
import { daemonPaths } from './paths'
import {
  readLines,
  writeLine,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStatusPayload,
} from './protocol'

const LOG_ROTATE_BYTES = 10 * 1024 * 1024

type DispatchKind =
  | 'triage'
  | 'implement'
  | 'refine'
  | 'glossary-write'
  | 'adr-add'

interface InFlightEntry {
  taskId: string
  kind: DispatchKind
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface Semaphore {
  limit: number
  inUse: number
  readonly waiters: Array<() => void>
}

export const makeSem = (limit: number): Semaphore => ({
  limit,
  inUse: 0,
  waiters: [],
})

export const acquire = (s: Semaphore): Promise<void> => {
  if (s.inUse < s.limit) {
    s.inUse += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => s.waiters.push(resolve))
}

// When a waiter exists, hand the slot directly to it without bouncing inUse —
// otherwise a parallel acquire could slip in between decrement and resume.
export const release = (s: Semaphore): void => {
  const next = s.waiters.shift()
  if (next) {
    next()
    return
  }
  s.inUse = Math.max(0, s.inUse - 1)
}

// Adjust the cap at runtime. Raising wakes up to `delta` waiters (mirroring
// the hand-off in release() so a parallel acquire can't slip past). Lowering
// never cancels in-flight work — release() simply won't hand to new acquirers
// until inUse < limit again.
export const setSemLimit = (s: Semaphore, newLimit: number): void => {
  if (!Number.isInteger(newLimit) || newLimit < 1) {
    throw new Error('limit must be a positive integer')
  }
  const delta = newLimit - s.limit
  s.limit = newLimit
  if (delta > 0 && s.waiters.length > 0) {
    const wakeCount = Math.min(delta, s.waiters.length)
    for (let i = 0; i < wakeCount; i += 1) {
      const next = s.waiters.shift()
      if (!next) break
      s.inUse += 1
      next()
    }
  }
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
    opts.integrationBranch ?? process.env.INTEGRATION_BRANCH ?? 'main'
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

  // Per-kind concurrency caps. glossary-write and adr-add share one pool
  // because they both contend on the same merge lock downstream — a second
  // slot would just sit waiting on the lock, so default to 1.
  const structuredWriteSem = makeSem(envInt('MARS_MAX_STRUCTURED_WRITE', 1))
  const sems: Record<DispatchKind, Semaphore> = {
    triage: makeSem(envInt('MARS_MAX_TRIAGE', 4)),
    implement: makeSem(envInt('MARS_MAX_IMPLEMENT', 4)),
    refine: makeSem(envInt('MARS_MAX_REFINE', 2)),
    'glossary-write': structuredWriteSem,
    'adr-add': structuredWriteSem,
  }
  log(
    `concurrency caps: implement=${sems.implement.limit} triage=${sems.triage.limit} refine=${sems.refine.limit} structured-write=${structuredWriteSem.limit}`,
  )

  // Pending sets used by reconcile + drain: never bus.emit a storm; pull from
  // these as semaphore slots free.
  const pendingTriage = new Set<string>()
  const pendingImplement = new Set<string>()

  const trackInFlight = (taskId: string, kind: DispatchKind): (() => void) => {
    inFlight.set(taskId, { taskId, kind })
    return () => inFlight.delete(taskId)
  }

  // Forward-declared so dispatchers can call it from finally; assigned after
  // both dispatchers exist.
  let drain: () => Promise<void> = async () => {}

  const dispatchTriage = async (taskId: string): Promise<void> => {
    if (inFlight.has(taskId)) return
    pendingTriage.delete(taskId)
    await acquire(sems.triage)
    const releaseTracking = trackInFlight(taskId, 'triage')
    log(`[triage] ${taskId} dispatching`)
    try {
      const { runTriage } = await import('../workflows/triage-workflow')
      const result = await runTriage(taskId)
      log(
        `[triage] ${taskId} -> actionable=${result.actionable} blockers=${result.blockerCount}`,
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
      releaseTracking()
      release(sems.triage)
      void drain()
    }
  }

  const dispatchImplement = async (task: Task): Promise<void> => {
    if (inFlight.has(task.id)) return
    pendingImplement.delete(task.id)
    await acquire(sems.implement)
    const releaseTracking = trackInFlight(task.id, 'implement')
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
      releaseTracking()
      release(sems.implement)
      void drain()
    }
  }

  const dispatchGlossaryWrite = async (req: {
    kind: 'set' | 'remove'
    term: string
    definition?: string
    aliases?: readonly string[]
  }): Promise<void> => {
    const synthetic = `glossary-write:${req.kind}:${req.term}:${Date.now()}`
    await acquire(sems['glossary-write'])
    const releaseTracking = trackInFlight(synthetic, 'glossary-write')
    log(`[glossary-write] ${req.kind} "${req.term}" dispatching`)
    try {
      const { runStructuredWrite } = await import('../lib/structured-write')
      const {
        readGlossaryFile,
        writeGlossaryFile,
        upsertTerm,
        removeTermByName,
      } = await import('../lib/glossary')
      const { resolve: resolvePath } = await import('node:path')

      const outcome = await runStructuredWrite({
        kind: 'glossary',
        commitMessage:
          req.kind === 'set'
            ? `glossary: set "${req.term}"`
            : `glossary: remove "${req.term}"`,
        integrationBranch,
        mutate: async (worktreePath) => {
          const path = resolvePath(worktreePath, 'CONTEXT.md')
          const doc = await readGlossaryFile(path)
          if (req.kind === 'set') {
            const next = upsertTerm(doc, {
              term: req.term,
              definition: req.definition ?? '',
              aliases: req.aliases ?? [],
            })
            await writeGlossaryFile(path, next)
            return
          }
          const { doc: nextDoc, removed } = removeTermByName(doc, req.term)
          if (!removed) return false
          await writeGlossaryFile(path, nextDoc)
        },
      })
      log(`[glossary-write] ${req.kind} "${req.term}" -> ${outcome.kind}`)
    } catch (err) {
      log(
        `[glossary-write] ${req.kind} "${req.term}" failed: ${(err as Error).message}`,
      )
    } finally {
      releaseTracking()
      release(sems['glossary-write'])
    }
  }

  const dispatchAdrAdd = async (req: {
    title: string
    body: string
  }): Promise<void> => {
    const synthetic = `adr-add:${req.title}:${Date.now()}`
    await acquire(sems['adr-add'])
    const releaseTracking = trackInFlight(synthetic, 'adr-add')
    log(`[adr-add] "${req.title}" dispatching`)
    try {
      const { runStructuredWrite } = await import('../lib/structured-write')
      const { writeAdrInWorktree } = await import('../lib/adr')

      const outcome = await runStructuredWrite({
        kind: 'adr',
        commitMessage: `adr: add "${req.title}"`,
        integrationBranch,
        mutate: async (worktreePath) => {
          await writeAdrInWorktree({
            worktreePath,
            title: req.title,
            body: req.body,
          })
        },
      })
      log(`[adr-add] "${req.title}" -> ${outcome.kind}`)
    } catch (err) {
      log(`[adr-add] "${req.title}" failed: ${(err as Error).message}`)
    } finally {
      releaseTracking()
      release(sems['adr-add'])
    }
  }

  const dispatchRefine = async (
    taskId: string,
    refresh: boolean,
  ): Promise<void> => {
    if (inFlight.has(taskId)) return
    await acquire(sems.refine)
    const releaseTracking = trackInFlight(taskId, 'refine')
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
      releaseTracking()
      release(sems.refine)
    }
  }

  // Pick the highest-priority pending task. Ties broken by oldest createdAt
  // so equal-priority work stays FIFO. Returns null if no pending row resolves
  // to a real task (drained while we looked).
  const pickNextImplement = async (
    pending: ReadonlySet<string>,
  ): Promise<string | null> => {
    let best: { id: string; priority: number; createdAt: string } | null = null
    for (const id of pending) {
      const t = await getTask(id)
      if (!t) continue
      if (
        best === null ||
        t.priority > best.priority ||
        (t.priority === best.priority && t.createdAt < best.createdAt)
      ) {
        best = { id, priority: t.priority, createdAt: t.createdAt }
      }
    }
    return best?.id ?? null
  }

  // Drain pulls from the pending sets as semaphore slots free. Bus handlers
  // and dispatcher finally-blocks both call this. It's idempotent and cheap
  // when there's nothing to do.
  drain = async (): Promise<void> => {
    while (
      pendingTriage.size > 0 &&
      sems.triage.inUse < sems.triage.limit
    ) {
      const id = pendingTriage.values().next().value as string
      pendingTriage.delete(id)
      void dispatchTriage(id)
    }
    while (
      pendingImplement.size > 0 &&
      sems.implement.inUse < sems.implement.limit
    ) {
      const id = await pickNextImplement(pendingImplement)
      if (id === null) break
      pendingImplement.delete(id)
      const t = await getTask(id)
      if (!t || t.status !== 'queued') continue
      if (await hasIncompleteBlockers(id)) {
        log(`[dispatch] ${id} blocked; deferring until blockers complete`)
        continue
      }
      void dispatchImplement(t)
    }
  }

  bus.on('task.added', (e: { taskId: string }) => {
    if (inFlight.has(e.taskId)) return
    pendingTriage.add(e.taskId)
    void drain()
  })

  // refine is user-initiated and rare; let it push directly through its sem
  // (dispatchRefine already acquires/releases). No pending-set needed.
  bus.on('task.refine', (e: { taskId: string; refresh: boolean }) => {
    void dispatchRefine(e.taskId, e.refresh)
  })

  bus.on('task.queued', (e: { taskId: string }) => {
    if (inFlight.has(e.taskId)) return
    pendingImplement.add(e.taskId)
    void drain()
  })

  // ── Wrappers around queue ops that emit the right events ──────────────────

  const handleAdd = async (
    prompt: string,
    plan?: Task['plan'],
    skipTriage?: boolean,
    author?: Task['author'],
    blockerIds?: readonly string[],
    priority?: number,
  ): Promise<Task> => {
    const opts: Parameters<typeof enqueueTask>[2] = {}
    if (skipTriage) opts.skipTriage = true
    if (author) opts.author = author
    if (priority !== undefined) opts.priority = priority
    const task = await enqueueTask(
      prompt,
      plan ?? undefined,
      Object.keys(opts).length > 0 ? opts : undefined,
    )
    if (blockerIds && blockerIds.length > 0) {
      try {
        await addBlockers(task.id, blockerIds)
      } catch (err) {
        await deleteTask(task.id).catch(() => {})
        throw err
      }
    }
    if (task.status === 'queued') {
      bus.emit('task.queued', { taskId: task.id })
    } else if (task.status === 'draft') {
      bus.emit('task.added', { taskId: task.id })
    }
    return task
  }

  const handleBlock = async (
    id: string,
    blockerIds: readonly string[],
  ): Promise<{ taskId: string; blockerIds: readonly string[] }> => {
    if (blockerIds.length === 0) {
      throw new Error('block requires at least one blocker id')
    }
    if (blockerIds.some((b) => b === id)) {
      throw new Error(`task ${id} cannot block itself`)
    }
    const t = await getTask(id)
    if (!t) throw new Error(`task ${id} not found`)
    await addBlockers(id, blockerIds)
    return { taskId: id, blockerIds }
  }

  const handleRemoveBlockers = async (
    id: string,
    blockerIds: readonly string[],
  ): Promise<{ taskId: string; removed: readonly string[] }> => {
    if (blockerIds.length === 0) {
      throw new Error('remove-blockers requires at least one blocker id')
    }
    const t = await getTask(id)
    if (!t) throw new Error(`task ${id} not found`)
    const removed: string[] = []
    for (const blockerId of blockerIds) {
      const r = await removeBlocker(id, blockerId)
      if (!r.removed) {
        throw new Error(`no blocker edge: ${id} -> ${blockerId}`)
      }
      removed.push(blockerId)
    }
    return { taskId: id, removed }
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
        try {
          const blockerResolved = await onBlockerTaskCompleted(id)
          for (const o of blockerResolved.outcomes) {
            if (o.outcome === 'queued') {
              log(
                `[unblock] task ${o.taskId} re-queued after blocker task ${id} completed`,
              )
              bus.emit('task.queued', { taskId: o.taskId })
            } else if (o.outcome === 'dropped') {
              log(
                `[unblock] task ${o.taskId} dropped at unblock (retry budget exhausted)`,
              )
            }
          }
        } catch (err) {
          log(
            `[unblock] error resolving task_blockers for ${id}: ${(err as Error).message}`,
          )
        }
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

  const handleUnblock = async (id: string): Promise<UnblockTaskResult> => {
    return unblockTask(id)
  }

  const handleRefine = async (id: string, refresh: boolean): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    if (inFlight.has(id)) {
      throw new Error(`task ${id} already has a ${inFlight.get(id)?.kind} job in flight`)
    }
    bus.emit('task.refine', { taskId: id, refresh })
  }

  const handleIdeaPromote = async (
    ideaId: string,
  ): Promise<{ ideaId: string; status: string }> => {
    const idea = await promoteIdea(ideaId)
    return { ideaId: idea.id, status: idea.status }
  }

  const handleIdeaSlice = async (
    ideaId: string,
  ): Promise<{ ideaId: string; status: string; taskIds: string[] }> => {
    const { runSlice } = await import('../workflows/slice-workflow')
    const result = await runSlice(ideaId)
    // Newly-queued slice tasks need to enter the implement pool. Emit one
    // 'task.queued' per id; the bus subscriber pushes them into pendingImplement
    // and drain() picks them up under the implement semaphore.
    for (const taskId of result.taskIds) {
      const t = await getTask(taskId)
      if (t?.status === 'queued') {
        bus.emit('task.queued', { taskId })
      }
    }
    return result
  }

  const handleInit = async (
    opts: import('../workflows/init-workflow').RunInitOptions,
  ): Promise<import('../workflows/init-workflow').RunInitResult> => {
    const { runInit } = await import('../workflows/init-workflow')
    log(`[init] dispatching (force=${opts.force} fetch=${opts.fetch} dryRun=${opts.dryRun} refresh=${opts.refresh})`)
    const result = await runInit(opts)
    log(`[init] -> ${result.status}`)
    return result
  }

  const handleAb = async (
    instruction: string,
    variants: readonly unknown[],
  ): Promise<unknown> => {
    const { mastra } = await import('../index')
    const wf = mastra.getWorkflow('abExperimentWorkflow')
    const run = await wf.createRun()
    log(`[ab] dispatching instruction="${instruction.slice(0, 60)}${instruction.length > 60 ? '…' : ''}"`)
    // Workflow inputSchema (zod) expects a mutable array; the wire delivers
    // a readonly one. Validation happens inside .start() — the copy here
    // is just to satisfy the static type.
    const result = await run.start({
      inputData: {
        instruction,
        variants: [...variants] as never,
        integrationBranch,
      },
    })
    if (result.status !== 'success') {
      const err =
        'error' in result && result.error instanceof Error
          ? result.error.message
          : '(no error message)'
      log(`[ab] -> ${result.status}: ${err}`)
      throw new Error(`ab experiment ${result.status}: ${err}`)
    }
    log(`[ab] -> success`)
    return result.result
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
    try {
      const recovered = await recoverBlockedTasks()
      for (const r of recovered) {
        for (const o of r.outcomes) {
          if (o.outcome === 'queued') {
            log(
              `[reconcile-unblock] task ${o.taskId} re-queued (blocker task already done while daemon was down)`,
            )
          } else if (o.outcome === 'dropped') {
            log(
              `[reconcile-unblock] task ${o.taskId} dropped (retry budget exhausted)`,
            )
          }
        }
      }
    } catch (err) {
      log(`[reconcile-unblock] failed: ${(err as Error).message}`)
    }

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
          if (typeof req.prompt !== 'string') {
            return {
              ok: false,
              error: `add: prompt must be a string; got ${typeof req.prompt}`,
            }
          }
          const task = await handleAdd(
            req.prompt,
            req.plan,
            req.skipTriage,
            req.author,
            req.blockerIds,
            req.priority,
          )
          return { ok: true, data: task }
        }
        case 'task.priority': {
          const task = await setTaskPriority(req.id, req.priority)
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
        case 'unblock': {
          const result = await handleUnblock(req.id)
          return { ok: true, data: result }
        }
        case 'block': {
          const result = await handleBlock(req.id, req.blockerIds ?? [])
          return { ok: true, data: result }
        }
        case 'remove-blockers': {
          const result = await handleRemoveBlockers(req.id, req.blockerIds ?? [])
          return { ok: true, data: result }
        }
        case 'idea.promote': {
          const r = await handleIdeaPromote(req.ideaId)
          return { ok: true, data: r }
        }
        case 'idea.slice': {
          const r = await handleIdeaSlice(req.ideaId)
          return { ok: true, data: r }
        }
        case 'refine': {
          await handleRefine(req.id, req.refresh ?? false)
          return { ok: true }
        }
        case 'glossary-write': {
          if (req.kind !== 'set' && req.kind !== 'remove') {
            return { ok: false, error: `unknown glossary-write kind: ${req.kind}` }
          }
          if (!req.term || req.term.trim().length === 0) {
            return { ok: false, error: 'glossary-write requires a non-empty term' }
          }
          if (req.kind === 'set' && (!req.definition || req.definition.trim().length === 0)) {
            return { ok: false, error: 'glossary-write set requires a definition' }
          }
          void dispatchGlossaryWrite({
            kind: req.kind,
            term: req.term,
            definition: req.definition,
            aliases: req.aliases,
          })
          return { ok: true, data: { enqueued: true } }
        }
        case 'adr-add': {
          if (!req.title || req.title.trim().length === 0) {
            return { ok: false, error: 'adr-add requires a non-empty title' }
          }
          if (!req.body || req.body.trim().length === 0) {
            return { ok: false, error: 'adr-add requires a non-empty body' }
          }
          void dispatchAdrAdd({ title: req.title.trim(), body: req.body })
          return { ok: true, data: { enqueued: true } }
        }
        case 'init': {
          try {
            const result = await handleInit(req.opts)
            return { ok: true, data: result }
          } catch (err) {
            const { NestedTechError, WalkAccessError } = await import(
              '../../init/walk-manifests'
            )
            if (err instanceof NestedTechError) {
              return {
                ok: false,
                error: err.message,
                errorCode: `nested-tech:${err.outerPath}::${err.innerPath}`,
              }
            }
            if (err instanceof WalkAccessError) {
              return {
                ok: false,
                error: err.message,
                errorCode: `walk-access:${err.path}`,
              }
            }
            throw err
          }
        }
        case 'ab': {
          if (!Array.isArray(req.variants) || req.variants.length !== 2) {
            return {
              ok: false,
              error: 'ab requires exactly 2 variants',
            }
          }
          const report = await handleAb(req.instruction, req.variants)
          return { ok: true, data: report }
        }
        case 'status': {
          return { ok: true, data: await handleStatus() }
        }
        case 'reload-config': {
          const newImplement = envInt('MARS_MAX_IMPLEMENT', 4)
          const newTriage = envInt('MARS_MAX_TRIAGE', 4)
          const newRefine = envInt('MARS_MAX_REFINE', 2)
          const newStructured = envInt('MARS_MAX_STRUCTURED_WRITE', 1)
          setSemLimit(sems.implement, newImplement)
          setSemLimit(sems.triage, newTriage)
          setSemLimit(sems.refine, newRefine)
          // structuredWriteSem is shared by 'glossary-write' and 'adr-add';
          // update once via the captured reference.
          setSemLimit(structuredWriteSem, newStructured)
          log(
            `concurrency reloaded: implement=${newImplement} triage=${newTriage} refine=${newRefine} structured-write=${newStructured}`,
          )
          void drain()
          return {
            ok: true,
            data: {
              caps: {
                implement: newImplement,
                triage: newTriage,
                refine: newRefine,
                'structured-write': newStructured,
              },
            },
          }
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
