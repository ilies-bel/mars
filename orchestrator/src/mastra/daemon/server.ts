import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, resolve as resolvePath } from 'node:path'
import { resolveContext } from '../context'
import {
  addBlockers,
  deleteTask,
  dropTask,
  enqueueTask,
  getClient,
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
import {
  drainAlertDismissals,
  ensureAlertDismisser,
} from './alert-dismisser'
import {
  drainInboxRepopulations,
  ensureInboxRepopulator,
} from './inbox-repopulator'
import type { Logger, WorkflowEvent } from '@mars/workflow'
import { scanRecoveryBlockerEdges } from '../lib/blocker-invariant'
import { resolveGitBin } from '../lib/git'
import { getDefaultTaskStore } from '../lib/task-store'
import { getDefaultDomainTaskStore } from '../store/task-store'
import { listTerminalEvents } from './view/terminal-events'
import { listProposals, promoteProposal } from '../proposals'
import type { DraftFeature, StaleWorktreeAlert } from './http-server'
import {
  CANCELLED_FAILURE_REASON,
  markOriginDoneFromRecovery,
  onBlockerTaskCancelled,
  onBlockerTaskCompleted,
  onBlockerTaskFailed,
  recoverBlockedTasks,
} from '../blocker-resolution'
import {
  supersedeInboxItemsForOrigin,
  supersedeObsoletePreflightDirtyMainRows,
} from '../lib/inbox'
import {
  raiseAggregatedMainCommiterFailureRow,
  sweepStaleFailedMainCommiterInbox,
} from './main-dirty-inbox'
import { DAEMON_KILLED_SIGNATURE } from '../lib/retry-budget'
import { failureReasonStringToCode } from '../lib/failure-reasons'
import { openTraceEventStore, type TraceEventStore } from '../lib/trace-events-store'
import { internalBus } from '../../internal-bus'
import { daemonPaths, isProcessAlive, readDaemonPid, tryConnectSocket } from './paths'
import { loadDaemonConfig } from './config'
import { probeDuckDBLock } from './duckdb-lock'
import {
  assertProposalsSourceFresh,
  captureProposalsStamp,
  mapDaemonError,
} from './stale-detection'
import {
  readLines,
  writeLine,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStatusPayload,
} from './protocol'
import { ViewStreamHub } from './view/stream-hub'

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

/**
 * Adapt the daemon's `log(line)` sink into the pino-shaped `Logger` the
 * @mars/workflow engine expects. The engine calls `info/warn/error` with
 * either `(msg)` or `(fields, msg)` and chains `child(bindings)`; we fold the
 * bindings + fields into a single bracketed daemon log line so engine
 * lifecycle output lands in the same `.mars/watch.log` stream as everything
 * else. Bindings accumulate across `child` calls (runId/workflowId/step) so a
 * line is self-describing.
 */
const makeWorkflowLogger = (
  log: (line: string) => void,
  bindings: Record<string, unknown> = {},
): Logger => {
  const fmt = (
    level: string,
    arg1: Record<string, unknown> | string,
    arg2?: string,
  ): string => {
    const fields = typeof arg1 === 'string' ? {} : arg1
    const msg = typeof arg1 === 'string' ? arg1 : arg2
    const merged = { ...bindings, ...fields }
    const ctx = Object.entries(merged)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ')
    return `[workflow] ${level}${ctx ? ` ${ctx}` : ''}${msg ? ` ${msg}` : ''}`
  }
  return {
    info: (arg1: Record<string, unknown> | string, arg2?: string) =>
      log(fmt('info', arg1, arg2)),
    warn: (arg1: Record<string, unknown> | string, arg2?: string) =>
      log(fmt('warn', arg1, arg2)),
    error: (arg1: Record<string, unknown> | string, arg2?: string) =>
      log(fmt('error', arg1, arg2)),
    child: (extra: Record<string, unknown>) =>
      makeWorkflowLogger(log, { ...bindings, ...extra }),
  }
}

/**
 * One-shot cleanup: remove legacy `.mars/mastra.db*` files left over from
 * the pre-@mars/workflow era. The orchestrator no longer opens or queries
 * `.mars/mastra.db`, so the file (plus its SQLite `-shm`/`-wal` siblings)
 * is dead weight that lingers on disk. Idempotent — `force: true` makes a
 * missing file a no-op rather than an error.
 */
const removeLegacyMastraDb = (
  stateDir: string,
  log: (line: string) => void,
): void => {
  const removed: string[] = []
  for (const name of ['mastra.db', 'mastra.db-shm', 'mastra.db-wal']) {
    const path = resolvePath(stateDir, name)
    if (existsSync(path)) {
      rmSync(path, { force: true })
      removed.push(name)
    }
  }
  if (removed.length > 0) {
    log(`[cleanup] removed legacy ${removed.join(', ')} from ${stateDir}`)
  }
}

/**
 * ADR-0040 forensic backfill: scan `task_blockers` for rows that violate the
 * recovery-leaf invariant (either endpoint is a kind='fix' / fixForTaskId-set
 * task) and log them so the operator can resolve via `mars unblock <id>`.
 * Read-only — never mutates the table.
 */
const scanRecoveryLeafViolations = async (
  log: (line: string) => void,
): Promise<void> => {
  const violations = await scanRecoveryBlockerEdges()
  if (violations.length === 0) return
  log(
    `[adr-0040] found ${violations.length} task_blockers row(s) involving a recovery task (pre-leaf-guard residue). ` +
      `Recovery tasks must be leaf nodes — run \`mars unblock <id>\` on each to clear them.`,
  )
  for (const v of violations) {
    const roles: string[] = []
    if (v.taskIsRecovery) roles.push(`task=${v.taskId}`)
    if (v.blockerIsRecovery) roles.push(`blocker=${v.blockerTaskId}`)
    log(
      `[adr-0040]   edge (task=${v.taskId}, blocker=${v.blockerTaskId}) violates leaf invariant: ${roles.join(', ')}`,
    )
  }
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
  const { socket: socketPath, pidFile, logFile, httpPortFile } = daemonPaths()
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
        `observability DuckDB store at ${observabilityDbPath} is locked by pid ${probe.holderPid}; refusing to start. ` +
          `Stop that process or set MARS_DISABLE_DUCKDB=1 to skip DuckDB.`,
      )
      process.exit(1)
    }
    if (probe.status === 'stale') {
      log(
        `observability DuckDB store at ${observabilityDbPath} has a stale fd holder (pid ${probe.holderPid} not alive); proceeding`,
      )
    }
  }
  // Open the unified Mars trace-event store. It lives in `mars.db` alongside
  // the rest of the state, so there is no separate file lock to probe — the
  // SQLite connection is shared via libsql's normal pool.
  const traceStore: TraceEventStore = await openTraceEventStore(
    resolveContext().stateDbPath,
  )

  // Resolve git binary once at startup. If git is not on PATH the daemon
  // exits immediately with a clear message instead of letting the first
  // git call fail mid-task as a retry-budget-exhausted ENOENT.
  try {
    resolveGitBin()
  } catch {
    log('git binary not found on PATH; refusing to start')
    process.exit(1)
  }

  // One-shot cleanup of pre-@mars/workflow `.mars/mastra.db*` files.
  // Idempotent: silent if nothing exists, single info line if anything
  // was removed. Runs every startup; deleting absent files is cheap.
  try {
    removeLegacyMastraDb(resolveContext().stateDir, log)
  } catch (err) {
    log(`[cleanup] legacy mastra.db sweep failed: ${(err as Error).message}`)
  }

  await initQueue()

  // Slice K one-shot cleanup: supersede any open inbox rows that still
  // describe the retired `setup:preflight/dirty-main` failure mode. The
  // codepath no longer exists, so these rows can never reach a true
  // resolution from the operator side. Idempotent: silent when no rows
  // match; one info line when at least one row was closed.
  try {
    const closed = await supersedeObsoletePreflightDirtyMainRows()
    if (closed.length > 0) {
      log(
        `[slice K] resolved ${closed.length} obsolete preflight-dirty-main inbox rows`,
      )
    }
  } catch (err) {
    log(
      `[slice K] preflight-dirty-main inbox cleanup failed: ${(err as Error).message}`,
    )
  }

  // Forensic backfill check for ADR-0040 (recovery tasks are leaf nodes).
  // Read-only scan of `task_blockers` for rows where either endpoint is a
  // recovery (fix) task — those edges predate the leaf-node guard and must
  // be cleared by the operator (`mars unblock <id>`). The check never
  // mutates the DB; if it fails, log and continue.
  try {
    await scanRecoveryLeafViolations(log)
  } catch (err) {
    log(
      `[adr-0040] recovery-leaf backfill scan failed: ${(err as Error).message}`,
    )
  }

  // Source-stamp guard for the proposals schema migration (and any future
  // schema-rename that lands in proposals.ts). Captured before any RPC is
  // served; checked by proposal-mutating handlers. See stale-detection.ts.
  const proposalsStamp = captureProposalsStamp()
  if (proposalsStamp.mtimeMs !== null) {
    log(
      `[stale-guard] proposals source stamp: ${proposalsStamp.path} @ ${new Date(
        proposalsStamp.mtimeMs,
      ).toISOString()}`,
    )
  } else {
    log(
      `[stale-guard] proposals source not on disk (${proposalsStamp.path}); guard disabled, relying on error-rewrite fallback`,
    )
  }

  const bus = new EventEmitter()
  bus.setMaxListeners(50)

  // SSE invalidation hub: the daemon broadcasts one event per channel
  // whenever it mutates the corresponding store. Connected UI clients
  // re-fetch the relevant view endpoint on receipt.
  const viewStreamHub = new ViewStreamHub()

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
      const { runTriage } = await import('../../workflows/triage-workflow')
      const result = await runTriage(taskId, getDefaultDomainTaskStore())
      log(`[triage] ${taskId} -> actionable=${result.actionable}`)
      if (result.actionable) {
        const t = await getTask(taskId)
        if (t?.status === 'queued') {
          if (await hasIncompleteBlockers(taskId)) {
            // Park it 'blocked', not 'queued'. The unblock machinery
            // (onBlockerTaskCompleted / recoverBlockedTasks) only re-evaluates
            // tasks WHERE status='blocked', so a dependent left 'queued' here is
            // invisible to it and would strand until a daemon restart. Flipping
            // to 'blocked' wires it into the normal blocked→queued flow.
            await updateTask(taskId, { status: 'blocked' })
            log(`[triage] ${taskId} actionable but has incomplete blockers; parked blocked`)
          } else {
            bus.emit('task.queued', { taskId })
          }
        }
      }
    } catch (err) {
      // One bad task must NEVER crash the daemon. dispatchTriage is invoked
      // fire-and-forget (`void dispatchTriage(...)`), so any error that escapes
      // this catch becomes an unhandledRejection that kills the process and
      // triggers the crash-respawn loop. Convert the failure into a logged,
      // persisted task failure + a `task.failed` emit, and let the finally run.
      const message = err instanceof Error ? err.message : String(err)
      log(`[triage] ${taskId} failed: ${message}`)
      try {
        await updateTask(taskId, {
          status: 'failed',
          error: message,
          failureReason: message,
          failureReasonCode: failureReasonStringToCode(message),
        })
      } catch {
        // best-effort
      }
      try {
        bus.emit('task.failed', { taskId, error: message })
      } catch {
        // best-effort
      }
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
      // Slice F.2: dispatch-time dirty-main check. Runs BEFORE workflow
      // dispatch (i.e. before the worktree is created) so we never burn the
      // coding turn on a tree we'd reject at verify anyway. Recovery
      // (kind='fix') tasks are exempt — the main-commiter is itself the
      // tool we use to fix dirty-main, so it MUST be allowed to dispatch
      // against the dirty integration branch.
      if (task.kind !== 'fix') {
        try {
          const { runMainDirtyDispatchCheck } = await import(
            './main-dirty-dispatch'
          )
          const parked = await runMainDirtyDispatchCheck({
            task,
            integrationBranch,
            traceStore,
            recipeCatalog,
            log,
          })
          if (parked) {
            // Source is now `blocked` with an edge to a (new or existing)
            // main-commiter. Skip dispatching the workflow — its first step
            // (setup) would just hit the same condition.
            return
          }
        } catch (err) {
          log(
            `[main-dirty] dispatch-time check threw for task ${task.id}; falling through to workflow (legacy preflight is backstop): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
      const { runWorkflow } = await import('@mars/workflow')
      const { implementWorkflow } = await import('../../workflows/implement-workflow')
      const { createQueueWorkflowStore } = await import('../../workflows/queue-workflow-store')
      // The implement pipeline now runs on the in-house @mars/workflow engine
      // rather than Mastra. Two seams are wired here:
      //   - `store`    — the engine's run/step checkpoint persistence, backed
      //                  by `.mars/queue.db` (createQueueWorkflowStore).
      //   - `services` — the orchestrator's TaskStore from the composition
      //                  root, read inside the workflow as `ctx.services.store`
      //                  (replaces the Mastra RequestContext('taskStore')).
      // `runId: task.id` is what makes `mars continue` resume: re-dispatching
      // the same task id re-enters runWorkflow with that runId, and every step
      // whose record is already `'completed'` short-circuits. Resume is now
      // entirely engine-driven — there is no `resumeFrom` hint in the input.
      const taskStore = await getDefaultTaskStore()
      const workflowStore = createQueueWorkflowStore()
      // Pino-shaped logger adapter over the daemon's `log`. The engine emits
      // structured run/step lifecycle lines (`step.started`, `step.completed`,
      // `run.failed`, …); fold them into one greppable daemon log line each.
      const workflowLogger = makeWorkflowLogger(log)
      // Forward fine-grained progress events. The high-volume per-tool-call
      // streams (`claude-event`, `vcs-supervisor-event`) used to flow through
      // Mastra's workflow writer purely for live UI tailing and were not
      // persisted here; we drop them to keep the daemon log readable and let
      // the per-step transcript (keyed by claudeSessionId) carry the detail.
      const onEvent = (evt: WorkflowEvent): void => {
        if (evt.event === 'claude-event' || evt.event === 'vcs-supervisor-event') return
        log(`[implement] ${task.id} ${evt.step ?? 'run'}:${evt.event}`)
      }
      const result = await runWorkflow(
        implementWorkflow,
        {
          taskId: task.id,
          prompt: task.prompt,
          plan: task.plan,
          tags: task.tags ?? ['coder'],
          kind: task.kind ?? 'task',
          integrationBranch,
          spec: task.spec
            ? {
                files: [...task.spec.files],
                verifyCmd: task.spec.verifyCmd,
                doneCriteria: [...task.spec.doneCriteria],
                taskType: task.spec.taskType,
                readFirst: [...(task.spec.readFirst ?? [])],
                prescriptiveAction: task.spec.prescriptiveAction ?? null,
              }
            : null,
        },
        {
          store: workflowStore,
          services: { store: taskStore },
          runId: task.id,
          logger: workflowLogger,
          onEvent,
        },
      )
      const {
        isBlockersAbortError,
        isMainDirtyVerifyError,
        isTooHardAbortError,
      } = await import('../../workflows/implement-workflow')
      // Read the failure off RunResult.error (the engine puts the thrown Error
      // there verbatim on the `failed` path). The detectors flatten the cause
      // chain and accept `unknown`, so passing the raw error through is correct
      // and the previous `instanceof Error` precondition is unnecessary.
      const resultError = result.status === 'failed' ? result.error : null
      if (result.status === 'failed' && isBlockersAbortError(resultError)) {
        log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
        return
      }
      // Slice F.2: verify-time dirty-main detection. The verify step parked
      // the source `blocked` behind a `main-commiter` recovery and threw a
      // sentinel; suppress the misleading `task.completed status=failed`
      // emit. (Slice K retired the legacy setup-time preflight; the
      // equivalent dispatch-time check runs in `runMainDirtyDispatchCheck`
      // before the workflow is dispatched, so no in-workflow suppression
      // pair is needed there.)
      if (result.status === 'failed' && isMainDirtyVerifyError(resultError)) {
        log(`[implement] ${task.id} parked blocked: integration branch dirty at verify; main-commiter spawned/attached`)
        return
      }
      // A read-span guard trip parks the original task `blocked` with a
      // task_blockers edge to the diagnose Chore. The step throws the sentinel
      // to abort the run, so the result surfaces as `failed` — suppress the
      // misleading `task.completed status=failed` emit and let the blocked
      // state stand.
      if (result.status === 'failed' && isTooHardAbortError(resultError)) {
        log(`[implement] ${task.id} parked blocked: read-span guard tripped; diagnose Chore spawned as blocker`)
        return
      }
      log(`[implement] ${task.id} -> ${result.status}`)
      bus.emit('task.completed', { taskId: task.id, status: result.status })
    } catch (err) {
      // One bad task must NEVER crash the daemon. Everything from here on is
      // defensive: the catch body itself must not throw, or the rejection
      // escapes dispatchImplement (it is invoked fire-and-forget as
      // `void dispatchImplement(t)`) and surfaces as an unhandledRejection
      // that kills the process — the crash-respawn loop this guard exists to
      // prevent. So the detector import, the failed-write, and the emit are
      // each individually guarded; whatever happens, control reaches the
      // `finally` and the function resolves.
      const message = err instanceof Error ? err.message : String(err)
      // The blockers-abort detector lives in the implement workflow module. A
      // dynamic import can itself reject (module-resolution / eval error), and
      // that rejection would escape this catch. Load it best-effort: if the
      // import fails, treat the error as an ordinary failure rather than a
      // benign blockers-abort — failing the task is the safe default.
      let isBlockersAbort = false
      try {
        const { isBlockersAbortError } = await import('../../workflows/implement-workflow')
        isBlockersAbort = isBlockersAbortError(err)
      } catch (importErr) {
        log(
          `[implement] ${task.id} could not load blockers-abort detector (${
            importErr instanceof Error ? importErr.message : String(importErr)
          }); treating as ordinary failure`,
        )
      }
      if (isBlockersAbort) {
        log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
      } else {
        log(`[implement] ${task.id} failed: ${message}`)
        try {
          await updateTask(task.id, {
            status: 'failed',
            error: message,
            failureReason: message,
            failureReasonCode: failureReasonStringToCode(message),
          })
        } catch {
          // best-effort
        }
        // bus.emit is synchronous, but a throwing listener would otherwise
        // propagate out of the emit call. Guard it so a bad subscriber can't
        // take the daemon down on the failure path either.
        try {
          bus.emit('task.failed', { taskId: task.id, error: message })
        } catch {
          // best-effort
        }
      }
    } finally {
      // The finally always runs even if an earlier `return` short-circuited
      // the try (the blockers-abort / dirty-main / too-hard branches), so the
      // semaphore slot and inFlight entry are released on every exit path and
      // drain() re-arms the loop. drain() has its own internal catch, so the
      // fire-and-forget `void` here can never leak a rejection.
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
      // One bad structured-write must NEVER crash the daemon. This dispatcher
      // is invoked fire-and-forget (`void dispatchGlossaryWrite(...)`), so an
      // escaping rejection becomes an unhandledRejection that kills the
      // process. Log-only is correct here: a glossary write operates on a
      // synthetic id (there is no queued task row to fail), so there is
      // nothing to mark `failed` — we just record the failure and release the
      // slot in finally. String() fallback keeps the catch body throw-proof.
      log(
        `[glossary-write] ${req.kind} "${req.term}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
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
      // One bad structured-write must NEVER crash the daemon. This dispatcher
      // is invoked fire-and-forget (`void dispatchAdrAdd(...)`), so an escaping
      // rejection becomes an unhandledRejection that kills the process.
      // Log-only is correct: an ADR add operates on a synthetic id (no queued
      // task row to fail), so there is nothing to mark `failed` — record the
      // failure and release the slot in finally. String() fallback keeps the
      // catch body throw-proof on a non-Error rejection value.
      log(
        `[adr-add] "${req.title}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
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
      const { runPlan } = await import('../../workflows/plan-workflow')
      // Wire the TaskStore from the composition root into the workflow so
      // the generate step routes its queue reads through the store
      // rather than calling getClient() directly (ADR-0021 seam, slice 2).
      // The store is read inside the workflow as `ctx.services.store`.
      const taskStore = await getDefaultTaskStore()
      const result = await runPlan(taskId, refresh, taskStore)
      log(
        `[refine] ${taskId} -> suggestions=${result.suggestionCount}`,
      )
    } catch (err) {
      // One bad refine must NEVER crash the daemon. dispatchRefine runs
      // fire-and-forget from the `task.refine` bus handler, so an escaping
      // rejection would become an unhandledRejection and kill the process.
      // We log-only here (no status flip): refine produces plan suggestions
      // and must not fail the underlying task — a failed refine simply leaves
      // the task in whatever status it already had. The finally always
      // releases the slot. The String() fallback guarantees the catch body
      // itself cannot throw on a non-Error rejection value.
      log(`[refine] ${taskId} failed: ${err instanceof Error ? err.message : String(err)}`)
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
        // A throw from any await below (getTask / hasIncompleteBlockers
        // hitting SQLITE_BUSY or a LibSQL client error under a large
        // queue.db) must not escape: drain() is invoked fire-and-forget
        // (`void drain()`), so an uncaught rejection silently kills the
        // loop with no log line and the daemon stops claiming work while
        // staying alive. Catch per-pass, log, and let the do/while exit
        // cleanly — the poll-fallback tick (or the next bus event) retries.
        try {
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
        } catch (err) {
          // Log and stop this drain. drainAgain is left as-is so a pending
          // re-entry request still re-runs; otherwise the poll-fallback
          // tick picks the queue back up on its next interval.
          log(
            `[dispatch] drain pass errored (will retry): ${
              (err as Error).message
            }`,
          )
          break
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
  // subscribers (logs, future UI/CLI bridges) see a unified stream.
  //
  // 'task.blocked' is purely observational. 'task.unblocked' is NOT: it is
  // the dispatch trigger for unblocks that arrive via updateTask() from
  // outside handleUpdate. The implement workflow marks a task done with a
  // direct updateTask(id, { status: 'done' }) (implement-workflow.ts:970,
  // 1102), which auto-promotes its dependents in the DB and emits
  // 'task.unblocked' on the internal bus (blocker-resolution.ts), but never
  // routes through handleUpdate — so without this handler the freshly
  // queued dependent never enters pendingImplement and only gets picked up
  // on the next daemon restart's reconcile(). This path and handleUpdate's
  // own task.queued emit are complementary: handleUpdate covers ops the
  // daemon routes through itself; this mirror covers ops that go straight
  // through updateTask.
  internalBus().on('task.blocked', (e) => {
    log(
      `[blocked] ${e.taskId} signature=${e.failureSignature} step=${e.failingStep} fix=${e.fixTaskId ?? '(none)'}`,
    )
    bus.emit('task.blocked', e)
  })
  internalBus().on('task.unblocked', (e) => {
    log(`[unblocked] ${e.taskId} via blocker ${e.blockerTaskId}`)
    bus.emit('task.unblocked', e)
    if (!acceptingWork) return
    if (inFlight.has(e.taskId)) return
    pendingImplement.add(e.taskId)
    void drain()
  })

  // Broadcast invalidations to connected SSE clients on every task lifecycle
  // event so the UI re-fetches the tasks/progress views without polling.
  bus.on('task.added', () => { viewStreamHub.broadcast('tasks') })
  bus.on('task.queued', () => { viewStreamHub.broadcast('tasks'); viewStreamHub.broadcast('progress') })
  bus.on('task.completed', () => { viewStreamHub.broadcast('tasks'); viewStreamHub.broadcast('progress') })
  bus.on('task.failed', () => { viewStreamHub.broadcast('tasks'); viewStreamHub.broadcast('progress') })
  bus.on('task.blocked', () => { viewStreamHub.broadcast('tasks') })
  bus.on('task.unblocked', () => { viewStreamHub.broadcast('tasks') })

  // ── Wrappers around queue ops that emit the right events ──────────────────

  const handleAdd = async (
    prompt: string,
    plan?: Task['plan'],
    skipTriage?: boolean,
    author?: Task['author'],
    blockerIds?: readonly string[],
    priority?: number,
    tags?: Task['tags'],
    spec?: Task['spec'],
  ): Promise<Task> => {
    const opts: Parameters<typeof enqueueTask>[2] = {}
    if (skipTriage) opts.skipTriage = true
    if (author) opts.author = author
    if (priority !== undefined) opts.priority = priority
    if (tags !== undefined) opts.tags = tags
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
      if (after.status === 'failed') {
        // Block downstream queued dependents: any task with a
        // task_blockers edge pointing at this failed task must not
        // dispatch into a broken tree. Helper is idempotent and
        // covers every failure mode (not just fix-task failure).
        try {
          const blocked = await onBlockerTaskFailed(id)
          for (const o of blocked.outcomes) {
            if (o.outcome === 'blocked') {
              log(
                `[block-cascade] task ${o.taskId} moved queued -> blocked because prerequisite ${id} failed`,
              )
            }
          }
        } catch (err) {
          log(
            `[block-cascade] error blocking downstreams for failed ${id}: ${(err as Error).message}`,
          )
        }
        // Slice F.2: when a `main-commiter` recovery itself fails, raise a
        // single aggregated inbox row listing every blocked dependent so
        // the operator can see the cohort at a glance. Overrides the
        // generic recovery-failed row that `inbox-repopulator` would
        // raise for this task. Idempotent on the committer task id —
        // a repeat failure transition bumps seenCount only.
        if (after.kind === 'fix') {
          try {
            const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } =
              await import('../lib/main-dirty')
            const payload = parseMainCommiterPayload(after.recoveryPayload)
            if (payload && payload.recipe === MAIN_COMMITER_RECIPE) {
              await raiseAggregatedMainCommiterFailureRow(after.id, log)
            }
          } catch (err) {
            log(
              `[main-dirty] error raising aggregated inbox row for failed committer ${id}: ${(err as Error).message}`,
            )
          }
        }
      }
      if (
        after.status === 'failed' &&
        after.failureReason === CANCELLED_FAILURE_REASON
      ) {
        // PRD slice 2/4 (mars-9234e1b2): cancellation cascade. When a
        // blocker is cancelled by the user (stop-task RPC marks the row
        // failed with failure_reason='cancelled'), every dependent
        // waiting on it must also fail rather than be recovered. The
        // helper raises one inbox item per cascaded dependent so the
        // operator can see why the chain died.
        try {
          const cascade = await onBlockerTaskCancelled(id)
          for (const o of cascade.outcomes) {
            if (o.outcome === 'failed') {
              log(
                `[cancel-cascade] task ${o.taskId} cancelled because blocker ${id} was cancelled`,
              )
            }
          }
        } catch (err) {
          log(
            `[cancel-cascade] error cascading cancellation from ${id}: ${(err as Error).message}`,
          )
        }
      }
      if (after.status === 'done') {
        // Auto-supersede the inbox row keyed to this origin task, if any.
        // The operator no longer needs to ack/dismiss: the underlying
        // stuck task has reached a terminal state on its own.
        //
        // NOTE: this is now redundant with the Invalidator, which closes
        // the same row off the task.terminal{done} event updateTask emits
        // in-tx. It is kept as an idempotent same-process fast path (the
        // supersede only touches OPEN rows, so a double-close is a no-op)
        // and because this block also drives the main-committer sweep and
        // recovery→origin propagation below. Folding these into the
        // Invalidator is deferred follow-up, not required for the
        // staleness guarantee (ADR-0027/0030).
        try {
          const closed = await supersedeInboxItemsForOrigin(id, 'origin-done')
          if (closed.length > 0) {
            log(
              `[inbox] superseded ${closed.length} item(s) for origin ${id} on done`,
            )
          }
        } catch (err) {
          log(
            `[inbox] error superseding items for origin ${id}: ${(err as Error).message}`,
          )
        }
        // Slice F.2: when a `main-commiter` succeeds, any open `failed`
        // inbox rows raised by PREVIOUS committer attempts (for stale
        // hashes — i.e. a different broken state of main that has since
        // been resolved) are no longer actionable. Sweep them to
        // `resolved/superseded` so the operator's inbox doesn't keep
        // stale "main-committer failed" rows for a state that's gone.
        if (after.kind === 'fix') {
          try {
            const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } =
              await import('../lib/main-dirty')
            const payload = parseMainCommiterPayload(after.recoveryPayload)
            if (payload && payload.recipe === MAIN_COMMITER_RECIPE) {
              await sweepStaleFailedMainCommiterInbox(
                payload.dirtyMainHash,
                after.id,
                log,
              )
            }
          } catch (err) {
            log(
              `[main-dirty] error sweeping stale committer inbox rows after ${id} done: ${(err as Error).message}`,
            )
          }
        }
        // Recovery→origin done propagation. CLAUDE.md contract: "a
        // successful recovery counts as its origin reaching done, so
        // a recovered blocker unblocks the whole chain." When a fix
        // task (kind='fix', non-null fixForTaskId) reaches done, flip
        // the origin row to done, close any inbox items keyed on the
        // origin, and propagate the unblock to its dependents.
        if (after.kind === 'fix' && after.fixForTaskId !== null) {
          try {
            const propagation = await markOriginDoneFromRecovery(
              after.fixForTaskId,
            )
            if (propagation.originFlipped) {
              log(
                `[propagate] recovery ${id} flipped origin ${propagation.originTaskId} to done; closed ${propagation.inboxItemsClosed} inbox item(s)`,
              )
              if (propagation.unblock) {
                for (const o of propagation.unblock.outcomes) {
                  if (o.outcome === 'queued') {
                    log(
                      `[unblock] task ${o.taskId} re-queued after recovery ${id} propagated done to origin ${propagation.originTaskId}`,
                    )
                    bus.emit('task.queued', { taskId: o.taskId })
                  } else if (o.outcome === 'failed') {
                    log(
                      `[unblock] task ${o.taskId} failed at unblock (retry budget exhausted) after recovery ${id} propagated done to origin ${propagation.originTaskId}`,
                    )
                  }
                }
              }
            }
          } catch (err) {
            log(
              `[propagate] error propagating recovery ${id} done to origin ${after.fixForTaskId}: ${(err as Error).message}`,
            )
          }
        }
        // Diagnose Chore completion takes the PRD 06e677fb verdict-driven
        // branch — read the structured verdict, dispatch exactly one fix
        // attempt OR raise exactly one inbox item, and re-park the parent
        // accordingly. The generic on-blocker-completed path is skipped
        // for diagnose Chores: their job is to redirect the parent's
        // blocker chain, not to unblock it directly.
        if (after.kind === 'diagnose') {
          try {
            const { runDiagnoseFollowup } = await import(
              '../lib/diagnose-followup'
            )
            const outcome = await runDiagnoseFollowup(id)
            if (outcome.action === 'fix-dispatched' && outcome.fixTaskId) {
              log(
                `[diagnose] chore ${id}: root-cause verdict; dispatched fix ${outcome.fixTaskId}; parent ${outcome.parentTaskId} parked behind it`,
              )
              bus.emit('task.queued', { taskId: outcome.fixTaskId })
            } else if (outcome.action === 'inbox-raised') {
              log(
                `[diagnose] chore ${id}: ${outcome.verdictKind} verdict; parent ${outcome.parentTaskId} parked failed, inbox item ${outcome.inboxItemId} raised`,
              )
            } else {
              log(`[diagnose] chore ${id}: no-op (parent ${outcome.parentTaskId})`)
            }
          } catch (err) {
            log(
              `[diagnose] chore ${id}: follow-up errored: ${(err as Error).message}`,
            )
          }
          return
        }
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
  // pipeline from setup. The restart mechanics live in coreRestartTask so
  // the HTTP endpoint (slice 2 of the retry-button PRD) shares the exact
  // same code path — see daemon/restart-task.ts.
  const handleRestart = async (id: string): Promise<void> => {
    const { coreRestartTask } = await import('./restart-task')
    await coreRestartTask(id, new Set(['failed', 'done']))
    bus.emit('task.queued', { taskId: id })
  }

  // 'mars continue <id>' resumes a failed task on its existing branch+
  // worktree, skipping into the failed phase. When the failure occurred
  // upstream of worktree creation (pre-setup), it degrades silently to
  // restart behaviour and returns a note the CLI can surface to the operator.
  const handleContinue = async (
    id: string,
  ): Promise<import('./continue-task').ContinueResult> => {
    const { coreContinueTask } = await import('./continue-task')
    const result = await coreContinueTask(id)
    bus.emit('task.queued', { taskId: id })
    return result
  }

  const handlePurge = async (id: string, force: boolean): Promise<void> => {
    const { corePurgeTask } = await import('./purge-task')
    const { getRepoRoot } = await import('../context')
    await corePurgeTask(id, force, integrationBranch, getRepoRoot())
    // Action-queue rows for the purged task are closed by the Invalidator,
    // which consumes the task.terminal{purged} event dropTask emits in-tx
    // before deleting the row. No inline supersede here — that best-effort
    // path was lost when the daemon was down and is the staleness class this
    // design removes (ADR-0027/0030).
  }

  const handleUnblock = async (id: string): Promise<UnblockTaskResult> => {
    return unblockTask(id)
  }

  const IN_FLIGHT_STATUSES = new Set<Task['status']>([
    'running',
    'verifying',
    'merging',
    'vega-reconciling',
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
    // Action-queue rows are closed by the Invalidator off the
    // task.terminal{purged} event dropTask emits in-tx before the row is
    // deleted; no inline supersede (ADR-0027/0030).
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

  const handleProposalPromote = async (
    proposalId: string,
  ): Promise<{ proposalId: string; status: string }> => {
    assertProposalsSourceFresh(proposalsStamp)
    const proposal = await promoteProposal(proposalId)
    // Auto-slice: chain slicing fire-and-forget so the RPC stays fast and a
    // slicer failure (e.g. malformed PRD) leaves the proposal in prd-ready for
    // the operator to inspect and re-promote without aborting the promote itself.
    if (proposal.status === 'prd-ready') {
      void handleProposalSlice(proposal.id).catch((err) =>
        log(`[auto-slice] proposal ${proposal.id} failed: ${(err as Error).message}`),
      )
    }
    return { proposalId: proposal.id, status: proposal.status }
  }

  const handleProposalSlice = async (
    proposalId: string,
  ): Promise<{ proposalId: string; status: string; taskIds: string[] }> => {
    assertProposalsSourceFresh(proposalsStamp)
    const { runSlice } = await import('../../workflows/slice-workflow')
    const result = await runSlice(proposalId)
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
    opts: import('../../workflows/init-workflow').RunInitOptions,
  ): Promise<import('../../workflows/init-workflow').RunInitResult> => {
    const { runInit } = await import('../../workflows/init-workflow')
    log(`[init] dispatching (force=${opts.force} fetch=${opts.fetch} dryRun=${opts.dryRun} refresh=${opts.refresh})`)
    const result = await runInit(opts)
    log(`[init] -> ${result.status}`)
    return result
  }

  const handleStatus = async (): Promise<DaemonStatusPayload> => {
    const counts = {
      draft: (await listTasks('draft')).length,
      queued: (await listTasks('queued')).length,
      running: (await listTasks('running')).length,
      verifying: (await listTasks('verifying')).length,
      merging: (await listTasks('merging')).length,
      'vega-reconciling': (await listTasks('vega-reconciling')).length,
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

    // Daemon-killed tasks: tasks SIGKILL'd with a prior daemon are stamped
    // `failureSignature: 'daemon-killed'` and left in `failed`. We do NOT
    // auto-requeue them — raise one alert-only inbox item per task so the
    // operator decides (Requeue now / Restart daemon).
    try {
      const { detectAndRaiseDaemonKilled } = await import('./daemon-killed-sweep')
      const raised = await detectAndRaiseDaemonKilled()
      if (raised.length > 0) {
        log(
          `[reconcile] raised ${raised.length} daemon-killed alert(s) (alert-only; not auto-requeued)`,
        )
      }
    } catch (err) {
      log(`[reconcile] daemon-killed sweep failed: ${(err as Error).message}`)
    }

    const drafts = await listTasks('draft')
    for (const t of drafts) bus.emit('task.added', { taskId: t.id })

    const queued = await listTasks('queued')
    for (const t of queued) bus.emit('task.queued', { taskId: t.id })

    // Stale in-flight rows: the previous daemon died mid-work.
    // Per-status recovery logic:
    //   running  → requeue from setup (daemon restart is not a task fault;
    //              do NOT consume the retry budget)
    //   verifying → auto-resume if worktree intact; else mark failed
    //   merging  → decide by git state: FF landed → done; else requeue from setup

    const { existsSync: exists } = await import('node:fs')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { removeWorktree, isBranchMergedIntoMain } = await import('../lib/git')
    const { getRepoRoot } = await import('../context')

    {
      const { requeueRunningTasksFromPriorDaemon } = await import('./reconcile-running')
      const requeued = await requeueRunningTasksFromPriorDaemon(getRepoRoot())
      for (const taskId of requeued) {
        log(`[reconcile] task ${taskId} was running on prior daemon; requeued from setup`)
        bus.emit('task.queued', { taskId })
      }
    }

    const verifying = await listTasks('verifying')
    for (const t of verifying) {
      if (t.branch && t.worktreePath && exists(t.worktreePath)) {
        // The prior daemon ran this task on Mastra (or a fresh engine run with
        // no checkpoint rows), so there is no @mars/workflow step record to
        // resume from — and re-running setup against the surviving worktree
        // would conflict on the existing branch/path. Clear the in-flight
        // worktree + branch and re-queue from a clean setup, mirroring the
        // merging not-landed path. Engine-resume (runId=task.id) is the only
        // resume mechanism now; there is no `resumeFrom` hint to skip into
        // verify.
        log(
          `[reconcile] task ${t.id} was verifying; clearing worktree and re-queuing from setup`,
        )
        const branch = t.branch
        if (exists(t.worktreePath)) {
          await removeWorktree({ path: t.worktreePath, branch }, true).catch(() => {})
        }
        await exec('git', ['branch', '-D', branch], { cwd: getRepoRoot() }).catch(() => {})
        await updateTask(t.id, {
          status: 'queued',
          branch: null,
          worktreePath: null,
          claudeSessionId: null,
          error: null,
          failedPhase: null,
        }).catch(() => {})
        bus.emit('task.queued', { taskId: t.id })
      } else {
        log(
          `[reconcile] task ${t.id} was verifying; worktree missing, marking failed`,
        )
        // Best-effort: prune any stale git worktree registration even though
        // the directory is already gone from disk. Keep the branch ref for
        // post-mortem forensics (keepBranch=true). Errors are logged and
        // swallowed — a missing/unregistered worktree must not break reconcile.
        if (t.worktreePath) {
          const branch = t.branch ?? `task/${t.id}`
          try {
            await removeWorktree({ path: t.worktreePath, branch }, true, true)
            log(`[reconcile] removed stale worktree registration for ${t.id} at ${t.worktreePath}`)
          } catch {
            log(`[reconcile] worktree cleanup skipped for ${t.id}: not registered or already removed`)
          }
        }
        await updateTask(t.id, {
          status: 'failed',
          error: 'daemon restart while task was verifying; worktree missing',
          failedPhase: 'verify',
          failureReason: 'daemon restart while task was verifying; worktree missing',
          failureReasonCode: 'unknown',
        }).catch(() => {})
      }
    }

    const merging = await listTasks('merging')
    for (const t of merging) {
      const branch = t.branch ?? `task/${t.id}`
      const landed = await isBranchMergedIntoMain(branch, getRepoRoot()).catch(() => false)
      if (landed) {
        log(
          `[reconcile] task ${t.id} was merging; FF already landed, finalized to done`,
        )
        if (t.worktreePath && exists(t.worktreePath)) {
          await removeWorktree({ path: t.worktreePath, branch }, true).catch(() => {})
        }
        await updateTask(t.id, {
          status: 'done',
          failedPhase: null,
          error: null,
        }).catch(() => {})
      } else {
        log(
          `[reconcile] task ${t.id} was merging; FF not landed, requeued from setup`,
        )
        if (t.worktreePath && exists(t.worktreePath)) {
          await removeWorktree({ path: t.worktreePath, branch }, true).catch(() => {})
        }
        await exec('git', ['branch', '-D', branch], { cwd: getRepoRoot() }).catch(() => {})
        await updateTask(t.id, {
          status: 'queued',
          branch: null,
          worktreePath: null,
          claudeSessionId: null,
          error: null,
          failedPhase: null,
        }).catch(() => {})
        bus.emit('task.queued', { taskId: t.id })
      }
    }

    // Proposals promoted while the daemon was offline are still in prd-ready;
    // pick them up and slice. Failures stay logged but don't abort reconcile.
    try {
      const stalled = await listProposals({ status: 'prd-ready' })
      for (const proposal of stalled) {
        log(`[reconcile-slice] proposal ${proposal.id} prd-ready on startup; slicing`)
        void handleProposalSlice(proposal.id).catch((err) =>
          log(`[reconcile-slice] proposal ${proposal.id} failed: ${(err as Error).message}`),
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
    'proposal.promote',
    'proposal.slice',
    'glossary-write',
    'adr-add',
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
            req.tags,
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
          const continueResult = await handleContinue(req.id)
          return { ok: true, data: continueResult }
        }
        case 'restart': {
          await handleRestart(req.id)
          return { ok: true }
        }
        case 'purge': {
          await handlePurge(req.id, req.force ?? false)
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
        case 'proposal.promote': {
          const r = await handleProposalPromote(req.proposalId)
          return { ok: true, data: r }
        }
        case 'proposal.slice': {
          const r = await handleProposalSlice(req.proposalId)
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
                failureSignature: DAEMON_KILLED_SIGNATURE,
                failureReason: 'killed by `mars daemon kill`',
                failureReasonCode: 'unknown',
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
              for (const f of [socketPath, pidFile, httpPortFile]) {
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
      return { ok: false, error: mapDaemonError((err as Error).message) }
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

  // ── Local HTTP action endpoint ────────────────────────────────────────────
  // Bound to 127.0.0.1 only; port is OS-assigned and published to
  // `.mars/http.port` so the read-only UI can discover it. The UI and any local
  // tooling resolve an error-kind action's `op` to a route here; the daemon —
  // the single writer — performs the state transition. Verbs mirror the CLI:
  // restart/unblock/purge and a worktree prune, plus a process-level
  // daemon restart. GET /error-kinds serves the action-menu registry.
  const { startHttpServer } = await import('./http-server')
  const { coreRestartTask: coreRestart } = await import('./restart-task')
  // Load the failure-reason catalog once at boot — built-in seed merged
  // with `.mars/failure-reasons/*.yaml` overrides. Consumers re-`mars
  // daemon reload` (or restart) to pick up file edits; no hot-reload.
  const { loadFailureReasonCatalog } = await import('../lib/failure-reasons')
  const failureReasonCatalog = await loadFailureReasonCatalog(
    resolveContext().stateDir,
    { onWarn: (msg) => log(msg) },
  )
  // Same lifecycle as the failure-reason catalog: built-in seed under
  // `src/mastra/recipes/built-in/*.md` merged with `.mars/recipes/*.md`
  // overrides, loaded once. No recipe is dispatched in this slice — the
  // catalog is exposed so the inbox UI can name which recipe a recovery
  // task ran under (wiring lands in slice F).
  const { loadRecipeCatalog } = await import('../lib/recipes')
  const recipeCatalog = await loadRecipeCatalog(resolveContext().stateDir, {
    onWarn: (msg) => log(msg),
  })
  const httpHandle = await startHttpServer({
    restartTask: async (id) => {
      await coreRestart(id, new Set(['failed']))
      bus.emit('task.queued', { taskId: id })
    },
    unblockTask: async (id) => {
      await handleUnblock(id)
    },
    purgeTask: async (id) => {
      await handlePurge(id, false)
    },
    pruneWorktree: async (id) => {
      // Guard: never remove a live task's worktree mid-flight. Removing the
      // spawn cwd while verify is running produces a cryptic "spawn git ENOENT"
      // that is indistinguishable from a missing git binary without this fix
      // (root cause of the 2026-05-29 verify:has-diff incident). The statuses
      // here match IN_FLIGHT_STATUSES above; they are inlined to avoid a
      // dependency on that internal Set from the closure.
      const task = await getTask(id)
      if (task && (task.status === 'running' || task.status === 'verifying' || task.status === 'merging')) {
        throw Object.assign(
          new Error(
            `task ${id} is in flight (status=${task.status}); cannot prune its worktree while live`,
          ),
          { code: 'WRONG_STATUS' as const },
        )
      }
      const { removeWorktree } = await import('../lib/git')
      const { getRepoRoot } = await import('../context')
      const { join } = await import('node:path')
      const path = join(getRepoRoot(), '.mars', 'worktrees', id)
      // keepBranch=true: leave the branch ref for post-mortem; ignoreMissing
      // so a half-gone worktree still prunes cleanly.
      await removeWorktree({ path, branch: `task/${id}` }, true, true)
    },
    investigateWorktree: (() => {
      // One active investigation per worktree id. A second concurrent POST for
      // the same id returns immediately with a "already running" explanation
      // rather than spawning a second Haiku process and melting the host.
      const inProgress = new Set<string>()

      return async (id: string): Promise<{ explanation: string }> => {
        if (inProgress.has(id)) {
          return { explanation: '(investigation already in progress — try again shortly)' }
        }
        inProgress.add(id)
        try {
          const { join } = await import('node:path')
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const { getRepoRoot } = await import('../context')
          const { runClaudeCode } = await import('../lib/git')
          const { getTask } = await import('../queue')
          const { patchOpenInboxPayload } = await import('../lib/inbox')

          const repoRoot = getRepoRoot()
          const worktreePath = join(repoRoot, '.mars', 'worktrees', id)
          const localExec = promisify(execFile)

          // Look up the originating task prompt (may not exist for absent tasks).
          const task = await getTask(id)
          const taskPrompt = task?.prompt ?? null

          // Compute the diff against the branch point on main.
          let mergeBase = 'main'
          try {
            const { stdout } = await localExec(
              'git',
              ['merge-base', `task/${id}`, 'main'],
              { cwd: repoRoot },
            )
            mergeBase = stdout.trim() || 'main'
          } catch { /* fall back to main */ }

          let diffStat = ''
          let diffBody = ''
          let untrackedFiles = ''
          try {
            const { stdout } = await localExec(
              'git',
              ['diff', '--stat', mergeBase],
              { cwd: worktreePath },
            )
            diffStat = stdout.trim()
          } catch { /* ignore */ }
          try {
            const { stdout } = await localExec(
              'git',
              ['diff', mergeBase],
              { cwd: worktreePath },
            )
            // Cap diff at 20 KB to keep the Haiku prompt small and cheap.
            diffBody = stdout.slice(0, 20_000)
          } catch { /* ignore */ }
          try {
            const { stdout } = await localExec(
              'git',
              ['ls-files', '--others', '--exclude-standard'],
              { cwd: worktreePath },
            )
            untrackedFiles = stdout.trim()
          } catch { /* ignore */ }

          const promptParts: string[] = []
          if (taskPrompt) {
            promptParts.push(`ORIGINAL TASK PROMPT:\n${taskPrompt}\n`)
          }
          promptParts.push(
            `DIFF STAT (changes vs main branch point):\n${diffStat || '(no committed changes)'}\n`,
          )
          if (diffBody) {
            promptParts.push(`DIFF:\n${diffBody}\n`)
          }
          if (untrackedFiles) {
            promptParts.push(`UNTRACKED FILES IN WORKTREE:\n${untrackedFiles}\n`)
          }
          promptParts.push(
            'In one short paragraph, explain what this abandoned task was trying ' +
              'to do and what the diff actually changed. Be terse — this is a ' +
              'cheap triage aid, not a code review.',
          )
          const investigatePrompt = promptParts.join('\n')

          const result = await runClaudeCode({
            cwd: worktreePath,
            prompt: investigatePrompt,
            model: 'claude-haiku-4-5-20251001',
            // Read-only: use default permission mode so no file edits are allowed.
            permissionMode: 'default',
            // Cap turns to keep cost low — Haiku only needs one turn to summarise.
            maxMessages: 5,
          })

          // Extract the final text from the conversation. Prefer the 'result'
          // event (the model's final answer), fall back to the last assistant text.
          let explanation = '(no explanation generated)'
          for (const event of result.conversation) {
            if (
              event.type === 'result' &&
              typeof event.result === 'string' &&
              !event.is_error
            ) {
              explanation = event.result as string
            }
          }

          // Persist onto the inbox item so the UI can render it.
          await patchOpenInboxPayload(id, {
            investigation: {
              text: explanation,
              investigatedAt: new Date().toISOString(),
            },
          })

          return { explanation }
        } finally {
          inProgress.delete(id)
        }
      }
    })(),
    diagnoseFailure: (() => {
      // One active diagnosis per task id — a second concurrent POST returns
      // immediately rather than spawning a second Sonnet process.
      const inProgress = new Set<string>()

      return async (id: string): Promise<{ diagnosis: string }> => {
        if (inProgress.has(id)) {
          return {
            diagnosis: '(diagnosis already in progress — try again shortly)',
          }
        }
        inProgress.add(id)
        try {
          const { join } = await import('node:path')
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const { existsSync } = await import('node:fs')
          const { getRepoRoot } = await import('../context')
          const { runClaudeCode } = await import('../lib/git')
          const { getTask } = await import('../queue')
          const { patchOpenInboxPayload } = await import('../lib/inbox')

          const repoRoot = getRepoRoot()
          const worktreePath = join(repoRoot, '.mars', 'worktrees', id)
          const localExec = promisify(execFile)

          const task = await getTask(id)

          // The worktree may have been cleaned up on a terminal failure. When
          // it exists, run the diagnosis from inside it (the model can read the
          // failing code); otherwise fall back to the repo root and diagnose
          // from the stored failure context + session trace alone.
          const worktreeExists = existsSync(worktreePath)
          const cwd = worktreeExists ? worktreePath : repoRoot

          let diffBody = ''
          if (worktreeExists) {
            let mergeBase = 'main'
            try {
              const { stdout } = await localExec(
                'git',
                ['merge-base', `task/${id}`, 'main'],
                { cwd: repoRoot },
              )
              mergeBase = stdout.trim() || 'main'
            } catch {
              /* fall back to main */
            }
            try {
              const { stdout } = await localExec('git', ['diff', mergeBase], {
                cwd: worktreePath,
              })
              diffBody = stdout.slice(0, 20_000)
            } catch {
              /* ignore */
            }
          }

          const promptParts: string[] = [
            'You are diagnosing why a Mars task failed. This failure has no ' +
              'registered recovery recipe, so a human asked for a root-cause ' +
              'diagnosis. You are READ-ONLY: do not edit any files.',
            '',
          ]
          if (task?.prompt) {
            promptParts.push(`ORIGINAL TASK PROMPT:\n${task.prompt}\n`)
          }
          promptParts.push(
            `FAILURE SIGNATURE: ${task?.failureSignature ?? '(unknown)'}`,
          )
          if (task?.error) {
            promptParts.push(`STORED FAILURE REASON:\n${task.error}\n`)
          }
          if (worktreeExists && diffBody) {
            promptParts.push(`WORKTREE DIFF (vs main branch point):\n${diffBody}\n`)
          } else {
            promptParts.push(
              'The failing task worktree is no longer on disk. Diagnose from ' +
                'the failure reason and original prompt above.\n',
            )
          }
          if (task?.claudeSessionId) {
            promptParts.push(
              `If the failure reason is insufficient, the failing run's session ` +
                `id is ${task.claudeSessionId} — reference its trace only if you ` +
                `cannot otherwise explain the failure.\n`,
            )
          }
          promptParts.push(
            'Give a terse root-cause diagnosis: what failed, the most likely ' +
              'cause, and whether a restart is likely to help or the task needs ' +
              'reshaping. A short paragraph — this is a triage aid, not a fix.',
          )

          const result = await runClaudeCode({
            cwd,
            prompt: promptParts.join('\n'),
            model: 'claude-sonnet-4-6',
            // Read-only: default permission mode disallows file edits.
            permissionMode: 'default',
            // A few turns so it can read the worktree / trace if needed.
            maxMessages: 12,
          })

          let diagnosis = '(no diagnosis generated)'
          for (const event of result.conversation) {
            if (
              event.type === 'result' &&
              typeof event.result === 'string' &&
              !event.is_error
            ) {
              diagnosis = event.result as string
            }
          }

          await patchOpenInboxPayload(id, {
            diagnosis: {
              text: diagnosis,
              diagnosedAt: new Date().toISOString(),
            },
          })

          return { diagnosis }
        } finally {
          inProgress.delete(id)
        }
      }
    })(),
    restartDaemon: async () => {
      // Re-exec a detached `mars daemon start` and let this process drain +
      // exit. Spawned detached so it survives our shutdown.
      const { spawn } = await import('node:child_process')
      const { resolveLaunchCommand } = await import('./paths')
      const { command, baseArgs } = resolveLaunchCommand()
      const child = spawn(command, [...baseArgs, 'daemon', 'start'], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      log(`restart-daemon requested; spawned replacement, draining self`)
      // Trigger our own graceful shutdown after the response flushes.
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
    },
    restartAllDaemonKilled: async () => {
      // Find every failed task stamped with the daemon-killed signature and
      // re-queue each one. Partial failures are tolerated: tasks that fail to
      // restart (e.g. wrong status race) are skipped; only successfully
      // restarted ids are returned.
      const failed = await listTasks('failed')
      const killed = failed.filter(
        (t) => t.failureSignature === DAEMON_KILLED_SIGNATURE,
      )
      const restarted: string[] = []
      for (const task of killed) {
        try {
          await coreRestart(task.id, new Set(['failed']))
          bus.emit('task.queued', { taskId: task.id })
          restarted.push(task.id)
        } catch {
          // Skip tasks that can't be restarted (e.g. raced to a different
          // status between the list and the restart). The others still proceed.
        }
      }
      log(`restart-all-daemon-killed: restarted ${restarted.length}/${killed.length} task(s)`)
      return restarted
    },
    isAcceptingWork: () => acceptingWork,
    failureReasonCatalog,
    recipeCatalog,
    traceStore,
    viewTasks: () =>
      getDefaultDomainTaskStore()
        .listTasks()
        .then((tasks) => ({ tasks })),
    viewProgress: async ({ failedWindowMs }) => {
      const {
        buildProgressView,
        createProgressTaskStore,
        createProposalReader,
      } = await import('./view/progress')
      const client = getClient()
      return buildProgressView(
        createProgressTaskStore(client),
        createProposalReader(client),
        { now: Date.now(), failedWindowMs },
      )
    },
    inboxAck: async (kind, id) => {
      const { dismissEntity } = await import('../lib/inbox-dismissals')
      await dismissEntity(kind, id, { by: 'daemon', note: 'ack' })
    },
    inboxResolve: async (kind, id) => {
      const { dismissEntity } = await import('../lib/inbox-dismissals')
      await dismissEntity(kind, id, { by: 'daemon', note: 'resolved' })
    },
    inboxDismiss: async (kind, id) => {
      const { dismissEntity } = await import('../lib/inbox-dismissals')
      await dismissEntity(kind, id, { by: 'daemon' })
    },
    todoDismiss: async (kind, id) => {
      if (kind === 'draft') {
        const { rejectProposal } = await import('../proposals')
        await rejectProposal(id)
      } else {
        const { dismissStaleWorktree } = await import('../lib/inbox')
        await dismissStaleWorktree(id)
      }
    },
    viewStreamHub,
    viewInbox: async (filter) => {
      const { buildInboxView } = await import('./view/inbox')
      const { listInboxItems } = await import('../lib/inbox')
      const { listDismissals } = await import('../lib/inbox-dismissals')
      const { listTasks: qListTasks, initQueue, getClient: getQueueClient } = await import('../queue')
      const { listErrorKinds: listErrKinds } = await import('../lib/error-kinds')
      const { hasRecipe } = await import('../lib/fix-recipes')
      const { getRepoRoot } = await import('../context')

      await initQueue()

      // Build the state store adapter.
      const stateStore = {
        listOpenInboxItems: async () => {
          const items = await listInboxItems('open')
          return items.map((item) => ({
            id: item.id,
            kind: item.kind as string,
            priority: item.priority as string,
            title: item.title,
            body: item.body,
            payload: item.payload,
            context: item.context,
            raisedAt: item.raisedAt,
            lastSeenAt: item.lastSeenAt,
          }))
        },
        listInboxDismissals: async () => {
          const dismissals = await listDismissals()
          const map = new Map<string, string | null>()
          for (const d of dismissals) {
            map.set(`${d.entityKind}:${d.entityId}`, d.note)
          }
          return map
        },
      }

      // Build the task store adapter: tasks + blocker info + parentProposalId.
      const taskStore = {
        listTasks: async () => {
          const tasks = await qListTasks()
          const c = getQueueClient()
          // Build blockedBy map from task_blockers.
          let blockedByMap = new Map<string, string[]>()
          let proposalMap = new Map<string, string | null>()
          try {
            const blockersResult = await c.execute(
              `SELECT task_id, blocker_task_id FROM task_blockers`,
            )
            for (const row of blockersResult.rows) {
              const r = row as unknown as { task_id: string; blocker_task_id: string }
              const arr = blockedByMap.get(r.task_id) ?? []
              arr.push(r.blocker_task_id)
              blockedByMap.set(r.task_id, arr)
            }
          } catch {
            // task_blockers may not exist on a fresh repo — empty map.
          }
          try {
            const proposalResult = await c.execute(
              `SELECT id, parent_proposal_id FROM tasks WHERE parent_proposal_id IS NOT NULL`,
            )
            for (const row of proposalResult.rows) {
              const r = row as unknown as { id: string; parent_proposal_id: string | null }
              proposalMap.set(r.id, r.parent_proposal_id)
            }
          } catch {
            // Tolerate missing column on legacy repos.
          }
          return tasks.map((t) => ({
            id: t.id,
            status: t.status,
            prompt: t.prompt,
            blockedBy: blockedByMap.get(t.id) ?? [],
            parentProposalId: proposalMap.get(t.id) ?? null,
            failureSignature: t.failureSignature,
            branch: t.branch,
            updatedAt: t.updatedAt,
          }))
        },
      }

      const errorKinds = listErrKinds()
      const errorKindRegistry = new Map(
        errorKinds.map((ek) => [ek.kind, ek]),
      )

      return buildInboxView({
        stateStore,
        taskStore,
        errorKindRegistry,
        recipeCatalog: { has: hasRecipe },
        repoRoot: getRepoRoot(),
        filter,
      })
    },
    viewTodo: async () => {
      const client = getClient()
      // Check if the proposals table exists (absent on a fresh repo before
      // the first `mars init` / daemon run that initialises the schema).
      const tablesResult = await client.execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'`,
      )
      const drafts: DraftFeature[] = []
      if (tablesResult.rows.length > 0) {
        const r = await client.execute(
          `SELECT p.id, p.title, p.problem, p.solution, p.status, p.source,
                  p.created_at, p.updated_at,
                  (SELECT COUNT(*) FROM proposal_user_stories s WHERE s.proposal_id = p.id) AS acceptance_count
           FROM proposals p
           WHERE p.status = 'draft'
           ORDER BY p.created_at DESC`,
        )
        for (const row of r.rows) {
          const r0 = row as unknown as Record<string, unknown>
          const src = r0.source
          const source: DraftFeature['source'] =
            src === 'reflection' || src === 'planner' || src === 'human' ? src : 'human'
          drafts.push({
            id: r0.id as string,
            title: (r0.title as string | null) ?? '',
            problem: (r0.problem as string | null) ?? '',
            solution: (r0.solution as string | null) ?? '',
            status: (r0.status as string | null) ?? 'draft',
            source,
            createdAt: Number(r0.created_at ?? 0),
            updatedAt: Number(r0.updated_at ?? 0),
            acceptanceCount: Number(r0.acceptance_count ?? 0),
          })
        }
      }

      const staleWorktrees: StaleWorktreeAlert[] = []
      try {
        const r = await client.execute(
          `SELECT context, payload, last_seen_at, raised_at
             FROM inbox_items
            WHERE kind = 'stale-worktree' AND state = 'open'
            ORDER BY raised_at DESC`,
        )
        for (const row of r.rows) {
          const r0 = row as unknown as Record<string, unknown>
          let ctx: Record<string, unknown> = {}
          let pld: Record<string, unknown> = {}
          try {
            const p = JSON.parse(r0.context as string)
            if (p && typeof p === 'object') ctx = p as Record<string, unknown>
          } catch { /* ignore */ }
          try {
            const p = JSON.parse(r0.payload as string)
            if (p && typeof p === 'object') pld = p as Record<string, unknown>
          } catch { /* ignore */ }
          const taskId = typeof ctx.taskId === 'string' ? ctx.taskId : null
          if (!taskId) continue
          staleWorktrees.push({
            taskId,
            status: typeof pld.status === 'string' ? pld.status : 'unknown',
            ageHours: typeof pld.ageHours === 'number' ? pld.ageHours : 0,
            updatedAt:
              typeof r0.last_seen_at === 'string'
                ? r0.last_seen_at
                : typeof r0.raised_at === 'string'
                  ? r0.raised_at
                  : new Date().toISOString(),
            prompt: typeof pld.prompt === 'string' ? pld.prompt : '',
            error: typeof pld.error === 'string' ? pld.error : null,
            branch: typeof pld.branch === 'string' ? pld.branch : null,
            blockerTaskId: null,
          })
        }
      } catch { /* inbox_items table may not exist on a fresh repo */ }

      return { drafts, staleWorktrees }
    },
    viewTerminalEvents: () =>
      listTerminalEvents(getDefaultDomainTaskStore()).then((events) => ({
        events,
      })),
  })
  writeFileSync(httpPortFile, String(httpHandle.port), 'utf8')
  log(`HTTP action endpoint on http://127.0.0.1:${httpHandle.port} (port → ${httpPortFile})`)

  // Boot reconcile after server is listening (so any reconcile-driven dispatch
  // is fully wired) — fire-and-forget; errors logged inside.
  void reconcile().catch((err) => log(`[reconcile] failed: ${(err as Error).message}`))

  // Boot drain for the alert-dismisser outbox subscriber: register it (no
  // replay — chokepoint already reconciles history) and clear alerts for any
  // status changes published while the daemon was down.
  void (async () => {
    try {
      await ensureAlertDismisser(getClient())
      const { processed } = await drainAlertDismissals(getClient(), log)
      if (processed > 0)
        log(`[alert-dismisser] cleared alerts for ${processed} status change(s) on boot`)
    } catch (err) {
      log(`[alert-dismisser] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // Boot drain for the inbox-repopulator outbox subscriber: register it and
  // apply any inbox mutations for events published while the daemon was down.
  void (async () => {
    try {
      await ensureInboxRepopulator(getClient())
      const { processed } = await drainInboxRepopulations(
        getClient(),
        failureReasonCatalog,
        log,
      )
      if (processed > 0) {
        log(`[inbox-repopulator] applied ${processed} inbox mutation(s) on boot`)
        viewStreamHub.broadcast('inbox')
      }
    } catch (err) {
      log(`[inbox-repopulator] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // ── Poll-fallback tick ────────────────────────────────────────────────────
  // drain() is otherwise purely event-driven (bus 'task.added'/'task.queued'
  // and dispatcher finally-blocks). If a drain pass throws and exits, or a
  // bus emit is missed, nothing re-arms it and the daemon sits idle with a
  // full queue while staying alive — the failure mode this fixes. This timer
  // is a safety net: only when the daemon is accepting work, not draining,
  // and has nothing in flight (i.e. genuinely wedged, not just busy) does it
  // re-seed the pending sets from the DB and kick drain(). During healthy
  // operation it is a no-op. .unref() so it never keeps the process alive.
  const POLL_FALLBACK_MS = Number(process.env.MARS_DRAIN_POLL_MS ?? 30_000)
  const pollFallback = setInterval(() => {
    if (!acceptingWork || drainRunning || inFlight.size > 0) return
    void (async () => {
      try {
        const [drafts, queued] = await Promise.all([
          listTasks('draft'),
          listTasks('queued'),
        ])
        const seedable = drafts.length + queued.length
        if (seedable === 0) return
        for (const t of drafts) {
          if (!inFlight.has(t.id)) pendingTriage.add(t.id)
        }
        for (const t of queued) {
          if (!inFlight.has(t.id)) pendingImplement.add(t.id)
        }
        log(
          `[dispatch] poll-fallback re-seeding ${seedable} task(s) (idle with non-empty queue)`,
        )
        await drain()
      } catch (err) {
        log(`[dispatch] poll-fallback errored: ${(err as Error).message}`)
      }
    })()
  }, POLL_FALLBACK_MS)
  pollFallback.unref()

  // ── Stale-worktree sweep ──────────────────────────────────────────────────
  // Periodically raises `stale-worktree` inbox items for tasks whose worktree
  // has not been updated within MARS_STALE_WORKTREE_HOURS (default 24h). The
  // inbox dedup logic ensures re-detecting the same stale worktree bumps the
  // existing open item rather than creating a sibling. Auto-close is handled
  // by dismissAlertsOnStatusChange (wired in queue.ts updateTask). .unref()
  // so the interval never prevents a clean shutdown.
  const STALE_SWEEP_MS = Number(process.env.MARS_STALE_SWEEP_MS ?? 5 * 60_000)
  const { detectAndRaiseStaleWorktrees } = await import('./stale-worktree-sweep')
  const staleSweep = setInterval(() => {
    void (async () => {
      try {
        const raised = await detectAndRaiseStaleWorktrees(resolveContext().repoRoot)
        if (raised.length > 0) {
          log(`[stale-sweep] raised/bumped ${raised.length} stale-worktree inbox item(s)`)
          viewStreamHub.broadcast('todo')
          viewStreamHub.broadcast('inbox')
        }
      } catch (err) {
        log(`[stale-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, STALE_SWEEP_MS)
  staleSweep.unref()

  // ── Alert-dismisser drain ─────────────────────────────────────────────────
  // Polls the outbox for status-transition events and clears the implicated
  // task's action-queue alert(s). This keeps the "status change clears
  // alerts" invariant whole for raw-SQL status writes that bypass the
  // updateTask chokepoint. .unref() so it never holds the process open.
  const ALERT_DRAIN_MS = Number(process.env.MARS_ALERT_DRAIN_MS ?? 30_000)
  const alertDrain = setInterval(() => {
    void (async () => {
      try {
        await drainAlertDismissals(getClient(), log)
      } catch (err) {
        log(`[alert-dismisser] drain errored: ${(err as Error).message}`)
      }
    })()
  }, ALERT_DRAIN_MS)
  alertDrain.unref()

  // ── Inbox-repopulator drain ───────────────────────────────────────────────
  // Polls the outbox for task/proposal lifecycle events and applies the
  // corresponding inbox_items mutations. .unref() so it never holds the
  // process open.
  const INBOX_REPOPULATOR_DRAIN_MS = Number(
    process.env.MARS_INBOX_REPOPULATOR_DRAIN_MS ?? 30_000,
  )
  const inboxRepopulatorDrain = setInterval(() => {
    void (async () => {
      try {
        const { processed } = await drainInboxRepopulations(getClient(), failureReasonCatalog, log)
        if (processed > 0) viewStreamHub.broadcast('inbox')
      } catch (err) {
        log(`[inbox-repopulator] drain errored: ${(err as Error).message}`)
      }
    })()
  }, INBOX_REPOPULATOR_DRAIN_MS)
  inboxRepopulatorDrain.unref()

  // ── Shutdown ──────────────────────────────────────────────────────────────

  const shutdown = async (force = false): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(pollFallback)
    clearInterval(staleSweep)
    clearInterval(alertDrain)
    clearInterval(inboxRepopulatorDrain)
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

    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      httpHandle.close(),
    ])
    // Close the trace-event store handle so libsql releases its connection.
    // process.exit below would also do this, but be explicit so the handle
    // never lingers if exit is delayed.
    await traceStore.close()
    for (const f of [socketPath, pidFile, httpPortFile]) {
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
