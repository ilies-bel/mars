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
  dropTask,
  enqueueTask,
  getTask,
  hasIncompleteBlockers,
  initQueue,
  listTasks,
  removeBlocker,
  setTaskPriority,
  unblockTask,
  updateTask,
  type DropTaskResult,
  type Task,
  type UnblockTaskResult,
} from '../queue'
import { listIdeas, promoteIdea } from '../ideas'
import {
  onBlockerTaskCompleted,
  recoverBlockedTasks,
} from '../blocker-resolution'
import { internalBus } from '../../internal-bus'
import { daemonPaths, isProcessAlive, readDaemonPid, tryConnectSocket } from './paths'
import { loadDaemonConfig } from './config'
import { probeDuckDBLock } from './duckdb-lock'
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

  // Refuse to clobber a live daemon. Probe the socket before unlinking —
  // a non-atomic existsSync check used to let two daemons coexist, leaking
  // DuckDB/LibSQL handles and making "kill the daemon" recovery unreliable.
  if (existsSync(socketPath)) {
    if (await tryConnectSocket(socketPath)) {
      log(`another daemon is already listening on ${socketPath}; exiting`)
      process.exit(0)
    }
    const recordedPid = readDaemonPid(pidFile)
    if (recordedPid !== null && isProcessAlive(recordedPid)) {
      log(
        `warning: stale-but-running daemon (pid ${recordedPid}) not responding on ${socketPath}; taking over socket`,
      )
    }
    try {
      unlinkSync(socketPath)
    } catch {
      // best-effort
    }
  }

  // Probe the DuckDB observability file before the first workflow dispatch
  // lazily opens it. A live foreign holder is a hard error here so the user
  // gets one clear message at startup instead of every implement step
  // failing with "Could not set lock on file". Stale fds (PID gone) are
  // tolerated: DuckDB will reclaim them on open.
  if (process.env.MARS_DISABLE_DUCKDB !== '1') {
    const { observabilityDbPath } = resolveContext()
    const probe = probeDuckDBLock(observabilityDbPath)
    if (probe.status === 'held') {
      log(
        `observability DuckDB lock held by pid ${probe.holderPid}; refusing to start. ` +
          `Stop that process or set MARS_DISABLE_DUCKDB=1 to skip observability.`,
      )
      process.exit(1)
    }
    if (probe.status === 'stale') {
      log(
        `observability DuckDB has a stale fd holder (pid ${probe.holderPid} not alive); proceeding`,
      )
    }
  }

  await initQueue()

  const bus = new EventEmitter()
  bus.setMaxListeners(50)

  const inFlight = new Map<string, InFlightEntry>()
  const startedAt = new Date().toISOString()
  let shuttingDown = false
  // When false, `drain()` is a no-op, new bus events skip enqueue, and
  // mutating RPCs (`add`, `continue`, `restart`, structured-write…) are
  // refused. Flipped by `shutdown { drain: true }` so in-flight tasks
  // finish without any new work landing on top of them.
  let acceptingWork = true

  // Per-kind concurrency caps. glossary-write and adr-add share one pool
  // because they both contend on the same merge lock downstream — a second
  // slot would just sit waiting on the lock, so default to 1.
  const initialCaps = loadDaemonConfig().caps
  const structuredWriteSem = makeSem(initialCaps.structuredWrite)
  const sems: Record<DispatchKind, Semaphore> = {
    triage: makeSem(initialCaps.triage),
    implement: makeSem(initialCaps.implement),
    refine: makeSem(initialCaps.refine),
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

  // Tasks claimed by a drain pass but not yet tracked in inFlight (the gap is
  // the time it takes to await the implement semaphore). Without this set
  // multiple concurrent `void drain()` invocations can each pick the same
  // task id from `pendingImplement` and start parallel dispatches before any
  // of them call `trackInFlight`. That was the dispatch-storm bug.
  const claimedImplement = new Set<string>()
  const claimedTriage = new Set<string>()

  const trackInFlight = (taskId: string, kind: DispatchKind): (() => void) => {
    inFlight.set(taskId, { taskId, kind })
    return () => inFlight.delete(taskId)
  }

  // Drain single-flight gate. While `drainRunning` is true, a second call
  // sets `drainAgain` and returns; the running drain re-runs once it finishes.
  // This + the claimed sets together guarantee no task id is ever dispatched
  // more than once concurrently.
  let drainRunning = false
  let drainAgain = false

  // Forward-declared so dispatchers can call it from finally; assigned after
  // both dispatchers exist.
  let drain: () => Promise<void> = async () => {}

  const dispatchTriage = async (taskId: string): Promise<void> => {
    if (inFlight.has(taskId)) return
    pendingTriage.delete(taskId)
    await acquire(sems.triage)
    const releaseTracking = trackInFlight(taskId, 'triage')
    claimedTriage.delete(taskId)
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
    claimedImplement.delete(task.id)
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
          tag: task.tag ?? 'coder',
          integrationBranch,
          resumeFrom:
            task.resumeFrom === 'verify' || task.resumeFrom === 'merge'
              ? task.resumeFrom
              : null,
          spec: task.spec
            ? {
                files: [...task.spec.files],
                verifyCmd: task.spec.verifyCmd,
                doneCriteria: [...task.spec.doneCriteria],
                taskType: task.spec.taskType,
              }
            : null,
        },
      })
      const { isBlockersAbortError, isTooHardAbortError } = await import('../workflows/implement-workflow')
      const resultError = 'error' in result && result.error instanceof Error ? result.error : null
      if (result.status === 'failed' && resultError && isBlockersAbortError(resultError)) {
        log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
        return
      }
      if (result.status === 'failed' && resultError && isTooHardAbortError(resultError)) {
        log(`[implement] ${task.id} parked in blocked: read/grep span watcher tripped; spawned context-gathering child task`)
        return
      }
      log(`[implement] ${task.id} -> ${result.status}`)
      bus.emit('task.completed', { taskId: task.id, status: result.status })
    } catch (err) {
      const message = (err as Error).message
      const { isBlockersAbortError, isTooHardAbortError } = await import('../workflows/implement-workflow')
      if (isBlockersAbortError(err)) {
        log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
      } else if (isTooHardAbortError(err)) {
        log(`[implement] ${task.id} parked in blocked: read/grep span watcher tripped; spawned context-gathering child task`)
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
      if (outcome.kind === 'aborted') {
        log(
          `[glossary-write] ${req.kind} "${req.term}" -> aborted: ${outcome.reason}`,
        )
      } else {
        log(`[glossary-write] ${req.kind} "${req.term}" -> ${outcome.kind}`)
      }
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
      if (outcome.kind === 'aborted') {
        log(`[adr-add] "${req.title}" -> aborted: ${outcome.reason}`)
      } else {
        log(`[adr-add] "${req.title}" -> ${outcome.kind}`)
      }
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
        `[refine] ${taskId} -> suggestions=${result.suggestionCount}`,
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
      // Skip ids already claimed by an in-flight (or about-to-be-in-flight)
      // dispatch — without this the same id can be picked by parallel
      // drains during the gap between pop-from-pending and acquire-slot.
      if (claimedImplement.has(id) || inFlight.has(id)) continue
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
  // Single-flight: only one drain runs at a time. Concurrent invocations
  // (from bus events, dispatcher finally-blocks, etc.) flip drainAgain so
  // the running drain re-enters once it finishes — no double-pick races.
  drain = async (): Promise<void> => {
    if (!acceptingWork) return
    if (drainRunning) {
      drainAgain = true
      return
    }
    drainRunning = true
    try {
      do {
        drainAgain = false
        // Triage: pick a candidate that isn't already claimed/in-flight,
        // mark it claimed BEFORE the dispatchTriage call so the next drain
        // pass can't pick it again.
        while (sems.triage.inUse < sems.triage.limit) {
          let pickedTriage: string | null = null
          for (const id of pendingTriage) {
            if (claimedTriage.has(id) || inFlight.has(id)) continue
            pickedTriage = id
            break
          }
          if (pickedTriage === null) break
          claimedTriage.add(pickedTriage)
          pendingTriage.delete(pickedTriage)
          void dispatchTriage(pickedTriage)
        }
        // Implement: same guarantee but priority-ordered.
        while (sems.implement.inUse < sems.implement.limit) {
          const id = await pickNextImplement(pendingImplement)
          if (id === null) break
          // Mark claimed BEFORE any further await so concurrent drains
          // (which we've gated, but belt-and-suspenders) can't double-pick.
          claimedImplement.add(id)
          pendingImplement.delete(id)
          const t = await getTask(id)
          if (!t || t.status !== 'queued') {
            claimedImplement.delete(id)
            continue
          }
          if (await hasIncompleteBlockers(id)) {
            log(`[dispatch] ${id} blocked; deferring until blockers complete`)
            claimedImplement.delete(id)
            continue
          }
          void dispatchImplement(t)
        }
      } while (drainAgain)
    } finally {
      drainRunning = false
    }
  }

  bus.on('task.added', (e: { taskId: string }) => {
    if (!acceptingWork) return
    if (inFlight.has(e.taskId)) return
    pendingTriage.add(e.taskId)
    void drain()
  })

  // refine is user-initiated and rare; let it push directly through its sem
  // (dispatchRefine already acquires/releases). No pending-set needed.
  bus.on('task.refine', (e: { taskId: string; refresh: boolean }) => {
    if (!acceptingWork) return
    void dispatchRefine(e.taskId, e.refresh)
  })

  bus.on('task.queued', (e: { taskId: string }) => {
    if (!acceptingWork) return
    if (inFlight.has(e.taskId)) return
    pendingImplement.add(e.taskId)
    void drain()
  })

  // Mirror internal-bus signals onto the daemon's local bus so existing
  // subscribers (logs, future UI/CLI bridges) see a unified stream. The
  // retry-on-unblock effect is already handled by handleUpdate's
  // onBlockerTaskCompleted path — these events are purely observational.
  internalBus().on('task.blocked', (e) => {
    log(
      `[blocked] ${e.taskId} signature=${e.failureSignature} step=${e.failingStep} fix=${e.fixTaskId ?? '(none)'}`,
    )
    bus.emit('task.blocked', e)
  })
  internalBus().on('task.unblocked', (e) => {
    log(`[unblocked] ${e.taskId} via blocker ${e.blockerTaskId}`)
    bus.emit('task.unblocked', e)
  })

  // ── Wrappers around queue ops that emit the right events ──────────────────

  const handleAdd = async (
    prompt: string,
    plan?: Task['plan'],
    skipTriage?: boolean,
    author?: Task['author'],
    blockerIds?: readonly string[],
    priority?: number,
    tag?: Task['tag'],
    spec?: Task['spec'],
  ): Promise<Task> => {
    const opts: Parameters<typeof enqueueTask>[2] = {}
    if (skipTriage) opts.skipTriage = true
    if (author) opts.author = author
    if (priority !== undefined) opts.priority = priority
    if (tag !== undefined) opts.tag = tag
    if (spec) opts.spec = spec
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
            } else if (o.outcome === 'failed') {
              log(
                `[unblock] task ${o.taskId} failed at unblock (retry budget exhausted)`,
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

  // 'mars restart <id>' wipes the worktree+branch and re-runs the full
  // pipeline from setup. Same body as the legacy 'retry' verb.
  const handleRestart = async (id: string): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    if (task.status !== 'failed' && task.status !== 'done') {
      throw new Error(`task ${id} is ${task.status}; only failed/done tasks can be restarted`)
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
      failedPhase: null,
      resumeFrom: null,
    })
    bus.emit('task.queued', { taskId: id })
  }

  // 'mars continue <id>' resumes a failed task on its existing branch+
  // worktree, skipping into the failed phase. Refuses if preconditions
  // aren't met — the user should reach for `mars restart` instead.
  const handleContinue = async (id: string): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    if (task.status !== 'failed') {
      throw new Error(
        `task ${id} is ${task.status}; only failed tasks can be continued (use 'mars restart' instead)`,
      )
    }
    if (task.failedPhase === null) {
      throw new Error(
        `task ${id} has no recorded failed_phase; this is a legacy row from before continue/restart split. Use 'mars restart ${id}' instead.`,
      )
    }
    if (task.failedPhase === 'code') {
      throw new Error(
        `task ${id} failed in the 'code' phase (no verifiable artefact exists). Use 'mars restart ${id}' to start over.`,
      )
    }
    if (!task.branch || !task.worktreePath) {
      throw new Error(
        `task ${id} has no branch+worktree on the row; cannot continue. Use 'mars restart ${id}' to start over.`,
      )
    }
    const { existsSync: exists } = await import('node:fs')
    if (!exists(task.worktreePath)) {
      throw new Error(
        `task ${id} worktree ${task.worktreePath} is missing on disk; cannot continue. Use 'mars restart ${id}' to start over.`,
      )
    }

    await updateTask(id, {
      status: 'queued',
      error: null,
      resumeFrom: task.failedPhase,
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

  const IN_FLIGHT_STATUSES = new Set<Task['status']>([
    'running',
    'verifying',
    'merging',
  ])

  const handleDrop = async (
    id: string,
    force: boolean,
  ): Promise<DropTaskResult & { worktreeRemoved: boolean; branchDeleted: boolean }> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)

    // Refuse to silently kill a worker-pool job. The daemon's inFlight
    // map tracks ANY dispatched job (triage, implement, refine,
    // structured-write); the row's status may still read 'queued' for
    // the gap between dispatch and the first persisted transition, so
    // the map is the source of truth, not status alone.
    const liveStatus = IN_FLIGHT_STATUSES.has(task.status)
    const liveInFlight = inFlight.has(id)
    if ((liveStatus || liveInFlight) && !force) {
      const kind = inFlight.get(id)?.kind
      const detail = liveInFlight
        ? `dispatched (kind=${kind ?? 'unknown'})`
        : `status=${task.status}`
      throw new Error(
        `task ${id} is in flight (${detail}); pass force=true to drop anyway`,
      )
    }

    const { existsSync: exists } = await import('node:fs')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { removeWorktree } = await import('../lib/git')
    const { getRepoRoot } = await import('../context')

    const branch = task.branch ?? `task/${task.id}`
    let worktreeRemoved = false
    if (task.worktreePath && exists(task.worktreePath)) {
      try {
        await removeWorktree({ path: task.worktreePath, branch }, true)
        worktreeRemoved = true
      } catch {
        // best-effort — the row still gets dropped; logged below
      }
    }
    const branchDeleteResult = await exec('git', ['branch', '-D', branch], {
      cwd: getRepoRoot(),
    })
      .then(() => true)
      .catch(() => false)

    const result = await dropTask(id)
    log(
      `[drop] ${id} (was ${result.previousStatus}; force=${force}, ` +
        `incoming=${result.edgesRemoved.incoming}, outgoing=${result.edgesRemoved.outgoing}, ` +
        `fixForRefs=${result.fixForRefsCleared.length}, worktree=${worktreeRemoved}, branch=${branchDeleteResult})`,
    )
    if (liveInFlight) {
      // The worker still holds an inFlight slot; clearing it here lets
      // drain() reclaim the semaphore even though the workflow run will
      // continue to its natural end (we cannot reach in and kill the
      // claude subprocess from here). Surfaced in the return payload so
      // the caller knows.
      inFlight.delete(id)
    }
    return {
      ...result,
      worktreeRemoved,
      branchDeleted: branchDeleteResult,
    }
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
    // Auto-slice: chain slicing fire-and-forget so the RPC stays fast and a
    // slicer failure (e.g. malformed PRD) leaves the idea in prd-ready for the
    // operator to inspect and re-promote without aborting the promote itself.
    if (idea.status === 'prd-ready') {
      void handleIdeaSlice(idea.id).catch((err) =>
        log(`[auto-slice] idea ${idea.id} failed: ${(err as Error).message}`),
      )
    }
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
          } else if (o.outcome === 'failed') {
            log(
              `[reconcile-unblock] task ${o.taskId} failed (retry budget exhausted)`,
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

    // Ideas promoted while the daemon was offline are still in prd-ready;
    // pick them up and slice. Failures stay logged but don't abort reconcile.
    try {
      const stalled = await listIdeas({ status: 'prd-ready' })
      for (const idea of stalled) {
        log(`[reconcile-slice] idea ${idea.id} prd-ready on startup; slicing`)
        void handleIdeaSlice(idea.id).catch((err) =>
          log(`[reconcile-slice] idea ${idea.id} failed: ${(err as Error).message}`),
        )
      }
    } catch (err) {
      log(`[reconcile-slice] failed: ${(err as Error).message}`)
    }
  }

  // ── Network: UDS server ───────────────────────────────────────────────────

  // Ops that spawn or schedule new work. Refused while the daemon is
  // draining (after `mars daemon stop`) so an in-flight drain isn't
  // chased by fresh task additions.
  const WORK_SPAWNING_OPS: ReadonlySet<DaemonRequest['op']> = new Set([
    'add',
    'continue',
    'restart',
    'refine',
    'idea.promote',
    'idea.slice',
    'glossary-write',
    'adr-add',
    'ab',
    'init',
  ])

  const handleRequest = async (req: DaemonRequest): Promise<DaemonResponse> => {
    if (!acceptingWork && WORK_SPAWNING_OPS.has(req.op)) {
      return {
        ok: false,
        error: 'daemon draining; new work refused. Use `mars daemon kill` to abort, or wait for shutdown',
        errorCode: 'DRAINING',
      }
    }
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
            req.tag,
            req.spec,
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
        case 'continue': {
          await handleContinue(req.id)
          return { ok: true }
        }
        case 'restart': {
          await handleRestart(req.id)
          return { ok: true }
        }
        case 'purge': {
          await handlePurge(req.id)
          return { ok: true }
        }
        case 'drop': {
          const result = await handleDrop(req.id, req.force ?? false)
          return { ok: true, data: result }
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
          const caps = loadDaemonConfig().caps
          setSemLimit(sems.implement, caps.implement)
          setSemLimit(sems.triage, caps.triage)
          setSemLimit(sems.refine, caps.refine)
          // structuredWriteSem is shared by 'glossary-write' and 'adr-add';
          // update once via the captured reference.
          setSemLimit(structuredWriteSem, caps.structuredWrite)
          log(
            `concurrency reloaded: implement=${caps.implement} triage=${caps.triage} refine=${caps.refine} structured-write=${caps.structuredWrite}`,
          )
          void drain()
          return {
            ok: true,
            data: {
              caps: {
                implement: caps.implement,
                triage: caps.triage,
                refine: caps.refine,
                'structured-write': caps.structuredWrite,
              },
            },
          }
        }
        case 'set-flag': {
          // In-memory kill-switch toggle. No persistence — a daemon
          // restart legitimately re-reads the spawn env. Allowlist is
          // narrow on purpose; extend deliberately rather than exposing
          // arbitrary env mutation over IPC.
          if (req.flag !== 'recovery') {
            return {
              ok: false,
              error: `set-flag: unknown flag '${req.flag}'; supported flags: recovery`,
            }
          }
          if (req.value !== 'on' && req.value !== 'off') {
            return {
              ok: false,
              error: `set-flag: value must be 'on' or 'off'; got '${req.value}'`,
            }
          }
          if (req.value === 'on') {
            process.env.MARS_RECOVERY_DISABLED = '1'
          } else {
            delete process.env.MARS_RECOVERY_DISABLED
          }
          log(`set-flag: recovery=${req.value} (MARS_RECOVERY_DISABLED=${process.env.MARS_RECOVERY_DISABLED ?? '<unset>'})`)
          return { ok: true, data: { flag: req.flag, value: req.value } }
        }
        case 'ping': {
          return { ok: true, data: { pid: process.pid } }
        }
        case 'shutdown': {
          // Three modes:
          //   drain=true  → stop picking new work, wait for in-flight to
          //                 finish, then exit. No timeout.
          //   force=true  → exit now and abandon in-flight (legacy
          //                 fast-path; in-flight tasks remain at
          //                 running/verifying in the queue).
          //   neither     → exit only if idle; refuse otherwise so the
          //                 user can pick drain or kill explicitly.
          if (req.drain) {
            if (acceptingWork) {
              acceptingWork = false
              pendingTriage.clear()
              pendingImplement.clear()
              log(`drain requested; stopped accepting new work (inFlight=${inFlight.size})`)
            }
            queueMicrotask(() => {
              void shutdown(false)
            })
            return { ok: true, data: { inFlight: inFlight.size, draining: true } }
          }
          if (!req.force && inFlight.size > 0) {
            return {
              ok: false,
              error: `${inFlight.size} task(s) in flight; pass drain=true to wait or use \`mars daemon kill\` to abort`,
            }
          }
          queueMicrotask(() => {
            void shutdown(req.force === true)
          })
          return { ok: true }
        }
        case 'kill': {
          // Hard stop: mark every in-flight task failed, then SIGKILL the
          // daemon's process group so every spawned `claude -p` (and any
          // child git/verify processes) dies with it.
          acceptingWork = false
          pendingTriage.clear()
          pendingImplement.clear()
          const victims = Array.from(inFlight.values())
          log(
            `kill requested; aborting ${victims.length} in-flight task(s): ${
              victims.map((v) => `${v.taskId}(${v.kind})`).join(', ') || '(none)'
            }`,
          )
          // Mark task rows failed so the queue reflects reality after the
          // children are gone. Best-effort — don't block kill on DB I/O.
          for (const v of victims) {
            if (v.kind !== 'implement' && v.kind !== 'triage' && v.kind !== 'refine') continue
            try {
              await updateTask(v.taskId, {
                status: 'failed',
                error: 'killed by `mars daemon kill`',
              })
            } catch {
              // best-effort
            }
          }
          // SIGKILL every tracked child (claude -p + any git/verify
          // subprocess) explicitly so the work dies even when we can't
          // safely signal our process group (foreground daemons share the
          // user's terminal pgid). killAllChildren() is a no-op if nothing
          // is in flight.
          const { killAllChildren } = await import('../lib/git')
          const killedPids = killAllChildren()
          if (killedPids.length > 0) {
            log(`SIGKILL'd ${killedPids.length} child pid(s): ${killedPids.join(', ')}`)
          }
          // Respond before pulling the rug on the event loop. Use a short
          // setTimeout so the response flush actually lands on the wire.
          setTimeout(() => {
            try {
              for (const f of [socketPath, pidFile]) {
                if (existsSync(f)) {
                  try {
                    unlinkSync(f)
                  } catch {
                    // best-effort
                  }
                }
              }
            } finally {
              // Belt-and-suspenders: SIGKILL our own process group too when
              // we lead it (detached mode). Catches anything killAllChildren
              // missed (e.g. a child that spawned its own subprocess and
              // exited before we got the pid). In foreground mode the pgid
              // is the user's terminal, so we only kill ourselves.
              try {
                // process.getpgrp is POSIX-only and not in @types/node; cast
                // through unknown so the type checker accepts the lookup.
                const getpgrp = (process as unknown as {
                  getpgrp?: () => number
                }).getpgrp
                const pgid = typeof getpgrp === 'function' ? getpgrp() : -1
                if (pgid === process.pid) {
                  process.kill(-process.pid, 'SIGKILL')
                } else {
                  process.kill(process.pid, 'SIGKILL')
                }
              } catch {
                process.kill(process.pid, 'SIGKILL')
              }
            }
          }, 50)
          return {
            ok: true,
            data: {
              killed: victims.map((v) => ({ taskId: v.taskId, kind: v.kind })),
              killedPids,
            },
          }
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
    // Once shutdown starts, stop dispatching new work even if drain wasn't
    // explicitly requested — a SIGINT/SIGTERM that arrives while the
    // dispatcher is mid-pick must not strand an extra worktree.
    acceptingWork = false
    pendingTriage.clear()
    pendingImplement.clear()
    log(`shutting down (force=${force}, inFlight=${inFlight.size})`)

    if (force && inFlight.size > 0) {
      const entries = Array.from(inFlight.values())
        .map((e) => `${e.taskId}(${e.kind})`)
        .join(', ')
      log(`force shutdown abandoning in-flight: ${entries}`)
    }

    if (!force) {
      // No timeout: a drain stop waits as long as the in-flight tasks need.
      // `mars daemon kill` is the escape hatch for stuck work.
      let lastLogged = -1
      while (inFlight.size > 0) {
        if (inFlight.size !== lastLogged) {
          log(`waiting on ${inFlight.size} in-flight task(s)`)
          lastLogged = inFlight.size
        }
        await new Promise((r) => setTimeout(r, 250))
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
    // The daemon process is expected to exit on shutdown: pending workflow
    // runners, DuckDB/LibSQL handles, and child Claude processes keep the
    // event loop alive otherwise, which leaks the DuckDB single-writer lock
    // across restarts. SIGINT/SIGTERM already exit; mirror that for RPC.
    process.exit(0)
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      log(`received ${sig}`)
      void shutdown(false)
    })
  }

  return {
    stop: shutdown,
    inFlightCount: () => inFlight.size,
  }
}
