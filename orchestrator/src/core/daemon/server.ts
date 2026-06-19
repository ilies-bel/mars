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
import { readFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContext } from '../context'
import {
  addBlockers,
  dropTask,
  enqueueTask,
  getTask,
  hasIncompleteBlockers,
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
import { reconcileTerminalTasks } from './lifecycle-reconcile'
import {
  drainActionQueueRepopulations,
  ensureActionQueueRepopulator,
} from './action-queue-repopulator'
import {
  drainBlockerResolution,
  ensureBlockerResolutionSubscriber,
} from '../../outbox/subscribers/blocker-resolution'
import type { Logger, WorkflowEvent } from '@mars/workflow'
import { scanRecoveryBlockerEdges } from '../lib/blocker-invariant'
import { exec, resolveGitBin } from '../lib/git/internal'
import { classifyInstallRoute } from './install-route'
import { isStaleDev } from './dev-staleness'
import { initSettings } from '../lib/settings'
import {
  getDefaultTaskStore,
  getDefaultDomainTaskStore,
  getCompositionRootClient,
  runCompositionRootMigrations,
} from '../store/task-store'
import { promoteProposal } from '../proposals'
import {
  CANCELLED_FAILURE_REASON,
  type RecoverAllBlockedTasksResult,
} from '../blocker-resolution'
import { Arc } from '../arc'
import {
  supersedeObsoletePreflightDirtyMainRows,
  supersedeOrphanedHitlActionQueueRows,
} from '../lib/action-queue'
import {
  raiseAggregatedMainCommiterFailureRow,
  releaseMainCommitterDependents,
  sweepStaleFailedMainCommiterActionQueue,
} from './main-dirty-action-queue'
import { DAEMON_KILLED_SIGNATURE } from '../lib/retry-budget'
import { computeFailureSignature } from '../lib/failure-signature'
import { openTraceEventStore, sweepOrphanRunningSpans, type TraceEventStore, type TraceEventPhase } from '../lib/trace-events-store'
import { setBusLogSink } from '../../bus/log'
import { daemonPaths, isProcessAlive, readDaemonPid, tryConnectSocket } from './paths'
import { loadDaemonConfig } from './config'
import { probeDuckDBLock } from './duckdb-lock'
import {
  assertProposalsSourceFresh,
  captureProposalsStamp,
} from './stale-detection'
import {
  readLines,
  writeLine,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStatusPayload,
} from './protocol'
import { ViewStreamHub } from './view/stream-hub'
import {
  createTaskFlightTracker,
  type DispatchKind,
} from './task-flight-tracker'
import { rpcRegistry, dispatchRpc } from './rpc/registry'
import type { DaemonDeps } from './rpc/types'
import { createAppServices } from '../app-services'

const LOG_ROTATE_BYTES = 10 * 1024 * 1024

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
  traceStore: TraceEventStore | null,
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
  // Tee each structured log call to the trace store as a log_line event.
  // Preserves real bindings/fields in payload.fields rather than pre-flattening
  // them. Fire-and-forget with a swallowed catch so a trace-store hiccup NEVER
  // throws into engine logging. Called from info/warn/error (3 callers).
  const teeTrace = (
    level: 'info' | 'warn' | 'error',
    arg1: Record<string, unknown> | string,
    arg2?: string,
  ): void => {
    if (traceStore === null) return
    const callFields = typeof arg1 === 'string' ? {} : arg1
    const msg = (typeof arg1 === 'string' ? arg1 : arg2) ?? ''
    void traceStore.record({
      kind: 'log_line',
      taskId: (bindings.taskId as string | undefined) ?? null,
      originId: (bindings.originId as string | undefined) ?? null,
      phase: (bindings.phase as TraceEventPhase | undefined) ?? null,
      payload: { level, msg, source: 'workflow', fields: { ...bindings, ...callFields } },
    }).catch(() => {})
  }
  return {
    info: (arg1: Record<string, unknown> | string, arg2?: string) => {
      log(fmt('info', arg1, arg2))
      teeTrace('info', arg1, arg2)
    },
    warn: (arg1: Record<string, unknown> | string, arg2?: string) => {
      log(fmt('warn', arg1, arg2))
      teeTrace('warn', arg1, arg2)
    },
    error: (arg1: Record<string, unknown> | string, arg2?: string) => {
      log(fmt('error', arg1, arg2))
      teeTrace('error', arg1, arg2)
    },
    child: (extra: Record<string, unknown>) =>
      makeWorkflowLogger(log, traceStore, { ...bindings, ...extra }),
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
  // Mutable ref captured by log() below so daemon lines can be teed to the
  // trace store once it's open (assigned after openTraceEventStore resolves).
  // Lines emitted before the store is open are silently dropped — those are
  // early-startup messages that cannot be captured because the store itself
  // hasn't been opened yet. NEVER call log() inside a catch here; that would
  // recurse back into log() and re-enter the record call.
  let _traceStore: TraceEventStore | null = null
  const log = (line: string): void => {
    writeLog(logFile, line)
    opts.log?.(line)
    if (_traceStore !== null) {
      const level = /^\[?error/i.test(line) ? 'error' : /^\[?warn/i.test(line) ? 'warn' : 'info'
      void _traceStore.record({
        kind: 'log_line',
        taskId: null,
        originId: null,
        phase: null,
        payload: { level, msg: line, source: 'daemon' },
      }).catch(() => {})
    }
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
  // Wire the trace store into the log() closure so every daemon line from
  // this point forward is also recorded as a log_line trace event (tee).
  _traceStore = traceStore

  // Tee bus-level log output into the trace-event store so bus log lines are
  // visible alongside workflow and daemon events. Fire-and-forget: a
  // trace-store hiccup must never propagate into bus logging. The catch
  // handler is intentionally empty (no log call inside to prevent recursion).
  setBusLogSink(({ level, msg, fields }) => {
    traceStore
      .record({
        kind: 'log_line',
        payload: {
          level,
          msg,
          source: 'bus',
          ...(fields !== undefined && { fields }),
        },
      })
      .catch(() => {})
  })

  // Resolve git binary once at startup. If git is not on PATH the daemon
  // exits immediately with a clear message instead of letting the first
  // git call fail mid-task as a retry-budget-exhausted ENOENT.
  try {
    resolveGitBin()
  } catch {
    log('git binary not found on PATH; refusing to start')
    process.exit(1)
  }

  // Auto-register this repo in the global project registry so a fresh
  // single-repo setup is never stranded with an empty ~/.mars/projects.json.
  // Idempotent: no-op when the repo is already registered.
  try {
    const { ensureProjectRegistered } = await import('../../registry/projects.js')
    ensureProjectRegistered({ repoRoot: resolveContext().repoRoot })
  } catch (err) {
    log(`[registry] warning: failed to auto-register project: ${(err as Error).message}`)
  }

  // One-shot cleanup of pre-@mars/workflow `.mars/mastra.db*` files.
  // Idempotent: silent if nothing exists, single info line if anything
  // was removed. Runs every startup; deleting absent files is cheap.
  try {
    removeLegacyMastraDb(resolveContext().stateDir, log)
  } catch (err) {
    log(`[cleanup] legacy mastra.db sweep failed: ${(err as Error).message}`)
  }

  // Self-heal: fold any residual legacy queue.db / state.db (the historical
  // two-DB layout, ADR-0034) into mars.db. Must run BEFORE any client opens
  // mars.db to preserve the ordering guarantee in databases.ts. Idempotent
  // and a no-op once both legacy files are gone. Failure is logged but never
  // prevents the daemon from starting.
  try {
    const { mergeLegacyDatabases } = await import('../../init/merge-databases.js')
    await mergeLegacyDatabases()
  } catch (err) {
    log(`[cleanup] legacy database merge failed: ${(err as Error).message}`)
  }

  await runCompositionRootMigrations()
  await initSettings()

  // Load the persisted Worker registry. When the file is absent, the existing
  // hard-coded WORKER_CONFIGS continue to serve as defaults. Dispatch
  // behaviour is unchanged in this cut — this call establishes the registry
  // load path at startup so later cuts can wire it into the dispatch surface.
  try {
    const { loadWorkerRegistry } = await import('../workers/persisted-registry')
    const registered = loadWorkerRegistry(resolveContext().stateDir)
    if (registered.length > 0) {
      log(
        `[worker-registry] ${registered.length} worker declaration(s) loaded from registry`,
      )
    }
  } catch (err) {
    log(
      `[worker-registry] failed to load registry: ${(err as Error).message}`,
    )
  }

  // Slice K one-shot cleanup: supersede any open actionQueue rows that still
  // describe the retired `setup:preflight/dirty-main` failure mode. The
  // codepath no longer exists, so these rows can never reach a true
  // resolution from the operator side. Idempotent: silent when no rows
  // match; one info line when at least one row was closed.
  try {
    const closed = await supersedeObsoletePreflightDirtyMainRows()
    if (closed.length > 0) {
      log(
        `[slice K] resolved ${closed.length} obsolete preflight-dirty-main actionQueue rows`,
      )
    }
  } catch (err) {
    log(
      `[slice K] preflight-dirty-main actionQueue cleanup failed: ${(err as Error).message}`,
    )
  }

  // Boot-time orphan sweep: supersede open hitl-slice-needs-operator items
  // that have no backing HITL slice task. The slicer may raise the actionQueue
  // row before persisting the HITL task, or may raise it when no hitl task is
  // ever created; such rows can never close via tryCompleteHitlSlice and would
  // otherwise remain open forever. Idempotent: silent when no orphans found.
  try {
    const swept = await supersedeOrphanedHitlActionQueueRows()
    if (swept.length > 0) {
      log(
        `[hitl-orphan-sweep] resolved ${swept.length} orphaned hitl-slice-needs-operator actionQueue row(s)`,
      )
    }
  } catch (err) {
    log(
      `[hitl-orphan-sweep] orphan sweep failed: ${(err as Error).message}`,
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

  // The TaskFlightTracker owns the four dispatch-bookkeeping collections
  // (inFlight + the two pending sets + the two claimed sets) and the
  // dispatch-storm-prevention invariant over them. The per-kind semaphores,
  // the `drain` single-flight loop, the dispatcher closures, and the bus glue
  // all stay here in startDaemon (ADR-0024). The lifecycle the tracker forces
  // is: claim (drain-driven kinds) → await acquire → commitInFlight → run →
  // release(), where release() is the closure commitInFlight returns.
  const tracker = createTaskFlightTracker()
  const startedAt = new Date().toISOString()

  // Dev-install source staleness detection. Capture the git HEAD SHA once at
  // startup so a periodic tick can detect when main has advanced while the
  // daemon keeps running the old in-memory code. Gate on dev install only;
  // prod binaries are handled by self-update.ts. On any git error, leave
  // sourceSha null so we never surface a spurious warning.
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  let sourceSha: string | null = null
  if (classifyInstallRoute() === 'dev') {
    try {
      const { stdout } = await exec(resolveGitBin(), ['rev-parse', 'HEAD'], { cwd: sourceDir })
      sourceSha = stdout.trim() || null
    } catch {
      // git unavailable or not a git repo — leave null, never warn
    }
  }
  let currentSha: string | null = sourceSha
  let isStale = false

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

  // Drain single-flight gate. While `drainRunning` is true, a second call
  // sets `drainAgain` and returns; the running drain re-runs once it finishes.
  // This + the claimed sets together guarantee no task id is ever dispatched
  // more than once concurrently.
  let drainRunning = false
  let drainAgain = false

  // Tracks the last time any RPC request was received. Used by the idle-timeout
  // timer to determine when the daemon has been genuinely inactive.
  let lastActivityAt = Date.now()

  // Per-task AbortControllers for in-flight implement runs. Keyed by task.id.
  // Created in dispatchImplement before runWorkflow; deleted in its finally.
  // handleCancel reads this map to abort the workflow run's AbortSignal.
  const runAbortControllers = new Map<string, AbortController>()

  // Forward-declared so dispatchers can call it from finally; assigned after
  // both dispatchers exist.
  let drain: () => Promise<void> = async () => {}

  const dispatchTriage = async (taskId: string): Promise<void> => {
    if (tracker.isInFlight(taskId)) return
    tracker.removePending(taskId, 'triage')
    await acquire(sems.triage)
    // commitInFlight records the inFlight entry AND clears the matching claim
    // in one step (claim-clears-after-commit), and is the sole producer of the
    // release closure — so the storm-prevention lifecycle can't be reordered.
    const releaseTracking = tracker.commitInFlight(taskId, 'triage')
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
            // (onBlockerTaskCompleted, driven by the outbox subscriber) only
            // re-evaluates tasks WHERE status='blocked', so a dependent left
            // 'queued' here is invisible to it and would strand. Flipping to
            // 'blocked' wires it into the normal blocked→queued flow.
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
        const triageSignature = computeFailureSignature('triage:crashed', message)
        await updateTask(taskId, {
          status: 'failed',
          error: message,
          failureReason: message,
          failureSignature: triageSignature,
          failureReasonCode: triageSignature,
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
    if (tracker.isInFlight(task.id)) return
    tracker.removePending(task.id, 'implement')
    await acquire(sems.implement)
    // commitInFlight records the inFlight entry AND clears the matching claim
    // in one step (claim-clears-after-commit); see dispatchTriage.
    const releaseTracking = tracker.commitInFlight(task.id, 'implement')
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
      const { createQueueWorkflowStore, loadWorkflowForKind } = await import(
        '../../workflows/queue-workflow-store'
      )
      // The implement pipeline now runs on the in-house @mars/workflow engine
      // rather than Mastra. Two seams are wired here:
      //   - `store`    — the engine's run/step checkpoint persistence, backed
      //                  by `.mars/mars.db` (createQueueWorkflowStore).
      //   - `services` — the orchestrator's TaskStore from the composition
      //                  root, read inside the workflow as `ctx.services.store`
      //                  (replaces the Mastra RequestContext('taskStore')).
      // `runId: task.id` is what makes `mars continue` resume: re-dispatching
      // the same task id re-enters runWorkflow with that runId, and every step
      // whose record is already `'completed'` short-circuits. Resume is now
      // entirely engine-driven — there is no `resumeFrom` hint in the input.
      const taskStore = await getDefaultTaskStore()
      const workflowStore = createQueueWorkflowStore()
      // ADR-0056: resolve the workflow to run by kind. A user-owned
      // `.mars/workflows/<kind>-workflow.js` (scaffolded by `mars init`) wins
      // over the bundled `implementWorkflow`; absent/malformed → fall back to
      // the bundled one. This changes WHICH workflow runs — not the engine and
      // not the write funnel: `services.store` is still the Arc-routed
      // TaskStore (S4), so task-state writes keep going through the aggregate.
      const dispatchKind = task.kind ?? 'task'
      const workflowToRun = await loadWorkflowForKind(
        dispatchKind,
        implementWorkflow,
      )
      // Pino-shaped logger adapter over the daemon's `log`. The engine emits
      // structured run/step lifecycle lines (`step.started`, `step.completed`,
      // `run.failed`, …); fold them into one greppable daemon log line each.
      // traceStore is passed so each engine call is also teed as a log_line
      // trace event with structured payload.fields (not pre-flattened).
      const workflowLogger = makeWorkflowLogger(log, traceStore)
      // Forward fine-grained progress events. The high-volume per-tool-call
      // streams (`claude-event`, `vcs-supervisor-event`) used to flow through
      // Mastra's workflow writer purely for live UI tailing and were not
      // persisted here; we drop them to keep the daemon log readable and let
      // the per-step transcript (keyed by claudeSessionId) carry the detail.
      const onEvent = (evt: WorkflowEvent): void => {
        if (evt.event === 'claude-event' || evt.event === 'vcs-supervisor-event') return
        log(`[implement] ${task.id} ${evt.step ?? 'run'}:${evt.event}`)
      }
      // Detect a code-phase resume: the task was continued (not restarted)
      // after a code-phase failure, so its worktree is preserved on disk.
      // The workflow injects a resume banner into the coder prompt so the
      // agent reads prior progress before continuing. failedPhase stays on
      // the row across the re-queue (coreContinueTask does not clear it),
      // which is how we distinguish a resume from a first-time dispatch.
      const resumeFromCodePhase = task.failedPhase === 'code' && !!task.worktreePath
      // Register an AbortController for this run so handleCancel can abort it.
      const runController = new AbortController()
      runAbortControllers.set(task.id, runController)
      const result = await runWorkflow(
        workflowToRun,
        {
          taskId: task.id,
          prompt: task.prompt,
          plan: task.plan,
          tags: task.tags ?? ['coder'],
          kind: dispatchKind,
          integrationBranch,
          spec: task.spec
            ? {
                files: [...task.spec.files],
                verifyCmd: task.spec.verifyCmd,
                previewCmd: task.spec.previewCmd ?? null,
                doneCriteria: [...task.spec.doneCriteria],
                taskType: task.spec.taskType,
                readFirst: [...(task.spec.readFirst ?? [])],
                prescriptiveAction: task.spec.prescriptiveAction ?? null,
              }
            : null,
          resumeFromCodePhase,
          recoveryPayload: task.recoveryPayload ?? null,
          fixForTaskId: task.fixForTaskId ?? null,
        },
        {
          store: workflowStore,
          services: { store: taskStore, traceStore },
          runId: task.id,
          logger: workflowLogger,
          onEvent,
          signal: runController.signal,
        },
      )
      runAbortControllers.delete(task.id)
      const {
        isBlockersAbortError,
        isMainDirtyVerifyError,
        isMainDirtyMergeError,
        isContextExhaustedAbortError,
        isOriginWorktreeMissingAbortError,
        isPreviewGateError,
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
      // Merge-time dirty-main detection. The merge step parked the source
      // `blocked` behind a `main-commiter` recovery and threw a sentinel.
      // Suppress the misleading `task.completed status=failed` emit. The task
      // re-enters the merge step (not from scratch) once the committer unblocks it.
      if (result.status === 'failed' && isMainDirtyMergeError(resultError)) {
        log(`[implement] ${task.id} parked blocked: integration branch dirty at merge; main-commiter spawned/attached`)
        return
      }
      // A context-budget exhaustion abort marks the task `failed` with cause
      // 'context-exhausted' and enqueues one follow-up task.
      if (result.status === 'failed' && isContextExhaustedAbortError(resultError)) {
        log(`[implement] ${task.id} failed: context-budget ceiling abort; follow-up enqueued`)
        bus.emit('task.completed', { taskId: task.id, status: result.status })
        return
      }
      // A recovery (kind=fix) task whose origin worktree is gone: the setup
      // step already marked it failed and raised an operator action-queue item.
      // Suppress both the re-update and the `task.completed` emit — emitting
      // would trip recovery-spawn into raising a SECOND escalation for the same
      // dead-end. The operator resolves via the raised item.
      if (result.status === 'failed' && isOriginWorktreeMissingAbortError(resultError)) {
        log(`[implement] ${task.id} failed: origin worktree missing; recovery cannot attach (action-queue item raised)`)
        return
      }
      // Preview gate: the merge step started a live dev server, parked the task
      // in 'awaiting-validation', and raised the action-queue row, then threw
      // this sentinel so the merge step stays resumable. The task is
      // intentionally parked, NOT failed — suppress the failure write and the
      // `task.completed` emit. The operator's Validate click re-queues it and
      // the engine re-enters merge past the gate.
      if (result.status === 'failed' && isPreviewGateError(resultError)) {
        log(`[implement] ${task.id} parked awaiting-validation: preview server up, waiting for operator Validate/Reject`)
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
      let isContextExhaustedAbort = false
      let isOriginWorktreeMissingAbort = false
      try {
        const {
          isBlockersAbortError,
          isContextExhaustedAbortError,
          isOriginWorktreeMissingAbortError,
        } = await import('../../workflows/implement-workflow')
        isBlockersAbort = isBlockersAbortError(err)
        isContextExhaustedAbort = isContextExhaustedAbortError(err)
        isOriginWorktreeMissingAbort = isOriginWorktreeMissingAbortError(err)
      } catch (importErr) {
        log(
          `[implement] ${task.id} could not load blockers-abort detector (${
            importErr instanceof Error ? importErr.message : String(importErr)
          }); treating as ordinary failure`,
        )
      }
      if (isBlockersAbort) {
        log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
      } else if (isContextExhaustedAbort) {
        // The workflow already marked this task failed with cause 'context-exhausted'
        // before throwing the sentinel. Suppress the re-update.
        log(`[implement] ${task.id} context-budget ceiling abort (exception path); task already marked failed`)
      } else if (isOriginWorktreeMissingAbort) {
        // The setup step already marked this fix task failed and raised an
        // operator action-queue item. Suppress the re-update and the emit.
        log(`[implement] ${task.id} origin-worktree-missing abort (exception path); task already marked failed, item raised`)
      } else {
        log(`[implement] ${task.id} failed: ${message}`)
        try {
          const implementSignature = computeFailureSignature('implement:crashed', message)
          await updateTask(task.id, {
            status: 'failed',
            error: message,
            failureReason: message,
            failureSignature: implementSignature,
            failureReasonCode: implementSignature,
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
      // the try (the blockers-abort / dirty-main branches), so the
      // semaphore slot and inFlight entry are released on every exit path and
      // drain() re-arms the loop. drain() has its own internal catch, so the
      // fire-and-forget `void` here can never leak a rejection.
      runAbortControllers.delete(task.id)
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
    const releaseTracking = tracker.commitInFlight(synthetic, 'glossary-write')
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
    const releaseTracking = tracker.commitInFlight(synthetic, 'adr-add')
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
    if (tracker.isInFlight(taskId)) return
    await acquire(sems.refine)
    const releaseTracking = tracker.commitInFlight(taskId, 'refine')
    log(`[refine] ${taskId} dispatching (refresh=${refresh})`)
    try {
      const { runPlan } = await import('../../workflows/plan-workflow')
      // Wire the TaskStore from the composition root into the workflow so
      // the generate step routes its queue reads through the store
      // rather than calling getCompositionRootClient() directly (ADR-0021 seam, slice 2).
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
  const pickNextImplement = async (): Promise<string | null> => {
    let best: { id: string; priority: number; createdAt: string } | null = null
    for (const id of tracker.drainPending('implement')) {
      // Skip ids already claimed by an in-flight (or about-to-be-in-flight)
      // dispatch — without this the same id can be picked by parallel
      // drains during the gap between pop-from-pending and acquire-slot.
      if (tracker.isClaimed(id, 'implement') || tracker.isInFlight(id)) continue
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
          // pass can't pick it again. tracker.claim returns false when the id
          // is already claimed/in-flight, folding the old has-checks in.
          while (sems.triage.inUse < sems.triage.limit) {
            let pickedTriage: string | null = null
            for (const id of tracker.drainPending('triage')) {
              if (!tracker.claim(id, 'triage')) continue
              pickedTriage = id
              break
            }
            if (pickedTriage === null) break
            tracker.removePending(pickedTriage, 'triage')
            void dispatchTriage(pickedTriage)
          }
          // Implement: same guarantee but priority-ordered.
          while (sems.implement.inUse < sems.implement.limit) {
            const id = await pickNextImplement()
            if (id === null) break
            // Mark claimed BEFORE any further await so concurrent drains
            // (which we've gated, but belt-and-suspenders) can't double-pick.
            tracker.claim(id, 'implement')
            tracker.removePending(id, 'implement')
            const t = await getTask(id)
            if (!t || t.status !== 'queued') {
              tracker.unclaim(id, 'implement')
              continue
            }
            if (await hasIncompleteBlockers(id)) {
              // Distinguish terminal (failed) blockers so operators know when
              // manual intervention is required vs. waiting for in-progress work.
              const { rows: failedBlockerRows } = await getCompositionRootClient().execute({
                sql: `SELECT b.blocker_task_id
                        FROM task_blockers b
                        JOIN tasks t ON t.id = b.blocker_task_id
                       WHERE b.task_id = ? AND t.status = 'failed'
                         AND b.state IN ('confirmed', 'pending-review')
                       LIMIT 1`,
                args: [id],
              })
              if (failedBlockerRows.length > 0) {
                const failedId = (failedBlockerRows[0] as unknown as { blocker_task_id: string }).blocker_task_id
                log(`[dispatch] ${id} blocked; blocker ${failedId} is failed and will never complete — needs operator`)
              } else {
                log(`[dispatch] ${id} blocked; deferring until blockers complete`)
              }
              tracker.unclaim(id, 'implement')
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
    if (tracker.isInFlight(e.taskId)) return
    tracker.enqueuePending(e.taskId, 'triage')
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
    if (tracker.isInFlight(e.taskId)) return
    tracker.enqueuePending(e.taskId, 'implement')
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

  // Proposal lifecycle events update the Progress-tab DAG in place.
  bus.on('proposal.added',     () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.updated',   () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.dismissed', () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.promoted',  () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.sliced',    () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.deleted',   () => { viewStreamHub.broadcast('progress') })

  // Post-task-completion KPI-drift trigger. Runs fire-and-forget so a trigger
  // failure never affects the task-completion path. Only active when
  // selfEvolve.autoTrigger=true (default: false). Never queues tasks.
  bus.on('task.completed', () => {
    void (async () => {
      try {
        const { runSelfEvolveTrigger } = await import('../lib/self-evolve-trigger')
        const result = await runSelfEvolveTrigger()
        if (result.raised.length > 0) {
          log(
            `[self-evolve] raised ${result.raised.length} KPI-drift proposal(s): ${result.raised.join(', ')}`,
          )
        }
      } catch (err) {
        log(
          `[self-evolve] trigger error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })()
  })

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
    intent?: string,
  ): Promise<Task> => {
    const opts: Parameters<typeof enqueueTask>[2] = {}
    if (skipTriage) opts.skipTriage = true
    if (author) opts.author = author
    if (priority !== undefined) opts.priority = priority
    if (tags !== undefined) opts.tags = tags
    if (spec) opts.spec = spec
    if (intent !== undefined) opts.intent = intent
    // Arc inheritance (ADR-0050): when a task has exactly one blocker it is
    // almost always a continuation of that blocker's work (the canonical coder
    // follow-up pattern: `mars task add "..." --blocked-by $TASK_ID`). Inherit
    // the blocker's resolved origin_id so the new task joins the same arc.
    // Multiple blockers are left as self-arc (the target arc is ambiguous).
    if (blockerIds && blockerIds.length === 1) {
      const blocker = await getTask(blockerIds[0])
      if (blocker) {
        opts.originId = blocker.originId
      }
    }
    const task = await enqueueTask(
      prompt,
      plan ?? undefined,
      Object.keys(opts).length > 0 ? opts : undefined,
    )
    if (blockerIds && blockerIds.length > 0) {
      try {
        await addBlockers(task.id, blockerIds)
      } catch (err) {
        // ADR-0052 (Arc = sole writer): route the error-recovery cleanup
        // through the Arc aggregate's atomic drop (pre-delete task.dropped/
        // task.terminal emit, cascade fix-task delete, dependent re-queue,
        // task_proposal_blockers + questions + task_blockers cleanup) instead
        // of the deleted bare `DELETE FROM tasks`. Best-effort: a not-found
        // throw is swallowed, mirroring the prior `.catch(() => {})`.
        try {
          await Arc.load(task.id).drop()
        } catch {}
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
    // Re-evaluate status: if the task is still in a pre-dispatch state and now
    // has at least one unmet blocker, flip it to 'blocked' so the dispatcher
    // cannot pick it up while a prerequisite is outstanding.  Only pre-dispatch
    // states (queued / draft) are reclassified; an already-running task gaining
    // a post-hoc blocker is a separate concern and is left as-is.
    if (
      (t.status === 'queued' || t.status === 'draft') &&
      (await hasIncompleteBlockers(id))
    ) {
      await updateTask(id, { status: 'blocked' })
    }
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
    // After edge removal, re-evaluate the task: if it was blocked solely on
    // the edges we just removed (all remaining blockers are done / gone),
    // flip it to 'queued' immediately so it dispatches without a restart.
    try {
      const recovery = await Arc.load(id).recoverBlocked()
      if (recovery.outcome === 'queued') {
        log(
          `[blocker-recovery] ${id} queued after blocker edge removal (removed: ${removed.join(', ')})`,
        )
        // Surface the newly queued task to the dispatch loop directly.
        // Previously this happened via the internal-bus wake-hint; now
        // the caller is responsible because the bus no longer delivers
        // payloads to handlers.
        if (acceptingWork && !tracker.isInFlight(id)) {
          tracker.enqueuePending(id, 'implement')
          void drain()
        }
      }
    } catch (err) {
      log(
        `[blocker-recovery] error recovering ${id} after edge removal: ${(err as Error).message}`,
      )
    }
    return { taskId: id, removed }
  }

  const handleRecover = async (id?: string): Promise<RecoverAllBlockedTasksResult> => {
    if (id) {
      const outcome = await Arc.load(id).recoverBlocked()
      if (outcome.outcome === 'queued' && acceptingWork && !tracker.isInFlight(id)) {
        tracker.enqueuePending(id, 'implement')
        void drain()
      }
      return { outcomes: [outcome] }
    }
    const result = await Arc.recoverAllBlocked()
    for (const o of result.outcomes) {
      if (o.outcome === 'queued' && acceptingWork && !tracker.isInFlight(o.taskId)) {
        tracker.enqueuePending(o.taskId, 'implement')
      }
    }
    if (result.outcomes.some(o => o.outcome === 'queued')) void drain()
    return result
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
          const blocked = await Arc.blockByTaskFailure(id)
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
        // single aggregated actionQueue row listing every blocked dependent so
        // the operator can see the cohort at a glance. Overrides the
        // generic recovery-failed row that `action-queue-repopulator` would
        // raise for this task. Idempotent on the committer task id —
        // a repeat failure transition bumps seenCount only.
        if (after.kind === 'fix') {
          try {
            const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } =
              await import('../lib/main-dirty')
            const payload = parseMainCommiterPayload(after.recoveryPayload)
            if (payload && payload.recipe === MAIN_COMMITER_RECIPE) {
              await raiseAggregatedMainCommiterFailureRow(after.id, log)
              // Release dependents blocked on the dead committer so they
              // aren't permanently wedged. Each blocked task's edge to this
              // committer is removed; tasks with no remaining active blockers
              // are flipped back to 'queued' and will re-dispatch once the
              // operator resolves the dirty-main state.
              try {
                await releaseMainCommitterDependents(after.id, log)
              } catch (releaseErr) {
                log(
                  `[main-dirty] error releasing dependents of failed committer ${after.id}: ${(releaseErr as Error).message}`,
                )
              }
            }
          } catch (err) {
            log(
              `[main-dirty] error raising aggregated actionQueue row for failed committer ${id}: ${(err as Error).message}`,
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
        // helper raises one actionQueue item per cascaded dependent so the
        // operator can see why the chain died.
        try {
          const cascade = await Arc.cascadeCancellation(id)
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
        // Slice F.2: when a `main-commiter` succeeds, any open `failed`
        // actionQueue rows raised by PREVIOUS committer attempts (for stale
        // hashes — i.e. a different broken state of main that has since
        // been resolved) are no longer actionable. Sweep them to
        // `resolved/superseded` so the operator's actionQueue doesn't keep
        // stale "main-committer failed" rows for a state that's gone.
        if (after.kind === 'fix') {
          try {
            const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } =
              await import('../lib/main-dirty')
            const payload = parseMainCommiterPayload(after.recoveryPayload)
            if (payload && payload.recipe === MAIN_COMMITER_RECIPE) {
              await sweepStaleFailedMainCommiterActionQueue(
                payload.dirtyMainHash,
                after.id,
                log,
              )
            }
          } catch (err) {
            log(
              `[main-dirty] error sweeping stale committer actionQueue rows after ${id} done: ${(err as Error).message}`,
            )
          }
        }
        // Recovery→origin done propagation. CLAUDE.md contract: "a
        // successful recovery counts as its origin reaching done, so
        // a recovered blocker unblocks the whole chain." When a fix
        // task (kind='fix', non-null fixForTaskId) reaches done, flip
        // the origin row to done, close any actionQueue items keyed on the
        // origin, and propagate the unblock to its dependents.
        if (after.kind === 'fix' && after.fixForTaskId !== null) {
          try {
            const propagation = await Arc.load(
              after.fixForTaskId,
            ).propagateRecoveryDone()
            if (propagation.originFlipped) {
              log(
                `[propagate] recovery ${id} flipped origin ${propagation.originTaskId} to done; closed ${propagation.actionQueueItemsClosed} actionQueue item(s)`,
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
        // attempt OR raise exactly one actionQueue item, and re-park the parent
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
            } else if (outcome.action === 'action-queue-raised') {
              log(
                `[diagnose] chore ${id}: ${outcome.verdictKind} verdict; parent ${outcome.parentTaskId} parked failed, actionQueue item ${outcome.actionQueueItemId} raised`,
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
          const blockerResolved = await Arc.unblockByCompletion(id)
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
          if (!tracker.isInFlight(t.id)) bus.emit('task.queued', { taskId: t.id })
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
    const { createQueueWorkflowStore } = await import('../../workflows/queue-workflow-store')
    await coreRestartTask(id, new Set(['failed', 'done']), createQueueWorkflowStore())
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

  // Statuses where the task is mid-merge: interrupting the merge risks a
  // half-applied fast-forward or an orphaned .merge.lock. Cancel is refused.
  const MERGE_STATUSES = new Set<Task['status']>(['merging', 'vega-reconciling'])

  const handleCancel = async (id: string): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)

    // Refuse terminal tasks.
    if (
      task.status === 'done' ||
      task.status === 'dropped' ||
      task.status === 'cancelled' ||
      task.status === 'failed'
    ) {
      throw new Error(
        `task ${id} is already in terminal status '${task.status}'; cannot cancel`,
      )
    }

    // Refuse mid-merge: the merge step holds a file lock and fast-forwards
    // into main. Interrupting it risks a half-applied merge or orphaned .merge.lock.
    if (MERGE_STATUSES.has(task.status)) {
      throw new Error(
        `task ${id} is merging; refuse to cancel mid-merge — wait for the merge to finish or fail`,
      )
    }

    // Determine if an in-flight slot exists (running subprocess).
    const inFlightEntry = tracker.inFlightSnapshot().find((e) => e.taskId === id)
    const pid = inFlightEntry?.pid

    // Mirror the watchdog: mark status BEFORE reclaiming the slot so there
    // is never a window where the slot is free but the task still reads running.
    // The IllegalTransitionError guard on updateTask prevents the implement
    // dispatcher's catch block from re-writing status='failed' after the SIGKILL,
    // so no task.failed outbox event fires, no recovery is spawned, and no
    // action-queue item is raised.
    await updateTask(id, {
      status: 'cancelled',
      error: 'cancelled by operator (mars cancel)',
    })
    log(`[cancel] ${id} status set to cancelled`)

    // Abort the workflow run's AbortSignal so the @mars/workflow engine can
    // begin tearing down steps gracefully before the SIGKILL lands.
    const controller = runAbortControllers.get(id)
    if (controller) {
      controller.abort()
    }

    // Kill the subprocess: SIGTERM first, then SIGKILL after a grace period.
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGTERM')
        log(`[cancel] ${id} sent SIGTERM to pid ${pid}`)
      } catch {
        // Process may have already exited.
      }
      // Grace window: wait ~2.5 s before SIGKILL.
      await new Promise<void>((resolve) => setTimeout(resolve, 2500))
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
          log(`[cancel] ${id} sent SIGKILL to pid ${pid} (still alive after grace)`)
        } catch {
          // best-effort
        }
      }
    }

    // Free the in-flight slot so drain() can pick up the next queued task.
    if (inFlightEntry) {
      tracker.forceRelease(id)
      release(sems.implement)
      void drain()
    }

    log(`[cancel] ${id} cancelled (pid=${pid ?? 'none'}, slot=${inFlightEntry ? 'freed' : 'none'})`)
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

  const handleArcPurge = async (
    id: string,
    force: boolean,
  ): Promise<{ purgedIds: string[]; originId: string }> => {
    const { coreArcPurge } = await import('./arc-purge')
    const { getRepoRoot } = await import('../context')
    return coreArcPurge(id, force, integrationBranch, getRepoRoot())
    // Action-queue rows for each purged task are closed by the Invalidator,
    // which consumes the task.terminal{purged} events emitted in-tx by
    // Arc.drop() before each row is deleted (ADR-0027/0030).
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
    const liveInFlight = tracker.isInFlight(id)
    if ((liveStatus || liveInFlight) && !force) {
      const kind = tracker.inFlightKind(id)
      const detail = liveInFlight
        ? `dispatched (kind=${kind ?? 'unknown'})`
        : `status=${task.status}`
      throw new Error(
        `task ${id} is in flight (${detail}); pass force=true to drop anyway`,
      )
    }

    // If the task was parked at the preview gate, a detached dev server is
    // still running off its worktree. Reap it before we tear the worktree down
    // so dropping/purging a parked task never orphans the server.
    if (task.devServerPid !== null) {
      const { killDevServer } = await import('../lib/dev-server')
      await killDevServer(task.devServerPid).catch(() => {
        // best-effort — the drop proceeds regardless
      })
    }

    const { existsSync: exists } = await import('node:fs')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { removeWorktree } = await import('../lib/git/worktree')
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
        `cascadedFix=${result.cascadedFixTaskIds.length}, worktree=${worktreeRemoved}, branch=${branchDeleteResult})`,
    )
    if (liveInFlight) {
      // The worker still holds an inFlight slot; force-clearing it here lets
      // drain() reclaim the semaphore even though the workflow run will
      // continue to its natural end (we cannot reach in and kill the
      // claude subprocess from here). The dispatcher's own release closure is
      // identity-checked, so when the run finishes it won't evict a newer
      // entry that may have re-committed under this id. Surfaced in the return
      // payload so the caller knows.
      tracker.forceRelease(id)
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
    if (tracker.isInFlight(id)) {
      throw new Error(`task ${id} already has a ${tracker.inFlightKind(id)} job in flight`)
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
    log(`[init] dispatching (force=${opts.force} dryRun=${opts.dryRun})`)
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
      inFlight: tracker.inFlightSnapshot(),
      counts,
      sourceSha,
      currentSha,
      isStale,
    }
  }

  // ── Reconcile on startup ──────────────────────────────────────────────────

  const reconcile = async (): Promise<void> => {
    const { runStartupReconcile } = await import('./startup-reconcile')
    await runStartupReconcile({ log, bus, traceStore, handleProposalSlice })
  }

  // The 'sync' RPC op: same reconcile as startup, but the summary is returned
  // to the caller rather than discarded.
  const runSync = async (): Promise<unknown> => {
    const { runStartupReconcile } = await import('./startup-reconcile')
    return runStartupReconcile({ log, bus, traceStore, handleProposalSlice })
  }

  // ── Investigate / diagnose-failure handlers (shared by HTTP and RPC) ────────
  // Defined here — before handleRequest — so the RPC switch can call them
  // directly without going through the HTTP layer.

  const investigateWorktree = (() => {
    // One active investigation per worktree id. A second concurrent request for
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
        const { runClaudeCode } = await import('../lib/git/claude')
        const { getTask } = await import('../queue')
        const { patchOpenActionQueuePayload } = await import('../lib/action-queue')

        const repoRoot = getRepoRoot()
        const worktreePath = join(repoRoot, '.mars', 'worktrees', id)
        const localExec = promisify(execFile)

        // Look up the originating task prompt (may not exist for absent tasks).
        // 'id' is the task id, which equals the worktree directory name under
        // .mars/worktrees/ — both the task row and the worktree use the same id.
        const task = await getTask(id)
        const taskPrompt = task?.prompt ?? null

        // FIRE-AND-FORGET HAIKU: runs in the background after the response
        // returns. Per ADR-0054 (level-triggered alerts), the alert stays OPEN
        // while Haiku runs — it clears only when the entity itself mutates (task
        // reaches a terminal state or the worktree is pruned). Errors are
        // swallowed — the investigation is best-effort. inProgress is cleared in
        // the outer finally so a second call can start a new investigation.
        ;(async () => {
          try {
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

            // Persist the explanation onto the OPEN action_queue_items row.
            // Per ADR-0054, the row is still open (the investigation does not
            // dismiss it). patchOpenActionQueuePayload is a no-op when no open
            // row exists (e.g. if the worktree was pruned while Haiku was
            // running), which is the correct behaviour — the alert is gone
            // because the entity was mutated, so there is nothing to annotate.
            await patchOpenActionQueuePayload(id, {
              investigation: { text: explanation, investigatedAt: new Date().toISOString() },
            })
          } catch { /* background errors are suppressed — flip already happened */ }
        })().catch(() => { /* suppress unhandled rejection */ })

        // Return immediately — Haiku continues in the background. The alert
        // stays OPEN in the action queue (ADR-0054: level-triggered); the
        // investigation annotation appears on the live row once Haiku finishes.
        return { explanation: '' }
      } finally {
        inProgress.delete(id)
      }
    }
  })()

  const diagnoseFailure = (() => {
    // One active diagnosis per task id — a second concurrent request returns
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
        const { runClaudeCode } = await import('../lib/git/claude')
        const { getTask } = await import('../queue')
        const { patchOpenActionQueuePayload, supersedeActionQueueItemsForOrigin } = await import('../lib/action-queue')

        const repoRoot = getRepoRoot()
        const worktreePath = join(repoRoot, '.mars', 'worktrees', id)
        const localExec = promisify(execFile)

        const task = await getTask(id)

        if (!task) {
          // Task is gone — resolve any orphaned action-queue card so it
          // doesn't stay stuck, and return a clear not-found diagnosis.
          await supersedeActionQueueItemsForOrigin(id, 'origin-purged', 'diagnose-failure:task-already-gone')
          return { diagnosis: `task ${id} not found; nothing to diagnose` }
        }

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

        await patchOpenActionQueuePayload(id, {
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
  })()

  // ── Network: UDS server ───────────────────────────────────────────────────

  // ── RPC command seam (ADR daemon-command-seam; mirrors ADR-0023) ──────────
  // The 27-case `switch (req.op)` is now a flat op-keyed registry of leaf
  // handlers in `./rpc/`. `handleRequest` keeps its socket-facing signature and
  // delegates to `dispatchRpc`, which applies the drain gate + error mapping and
  // routes to the matched leaf. Per ADR-0024 drain/dispatch/tracker are NOT
  // extracted — they reach each leaf through the injected `deps` below.
  //
  // `deps` is built lazily and memoised: `shutdown` is declared later in this
  // closure, so the object is assembled on first request (by which point every
  // captured fn is initialised) rather than at definition time.
  let rpcDeps: DaemonDeps | undefined
  const buildRpcDeps = (): DaemonDeps => ({
    log,
    bus,
    tracker,
    sems: {
      implement: sems.implement,
      triage: sems.triage,
      refine: sems.refine,
      structuredWrite: structuredWriteSem,
    },
    getAcceptingWork: () => acceptingWork,
    setAcceptingWork: (value: boolean) => {
      acceptingWork = value
    },
    drain: () => drain(),
    shutdown: (force?: boolean) => shutdown(force),
    paths: { socketPath, pidFile, httpPortFile },
    handleAdd,
    setTaskPriority,
    handleUpdate,
    handleContinue,
    handleRestart,
    handleCancel,
    handlePurge,
    handleArcPurge,
    handleDrop,
    handleUnblock,
    handleBlock,
    handleRemoveBlockers,
    handleRecover,
    runSync,
    handleProposalPromote,
    handleProposalSlice,
    handleRefine,
    dispatchGlossaryWrite,
    dispatchAdrAdd,
    handleInit,
    handleStatus,
    investigateWorktree,
    diagnoseFailure,
  })

  const handleRequest = async (req: DaemonRequest): Promise<DaemonResponse> => {
    lastActivityAt = Date.now()
    rpcDeps ??= buildRpcDeps()
    return dispatchRpc(rpcRegistry, req, rpcDeps)
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
  // daemon restart. GET /failure-kinds serves the signature-keyed Failure-kind
  // registry (ADR-0042).
  const { startHttpServer } = await import('./http-server')
  const { coreRestartTask: coreRestart } = await import('./restart-task')
  const { createQueueWorkflowStore: makeWorkflowStore } = await import('../../workflows/queue-workflow-store')
  // Same lifecycle as the Failure-kind registry: built-in seed under
  // `src/core/recipes/built-in/*.md` merged with `.mars/recipes/*.md`
  // overrides, loaded once. No recipe is dispatched in this slice — the
  // catalog is exposed so the actionQueue UI can name which recipe a recovery
  // task ran under (wiring lands in slice F).
  const { loadRecipeCatalog } = await import('../lib/recipes')
  const recipeCatalog = await loadRecipeCatalog(resolveContext().stateDir, {
    onWarn: (msg) => log(msg),
  })

  // Build the pure-read AlertSources for the /alerts endpoints (ADR-0054). The
  // Alert read aggregate derives entirely from arc state: a failed arc is one
  // whose every task is terminal and none reached 'done' (arcStatus ===
  // 'arc-failed'); each arc's failing signal comes from the terminal task that
  // never succeeded. Stale-worktree alerts come from the open stale-worktree
  // action-queue rows. Nothing here writes — every call recomputes from the DB.
  const buildAlertSources = async () => {
    const { listTasks: qListTasks } = await import('../queue')
    const { getDefaultDomainTaskStore } = await import('../store/task-store')
    const { resolveOriginIdForTask } = await import('../lib/origin')
    await runCompositionRootMigrations()
    return {
      listFailedArcs: async () => {
        const tasks = await qListTasks()
        const store = getDefaultDomainTaskStore()
        // Group tasks by their resolved arc (origin_id).
        const byArc = new Map<string, typeof tasks>()
        for (const t of tasks) {
          const arcId = await resolveOriginIdForTask(t.id)
          const bucket = byArc.get(arcId) ?? []
          bucket.push(t)
          byArc.set(arcId, bucket)
        }
        const { getProposal: fetchProposal } = await import('../proposals')
        const truncateLabel = (prompt: string) => {
          const flat = prompt.replace(/\s+/g, ' ').trim()
          return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`
        }
        const records = []
        for (const [arcId, arcTasks] of byArc) {
          const rollup = await store.arcStatus(arcId)
          if (rollup.status !== 'arc-failed') continue
          const origin = arcTasks.find((t) => t.id === arcId) ?? arcTasks[0]!
          // Pick the terminal task carrying the failure signal: prefer a
          // 'failed' task with a structured signature, else any failed/dropped.
          const failing =
            arcTasks.find(
              (t) => t.status === 'failed' && t.failureSignature !== null,
            ) ??
            arcTasks.find((t) => t.status === 'failed') ??
            arcTasks.find((t) => t.status === 'dropped') ??
            origin
          const capturedError = failing.error ?? ''
          const descendants = arcTasks
            .filter((t) => t.id !== arcId)
            .map((t) => ({ id: t.id, status: t.status }))

          // Build the arc chain: optional proposal head → origin attempt (1) →
          // operator-initiated restarts (2, 3, …) → automatic recovery tasks.
          const proposalRow = await store.query({
            sql: `SELECT parent_proposal_id FROM tasks WHERE id = ? LIMIT 1`,
            args: [arcId],
          })
          const parentProposalId: string | null =
            (proposalRow.rows[0] as unknown as { parent_proposal_id: string | null } | undefined)
              ?.parent_proposal_id ?? null
          const proposal = parentProposalId ? await fetchProposal(parentProposalId) : null
          // Operator restarts: non-fix, non-origin tasks (same arc but distinct runs).
          // Recovery tasks: fix tasks (fixForTaskId set or kind === 'fix').
          const restartTasks = arcTasks.filter(
            (t) => t.id !== arcId && t.fixForTaskId === null && t.kind !== 'fix',
          )
          const recoveryTasks = arcTasks.filter(
            (t) => t.id !== arcId && (t.fixForTaskId !== null || t.kind === 'fix'),
          )
          const chain = [
            ...(proposal
              ? [{ kind: 'proposal' as const, id: proposal.id, status: proposal.status, label: proposal.title || proposal.id }]
              : []),
            { kind: 'task' as const, id: arcId, status: origin.status, label: truncateLabel(origin.prompt), attemptIndex: 1 },
            ...restartTasks.map((t, i) => ({
              kind: 'task' as const,
              id: t.id,
              status: t.status,
              label: truncateLabel(t.prompt),
              attemptIndex: i + 2,
            })),
            ...recoveryTasks.map((t) => ({
              kind: 'task' as const,
              id: t.id,
              status: t.status,
              label: truncateLabel(t.prompt),
            })),
          ]

          records.push({
            arcId,
            goal: origin.intent || origin.prompt,
            failureSignature: failing.failureSignature,
            capturedError,
            traceTail: capturedError,
            descendants,
            chain,
          })
        }
        return records
      },
      listStaleWorktrees: async () => {
        const client = getCompositionRootClient()
        const records: {
          taskId: string
          prompt: string
          status: string
          ageHours: number
        }[] = []
        try {
          const r = await client.execute(
            `SELECT context, payload
               FROM action_queue_items
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
            } catch {
              /* ignore */
            }
            try {
              const p = JSON.parse(r0.payload as string)
              if (p && typeof p === 'object') pld = p as Record<string, unknown>
            } catch {
              /* ignore */
            }
            const taskId = typeof ctx.taskId === 'string' ? ctx.taskId : null
            if (!taskId) continue
            records.push({
              taskId,
              prompt: typeof pld.prompt === 'string' ? pld.prompt : '',
              status: typeof pld.status === 'string' ? pld.status : 'unknown',
              ageHours: typeof pld.ageHours === 'number' ? pld.ageHours : 0,
            })
          }
        } catch {
          /* action_queue_items table may not exist on a fresh repo */
        }
        return records
      },
    }
  }

  // The in-process application-service layer (ADR-0055). Every read use-case the
  // HTTP routes serve now lives in `createAppServices`; the daemon constructs it
  // once over its trace store and arc-derived alert sources, and the HTTP server
  // is a thin transport over it. The genuinely daemon-runtime collaborators
  // (the trace store, the alert-sources builder) are INJECTED here — they stay
  // daemon-owned, not absorbed into AppServices. The SSE hub and the
  // update-poller writer are transport/stream concerns and remain on the daemon
  // (the hub is passed to startHttpServer as `viewStreamHub`; the poller writes
  // the cache AppServices.viewFrameworkUpdate only reads).
  const appServices = createAppServices({
    traceStore,
    buildAlertSources,
  })

  const httpHandle = await startHttpServer({
    restartTask: async (id) => {
      await coreRestart(id, new Set(['failed']), makeWorkflowStore())
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
      if (
        task &&
        (task.status === 'running' ||
          task.status === 'verifying' ||
          task.status === 'merging' ||
          // A task parked at the preview gate has a live dev server running off
          // this worktree; pruning it would kill the preview the operator is
          // reviewing. Resolve it via Validate/Reject first.
          task.status === 'awaiting-validation')
      ) {
        throw Object.assign(
          new Error(
            `task ${id} is in flight (status=${task.status}); cannot prune its worktree while live`,
          ),
          { code: 'WRONG_STATUS' as const },
        )
      }
      const { removeWorktree } = await import('../lib/git/worktree')
      const { getRepoRoot } = await import('../context')
      const { join } = await import('node:path')
      const path = join(getRepoRoot(), '.mars', 'worktrees', id)
      // keepBranch=true: leave the branch ref for post-mortem; ignoreMissing
      // so a half-gone worktree still prunes cleanly.
      await removeWorktree({ path, branch: `task/${id}` }, true, true)
    },
    dismissProposal: async (id) => {
      const { rejectProposal } = await import('../proposals')
      await rejectProposal(id)
    },
    validateTask: async (id) => {
      const { coreValidateTask } = await import('./validate-task')
      await coreValidateTask(id)
      // Re-queue emitted so the dispatcher re-enters the workflow and the merge
      // step runs past the gate (previewValidated=true now).
      bus.emit('task.queued', { taskId: id })
    },
    rejectTask: async (id) => {
      const { coreRejectTask } = await import('./validate-task')
      await coreRejectTask(id)
    },
    investigateWorktree,
    diagnoseFailure,
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
          await coreRestart(task.id, new Set(['failed']), makeWorkflowStore())
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
    inFlightCount: () => tracker.inFlightCount(),
    selfUpdate: async () => {
      const { performSelfUpdate, makeSelfUpdateDeps } = await import('./self-update')
      const cacheFile = resolvePath(resolveContext().stateDir, 'update.json')
      const { classifyInstallRoute } = await import('./install-route')
      await performSelfUpdate(
        makeSelfUpdateDeps({
          readUpdateCache: async () => {
            try {
              const raw = await readFile(cacheFile, 'utf8')
              const parsed = JSON.parse(raw) as { latest?: unknown; available?: unknown }
              if (
                typeof parsed.latest === 'string' &&
                typeof parsed.available === 'boolean'
              ) {
                return { latest: parsed.latest, available: parsed.available }
              }
              return null
            } catch {
              return null
            }
          },
          inFlightCount: () => tracker.inFlightCount(),
          installRoute: classifyInstallRoute,
          restartDaemon: async () => {
            const { spawn } = await import('node:child_process')
            const { resolveLaunchCommand } = await import('./paths')
            const { command, baseArgs } = resolveLaunchCommand()
            const child = spawn(command, [...baseArgs, 'daemon', 'start'], {
              detached: true,
              stdio: 'ignore',
            })
            child.unref()
            log('self-update complete; spawned replacement daemon, draining self')
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
          },
        }),
      )
    },
    recipeCatalog,
    traceStore,
    viewStreamHub,
    appServices,
  })
  writeFileSync(httpPortFile, String(httpHandle.port), 'utf8')
  log(`HTTP action endpoint on http://127.0.0.1:${httpHandle.port} (port → ${httpPortFile})`)

  // Boot reconcile after server is listening (so any reconcile-driven dispatch
  // is fully wired) — fire-and-forget; errors logged inside.
  void reconcile().catch((err) => log(`[reconcile] failed: ${(err as Error).message}`))

  // Boot drain for the alert-dismisser outbox subscriber: register it (no
  // replay — chokepoint already reconciles history) and clear alerts for any
  // status changes published while the daemon was down.
  //
  // reconcileTerminalTasks is deliberately NOT part of the RECONCILERS
  // startup registry (see ./reconciler.ts): it is an action-queue concern,
  // takes a libsql Client rather than ReconcileDeps, and must run *here* —
  // after ensureAlertDismisser and before drainAlertDismissals — not in the
  // task-status recovery pass that runs earlier in boot. Folding it into the
  // registry would change when it runs relative to the alert-dismisser drain.
  void (async () => {
    try {
      await ensureAlertDismisser(getCompositionRootClient())
      const { rowsResolved } = await reconcileTerminalTasks(getCompositionRootClient())
      log(`[lifecycle-reconcile] resolved=${rowsResolved}`)
      const { processed } = await drainAlertDismissals(getCompositionRootClient(), log)
      if (processed > 0)
        log(`[alert-dismisser] cleared alerts for ${processed} status change(s) on boot`)
    } catch (err) {
      log(`[alert-dismisser] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // Boot drain for the action-queue-repopulator outbox subscriber: register it and
  // apply any actionQueue mutations for events published while the daemon was down.
  void (async () => {
    try {
      await ensureActionQueueRepopulator(getCompositionRootClient())
      const { processed } = await drainActionQueueRepopulations(
        getCompositionRootClient(),
        log,
      )
      if (processed > 0) {
        log(`[action-queue-repopulator] applied ${processed} actionQueue mutation(s) on boot`)
        viewStreamHub.broadcast('action-queue')
      }
    } catch (err) {
      log(`[action-queue-repopulator] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // Boot drain for the blocker-resolution outbox subscriber: register it and
  // unblock any dependents whose blocker reached done while the daemon was down.
  // This replaces the former boot-time recoverBlockedTasks scan — the subscriber
  // cursor replays any task.terminal events published since the last drain.
  void (async () => {
    try {
      await ensureBlockerResolutionSubscriber(getCompositionRootClient())
      const { processed } = await drainBlockerResolution(getCompositionRootClient(), log)
      if (processed > 0) {
        log(`[blocker-resolution] unblocked ${processed} dependent(s) on boot`)
        // Surface newly queued tasks to the dispatch loop.
        const queued = await listTasks('queued')
        for (const t of queued) {
          if (!tracker.isInFlight(t.id)) bus.emit('task.queued', { taskId: t.id })
        }
      }
    } catch (err) {
      log(`[blocker-resolution] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // ── GitHub release update poller ─────────────────────────────────────────
  // Fetches https://api.github.com/repos/ilies-bel/mars/releases/latest once
  // on startup and then every UPDATE_POLL_INTERVAL_MS (6 h). Writes the result
  // to .mars/update.json; on any failure it leaves the cache untouched and
  // logs at debug level. .unref() so the interval never prevents shutdown.
  const { pollGithubRelease, UPDATE_POLL_INTERVAL_MS } = await import('./github-update-poller')
  const runUpdatePoll = (): void => {
    void (async () => {
      try {
        await pollGithubRelease(resolveContext().stateDir, {
          debug: (msg) => log(msg),
        })
      } catch (err) {
        log(`[github-update-poller] unexpected error: ${(err as Error).message}`)
      }
    })()
  }
  // One-shot on startup (fire-and-forget; errors already swallowed inside).
  runUpdatePoll()
  const githubUpdatePoll = setInterval(runUpdatePoll, UPDATE_POLL_INTERVAL_MS)
  githubUpdatePoll.unref()

  // ── Dev-install staleness check ──────────────────────────────────────────
  // Periodically compares the git HEAD at startup against the current HEAD.
  // When they differ, marks the daemon stale so `mars daemon status` renders
  // a restart warning. Active only for dev installs (prod is handled by
  // self-update.ts). On any git error the check is a no-op — we never flip
  // isStale to false once it is true. .unref() so the interval never
  // prevents a clean shutdown. Override interval via MARS_DEV_STALENESS_CHECK_MS.
  const DEV_STALENESS_CHECK_MS = Number(process.env.MARS_DEV_STALENESS_CHECK_MS ?? 60_000)
  const devStalenessCheck = setInterval(() => {
    void (async () => {
      try {
        const { stdout } = await exec(resolveGitBin(), ['rev-parse', 'HEAD'], { cwd: sourceDir })
        const head = stdout.trim() || null
        if (isStaleDev(sourceSha, head, classifyInstallRoute())) {
          currentSha = head
          isStale = true
        }
      } catch {
        // git unavailable — leave isStale unchanged
      }
    })()
  }, DEV_STALENESS_CHECK_MS)
  devStalenessCheck.unref()

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
    if (!acceptingWork || drainRunning || tracker.inFlightCount() > 0) return
    void (async () => {
      try {
        const [drafts, queued] = await Promise.all([
          listTasks('draft'),
          listTasks('queued'),
        ])
        const seedable = drafts.length + queued.length
        if (seedable === 0) return
        for (const t of drafts) {
          if (!tracker.isInFlight(t.id)) tracker.enqueuePending(t.id, 'triage')
        }
        for (const t of queued) {
          if (!tracker.isInFlight(t.id)) tracker.enqueuePending(t.id, 'implement')
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
  // Periodically raises `stale-worktree` actionQueue items for tasks whose worktree
  // has not been updated within MARS_STALE_WORKTREE_HOURS (default 24h). The
  // actionQueue dedup logic ensures re-detecting the same stale worktree bumps the
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
          log(`[stale-sweep] raised/bumped ${raised.length} stale-worktree actionQueue item(s)`)
          viewStreamHub.broadcast('proposals')
          viewStreamHub.broadcast('action-queue')
        }
      } catch (err) {
        log(`[stale-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, STALE_SWEEP_MS)
  staleSweep.unref()

  // ── Observability store size watchdog ─────────────────────────────────────
  // Periodically checks the trace_events footprint inside mars.db. When the
  // table exceeds 500 MB a single open action-queue item is raised so the
  // operator notices a runaway daemon or telemetry-capture bug.
  // Re-detecting the oversize condition bumps the existing item rather than
  // spawning a sibling. NEVER prunes the store or alters retention.
  // .unref() so the interval never prevents a clean shutdown.
  const OBSERVABILITY_WATCHDOG_MS = Number(
    process.env.MARS_OBSERVABILITY_WATCHDOG_MS ?? 5 * 60_000,
  )
  const { checkObservabilityStoreSize } = await import('./observability-watchdog')
  const observabilityWatchdog = setInterval(() => {
    void (async () => {
      try {
        const itemId = await checkObservabilityStoreSize(
          resolveContext().stateDbPath,
        )
        if (itemId) {
          log(
            `[observability-watchdog] store oversize — raised/bumped action-queue item ${itemId}`,
          )
          viewStreamHub.broadcast('action-queue')
        }
      } catch (err) {
        log(`[observability-watchdog] errored: ${(err as Error).message}`)
      }
    })()
  }, OBSERVABILITY_WATCHDOG_MS)
  observabilityWatchdog.unref()

  // ── Outbox sweeper ────────────────────────────────────────────────────────
  // Periodically prunes aged events from the outbox and raises a dedup'd
  // action-queue item for any subscriber whose cursor lag exceeds the
  // configured threshold (MARS_OUTBOX_LAG_WARN_THRESHOLD). .unref() so
  // the interval never prevents a clean shutdown.
  const MARS_OUTBOX_PRUNE_INTERVAL_MS = Number(
    process.env.MARS_OUTBOX_PRUNE_INTERVAL_MS ?? 60_000,
  )
  const { sweepOutbox } = await import('./outbox-sweeper')
  const outboxSweep = setInterval(() => {
    void (async () => {
      try {
        await sweepOutbox(resolveContext().stateDbPath)
      } catch (err) {
        log(`[outbox-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, MARS_OUTBOX_PRUNE_INTERVAL_MS)
  outboxSweep.unref()

  // ── Phantom-task watchdog ─────────────────────────────────────────────────
  // Periodically sweeps for tasks stuck in 'running' or 'verifying' with no
  // live subprocess, preventing a dead worker from holding an in-flight slot
  // indefinitely (the root cause of the mars-f35b1c7f 12-hour freeze).
  //
  // Two detection mechanisms (belt and suspenders):
  //  1. PID liveness: if an in-flight entry carries a recorded PID and
  //     isProcessAlive(pid) returns false, the task is auto-failed immediately
  //     without waiting for the wall-clock ceiling.
  //  2. Wall-clock ceiling: if updatedAt exceeds MARS_PHANTOM_WATCHDOG_CEILING_MS
  //     (default 30 min) — or the PID is alive but updatedAt still exceeds the
  //     ceiling (hung subprocess case) — the task is auto-failed as a backstop.
  //
  // For each phantom: marks the task failed with failedPhase set, calls
  // forceRelease + release(sem) to free the slot, triggers drain() so queued
  // work resumes, and raises exactly one action-queue item (dedup by taskId
  // prevents a retry storm). .unref() so the timer never prevents shutdown.
  const PHANTOM_WATCHDOG_MS = Number(
    process.env.MARS_PHANTOM_WATCHDOG_MS ?? 5 * 60_000,
  )
  const { sweepPhantomTasks } = await import('./phantom-task-watchdog')
  const phantomWatchdog = setInterval(() => {
    void (async () => {
      try {
        const { failed } = await sweepPhantomTasks(
          tracker.inFlightSnapshot(),
          (id, kind) => {
            tracker.forceRelease(id)
            release(sems[kind])
            void drain()
          },
        )
        if (failed.length > 0) {
          log(
            `[phantom-watchdog] auto-failed ${failed.length} phantom in-flight task(s): ${failed.join(', ')}`,
          )
          viewStreamHub.broadcast('action-queue')
          viewStreamHub.broadcast('tasks')
          void drain()
        }
      } catch (err) {
        log(`[phantom-watchdog] errored: ${(err as Error).message}`)
      }
    })()
  }, PHANTOM_WATCHDOG_MS)
  phantomWatchdog.unref()

  // ── Observability telemetry sweeper ───────────────────────────────────────
  // Periodically deletes trace_events rows older than three days so the
  // SQLite state DB stays bounded across multi-day sessions. The sweep reuses
  // the same pruneObservability routine that `mars observability prune` calls —
  // the retention window is always 3 days and is never shortened by the sweeper.
  // Logs the row count when any rows are removed. .unref() so the timer never
  // keeps the daemon process alive after shutdown.
  const OBSERVABILITY_SWEEP_MS = Number(
    process.env.MARS_OBSERVABILITY_SWEEP_MS ?? 60 * 60_000,
  )
  const { sweepObservability } = await import('./observability-sweeper')
  const observabilitySweep = setInterval(() => {
    void (async () => {
      try {
        const deleted = await sweepObservability(resolveContext().stateDbPath)
        if (deleted > 0) {
          log(
            `[observability-sweep] pruned ${deleted} telemetry row(s) older than 3 days`,
          )
        }
      } catch (err) {
        log(`[observability-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, OBSERVABILITY_SWEEP_MS)
  observabilitySweep.unref()

  // ── WAL checkpoint sweep ──────────────────────────────────────────────────
  // Periodically runs PRAGMA wal_checkpoint(TRUNCATE) on the daemon's DB
  // client so the WAL file stays bounded even when the long-lived connection
  // suppresses SQLite's built-in autocheckpoint.  A blocked result (busy=1)
  // is expected under write load and is logged, not thrown.  Default: 60 s;
  // override via MARS_WAL_CHECKPOINT_INTERVAL_MS.  .unref() so the timer
  // never holds the daemon process alive after shutdown.
  const WAL_CHECKPOINT_MS = Number(
    process.env.MARS_WAL_CHECKPOINT_INTERVAL_MS ?? 60_000,
  )
  const { sweepWalCheckpoint } = await import('./wal-checkpoint-sweeper')
  const walCheckpointSweep = setInterval(() => {
    void (async () => {
      try {
        const { busy, log: walLog, checkpointed } = await sweepWalCheckpoint(
          getCompositionRootClient(),
        )
        log(
          `[wal-checkpoint] busy=${busy} log=${walLog} checkpointed=${checkpointed}`,
        )
      } catch (err) {
        log(`[wal-checkpoint] errored: ${(err as Error).message}`)
      }
    })()
  }, WAL_CHECKPOINT_MS)
  walCheckpointSweep.unref()

  // ── KPI snapshot sweep ────────────────────────────────────────────────────
  // Takes a rolling 7-day KPI snapshot once per interval and persists a row
  // to kpi_snapshots so the /kpis route and UI tiles always have data.
  // Default: 1 h (60 * 60_000 ms) — the window is 7 days so hourly is
  // plenty and cheap.  Override via MARS_KPI_SNAPSHOT_MS.  .unref() so the
  // timer never holds the daemon process alive after shutdown.
  const KPI_SNAPSHOT_MS = Number(process.env.MARS_KPI_SNAPSHOT_MS ?? 60 * 60_000)
  const runKpiSnapshot = (): void => {
    void (async () => {
      try {
        const { takeKpiSnapshot } = await import('../lib/kpi-snapshots.js')
        await takeKpiSnapshot({ surface: getDefaultDomainTaskStore(), now: new Date().toISOString() })
        log('[kpi-snapshot] snapshot taken')
      } catch (err) {
        log(`[kpi-snapshot] errored: ${(err as Error).message}`)
      }
    })()
  }
  // Take one snapshot immediately on startup so a freshly started daemon
  // shows data without waiting a full interval.
  runKpiSnapshot()
  const kpiSnapshotSweep = setInterval(runKpiSnapshot, KPI_SNAPSHOT_MS)
  kpiSnapshotSweep.unref()

  // ── Alert-dismisser drain ─────────────────────────────────────────────────
  // Polls the outbox for status-transition events and clears the implicated
  // task's action-queue alert(s). This keeps the "status change clears
  // alerts" invariant whole for raw-SQL status writes that bypass the
  // updateTask chokepoint. .unref() so it never holds the process open.
  const ALERT_DRAIN_MS = Number(process.env.MARS_ALERT_DRAIN_MS ?? 30_000)
  const alertDrain = setInterval(() => {
    void (async () => {
      try {
        await drainAlertDismissals(getCompositionRootClient(), log)
      } catch (err) {
        log(`[alert-dismisser] drain errored: ${(err as Error).message}`)
      }
    })()
  }, ALERT_DRAIN_MS)
  alertDrain.unref()

  // ── Action queue repopulator drain ───────────────────────────────────────────────
  // Polls the outbox for task/proposal lifecycle events and applies the
  // corresponding action_queue_items mutations. .unref() so it never holds the
  // process open.
  const ACTION_QUEUE_REPOPULATOR_DRAIN_MS = Number(
    process.env.MARS_ACTION_QUEUE_REPOPULATOR_DRAIN_MS ?? 30_000,
  )
  const actionQueueRepopulatorDrain = setInterval(() => {
    void (async () => {
      try {
        const { processed } = await drainActionQueueRepopulations(getCompositionRootClient(), log)
        if (processed > 0) viewStreamHub.broadcast('action-queue')
      } catch (err) {
        log(`[action-queue-repopulator] drain errored: ${(err as Error).message}`)
      }
    })()
  }, ACTION_QUEUE_REPOPULATOR_DRAIN_MS)
  actionQueueRepopulatorDrain.unref()

  // ── Blocker-resolution drain ──────────────────────────────────────────────
  // Polls the outbox for task.terminal { reason: 'done' } events and unblocks
  // any dependents whose every blocker is now done. .unref() so it never holds
  // the process open.
  const BLOCKER_RESOLUTION_DRAIN_MS = Number(
    process.env.MARS_BLOCKER_RESOLUTION_DRAIN_MS ?? 30_000,
  )
  const blockerResolutionDrain = setInterval(() => {
    void (async () => {
      try {
        const { processed } = await drainBlockerResolution(getCompositionRootClient(), log)
        if (processed > 0) {
          const queued = await listTasks('queued')
          for (const t of queued) {
            if (!tracker.isInFlight(t.id)) bus.emit('task.queued', { taskId: t.id })
          }
        }
      } catch (err) {
        log(`[blocker-resolution] drain errored: ${(err as Error).message}`)
      }
    })()
  }, BLOCKER_RESOLUTION_DRAIN_MS)
  blockerResolutionDrain.unref()

  // ── Idle-shutdown timeout ─────────────────────────────────────────────────
  // When no RPC request has arrived for IDLE_TIMEOUT_MS and no tasks are in
  // flight, the daemon shuts itself down gracefully. Background sweepers do
  // NOT reset the clock — only incoming handleRequest calls count as activity.
  // Set MARS_IDLE_TIMEOUT_MS=0 to disable entirely (e.g. during manual testing
  // or when the daemon is kept alive by a process supervisor).
  // .unref() so this timer never keeps the process alive on its own.
  const IDLE_TIMEOUT_MS = Number(process.env.MARS_IDLE_TIMEOUT_MS ?? 15 * 60_000)
  const IDLE_CHECK_MS = Number(process.env.MARS_IDLE_CHECK_MS ?? 30_000)
  let idleTimeout: ReturnType<typeof setInterval> | undefined
  if (IDLE_TIMEOUT_MS > 0) {
    idleTimeout = setInterval(() => {
      if (shuttingDown) return
      if (drainRunning) return
      if (tracker.inFlightCount() > 0) {
        // While tasks are running, keep resetting the idle clock so the timeout
        // only starts counting once the daemon is truly quiet.
        lastActivityAt = Date.now()
        return
      }
      if (Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS) {
        log(
          `[idle-timeout] no activity for ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m and no tasks in flight — shutting down`,
        )
        void shutdown(false)
      }
    }, IDLE_CHECK_MS)
    idleTimeout.unref()
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  const shutdown = async (force = false): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(pollFallback)
    clearInterval(githubUpdatePoll)
    clearInterval(devStalenessCheck)
    clearInterval(staleSweep)
    clearInterval(observabilityWatchdog)
    clearInterval(phantomWatchdog)
    clearInterval(observabilitySweep)
    clearInterval(walCheckpointSweep)
    clearInterval(kpiSnapshotSweep)
    clearInterval(alertDrain)
    clearInterval(actionQueueRepopulatorDrain)
    clearInterval(blockerResolutionDrain)
    clearInterval(idleTimeout)
    // Once shutdown starts, stop dispatching new work even if drain wasn't
    // explicitly requested — a SIGINT/SIGTERM that arrives while the
    // dispatcher is mid-pick must not strand an extra worktree.
    acceptingWork = false
    tracker.clearPending()
    log(`shutting down (force=${force}, inFlight=${tracker.inFlightCount()})`)

    if (force && tracker.inFlightCount() > 0) {
      const entries = tracker
        .inFlightSnapshot()
        .map((e) => `${e.taskId}(${e.kind})`)
        .join(', ')
      log(`force shutdown abandoning in-flight: ${entries}`)
    }

    if (!force) {
      // No timeout: a drain stop waits as long as the in-flight tasks need.
      // `mars daemon kill` is the escape hatch for stuck work.
      let lastLogged = -1
      while (tracker.inFlightCount() > 0) {
        const remaining = tracker.inFlightCount()
        if (remaining !== lastLogged) {
          log(`waiting on ${remaining} in-flight task(s)`)
          lastLogged = remaining
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
    inFlightCount: () => tracker.inFlightCount(),
  }
}
