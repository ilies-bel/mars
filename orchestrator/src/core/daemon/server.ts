import { EventEmitter } from 'node:events'
import { acquire, makeSem, release, setSemLimit, type Semaphore } from './semaphore'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
import { findExistingMarsDb, resolveContext, resolveDbTarget } from '../context'
import { openDb, recycleDbPool, type DbClient } from '../lib/db'
import { startEmbeddedPg, type EmbeddedPgHandle } from '../lib/pg-server'
import { importLegacySqlite } from '../../init/import-sqlite'
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
import {
  drainRecoverySpawner,
  ensureRecoverySpawner,
} from '../../outbox/subscribers/recovery-spawn'
import {
  drainSubthreadCloser,
  ensureSubthreadCloser,
} from '../../outbox/subscribers/subthread-closer'
import {
  drainArchivePrompter,
  ensureArchivePrompter,
} from '../../outbox/subscribers/archive-prompter'
import {
  drainArcVerifier,
  ensureArcVerifierSubscriber,
} from '../../outbox/subscribers/arc-verifier-subscriber'
import {
  drainGateFixSteward,
  ensureGateFixStewardSubscriber,
} from '../../outbox/subscribers/gate-fix-steward'
import {
  ensureArchiveEntriesSubscriber,
  drainArchiveEntries,
} from '../archive/insert.js'
import {
  drainRecipeConversationNotices,
  ensureRecipeConversationNoticeSubscriber,
} from '../../outbox/subscribers/recipe-conversation-notice'
import {
  clearFailureConversationNoticeFlush,
  drainFailureConversationNotices,
  ensureFailureConversationNoticeSubscriber,
  scheduleFailureConversationNoticeFlush,
} from '../../outbox/subscribers/failure-conversation-notices'
import {
  isArcVerifyDisabled,
  runArcVerification,
  triggerArcVerification,
} from '../lib/arc-verifier'
import { buildTranscriptAppendSubscriber } from '../../outbox/subscribers/transcript-append'
import { readAllTranscriptsForTask } from '../lib/claude-transcript'
import type { ClaudeEvent } from '../lib/claude-stream'
import { createHash } from 'node:crypto'
import type { Logger, WorkflowEvent } from '@mars/workflow'
import { resolveManualStep, awaitManualDone } from '@mars/workflow'
import { scanRecoveryBlockerEdges } from '../lib/blocker-invariant'
import { createScoringPool, resolveScoringLimit } from './scoring-pool'
import { exec, resolveGitBin } from '../lib/git/internal'
import { warnWhenRepoRootDiffersFromIntegration } from '../lib/repo-root-branch-warning'
import { classifyInstallRoute } from './install-route'
import {
  decideDevStalenessAction,
  hasDevDependencyDrift,
  hasRelevantDevDrift,
} from './dev-staleness'
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
import { Arc, type ProgressEntry } from '../arc'
import { WorkflowTerminalError } from '../lib/workflow-terminal-error'
import {
  raiseActionQueueItem,
  supersedeActionQueueItemsBySignature,
  supersedeObsoletePreflightDirtyMainRows,
  supersedeOrphanedHitlActionQueueRows,
} from '../lib/action-queue'
import {
  raiseAggregatedMainCommiterFailureRow,
  sweepStaleFailedMainCommiterActionQueue,
} from './main-dirty-action-queue'
import { DAEMON_KILLED_SIGNATURE } from '../lib/retry-budget'
import { AWAIT_HUMAN_SENTINEL } from '../lib/sentinels'
import { computeFailureSignature } from '../lib/failure-signature'
import { openTraceEventStore, sweepOrphanRunningSpans, type TraceEventStore, type TraceEventPhase } from '../lib/trace-events-store'
import { RETENTION_MAX_ROWS_DEFAULT } from '../lib/retention-prune'
import { setBusLogSink } from '../../bus/log'
import { daemonPaths, isProcessAlive, readDaemonPid, tryConnectSocket, waitForProcessExit } from './paths'
import {
  applyControlLevers,
  loadDaemonConfig,
  readPersistedPaused,
} from './config'
import { createPauseController } from './pause-state'
import {
  createStormBreaker,
  stormEscalationSignature,
  type StormEscalation,
  type StormStewardOutcome,
  type StormStewardReport,
} from './storm-breaker'
import { collectStormEvidence, type StormEvidence } from './storm-evidence'
import { setInstallSemCap } from '../lib/worktree-install'
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
import { registerDispatchHint } from './dispatch-hint'
import { setWorkerLivenessProbe } from '../lib/worker-liveness'
import { rpcRegistry, dispatchRpc } from './rpc/registry'
import type { DaemonDeps } from './rpc/types'
import { PreviewRegistry } from './preview-registry'
import { createAppServices } from '../app-services'
import { buildLiveAgentsRoster } from './live-agents-roster'
import { startApiEndpointProbe } from '../lib/api-endpoint-probe'
import { ChatRunner, CHAT_TIMEOUT_MS } from './chat-runner'
import { startMergeWorker, enqueueMergeJobAndAwait, type MergeWorkerHandle } from './merge-worker'
import { getDefaultMergeJobStore } from '../store/merge-job-store'
import { startHeartbeatWriter, type HeartbeatHandle } from './heartbeat-writer'
import { loadSpendControl, upsertSpendControl } from './spend-control/store'
import { getLatestUsageSnapshot } from '../lib/usage-snapshot-store'
import { computeBudgetPressure, getBudgetPressureConfig } from '../lib/budget-pressure'
import { deleteDeferral, upsertDeferral } from '../lib/deferral-store'
import { shouldDeferDispatch } from '../lib/dispatch-gate'
import { startDeferralWakeSweeper } from './deferral-wake-sweeper'
import { DocumentWriteCoordinator } from './document-write-coordinator'

const LOG_ROTATE_BYTES = 10 * 1024 * 1024

/**
 * Re-exec the daemon against the repository this process already serves.
 *
 * Auto-restart paths cannot rely on the child inheriting a useful working
 * directory: foreground daemons may have been launched with `--repo` from
 * elsewhere. Pinning both the command argument and environment keeps the
 * replacement reading the same daemon.json, including an operator pause.
 */
export const spawnReplacementDaemon = async (): Promise<void> => {
  const { captureDaemonBootStderr, daemonPaths, spawnDaemonProcess } = await import('./paths')
  const { repoRoot } = resolveContext()
  const child = spawnDaemonProcess({ repoRoot })
  captureDaemonBootStderr(child, daemonPaths(repoRoot).logFile)
  child.unref()
}

/** Select the built-in coordinator pipeline for coordinator-owned tasks. */
export const pickWorkflowFor = (task: Task): 'implement' | 'coordinator' =>
  task.spec?.executionMode === 'coordinated' ? 'coordinator' : 'implement'

export interface DaemonHandle {
  stop: (force?: boolean) => Promise<void>
  inFlightCount: () => number
}

export interface DaemonOptions {
  integrationBranch?: string
  log?: (line: string) => void
}

/**
 * Persist a structured-write failure for the operator. Structured writes run
 * fire-and-forget, so their dispatchers must catch failures rather than let an
 * unhandled rejection terminate the daemon; this action-queue row is the
 * durable counterpart to that catch.
 */
export const raiseStructuredWriteFailureAction = async (args: {
  kind: 'adr' | 'glossary' | 'vision'
  target: string
  error: unknown
}): Promise<void> => {
  const message = args.error instanceof Error ? args.error.message : String(args.error)
  await raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title: `Structured ${args.kind} write failed: ${args.target}`,
    body: [
      `The structured ${args.kind} write for \`${args.target}\` did not complete.`,
      '',
      `Error: ${message}`,
      '',
      'The daemon is still running. Review the failure and retry the original command after resolving it.',
    ].join('\n'),
    payload: { kind: args.kind, target: args.target, error: message },
    context: { repoRoot: process.env.MARS_REPO ?? null },
    raisedBy: 'structured-write:dispatch',
    signature: `structured-write:failed:${args.kind}:${args.target}`,
  })
}

/**
 * A pending implement candidate captured during the first phase of
 * {@link pickNextImplement}. Exported so the pure comparator can be unit-tested
 * without mounting a live daemon.
 */
export interface PickCandidate {
  id: string
  priority: number
  createdAt: string
  /** Arc root id (task.originId). Null is treated as "not started". */
  originId: string | null
}

/**
 * Pure comparator used by {@link pickNextImplement} — exported for unit tests.
 *
 * Selection order (earlier rule wins):
 * 1. Higher `priority` wins.
 * 2. At equal priority, a candidate whose `originId` is in `startedOriginIds`
 *    beats one that is not (prefer in-flight arcs over fresh ones).
 * 3. At equal priority and equal started-flag, older `createdAt` wins (FIFO).
 *
 * A null `originId` is never considered started.
 */
export function selectBestCandidate(
  candidates: PickCandidate[],
  startedOriginIds: Set<string>,
): PickCandidate | null {
  let best: PickCandidate | null = null
  for (const c of candidates) {
    if (best === null) {
      best = c
      continue
    }
    // Rule 1: higher priority always wins.
    if (c.priority > best.priority) { best = c; continue }
    if (c.priority < best.priority) continue
    // Rule 2: at equal priority, started-origin beats non-started.
    const cStarted = c.originId !== null && startedOriginIds.has(c.originId)
    const bStarted = best.originId !== null && startedOriginIds.has(best.originId)
    if (cStarted && !bStarted) { best = c; continue }
    if (!cStarted && bStarted) continue
    // Rule 3: older createdAt wins (FIFO fallback).
    if (c.createdAt < best.createdAt) best = c
  }
  return best
}

/**
 * Returns `true` when a task must skip the dispatch-time dirty-main check.
 *
 * Two categories are exempt:
 * - `kind === 'fix'`: the main-commiter recovery IS the tool we use to clean a
 *   dirty integration branch, so it must be allowed to dispatch against it.
 * - `workflow === 'report'`: report tasks are read-only and never merge back
 *   into the integration branch, so a dirty branch cannot block them.
 *
 * Exported so the exemption predicate can be unit-tested without mounting a
 * live daemon (same pattern as {@link selectBestCandidate}).
 */
export function isDispatchDirtyMainExempt(task: {
  kind?: string
  workflow?: string | null
}): boolean {
  return task.kind === 'fix' || task.workflow === 'report'
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
  const { socket: socketPath, pidFile, logFile, httpPortFile, runningMarker, crashMarker, lockFile } = daemonPaths()

  // ── Unclean-exit detection (before any file mutations) ───────────────────
  // If `daemon.running.json` exists from a prior run that never completed
  // `shutdown()`, that run exited uncleanly (crash, OOM, SIGKILL, or any path
  // that bypassed shutdown). Capture its metadata into `daemon.crash.json` so
  // the daemon-died-sweep reconciler can raise an action-queue alert. This
  // check runs before the socket guard so it captures every unclean exit
  // regardless of whether the socket was cleaned up or not.
  if (existsSync(runningMarker)) {
    try {
      const prev: unknown = JSON.parse(readFileSync(runningMarker, 'utf8'))
      const crashInfo = {
        pid: typeof prev === 'object' && prev !== null && 'pid' in prev
          ? (prev as Record<string, unknown>).pid
          : -1,
        startedAt: typeof prev === 'object' && prev !== null && 'startedAt' in prev
          ? (prev as Record<string, unknown>).startedAt
          : 'unknown',
        crashDetectedAt: new Date().toISOString(),
      }
      writeFileSync(crashMarker, JSON.stringify(crashInfo), 'utf8')
    } catch {
      // best-effort: write a minimal crash marker even if reading the running
      // marker failed (e.g. corrupted JSON from a truncated write at crash time)
      try {
        writeFileSync(
          crashMarker,
          JSON.stringify({ pid: -1, startedAt: 'unknown', crashDetectedAt: new Date().toISOString() }),
          'utf8',
        )
      } catch {
        // truly best-effort
      }
    }
    writeLog(logFile, '[warn] previous daemon run exited uncleanly (running marker found); daemon-died alert will be raised')
  }

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

  warnWhenRepoRootDiffersFromIntegration(
    resolveContext().repoRoot,
    integrationBranch,
    log,
  )

  // ── Exclusive advisory startup lock ─────────────────────────────────────
  // daemon.lock holds the PID of the daemon that last passed the startup
  // guards. A second concurrent start finds a live PID here and refuses
  // rather than running split-brain (two daemons sharing the DB / PG server).
  const lockPid = readDaemonPid(lockFile)
  if (lockPid !== null && isProcessAlive(lockPid)) {
    log(
      `daemon (pid ${lockPid}) holds the exclusive startup lock; refusing to start`,
    )
    process.exit(1)
  }

  // ── Socket probe ─────────────────────────────────────────────────────────
  // Refuse to clobber a live daemon. Probe the socket before unlinking —
  // a non-atomic existsSync check used to let two daemons coexist, leaking
  // DuckDB/DB-pool handles and making "kill the daemon" recovery unreliable.
  if (existsSync(socketPath)) {
    if (await tryConnectSocket(socketPath)) {
      log(`another daemon is already listening on ${socketPath}; exiting`)
      process.exit(0)
    }
    // Stale socket — unlink it before the kill-and-wait so the next
    // incarnation cannot find and try to connect to it.
    try {
      unlinkSync(socketPath)
    } catch {
      // best-effort
    }
  }

  // ── Kill-and-wait for any live prior process ──────────────────────────────
  // Covers both the stale-socket case (socket present but unresponsive) and
  // the race where the old daemon deleted its socket mid-shutdown but has not
  // yet exited the process — which would leave it holding DB connections and
  // producing SQLITE_BUSY / PG "too many connections" storms.
  const priorPid = readDaemonPid(pidFile)
  if (priorPid !== null && isProcessAlive(priorPid)) {
    log(
      `prior daemon (pid ${priorPid}) still alive; sending SIGTERM and waiting (max 30 s)`,
    )
    try {
      process.kill(priorPid, 'SIGTERM')
    } catch {
      // might already have exited between the isProcessAlive check and here
    }
    const exited = await waitForProcessExit(priorPid, 30_000)
    if (!exited) {
      log(
        `prior daemon (pid ${priorPid}) did not exit within 30 s; sending SIGKILL`,
      )
      try {
        process.kill(priorPid, 'SIGKILL')
      } catch {
        // best-effort
      }
      await waitForProcessExit(priorPid, 5_000)
    }
  }

  // Acquire the exclusive advisory lock. Written before any DB / socket work
  // so a concurrent start racing through the guard above (TOCTOU window) will
  // see a live PID and refuse on its next lock check or on restart.
  writeFileSync(lockFile, String(process.pid), 'utf8')

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
  // ── Embedded PostgreSQL provisioning (migration 0002) ────────────────────
  // The daemon owns the repo's PG server: start (or adopt) it BEFORE anything
  // opens the store. startEmbeddedPg publishes `.mars/pg.port`/`.mars/pg.dsn`
  // once the server answers, so every later resolveDbTarget() read succeeds.
  // Under MARS_DB_BACKEND=pglite (tests) the in-process instance needs no
  // server and no published files.
  let pgHandle: EmbeddedPgHandle | null = null
  let mergeWorkerHandle: MergeWorkerHandle | null = null
  if (process.env.MARS_DB_BACKEND !== 'pglite') {
    try {
      pgHandle = await startEmbeddedPg({
        stateDir: resolveContext().stateDir,
        onLog: (line) => log(`[pg] ${line}`),
      })
      log(
        `[pg] embedded PostgreSQL ${pgHandle.adopted ? 'adopted' : 'started'} on port ${pgHandle.port}`,
      )
    } catch (err) {
      log(`embedded PostgreSQL failed to start: ${(err as Error).message}; refusing to start`)
      process.exit(1)
    }
  }

  // Guarantee the canonical schema through the composition-root runner before
  // any boot sweep or subscriber obtains a database client. The runner shares
  // its readiness promise with ordinary client operations, preventing a late
  // reader from starting a second DDL batch while boot reconciliation reads.
  // Then fold any legacy SQLite `.mars/mars.db` in exactly once. The importer is
  // idempotent (schema_migrations marker + pg-has-data guard) and renames the
  // SQLite file to `mars.db.bak-<ts>` on success; a failed import is logged
  // and retried on the next boot rather than blocking startup.
  const dbClient: DbClient = openDb(resolveDbTarget())
  await runCompositionRootMigrations()
  log('[schema] migrations complete')
  try {
    const legacySqlitePath = findExistingMarsDb()
    if (legacySqlitePath !== null) {
      const imported = await importLegacySqlite({
        sqlitePath: legacySqlitePath,
        client: dbClient,
      })
      if (imported.status === 'imported') {
        const total = Object.values(imported.tables).reduce((a, b) => a + b, 0)
        log(
          `[pg-import] imported legacy mars.db (${total} row(s)); renamed to ${imported.renamedTo}`,
        )
      }
    }
  } catch (err) {
    log(`[pg-import] legacy SQLite import failed (will retry next start): ${(err as Error).message}`)
  }

  // Open the unified Mars trace-event store. It lives in the same database
  // as the rest of the state — the client registry in lib/db.ts shares one
  // pool per target, so this is a handle onto the daemon's connection pool.
  const traceStore: TraceEventStore = await openTraceEventStore(
    resolveDbTarget(),
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

  // ── Daemon heartbeat writer ───────────────────────────────────────────────
  // Upserts a daemon_heartbeat row (id=1) with the current pid and boot
  // timestamp, then ticks last_beat_ts every MARS_HEARTBEAT_MS (default 5 s)
  // so external observers can detect a stale/dead daemon. The handle is
  // stopped in shutdown() below.
  //
  // Carry forward the persisted dispatch-uptime counter. It advances only
  // while this live daemon can dispatch, so re-queue ceilings naturally
  // exclude pauses and time between daemon processes.
  let heartbeatPrevGapMs = 0
  let heartbeatDispatchUptimeMs = 0
  try {
    const { readDaemonHeartbeat } = await import('./heartbeat-writer').then(
      () => import('../store/state-store'),
    )
    const prevHb = await readDaemonHeartbeat(dbClient)
    if (prevHb) {
      heartbeatPrevGapMs = Math.max(0, Date.now() - prevHb.lastBeatTs)
      heartbeatDispatchUptimeMs = prevHb.dispatchUptimeMs
    }
  } catch {
    // Non-fatal: if reading the previous row fails we simply assume no gap.
  }
  let heartbeatHandle: HeartbeatHandle | null = null
  try {
    heartbeatHandle = await startHeartbeatWriter({
      db: dbClient,
      log,
      prevGapMs: heartbeatPrevGapMs,
      dispatchUptimeMs: heartbeatDispatchUptimeMs,
    })
    log('[heartbeat] writer started')
  } catch (err) {
    log(`[heartbeat] writer failed to start (non-fatal): ${(err as Error).message}`)
  }

  // Resolve git binary once at startup. If git is not on PATH the daemon
  // exits immediately with a clear message instead of letting the first
  // git call fail mid-task as a retry-budget-exhausted ENOENT.
  try {
    resolveGitBin()
  } catch {
    log('git binary not found on PATH; refusing to start')
    process.exit(1)
  }

  // Git-metadata writability pre-flight.
  //
  // A daemon started from a sandboxed shell can have write access to the
  // worktree files under `.mars/worktrees/<id>/` while being DENIED write
  // access to the shared `<repo>/.git/worktrees/<id>/` metadata directory —
  // a different filesystem location entirely. Coders then edit files and run
  // tests happily and fail only at the commit gate with
  // `Git cannot create '.git/worktrees/<id>/index.lock': Operation not
  // permitted`. That burned 79 full-context runs for zero output before it
  // was diagnosed. Probe it once, here, and refuse to start rather than
  // discover it 79 times.
  {
    const { checkGitMetadataWritable } = await import('../lib/git-metadata-preflight')
    const probe = checkGitMetadataWritable(resolveContext().repoRoot)
    if (!probe.writable) {
      log(probe.message)
      process.exit(1)
    }
  }

  // Worker-provider binary pre-flight (defensive hardening).
  //
  // Each headless adapter used to resolve its binary from PATH at spawn time
  // with no verification at all. If the daemon's environment cannot resolve it,
  // every coder run dies instantly with exit 127 and lands in the contentless
  // `coder-exit-nonzero` bucket — while `which codex` in the operator's own
  // shell keeps saying everything is fine. The check therefore has to happen
  // here, in the daemon's own process, and it has to print the PATH the DAEMON
  // inherited.
  //
  // This is a guard against a failure mode, not a fix for an observed one: the
  // exit-127 incidents seen in production traced to the retry-after-watchdog-
  // kill dispatch path, which is handled separately.
  //
  // Resolving here also warms the resolve-once cache in provider-bin.ts, so
  // every later spawn reuses this absolute path instead of re-reading PATH.
  {
    const { checkProviderBin } = await import('../workers/provider-bin')
    const { WORKER_PROVIDER } = await import('../workers/index')
    // MARS_WORKER_PROVIDER (already folded into WORKER_PROVIDER) wins over the
    // persisted defaultProvider.
    const effectiveProvider =
      process.env.MARS_WORKER_PROVIDER !== undefined
        ? WORKER_PROVIDER
        : loadDaemonConfig().defaultProvider
    const probe = checkProviderBin(effectiveProvider)
    if (!probe.ok) {
      log(probe.message)
      process.exit(1)
    }
    log(probe.message)
  }

  // Boot-time orphan sweep. A previous daemon that was killed (or restarted)
  // leaves its verify/test subprocesses reparented to init, where they burn
  // CPU forever and — via the autotuner's load guard — pin the implement cap.
  // Sweep before accepting any work so a restart is a genuine clean slate.
  try {
    const { sweepOrphans, formatSweepSummary } = await import('../lib/orphan-reaper')
    const summary = await sweepOrphans({
      repoRoot: resolveContext().repoRoot,
      // Nothing is in flight yet at boot: every match is leaked by definition.
      inFlightTaskIds: new Set<string>(),
      log,
    })
    if (summary.reaped > 0) {
      log(`[orphan-reaper] startup sweep: ${formatSweepSummary(summary)}`)
    }
  } catch (err) {
    log(`[orphan-reaper] startup sweep failed (non-fatal): ${(err as Error).message}`)
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

  // Publish the tracker's in-flight knowledge as the process-wide worker
  // liveness signal. The tracker is the ONLY authoritative record of which
  // tasks this daemon actually has a worker process for — `tasks.status`
  // carries no pid and no heartbeat — so modules that must distinguish a
  // live worker from a zombie row (lib/main-dirty.ts's main-committer attach
  // path) read it through this seam. A `claimed` task counts as alive: the
  // claim is taken before `await acquire(sem)` and is only cleared by
  // `commitInFlight`, so the claim covers the await-acquire gap during which
  // no in-flight entry exists yet.
  setWorkerLivenessProbe(
    (taskId) =>
      tracker.isInFlight(taskId) ||
      tracker.isClaimed(taskId, 'implement') ||
      tracker.isClaimed(taskId, 'triage'),
  )

  const startedAt = new Date().toISOString()

  // Dev-install source staleness detection. Capture the git HEAD SHA and repo
  // root once at startup so a periodic tick can detect commits that changed
  // loaded daemon code or workflows. Unrelated auto-commits must not mark the
  // in-memory daemon stale. Gate on dev install only; prod binaries are
  // handled by self-update.ts. A stable, idle local code drift automatically
  // restarts by default; dependency drift and disabled auto-restart keep the
  // operator-facing nudge. On any git error, leave sourceSha null so we never
  // surface a spurious warning.
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  const installRoute = classifyInstallRoute()
  const devAutoRestartEnabled = process.env.MARS_DEV_AUTORESTART !== '0'
  let sourceSha: string | null = null
  let sourceRepoDir: string | null = null
  if (installRoute === 'dev') {
    try {
      const { stdout: root } = await exec(resolveGitBin(), ['rev-parse', '--show-toplevel'], {
        cwd: sourceDir,
      })
      sourceRepoDir = root.trim() || null
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
  // The ONE authoritative dispatch-pause state, with the reason recorded on it
  // ('operator' | 'storm' | 'quota'). Unlike acceptingWork=false (shutdown),
  // tasks added while paused still reach the pending sets so resume dispatches
  // them immediately; in-flight tasks continue to completion. The storm
  // breaker's durable `tripped` row is reconciled against this state at
  // startup and cleared alongside it on resume, so the two cannot drift.
  //
  // Every transition also re-publishes dispatch-enabled to the heartbeat
  // writer, so the heartbeat can never disagree with the pause state — that
  // side-effect used to live in a hand-rolled `setDaemonPaused` next to the
  // old `isPaused` boolean and is now owned by the controller.
  /**
   * Say out loud that the gate is shut, and how much work is stuck behind it.
   * Urgent by design: this is the one Notice that must interrupt.
   */
  const announceBrokenGate = async (detail: string | null): Promise<void> => {
    const { postConversationNotice } = await import('../lib/conversation-delivery.js')
    const { resolveStateClient } = await import('../store/state-client.js')
    const blocked = await resolveStateClient().execute(
      `SELECT count(*) AS n FROM tasks WHERE status IN ('queued', 'blocked')`,
    )
    await postConversationNotice({
      kind: 'gate.main-broken',
      payload: {
        failingCheck: detail ?? 'the same check',
        blockedTasks: Number((blocked.rows[0] as { n?: unknown } | undefined)?.n ?? 0),
      },
      priority: 'urgent',
      viewStreamHub,
    })
  }

  const pause = createPauseController({
    onChange: (state) => {
      heartbeatHandle?.setDispatchEnabled(acceptingWork && !state.paused)
      log(
        state.paused
          ? `[pause] dispatch paused (reason=${state.reason}${
              state.detail !== null ? `: ${state.detail}` : ''
            })`
          : '[pause] dispatch resumed',
      )
      // A storm pause means every incoming task is failing the same way, which
      // in practice means the integration branch is broken. That is the one
      // pause the operator must hear about the moment it happens, wherever
      // they are — including mid-grill — because until it clears nothing they
      // queue can land. An operator pause needs no announcement: they did it.
      if (state.paused && state.reason === 'storm') {
        void announceBrokenGate(state.detail).catch((err: unknown) => {
          log(`[pause] could not announce the broken gate: ${(err as Error).message}`)
        })
      }
    },
  })
  // An OPERATOR pause is persisted to daemon.json so the intent survives a
  // daemon auto-respawn (ADR-0058): a new process coming up unpaused could
  // trigger a merge-step git reset --hard on uncommitted operator work. It is
  // restored first, so it wins the first-cause slot over a storm pause
  // restored later from the breaker's durable `tripped` flag.
  const restoredOperatorPause = readPersistedPaused()
  if (restoredOperatorPause) {
    pause.pause('operator', 'restored from daemon.json')
  }
  // Heartbeat startup deliberately begins with dispatch disabled: initialization
  // work is not a period in which queued tasks can make progress.
  heartbeatHandle?.setDispatchEnabled(acceptingWork && !pause.isPaused())

  // Per-kind concurrency caps. glossary-write and adr-add share one pool
  // because they both contend on the same merge lock downstream — a second
  // slot would just sit waiting on the lock, so default to 1.
  const initialConfig = loadDaemonConfig()
  // Re-apply persisted operator control levers before dispatch starts so a
  // hold set before a daemon restart survives it (e.g. recovery='off' holds
  // across `mars daemon restart`).
  applyControlLevers(initialConfig.controlLevers)
  const initialCaps = initialConfig.caps
  // Document-write dispatch kinds ('glossary-write', 'adr-add',
  // 'adr-supersede', 'vision') are now coordinated by DocumentWriteCoordinator
  // — no shared semaphore needed.
  const docCoordinator = new DocumentWriteCoordinator()
  // 'merge' is a tracker-only kind (no per-kind semaphore); excluded here.
  // Document-write kinds use docCoordinator rather than semaphores.
  const sems: Record<
    Exclude<
      DispatchKind,
      'merge' | 'arc-verify' | 'glossary-write' | 'adr-add' | 'adr-supersede' | 'vision'
    >,
    Semaphore
  > & {
    arcVerify: Semaphore
  } = {
    triage: makeSem(initialCaps.triage),
    implement: makeSem(initialCaps.implement),
    refine: makeSem(initialCaps.refine),
    // Arc verification is best-effort post-merge analysis. Keep its historic
    // single-run cap, but make the run visible to the daemon worker pool.
    arcVerify: makeSem(1),
  }
  // Verify concurrency semaphore: caps parallel verify (npm test / typecheck)
  // steps independently of the implement cap. Default: MARS_MAX_VERIFY (2).
  // Acquired inside the review primitive; the implement slot is released first
  // so other tasks can continue coding while this one waits for a verify slot.
  const verifySem = makeSem(initialCaps.verify)
  // Install concurrency semaphore: caps parallel worktree dep-installs to
  // prevent concurrent tsup/esbuild prepare scripts from OOM-killing the process.
  // Lives in worktree-install.ts as a module-level semaphore; the daemon
  // sets the initial cap here and updates it on `reload-config`.
  setInstallSemCap(initialCaps.setupInstall)
  log(
    `concurrency caps: implement=${sems.implement.limit} triage=${sems.triage.limit} refine=${sems.refine.limit} arc-verify=${sems.arcVerify.limit} setup-install=${initialCaps.setupInstall} verify=${verifySem.limit}`,
  )
  if (restoredOperatorPause) {
    log(
      '[pause] restored persisted paused state from daemon.json — dispatch suspended. Run `mars operator set dispatch on` to re-enable dispatch.',
    )
  }

  // Why the EFFECTIVE implement cap differs from the configured one, in one
  // operator-facing line. Written by the Steward autotuner on every cap
  // decision (raise or hold) and surfaced by `mars daemon status`, so nobody
  // has to reconcile `implement: 3` in .mars/daemon.json against a daemon
  // that is actually running at 1.
  let implementCapReason: string | null = null

  /** Live set of in-flight task ids — used to protect their subprocesses. */
  const liveInFlightTaskIds = (): ReadonlySet<string> =>
    new Set(tracker.inFlightSnapshot().map((e) => e.taskId))

  // Drain single-flight gate. While `drainRunning` is true, a second call
  // sets `drainAgain` and returns; the running drain re-runs once it finishes.
  // This + the claimed sets together guarantee no task id is ever dispatched
  // more than once concurrently.
  let drainRunning = false
  let drainAgain = false

  // Unlike task dispatch, arc verification is best-effort and must shed rather
  // than accumulate a backlog. This set normally holds at most one id: it
  // bridges the synchronous outbox handler to the single-flight drain loop.
  const pendingArcVerifications = new Set<string>()

  // Forward-declared so dispatchers can call it from finally; assigned after
  // both dispatchers exist.
  let drain: () => Promise<void> = async () => {}

  const dispatchArcVerification = async (originId: string): Promise<void> => {
    pendingArcVerifications.delete(originId)
    if (isArcVerifyDisabled()) {
      log(`[arc-verifier] ${originId}: skipped; arc verification is disabled`)
      void drain()
      return
    }
    await acquire(sems.arcVerify)
    const releaseTracking = tracker.commitInFlight(originId, 'arc-verify')
    log(`[arc-verifier] ${originId} dispatching`)
    try {
      await runArcVerification(originId, {
        cwd: process.env.MARS_REPO ?? process.cwd(),
      })
    } catch (err) {
      // Best-effort post-merge analysis must never destabilize the daemon.
      log(`[arc-verifier] ${originId} failed: ${(err as Error).message}`)
    } finally {
      releaseTracking()
      release(sems.arcVerify)
      void drain()
    }
  }

  const scheduleArcVerification = (originId: string) => {
    if (!acceptingWork || pause.isPaused()) return 'skipped-paused' as const
    if (sems.arcVerify.inUse + pendingArcVerifications.size >= sems.arcVerify.limit) {
      log(`[arc-verifier] ${originId}: shedding verification; pool is at capacity`)
      return 'skipped-capacity' as const
    }

    const result = triggerArcVerification(originId)
    if (result !== 'triggered') return result

    pendingArcVerifications.add(originId)
    void drain()
    return result
  }

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
      const result = await runTriage(taskId, getDefaultDomainTaskStore(), traceStore)
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
    const usageSnapshot = await getLatestUsageSnapshot(dbClient)
    const deferral = shouldDeferDispatch(
      task,
      usageSnapshot,
      getBudgetPressureConfig(),
    )
    if (deferral.defer) {
      const targetWindowEnd =
        typeof usageSnapshot?.rawJson.nextResetAt === 'string'
          ? usageSnapshot.rawJson.nextResetAt
          : null
      await upsertDeferral({
        taskId: task.id,
        reason: deferral.reason ?? 'usage pressure requires deferral',
        targetWindowEnd,
        pressure: usageSnapshot === null
          ? 'ok'
          : computeBudgetPressure(usageSnapshot, getBudgetPressureConfig()),
      }, dbClient)
      tracker.unclaim(task.id, 'implement')
      log(`[implement] ${task.id} deferred: ${deferral.reason}`)
      return
    }
    await deleteDeferral(task.id, dbClient)
    await acquire(sems.implement)
    // commitInFlight records the inFlight entry AND clears the matching claim
    // in one step (claim-clears-after-commit); see dispatchTriage.
    const taskAbortController = new AbortController()
    const releaseTracking = tracker.commitInFlight(
      task.id,
      'implement',
      taskAbortController,
    )
    // Merge-queue handoff bookkeeping.
    // `mergeHandedOff` flips to true when the workflow calls enqueueMergeJobAndAwait,
    // at which point the implement slot has been released and merge tracking started.
    let releaseMergeTracking: (() => void) | null = null
    let mergeHandedOff = false
    // Verify-slot handoff bookkeeping.
    // `verifyHandedOff` flips to true when the review primitive calls
    // acquireVerifySlot(), at which point the implement slot and tracking are
    // released so other tasks can continue coding while this task is queued
    // behind the verify semaphore (or actively running verify).
    let verifyHandedOff = false
    log(`[implement] ${task.id} dispatching`)
    try {
      // Slice F.2: dispatch-time dirty-main check. Runs BEFORE workflow
      // dispatch (i.e. before the worktree is created) so we never burn the
      // coding turn on a tree we'd reject at verify anyway.
      // isDispatchDirtyMainExempt captures the full exemption set:
      //   - kind='fix' (the main-commiter IS the dirty-main fix; must dispatch)
      //   - workflow='report' (read-only, never merges; dirty branch irrelevant)
      if (!isDispatchDirtyMainExempt(task)) {
        try {
          const { runMainDirtyDispatchCheck } = await import(
            './main-dirty-dispatch'
          )
          const dirtyResult = await runMainDirtyDispatchCheck({
            task,
            integrationBranch,
            traceStore,
            recipeCatalog,
            log,
          })
          if (dirtyResult.parked) {
            // Source is now `blocked` with an edge to a (new or existing)
            // main-commiter, OR the integration branch has unrelated dirt that
            // the committer cannot resolve (action-queue alert raised instead).
            // Either way, skip dispatching the workflow — its first step
            // (setup) would just hit the same condition.
            //
            // When a FRESH committer was spawned, emit task.queued for it so
            // the dispatch loop picks it up immediately. Without this, the
            // committer row sits in `queued` forever unless the daemon restarts
            // (reseed-dispatch re-seeds it at boot). The bus handler pushes the
            // id into pendingImplement and calls drain().
            if ('fixTaskId' in dirtyResult && dirtyResult.spawned) {
              bus.emit('task.queued', { taskId: dirtyResult.fixTaskId })
            }
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
      // Eagerly persist 'running' so the DB count matches the in-flight tracker
      // before the setup-worktree step executes. Without this, there is a window
      // between commitInFlight (which makes the task visible in 'mars daemon
      // status' inFlight counts) and the first updateTask({status:'running'})
      // inside the setup-worktree step during which the DB still shows 'queued'.
      // That window causes the UI (which reads from the DB) to under-report
      // in-progress work and the post-restart reconcile to see the task as queued.
      // The setup-worktree step's own updateTask is still present — on a
      // checkpoint resume where setup is already done it is the only place the
      // status is set to 'running', so both writes are load-bearing.
      await updateTask(task.id, {
        status: 'running',
        // Persist the cumulative dispatch uptime once, at the beginning of a
        // re-queue episode. Subsequent re-dispatches retain the same anchor so
        // real retry churn continues to consume its original budget.
        ...(task.requeueDispatchUptimeMs === null || task.requeueDispatchUptimeMs === undefined
          ? { requeueDispatchUptimeMs: heartbeatHandle?.getDispatchUptimeMs() ?? null }
          : {}),
      }).catch((err) => {
        log(
          `[implement] ${task.id} eager-running update failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
      const { runWorkflow } = await import('@mars/workflow')
      const { createQueueWorkflowStore, loadWorkflowByName } = await import(
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
      const workflowKind = pickWorkflowFor(task)
      // Resolve the workflow to run by NAME: the task's `workflow` field wins,
      // else default-by-kind. NO fallback (supersedes ADR-0056's clause): a
      // missing/malformed file fails the task right here with an actionable
      // message rather than silently running a different pipeline — with
      // per-step Execution modes, silent substitution would hand a manual
      // step to an agent. This changes WHICH workflow runs — not the engine
      // and not the write funnel: `services.store` is still the Arc-routed
      // TaskStore (S4), so task-state writes keep going through the aggregate.
      const workflowName = task.workflow ?? task.kind ?? 'task'
      let workflowToRun
      if (workflowKind === 'coordinator') {
        // This module is intentionally loaded only for coordinator-owned work:
        // ordinary tasks continue to resolve their user-selected workflow.
        // The string variable keeps this daemon slice independently type-checkable
        // until the coordinator pipeline lands from its prerequisite slice.
        const coordinatorWorkflowModule = '../../workflows/coordinator-workflow'
        const { coordinatorWorkflow } = await import(coordinatorWorkflowModule)
        workflowToRun = coordinatorWorkflow
      } else {
        try {
          workflowToRun = await loadWorkflowByName(workflowName)
        } catch (loadErr) {
          const loadMsg =
            loadErr instanceof Error ? loadErr.message : String(loadErr)
          log(`[implement] ${task.id} workflow load failed: ${loadMsg}`)
          await updateTask(task.id, {
            status: 'failed',
            error: loadMsg,
            failureReason: loadMsg,
            failureReasonCode: 'dispatch:workflow-load',
            failureSignature: computeFailureSignature(
              'dispatch:workflow-load',
              workflowName,
            ),
          })
          bus.emit('task.failed', { taskId: task.id, error: loadMsg })
          return
        }
      }
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
      //
      // Heartbeat: on each `claude-event` we update the in-flight entry's
      // `lastActivityMs` so the phantom-task watchdog can distinguish a
      // healthy long-running coder from a genuinely hung one. We also touch
      // `task.updatedAt` in the DB (throttled to ~once per minute) so the
      // row stays observable by monitoring tools.
      let lastDbHeartbeatMs = 0
      const HEARTBEAT_INTERVAL_MS = 60_000
      const onEvent = (evt: WorkflowEvent): void => {
        if (evt.event === 'claude-event') {
          const nowMs = Date.now()
          tracker.recordActivity(task.id, nowMs)
          if (nowMs - lastDbHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
            lastDbHeartbeatMs = nowMs
            // Best-effort: a failed heartbeat write is non-fatal — the
            // in-memory lastActivityMs is the authoritative liveness signal.
            void updateTask(task.id, {}).catch(() => {})
          }
          // Token usage is NOT accumulated here: this bus event carries no
          // provider, and where usage lives on a stream is a per-provider fact
          // (assistant events for Claude, one terminal `turn.completed` for
          // Codex). The spend meter is fed from runWorkerWithSpan, which knows
          // the Worker's Provider — see recordUsageEvent.
          return
        }
        if (evt.event === 'vcs-supervisor-event') return
        log(`[implement] ${task.id} ${evt.step ?? 'run'}:${evt.event}`)
      }
      // Detect a resume that must re-enter the coder. A verify failure has
      // completed code checkpoints, but continue clears them so the worker can
      // repair its own diff instead of re-running an unchanged verify step.
      // failedPhase stays on the row across re-queue, which distinguishes this
      // from a first-time dispatch.
      const resumeFromPriorAttempt =
        (task.failedPhase === 'code' || task.failedPhase === 'verify') && !!task.worktreePath
      const verifyResumeEvent =
        task.failedPhase === 'verify'
          ? (await traceStore.query({
              taskId: task.id,
              phase: ['verify'],
              kind: ['step_ended'],
              limit: 1,
            }))[0]
          : undefined
      const verifyFailureOutput =
        typeof verifyResumeEvent?.payload.commandOutput === 'string'
          ? verifyResumeEvent.payload.commandOutput
          : task.failedPhase === 'verify'
            ? task.error
            : null
      const result = await runWorkflow(
        workflowToRun,
        workflowKind === 'coordinator'
          ? { coordinatorTaskId: task.id }
          : {
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
                  mergeMode: task.spec.mergeMode,
                  readFirst: [...(task.spec.readFirst ?? [])],
                  prescriptiveAction: task.spec.prescriptiveAction ?? null,
                }
              : null,
            resumeFromPriorAttempt,
            verifyFailureOutput,
            recoveryPayload: task.recoveryPayload ?? null,
            fixForTaskId: task.fixForTaskId ?? null,
            qa: task.qa ?? 'auto',
          },
        {
          store: workflowStore,
          services: {
            store: taskStore,
            traceStore,
            // Wire the spawn-time PID callback so the phantom-task watchdog can
            // use PID liveness (case b/c) instead of the bare wall-clock ceiling
            // on task.updatedAt (case a). Fixes the failure storm observed on
            // 2026-07-20 where 30-min+ coder runs were ceiling-killed while still
            // healthy because recordPid was defined but never called from the
            // dispatch path.
            onPid: (pid: number) => tracker.recordPid(task.id, pid),
            // Promise-based manual step park/resume hook (ADR-0052 write funnel).
            // Called by runAgent/verify when mode === 'manual'; parks the task and
            // suspends the workflow until handleStepDone resolves the promise.
            // Preserves lease_owner and origin_session_id across parks so the
            // Foreground session walks the runbook without re-attaching.
            onManualPark: async ({
              runId,
              taskId,
              stepName,
              guide,
            }: {
              runId: string
              taskId: string
              stepName: string
              guide: string | null
            }): Promise<void> => {
              const now = new Date().toISOString()
              // Preserve the prior lease owner across manual steps so the same
              // Foreground operator re-receives the lease at the next park
              // without re-attaching ('mars step done' keepLease:true kept it).
              let leaseOwner: string = AWAIT_HUMAN_SENTINEL
              try {
                const t = await getTask(taskId, taskStore)
                if (t?.leaseOwner && t.leaseOwner !== AWAIT_HUMAN_SENTINEL) {
                  leaseOwner = t.leaseOwner
                }
              } catch { /* fall through — park under sentinel identity */ }
              await updateTask(
                taskId,
                {
                  status: 'awaiting-human',
                  leaseOwner,
                  leasedAt: now,
                  leaseNote: guide,
                  currentStepName: stepName,
                  currentStepGuide: guide,
                },
                taskStore,
              )
              raiseActionQueueItem({
                kind: 'awaiting-human',
                category: 'daemon',
                priority: 'normal',
                title: `Task ${taskId} parked at step '${stepName}' — awaiting human`,
                body:
                  `Task ${taskId} is parked at manual step '${stepName}'.` +
                  (guide ? ` Step guide: ${guide}.` : '') +
                  ` Lease: ${leaseOwner}. Run \`mars step done ${taskId}\` to continue.`,
                payload: { taskId, leaseOwner, leasedAt: now, leaseNote: guide, stepName },
                context: { taskId },
                raisedBy: 'primitive:manual-step',
                signature: taskId,
                originTaskId: taskId,
                occurrence: { leaseOwner, leasedAt: now, parkedAt: now },
              }).catch((err: unknown) => {
                console.error(
                  `[manual-park] task ${taskId} action-queue raise errored:`,
                  err,
                )
              })
              return awaitManualDone(runId, stepName)
            },
            // Verify-slot hooks. The review primitive (auto path) calls
            // acquireVerifySlot() before running verifyChanges and
            // releaseVerifySlot() in its finally block.
            //
            // At the point of acquireVerifySlot:
            //   1. The implement slot and tracker entry are released so other
            //      tasks can start coding while this task is queued on verify.
            //   2. drain() is called so freed implement slots are picked up.
            //   3. The verify semaphore (verifySem, MARS_MAX_VERIFY) is acquired
            //      — this is where the task may block until a slot is free.
            //
            // There is no circular dependency: coding never waits on verify, so
            // a task blocked on verifySem cannot prevent verifySem from being
            // released. No deadlock is possible.
            acquireVerifySlot: async (): Promise<void> => {
              if (!verifyHandedOff) {
                verifyHandedOff = true
                releaseTracking()
                release(sems.implement)
                void drain()
              }
              await acquire(verifySem)
            },
            releaseVerifySlot: (): void => {
              release(verifySem)
            },
            // Durable merge-queue hook. The merge primitive always routes git
            // merges through the single-consumer worker. At the point of
            // handoff the implement semaphore slot and tracker entry are
            // released so other coders can proceed while this task is parked
            // in the merge queue. Merge tracking (kind='merge') replaces the
            // implement entry in the inFlight map.
            enqueueMergeJobAndAwait: async (args: {
              taskId: string
              branch: string
              worktreePath: string
              integrationBranch: string
            }) => {
              if (!mergeHandedOff) {
                mergeHandedOff = true
                // A verify handoff already returned the implement slot and
                // removed this task from implement tracking. Do not release
                // either a second time when the following merge step starts.
                if (!verifyHandedOff) {
                  releaseTracking()
                  release(sems.implement)
                }
                releaseMergeTracking = tracker.commitInFlight(task.id, 'merge')
                void drain()
              }
              const result = await enqueueMergeJobAndAwait({
                store: getDefaultMergeJobStore(),
                bus,
                ...args,
              })
              releaseMergeTracking?.()
              releaseMergeTracking = null
              return result
            },
          },
          runId: task.id,
          logger: workflowLogger,
          onEvent,
          signal: taskAbortController.signal,
        },
      )
      if (taskAbortController.signal.aborted) {
        log(`[implement] ${task.id} stopped by operator`)
        return
      }
      // Switch on the WorkflowTerminalError discriminant.  The workflow steps
      // throw WorkflowTerminalError (subclass of Error) with a `kind` field for
      // every self-handled terminal condition; the engine propagates it verbatim
      // via RunResult.error.  A single instanceof check replaces the previous
      // family of message-substring predicates.
      const resultTerminal =
        result.status === 'failed' && result.error instanceof WorkflowTerminalError
          ? result.error
          : null
      if (resultTerminal !== null) {
        switch (resultTerminal.kind) {
          case 'blockers-abort':
            log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
            return

          case 'quota-rejected': {
            // Provider rate/spend-limit rejection: the code step re-queued the
            // task with its worktree intact and threw the quota-rejected sentinel.
            // Pause dispatch until resetsAt + jitter and raise exactly one
            // level-triggered action-queue row. Task status is already 'queued' —
            // suppress the task.completed emit so the task stays pending.
            const resetsAt = resultTerminal.meta.resetsAt ?? 0
            void handleQuotaRejection(resetsAt)
            log(`[implement] ${task.id} env-rejected: quota; task re-queued, dispatch paused until ${new Date(resetsAt * 1000).toISOString()}`)
            return
          }

          case 'main-dirty-verify':
            // Slice F.2: verify-time dirty-main detection. The verify step parked
            // the source `blocked` behind a `main-commiter` recovery and threw a
            // sentinel; suppress the misleading `task.completed status=failed` emit.
            log(`[implement] ${task.id} parked blocked: integration branch dirty at verify; main-commiter spawned/attached`)
            return

          case 'main-dirty-merge':
            // Merge-time dirty-main detection. The merge step parked the source
            // `blocked` behind a `main-commiter` recovery and threw a sentinel.
            log(`[implement] ${task.id} parked blocked: integration branch dirty at merge; main-commiter spawned/attached`)
            return

          case 'context-exhausted':
            // A context-budget exhaustion abort marks the task `failed` with cause
            // 'context-exhausted' and enqueues one follow-up task.
            log(`[implement] ${task.id} failed: context-budget ceiling abort; follow-up enqueued`)
            bus.emit('task.completed', { taskId: task.id, status: result.status })
            return

          case 'origin-worktree-missing':
            // A recovery (kind=fix) task whose origin worktree is gone: the setup
            // step already marked it failed and raised an operator action-queue item.
            // Suppress both the re-update and the `task.completed` emit.
            log(`[implement] ${task.id} failed: origin worktree missing; recovery cannot attach (action-queue item raised)`)
            return

          case 'origin-terminal':
            log(`[implement] ${task.id} dropped: its Chore origin already reached a terminal state`)
            return

          case 'await-human': {
            // The primitive parked the task in 'awaiting-human', raised the
            // action-queue row, and threw this sentinel so the step does NOT
            // checkpoint as 'completed'. Patch the step record to 'completed' now
            // so the engine short-circuits it on re-dispatch.
            const stepName = resultTerminal.meta.stepName ?? null
            if (stepName !== null) {
              try {
                const { createQueueWorkflowStore } = await import('../../workflows/queue-workflow-store')
                const wfStore = createQueueWorkflowStore()
                const step = await wfStore.getStep(task.id, stepName)
                if (step !== undefined && step.status !== 'completed') {
                  await wfStore.putStep({
                    ...step,
                    status: 'completed',
                    finishedAt: Date.now(),
                    resultJson: JSON.stringify({ parkedForHuman: true }),
                  })
                }
              } catch (patchErr) {
                log(
                  `[implement] ${task.id} await-human: step-completion patch errored (non-fatal): ${
                    patchErr instanceof Error ? patchErr.message : String(patchErr)
                  }`,
                )
              }
            }
            log(`[implement] ${task.id} parked awaiting-human: lease holder = ${AWAIT_HUMAN_SENTINEL}`)
            return
          }

          case 'coder-exit-nonzero':
          case 'coder-uncommitted':
            // These are self-handled in the code step (it already marked the task
            // failed with a precise failureReason and spawned exactly one recovery
            // fix-task before throwing). Fall through to the normal bus.emit so the
            // task transitions out of the running state.
            break
        }
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
      if (taskAbortController.signal.aborted) {
        log(`[implement] ${task.id} stopped by operator`)
        return
      }
      // The blockers-abort detector lives in the implement workflow module. A
      // dynamic import can itself reject (module-resolution / eval error), and
      // that rejection would escape this catch. Load it best-effort: if the
      // import fails, treat the error as an ordinary failure rather than a
      // benign blockers-abort — failing the task is the safe default.
      // On the exception path, WorkflowTerminalError is already available as a
      // static import — no dynamic import needed. The same discriminant-switch
      // logic applies, but most terminal kinds are already fully self-handled
      // inside the workflow before throwing; we only need to suppress the
      // generic `implement:crashed` re-update for those cases.
      if (err instanceof WorkflowTerminalError) {
        switch (err.kind) {
          case 'blockers-abort':
            log(`[implement] ${task.id} aborted: blockers added between dispatch and execution; task remains queued`)
            break
          case 'context-exhausted':
            // The workflow already marked this task failed with cause 'context-exhausted'.
            log(`[implement] ${task.id} context-budget ceiling abort (exception path); task already marked failed`)
            break
          case 'origin-worktree-missing':
            // The setup step already marked this fix task failed and raised an item.
            log(`[implement] ${task.id} origin-worktree-missing abort (exception path); task already marked failed, item raised`)
            break
          case 'resume-worktree-missing':
            // The code step's resume preflight already marked this task failed
            // with the code:worktree-missing signature.
            log(`[implement] ${task.id} resume-worktree-missing abort (exception path); task already marked failed`)
            break
          case 'worktree-rebase-conflict':
            // ensureWorktreeCurrent already marked this task failed with the
            // {setup,code}:worktree-rebase-conflict signature and raised an
            // operator item. The rebase was aborted; the worktree is intact.
            log(`[implement] ${task.id} worktree-rebase-conflict abort (exception path); task already marked failed, item raised`)
            break
          case 'origin-terminal':
            log(`[implement] ${task.id} origin-terminal abort (exception path); Chore already dropped`)
            break
          case 'coder-exit-nonzero':
          case 'coder-uncommitted':
            // The code step already marked this task failed and spawned recovery.
            log(`[implement] ${task.id} coder self-handled abort (exception path); task already marked failed, recovery spawned`)
            break
          case 'await-human':
            // The awaitHuman primitive already parked the task.
            log(`[implement] ${task.id} await-human abort (exception path); task already parked awaiting-human`)
            break
          case 'quota-rejected': {
            const resetsAt = err.meta.resetsAt ?? 0
            void handleQuotaRejection(resetsAt)
            log(`[implement] ${task.id} env-rejected abort (exception path); task re-queued, dispatch paused`)
            break
          }
          case 'main-dirty-verify':
          case 'main-dirty-merge':
            // These are fully self-handled; suppress the generic re-update.
            log(`[implement] ${task.id} ${err.kind} abort (exception path); task already handled`)
            break
        }
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
      //
      // Three mutually-exclusive handoff states:
      //   mergeHandedOff=true  — implement slot released at merge handoff; only
      //                          clean up remaining merge tracking here.
      //   verifyHandedOff=true — implement slot and tracking already released
      //                          when the review primitive called acquireVerifySlot;
      //                          the verify semaphore is released inside the
      //                          review primitive's own finally block.
      //   neither              — task never reached verify or merge; release the
      //                          implement slot now.
      if (mergeHandedOff) {
        // TS CFA inside an async function incorrectly narrows `releaseMergeTracking`
        // to `null` here (it sees the `= null` assignment in the service closure and
        // concludes the type at this point is always null). Cast to the declared type.
        const releaseMerge = releaseMergeTracking as (() => void) | null
        if (releaseMerge !== null) releaseMerge()
      } else if (!verifyHandedOff) {
        releaseTracking()
        release(sems.implement)
      }
      // When verifyHandedOff=true the implement slot was already released inside
      // acquireVerifySlot. The verify semaphore is released by releaseVerifySlot
      // in the review primitive's finally block. Nothing to release here.
      void drain()
    }
  }

  const dispatchGlossaryWrite = async (req: {
    kind: 'set' | 'remove'
    term: string
    definition?: string
    aliases?: readonly string[]
    surfaceForms?: readonly string[]
  }): Promise<void> => {
    const synthetic = `glossary-write:${req.kind}:${req.term}:${Date.now()}`
    const releaseTracking = tracker.commitInFlight(synthetic, 'glossary-write')
    log(`[glossary-write] ${req.kind} "${req.term}" dispatching`)
    try {
      // Glossary terms are stored in CONTEXT.md; serialize all glossary writes
      // against that unit path so concurrent term edits don't conflict.
      await docCoordinator.run('CONTEXT.md', async () => {
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
                ...(req.surfaceForms ? { surfaceForms: req.surfaceForms } : {}),
              })
              await writeGlossaryFile(path, next)
              return
            }
            const { doc: nextDoc, removed } = removeTermByName(doc, req.term)
            if (!removed) return false
            await writeGlossaryFile(path, nextDoc)
          },
          enqueueMerge: async (mergeArgs) =>
            enqueueMergeJobAndAwait({
              store: getDefaultMergeJobStore(),
              bus,
              ...mergeArgs,
            }),
        })
        if (outcome.kind === 'aborted') {
          log(
            `[glossary-write] ${req.kind} "${req.term}" -> aborted: ${outcome.reason}`,
          )
        } else {
          log(`[glossary-write] ${req.kind} "${req.term}" -> ${outcome.kind}`)
        }
      })
    } catch (err) {
      // One bad structured-write must NEVER crash the daemon. This dispatcher
      // is invoked fire-and-forget (`void dispatchGlossaryWrite(...)`), so an
      // escaping rejection becomes an unhandledRejection that kills the
      // process. The action-queue raise makes this otherwise detached failure
      // visible without compromising that containment.
      log(
        `[glossary-write] ${req.kind} "${req.term}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      await raiseStructuredWriteFailureAction({
        kind: 'glossary',
        target: req.term,
        error: err,
      }).catch((raiseErr: unknown) => {
        log(
          `[glossary-write] ${req.kind} "${req.term}" failed to raise action-queue item: ${
            raiseErr instanceof Error ? raiseErr.message : String(raiseErr)
          }`,
        )
      })
    } finally {
      releaseTracking()
    }
  }

  const dispatchAdrAdd = async (req: {
    title: string
    body: string
  }): Promise<void> => {
    const synthetic = `adr-add:${req.title}:${Date.now()}`
    const releaseTracking = tracker.commitInFlight(synthetic, 'adr-add')
    log(`[adr-add] "${req.title}" dispatching`)
    try {
      // Each ADR lands in a unique numbered file (NNNN-slug.md), so concurrent
      // ADR additions never touch the same path. No coordinator needed — the
      // atomic file-number allocator (nextAdrNumber) is the sole correctness gate.
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
        enqueueMerge: async (mergeArgs) =>
          enqueueMergeJobAndAwait({
            store: getDefaultMergeJobStore(),
            bus,
            ...mergeArgs,
          }),
      })
      if (outcome.kind === 'aborted') {
        log(`[adr-add] "${req.title}" -> aborted: ${outcome.reason}`)
      } else {
        log(`[adr-add] "${req.title}" -> ${outcome.kind}`)
      }
    } catch (err) {
      // One bad structured-write must NEVER crash the daemon. This dispatcher
      // is invoked fire-and-forget (`void dispatchAdrAdd(...)`), so an escaping
      // rejection becomes an unhandledRejection that kills the process. Raise
      // an action-queue item as well, then release the slot in finally.
      log(
        `[adr-add] "${req.title}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      await raiseStructuredWriteFailureAction({
        kind: 'adr',
        target: req.title,
        error: err,
      }).catch((raiseErr: unknown) => {
        log(
          `[adr-add] "${req.title}" failed to raise action-queue item: ${
            raiseErr instanceof Error ? raiseErr.message : String(raiseErr)
          }`,
        )
      })
    } finally {
      releaseTracking()
    }
  }

  /**
   * Write the product vision to `docs/knowledge/vision.md` via the
   * structured-write pipeline.
   *
   * Unlike `dispatchGlossaryWrite` / `dispatchAdrAdd` (fire-and-forget),
   * callers AWAIT this function — the `vision-write` RPC handler awaits it so
   * `mars vision set` exits only after the file has merged.
   */
  const dispatchVisionWrite = async (content: string): Promise<void> => {
    const synthetic = `vision-write:${Date.now()}`
    const releaseTracking = tracker.commitInFlight(synthetic, 'vision')
    log(`[vision-write] dispatching`)
    try {
      const { VISION_PATH, writeVisionInWorktree } = await import('../lib/vision')
      // Serialize vision writes against the canonical vision.md unit path.
      await docCoordinator.run(VISION_PATH, async () => {
        const { runStructuredWrite } = await import('../lib/structured-write')

        const outcome = await runStructuredWrite({
          kind: 'vision',
          commitMessage: 'vision: set product vision',
          integrationBranch,
          mutate: async (worktreePath) => {
            await writeVisionInWorktree(worktreePath, content)
          },
          enqueueMerge: async (mergeArgs) =>
            enqueueMergeJobAndAwait({
              store: getDefaultMergeJobStore(),
              bus,
              ...mergeArgs,
            }),
        })
        if (outcome.kind === 'aborted') {
          log(`[vision-write] -> aborted: ${outcome.reason}`)
        } else {
          log(`[vision-write] -> ${outcome.kind}`)
        }
      })
    } catch (err) {
      // The vision-write RPC handler awaits this function, so a rejection
      // propagates back to the CLI call site as an error response.
      // Still raise an action-queue row so the failure is surfaced visibly.
      log(
        `[vision-write] failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      await raiseStructuredWriteFailureAction({
        kind: 'vision',
        target: 'vision.md',
        error: err,
      }).catch((raiseErr: unknown) => {
        log(
          `[vision-write] failed to raise action-queue item: ${
            raiseErr instanceof Error ? raiseErr.message : String(raiseErr)
          }`,
        )
      })
      throw err
    } finally {
      releaseTracking()
    }
  }

  const dispatchAdrSupersede = async (req: {
    oldNumber: string
    newNumber: string
  }): Promise<void> => {
    const label = `${req.oldNumber}→${req.newNumber}`
    const synthetic = `adr-supersede:${label}:${Date.now()}`
    const releaseTracking = tracker.commitInFlight(synthetic, 'adr-supersede')
    log(`[adr-supersede] ${label} dispatching`)
    try {
      const { runStructuredWrite } = await import('../lib/structured-write')
      const { supersedeAdrInWorktree } = await import('../lib/adr')

      // Unlike `adr-add` (which allocates a fresh numbered file and so never
      // collides), a supersede mutates the EXISTING ADR numbered `oldNumber`.
      // Two concurrent supersedes of the same ADR would race on that one path,
      // so serialize them on it via the document-write coordinator.
      await docCoordinator.run(`docs/knowledge/decisions/${req.oldNumber}`, async () => {
        const outcome = await runStructuredWrite({
          kind: 'adr',
          commitMessage: `adr: supersede ${req.oldNumber} with ${req.newNumber}`,
          integrationBranch,
          mutate: async (worktreePath) => {
            await supersedeAdrInWorktree({
              worktreePath,
              oldNumber: req.oldNumber,
              newNumber: req.newNumber,
            })
          },
          enqueueMerge: async (mergeArgs) =>
            enqueueMergeJobAndAwait({
              store: getDefaultMergeJobStore(),
              bus,
              ...mergeArgs,
            }),
        })
        if (outcome.kind === 'aborted') {
          log(`[adr-supersede] ${label} -> aborted: ${outcome.reason}`)
        } else {
          log(`[adr-supersede] ${label} -> ${outcome.kind}`)
        }
      })
    } catch (err) {
      log(
        `[adr-supersede] ${label} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      await raiseStructuredWriteFailureAction({
        kind: 'adr',
        target: label,
        error: err,
      }).catch((raiseErr: unknown) => {
        log(
          `[adr-supersede] ${label} failed to raise action-queue item: ${
            raiseErr instanceof Error ? raiseErr.message : String(raiseErr)
          }`,
        )
      })
    } finally {
      releaseTracking()
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
      // Wire the TaskStore and TraceEventStore from the composition root into
      // the workflow so reads route through the store (ADR-0021 seam) and
      // span/event capture goes through the daemon-opened traceStore.
      const taskStore = await getDefaultTaskStore()
      const result = await runPlan(taskId, refresh, taskStore, traceStore)
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

  // Pick the highest-priority pending task. Ties broken first by whether the
  // task's arc has already started (a sibling in running/verifying/merging/done),
  // then by oldest createdAt (FIFO). Returns null if no pending row resolves
  // to a real task (drained while we looked).
  const pickNextImplement = async (): Promise<string | null> => {
    // Phase 1: collect all eligible candidates.
    const candidates: PickCandidate[] = []
    for (const id of tracker.drainPending('implement')) {
      // Skip ids already claimed by an in-flight (or about-to-be-in-flight)
      // dispatch — without this the same id can be picked by parallel
      // drains during the gap between pop-from-pending and acquire-slot.
      if (tracker.isClaimed(id, 'implement') || tracker.isInFlight(id)) continue
      const t = await getTask(id)
      if (!t) continue
      candidates.push({ id, priority: t.priority, createdAt: t.createdAt, originId: t.originId ?? null })
    }
    if (candidates.length === 0) return null

    // Phase 2: determine which origins already have started siblings.
    // An origin is STARTED iff any task with origin_id = <that id> has a
    // status in ('running','verifying','merging','done').
    // Guard the empty-candidate case so we never send an empty IN ().
    const distinctOriginIds = [
      ...new Set(
        candidates
          .map((c) => c.originId)
          .filter((o): o is string => o !== null),
      ),
    ]
    let startedOriginIds = new Set<string>()
    if (distinctOriginIds.length > 0) {
      const placeholders = distinctOriginIds.map(() => '?').join(', ')
      const { rows: startedRows } = await getCompositionRootClient().execute({
        sql: `SELECT DISTINCT origin_id
                FROM tasks
               WHERE origin_id IN (${placeholders})
                 AND status IN ('running', 'verifying', 'merging', 'done')`,
        args: distinctOriginIds,
      })
      startedOriginIds = new Set(
        startedRows.map((r) => r['origin_id'] as string),
      )
    }

    // Phase 3: pick the best candidate by the three-level comparator.
    return selectBestCandidate(candidates, startedOriginIds)?.id ?? null
  }

  // Drain pulls from the pending sets as semaphore slots free. Bus handlers
  // and dispatcher finally-blocks both call this. It's idempotent and cheap
  // when there's nothing to do.
  // Single-flight: only one drain runs at a time. Concurrent invocations
  // (from bus events, dispatcher finally-blocks, etc.) flip drainAgain so
  // the running drain re-enters once it finishes — no double-pick races.
  drain = async (): Promise<void> => {
    if (!acceptingWork) return
    if (pause.isPaused()) return
    if (drainRunning) {
      drainAgain = true
      return
    }
    drainRunning = true
    try {
      do {
        drainAgain = false
        // A throw from any await below (getTask / hasIncompleteBlockers
        // hitting a transient connection or query error under load)
        // must not escape: drain() is invoked fire-and-forget
        // (`void drain()`), so an uncaught rejection silently kills the
        // loop with no log line and the daemon stops claiming work while
        // staying alive. Catch per-pass, log, and let the do/while exit
        // cleanly — the poll-fallback tick (or the next bus event) retries.
        try {
          // Arc verification: the outbox subscriber only queues an admitted
          // origin here. Start it through the same drain-owned acquire/release
          // lifecycle as other daemon work; excess events were shed on entry.
          while (sems.arcVerify.inUse < sems.arcVerify.limit) {
            const originId = pendingArcVerifications.values().next().value
            if (originId === undefined) break
            void dispatchArcVerification(originId)
          }

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

  // Queued tasks only become semaphore waiters after drain selects them. A
  // runtime cap increase must therefore re-drive drain as well as waking any
  // existing waiters; otherwise newly available implement slots can idle until
  // an unrelated completion or task-add event. The callback lives on each
  // daemon-owned semaphore so every setSemLimit caller gets this behavior.
  for (const sem of new Set([...Object.values(sems), verifySem])) {
    sem.onLimitIncrease = () => { void drain() }
  }

  // Provider rate/spend-limit rejection handler.
  //
  // Called from dispatchImplement (result path AND catch path) whenever the
  // code step surfaces a quotaRejected sentinel. Two call sites justify the
  // extraction.
  //
  // Contract:
  // - Pauses dispatch with reason 'quota' so drain() is a no-op until resume
  //   fires and `mars daemon status` can name the cause.
  // - Raises exactly ONE level-triggered 'provider-rate-limited' action-queue
  //   row (idempotent raises bump seen_count, so a burst of rejections produces
  //   one row, not one per task).
  // - Schedules auto-resume at resetsAt + 60-second jitter. If resetsAt is 0
  //   (unknown), falls back to a 30-minute wait so the loop stays self-healing
  //   even when the API does not supply a reset timestamp.
  // - Best-effort only — a DB hiccup must not crash the daemon.
  const handleQuotaRejection = async (resetsAt: number): Promise<void> => {
    const FALLBACK_PAUSE_MS = 30 * 60_000 // 30 min when resetsAt is unknown
    const JITTER_MS = 60_000 // 60-second cushion past resetsAt
    const nowMs = Date.now()
    const resumeMs =
      resetsAt > 0
        ? Math.max(resetsAt * 1000 + JITTER_MS, nowMs + 5_000)
        : nowMs + FALLBACK_PAUSE_MS
    const resumeIso = new Date(resumeMs).toISOString()
    if (!pause.pause('quota', `provider rate/spend limit; auto-resume at ${resumeIso}`)) {
      // Already paused (burst of concurrent rejections, or a storm). The timer
      // already running will resume. Do not raise a second action-queue row.
      return
    }
    log(`[quota] dispatch paused; will auto-resume at ${resumeIso}`)
    const resumeTimer = setTimeout(() => {
      if (pause.get().reason !== 'quota') return
      pause.resume()
      log(`[quota] dispatch resumed after rate-limit window`)
      viewStreamHub.broadcast('tasks')
      void drain()
    }, resumeMs - nowMs)
    resumeTimer.unref()
    // Raise one level-triggered action-queue row. Idempotent: a second call
    // within the same episode increments seen_count rather than inserting a
    // sibling row (raiseActionQueueItem dedupes by fingerprint).
    try {
      const { raiseActionQueueItem } = await import('../lib/action-queue')
      await raiseActionQueueItem({
        kind: 'provider-rate-limited',
        category: 'daemon',
        priority: 'urgent',
        title: 'Provider rate/spend limit reached — dispatch paused',
        body: `The Claude API rejected dispatched runs due to a rate or spend limit. Dispatch is paused until ${resumeIso}. Raise your spend limit at claude.ai/settings/usage if needed.`,
        payload: { resetsAt, resumeAt: resumeIso },
        context: {},
        raisedBy: 'daemon:quota-rejection',
        signature: 'provider-rate-limited:auto',
      })
      viewStreamHub.broadcast('action-queue')
    } catch (aqErr) {
      log(
        `[quota] action-queue raise failed (non-fatal): ${
          aqErr instanceof Error ? aqErr.message : String(aqErr)
        }`,
      )
    }
  }

  // ── Signature-storm circuit breaker ──────────────────────────────────────
  // Called by the recovery-spawner when the all-gate consecutive-failure-
  // signature circuit breaker first trips, and at startup when the durable
  // `tripped` flag says a previous daemon tripped it.
  //
  // The state machine (pause, resume invariant, crash/hang fallback, Steward
  // attempt budget, operator escalation) lives in `./storm-breaker` so it is
  // unit-testable without booting a daemon. This file supplies only the
  // side-effecting halves: running the Steward on a real worktree, writing the
  // ledger, and raising the escalation row.
  //
  // Idempotency: the persistent `tripped` flag in `failure_signature_streak`
  // ensures `handleTaskFailureWithFixTask` returns `signature-storm-tripped`
  // exactly once per episode; subsequent calls return `alreadyTripped=true`
  // so the subscriber never calls this handler again for the same storm.
  // The pause-state guard provides a secondary in-process safety net.

  /**
   * Gather the tasks that failed with this signature, best evidence first.
   * The row-matching rule lives in `./storm-evidence` alongside the shared
   * family helper the streak counter uses, so the evidence lookup and the
   * counter can never again disagree about which rows belong to a storm.
   */
  const collectStormContext = async (
    signature: string,
    lastTaskId: string,
  ): Promise<StormEvidence> => {
    try {
      const store = await getDefaultTaskStore()
      return await collectStormEvidence({ db: store, signature, lastTaskId, log })
    } catch (err) {
      // Non-fatal, as before: a Steward briefed with no excerpts is still worth
      // dispatching; a thrown store error would abort the whole episode.
      log(
        `[signature-storm] failure-context lookup failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return { affectedTaskIds: [lastTaskId], failureExcerpts: [], usableEvidenceCount: 0 }
    }
  }

  /**
   * Wake the write-capable Steward on its own worktree and let it land a fix.
   *
   * ALWAYS returns a terminal report — `fixed`, `no-op`, or `failed` — which
   * the breaker records in `steward_ledger` and uses to resume dispatch. The
   * previous shape returned `Promise<void>` while its doc comment claimed it
   * "returns true when the run succeeded", so the success signal was dropped
   * on the floor: resume happened as a side effect buried on the success path,
   * and every other outcome (including a non-zero exit, which WAS detected)
   * reached nothing but a log line and a 30-minute wait.
   *
   * `fixed` vs `no-op` is decided by the branch, not by the agent's prose: a
   * run that exits clean but leaves zero commits ahead of the integration
   * branch produced nothing, and must be recorded as such.
   */
  const runStormSteward = async (trip: {
    signature: string
    streak: number
    lastTaskId: string
  }): Promise<StormStewardReport> => {
    const { signature, streak, lastTaskId } = trip
    const { StewardEventSchema, renderStewardStormBrief, stewardAgent, STEWARD_STORM_TIMEOUT_MS } =
      await import('../agents/steward')
    const { createWorktree } = await import('../lib/git/worktree')
    const { runClaudeCode } = await import('../lib/git/claude')
    const {
      findOpenActionQueueItemIdBySignature,
      patchActionQueuePayloadById,
      setActionQueueState,
    } = await import('../lib/action-queue')

    const rowId = await findOpenActionQueueItemIdBySignature(
      'signature-storm',
      `signature-storm:${signature}`,
    ).catch(() => null)

    const { affectedTaskIds, failureExcerpts, usableEvidenceCount } = await collectStormContext(
      signature,
      lastTaskId,
    )
    const evidenceUsable = usableEvidenceCount > 0
    const brief = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature,
      streak,
      affectedTaskIds,
      failureExcerpts,
    })
    if (brief.kind !== 'signature-storm') {
      return {
        outcome: 'failed',
        stewardId: null,
        branch: null,
        worktree: null,
        rationale: 'storm brief failed to parse as a signature-storm event',
        commitSha: null,
        evidenceUsable,
      }
    }

    const stewardId = `steward-storm-${Date.now().toString(36)}`
    const worktree = await createWorktree({ taskId: stewardId, integrationBranch })
    log(
      `[signature-storm] steward ${stewardId} dispatched write-capable on ${worktree.branch} for "${signature}"`,
    )
    if (rowId !== null) {
      await patchActionQueuePayloadById(rowId, {
        steward: {
          id: stewardId,
          branch: worktree.branch,
          worktree: worktree.path,
          startedAt: new Date().toISOString(),
          affectedTaskIds,
        },
      }).catch(() => false)
    }

    const result = await runClaudeCode({
      cwd: worktree.path,
      prompt: renderStewardStormBrief(brief),
      systemPrompt: stewardAgent.systemPrompt,
      model: stewardAgent.model,
      // Write-capable: the whole point of this dispatch is landing a fix.
      permissionMode: 'acceptEdits',
      timeoutMs: STEWARD_STORM_TIMEOUT_MS,
    })

    let report = ''
    let modelErrored = false
    for (const event of result.conversation) {
      if (event.type === 'result') {
        if (event.is_error === true) modelErrored = true
        if (typeof event.result === 'string') report = event.result
      }
    }
    const ranClean = result.exitCode === 0 && !modelErrored && result.quotaRejected === null

    // Did the run actually land anything? A clean exit with an empty branch is
    // a no-op, and the operator must be able to tell the two apart.
    const landed = await countStewardCommits(worktree.path)

    const outcome: StormStewardOutcome = !ranClean
      ? 'failed'
      : landed.commits > 0
        ? 'fixed'
        : 'no-op'
    const rationale = !ranClean
      ? `steward ${stewardId} run failed (exit=${result.exitCode}, modelError=${modelErrored}, quotaRejected=${
          result.quotaRejected !== null
        })${report ? `; last report: ${report.slice(0, 2_000)}` : ''}`
      : landed.commits > 0
        ? report.slice(0, 4_000) ||
          `steward ${stewardId} landed ${landed.commits} commit(s) on ${worktree.branch} without a closing report`
        : `steward ${stewardId} exited clean but left ZERO commits on ${worktree.branch}` +
          `${evidenceUsable ? '' : ' — insufficient evidence to diagnose: no affected task recorded usable failure output'}` +
          `${report ? `; it reported: ${report.slice(0, 2_000)}` : ' and produced no report'}`

    log(`[signature-storm] steward ${stewardId} outcome=${outcome} on ${worktree.branch}`)
    if (rowId !== null) {
      // Patch the EXISTING signature-keyed row by id — raising again would
      // only bump seen_count and leave the payload stale.
      await patchActionQueuePayloadById(rowId, {
        steward: {
          id: stewardId,
          branch: worktree.branch,
          worktree: worktree.path,
          finishedAt: new Date().toISOString(),
          outcome,
          commits: landed.commits,
          evidence: evidenceUsable ? 'usable' : 'insufficient',
          report: report.slice(0, 4_000),
          affectedTaskIds,
        },
      }).catch(() => false)
      if (outcome === 'fixed') {
        await setActionQueueState(rowId, 'resolved', {
          resolution: 'steward-fixed',
          note: `steward ${stewardId} landed a fix on ${worktree.branch}; dispatch auto-resumed`,
          by: 'daemon:signature-storm-steward',
        }).catch(() => {})
      }
      // A no-op / failed run deliberately leaves the row OPEN: dispatch resumes
      // immediately, but the operator still owns an unfixed systemic failure.
    }

    return {
      outcome,
      stewardId,
      branch: worktree.branch,
      worktree: worktree.path,
      rationale,
      commitSha: landed.headSha,
      evidenceUsable,
    }
  }

  /** Commits the Steward landed on its own branch, plus that branch's head sha. */
  const countStewardCommits = async (
    worktreePath: string,
  ): Promise<{ commits: number; headSha: string | null }> => {
    try {
      const { execProbe, resolveGitBin } = await import('../lib/git/internal')
      const counted = await execProbe(
        resolveGitBin(),
        ['rev-list', '--count', `${integrationBranch}..HEAD`],
        { cwd: worktreePath, timeout: 15_000 },
      )
      if (counted.exitCode !== 0) return { commits: 0, headSha: null }
      const commits = Number.parseInt(counted.stdout.trim(), 10)
      if (!Number.isFinite(commits) || commits <= 0) return { commits: 0, headSha: null }
      const head = await execProbe(resolveGitBin(), ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        timeout: 15_000,
      })
      return {
        commits,
        headSha: head.exitCode === 0 ? head.stdout.trim() || null : null,
      }
    } catch (err) {
      log(
        `[signature-storm] steward commit probe failed (treated as no-op): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return { commits: 0, headSha: null }
    }
  }

  /**
   * Raise the urgent operator row for a signature whose Steward budget is
   * spent. Reuses the `signature-storm` kind (so it lands in the same triage
   * lane) under a distinct dedup key, so repeats bump `seen_count` instead of
   * inserting a sibling per re-trip.
   */
  const raiseStormEscalation = async (escalation: StormEscalation): Promise<void> => {
    const { raiseActionQueueItem } = await import('../lib/action-queue')
    await raiseActionQueueItem({
      kind: 'signature-storm',
      category: 'daemon',
      priority: 'urgent',
      title: `Signature storm UNRESOLVED — ${escalation.attempts} Steward attempts failed on ${escalation.signature}`,
      body:
        `The failure signature '${escalation.signature}' keeps tripping the circuit breaker and ` +
        `${escalation.attempts} write-capable Steward dispatch(es) produced no fix ` +
        `(last outcome: ${escalation.lastOutcome}).\n\n` +
        `Mars has stopped auto-dispatching Stewards for this signature and will NOT pause dispatch ` +
        `for it again — cycling pause/Steward/resume against a cause the Steward cannot reach only ` +
        `burns worktrees. Tasks keep dispatching and will keep failing with this signature until you ` +
        `fix the shared cause.\n\n` +
        `Last Steward rationale:\n${escalation.lastRationale.slice(0, 2_000)}\n\n` +
        `Inspect \`.mars/watch.log\` and the steward_ledger rows for target '${escalation.signature}'.`,
      payload: {
        signature: escalation.signature,
        streak: escalation.streak,
        stewardAttempts: escalation.attempts,
        stewardOutcome: escalation.lastOutcome,
        lastTaskId: escalation.lastTaskId,
      },
      context: {},
      raisedBy: 'daemon:signature-storm-steward',
      signature: stormEscalationSignature(escalation.signature),
    })
  }

  const stormBreaker = createStormBreaker({
    log,
    pause,
    clearBreakerFlag: async () => {
      const { resetFailureSignatureStreak } = await import('../lib/signature-storm-monitor')
      await resetFailureSignatureStreak(await getDefaultTaskStore())
    },
    onResumed: () => {
      viewStreamHub.broadcast('tasks')
      viewStreamHub.broadcast('action-queue')
      void drain()
    },
    runSteward: (trip) => runStormSteward(trip),
    recordLedger: async (entry) => {
      const { recordStewardIntervention } = await import('../steward-ledger')
      return recordStewardIntervention(entry)
    },
    raiseEscalation: (escalation) => raiseStormEscalation(escalation),
  })

  const handleSignatureStorm = (trip: {
    signature: string
    streak: number
    lastTaskId: string
  }): void => {
    stormBreaker.onTrip(trip)
    viewStreamHub.broadcast('action-queue')
    viewStreamHub.broadcast('tasks')
  }

  // A quarantined registry gate is advisory-only: this Steward can inspect the
  // repository and submit a candidate definition, but has no registry mutation
  // or proposal-approval authority. The durable subscriber below owns when it
  // is called; this callback owns only one provider invocation.
  const runGateFixStewardDispatch = async (event: import('../agents/steward').GateSystemicFailureEvent) => {
    const [{ runGateFixSteward }, { stewardAgent, STEWARD_GATE_FIX_TOOLS }, { runClaudeCode }] = await Promise.all([
      import('../gate-fix-steward'),
      import('../agents/steward'),
      import('../lib/git/claude'),
    ])
    const outcome = await runGateFixSteward(event, {
      worker: async (prompt) => {
        const result = await runClaudeCode({
          cwd: resolveContext().repoRoot,
          prompt,
          systemPrompt: stewardAgent.systemPrompt,
          model: stewardAgent.model,
          permissionMode: 'bypassPermissions',
          // `runClaudeCode` exposes denials rather than an allow-list. Keep
          // the useful repository-read tools while closing every repair/apply
          // route; the prompt independently names the same boundary.
          disallowedTools: [
            'Edit',
            'Write',
            'NotebookEdit',
            'Bash(mars verify-gate*)',
            'Bash(mars proposal*)',
            'Bash(mars gate-fix*)',
          ],
        })
        let output = result.stdout
        for (const message of result.conversation) {
          if (message.type === 'result' && typeof message.result === 'string') output = message.result
        }
        if (result.exitCode !== 0 || result.quotaRejected !== null) {
          log(`[gate-fix-steward] ${event.gate.id} diagnosis did not complete cleanly (exit=${result.exitCode})`)
          return ''
        }
        log(`[gate-fix-steward] ${event.gate.id} inspected with ${STEWARD_GATE_FIX_TOOLS.join(', ')}`)
        return output
      },
    })
    viewStreamHub.broadcast('chat')
    viewStreamHub.broadcast('action-queue')
    return outcome
  }

  bus.on('task.added', (e: { taskId: string }) => {
    if (!acceptingWork) return
    if (tracker.isInFlight(e.taskId)) return
    tracker.enqueuePending(e.taskId, 'triage')
    void drain()
  })

  // Dispatch hint for tasks the orchestrator creates for ITSELF mid-flight
  // (rescue-operators for dead-ended arcs). Those writers live in `core/` and
  // have no reference to this bus, so without this seam their rows sat
  // unscheduled until the `reseed-dispatch` reconciler ran — i.e. until the next
  // daemon restart. See core/daemon/dispatch-hint.ts.
  //
  // Deliberately delegates to the two bus handlers above rather than touching
  // the tracker directly, so the pending-set push + `drain()` sequence that
  // AGENTS.md mandates has exactly one implementation.
  const unregisterDispatchHint = registerDispatchHint((taskId, kind) => {
    bus.emit(kind === 'triage' ? 'task.added' : 'task.queued', { taskId })
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

  // Signature-storm streak reset: a successful task completion clears the
  // consecutive-failure streak so a future storm (same or different signature)
  // can trip independently. When dispatch is paused BECAUSE of that storm, the
  // reset also lifts the pause — leaving one half cleared is exactly the drift
  // this pause state exists to prevent.
  // Best-effort: a DB hiccup must not affect the dispatch path.
  bus.on('task.completed', (e: { taskId: string; status?: string }) => {
    if (e.status !== 'done') return
    void (async () => {
      try {
        const { resetFailureSignatureStreak } = await import('../lib/signature-storm-monitor')
        const storeForReset = await getDefaultTaskStore()
        await resetFailureSignatureStreak(storeForReset)
        log(`[signature-storm] streak reset after successful task ${e.taskId}`)
        if (pause.get().reason === 'storm') {
          await stormBreaker.resume(`successful task ${e.taskId}`)
        }
      } catch (err) {
        log(
          `[signature-storm] streak reset failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })()
  })

  // Proposal lifecycle events update the Progress-tab DAG in place.
  bus.on('proposal.added',     () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.updated',   () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.dismissed', () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.promoted',  () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.sliced',    () => { viewStreamHub.broadcast('progress') })
  bus.on('proposal.deleted',   () => { viewStreamHub.broadcast('progress') })

  // Durable transcript append (deep-reflect durability). On every
  // task.completed, persist the resolved Claude transcript for the task into
  // trace_events so deep-reflect no longer depends on the ephemeral
  // ~/.claude/projects/ tree. Wired onto the existing EventEmitter delivery
  // path rather than starting the real outbox dispatcher (which is dead
  // code at this commit) — see the transcript-append subscriber for the
  // exactly-once-per-(task) dedup contract. The event id is derived from
  // taskId via SHA-1 so dedup is task-scoped and cannot collide across
  // daemon restarts (each task.completed is unique to one task lifetime,
  // so a stable-per-task id is the right key).
  const compositionClient = getCompositionRootClient()
  const transcriptAppendSubscriber = buildTranscriptAppendSubscriber(
    compositionClient,
    async (taskId: string): Promise<string | null> => {
      const events: ClaudeEvent[] = []
      for await (const evt of readAllTranscriptsForTask(taskId)) {
        if (!evt.raw || typeof evt.raw !== 'object' || Array.isArray(evt.raw)) {
          continue
        }
        const o = evt.raw as Record<string, unknown>
        if (typeof o.type !== 'string') continue
        events.push(o as unknown as ClaudeEvent)
      }
      return events.length > 0 ? JSON.stringify(events) : null
    },
  )
  const stableTranscriptEventId = (taskId: string): number => {
    // Top 6 bytes of SHA-1 — 48 bits, safely below Number.MAX_SAFE_INTEGER.
    return createHash('sha1')
      .update(`task.completed:${taskId}`)
      .digest()
      .readUIntBE(0, 6)
  }
  bus.on('task.completed', (e: { taskId: string }) => {
    void (async () => {
      try {
        await transcriptAppendSubscriber.handler({
          id: stableTranscriptEventId(e.taskId),
          type: 'task.completed',
          payload: { taskId: e.taskId, result: null },
          ts: Date.now(),
        })
      } catch (err) {
        log(
          `[transcript-append] ${e.taskId} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })()
  })

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

  // ── Scorer runtime hook (PRD 6cf85bc9) ─────────────────────────────────────
  // NON-GATING post-instance quality grading: when an instance of a workflow
  // kind with ≥1 ACCEPTED Scorer reaches done via merge, the scoring pool
  // grades its persisted artifacts on the pinned read-only Haiku-class Scorer
  // Worker and records a 0..1 score + rationale in scorer_results. This hook
  // fires AFTER the merge already landed and the task row is terminal:
  // a low score (or a scorer failure) can never block the merge, fail the
  // task, or spawn recovery — verify remains the sole correctness gate.
  // The run is NOT a Task (no queue row, no recovery, no KPI distortion) and
  // sits behind its OWN semaphore (MARS_MAX_SCORING, default 2), never
  // competing for implement slots. Kill-switches: `mars operator set scoring
  // off` (persisted MARS_SCORING_DISABLED) and MARS_REFLECT_DISABLED=1.
  const scoringPool = createScoringPool({
    limit: resolveScoringLimit(),
    log,
    runScoring: async (taskId: string): Promise<void> => {
      const { runScorersForTask, isScoringDisabled } = await import(
        '../lib/scorer-runtime'
      )
      if (isScoringDisabled()) return
      const outcome = await runScorersForTask(taskId, { traceStore })
      if (outcome.outcome !== 'ran') return
      log(
        `[scorer] ${taskId} (workflow=${outcome.workflow ?? 'n/a'}): scored=${outcome.scored} errored=${outcome.errored} skipped=${outcome.skipped}`,
      )
      // "Fold into optimization" v1: after fresh results, evaluate the
      // OFF-by-default low-trend trigger (scoring.autoTrigger). When the
      // operator opted in, a sustained low rolling median raises one
      // source='reflection' draft proposal — an ordinary draft-proposal
      // action-queue row (pure projection, ADR-0048). Never queues tasks.
      if (outcome.scored > 0) {
        try {
          const { runScorerLowTrendTrigger } = await import(
            '../lib/scorer-trend-trigger'
          )
          const trigger = await runScorerLowTrendTrigger()
          if (trigger.raised.length > 0) {
            log(
              `[scorer-trend] raised ${trigger.raised.length} low-trend proposal(s): ${trigger.raised.join(', ')}`,
            )
          }
        } catch (err) {
          log(
            `[scorer-trend] trigger error: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    },
  })
  bus.on('task.completed', (e: { taskId: string }) => {
    // Enqueue only — no emit-then-dispatch from a bus handler. The pool's
    // drain() dispatches behind its own cap; runScorersForTask re-fetches the
    // task and exits fast unless status='done' with an accepted Scorer.
    scoringPool.enqueue(e.taskId)
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
    originSessionId?: string | null,
    workflow?: string | null,
    qa?: 'auto' | 'manual',
    deferrable?: boolean,
  ): Promise<Task> => {
    const opts: Parameters<typeof enqueueTask>[2] = {}
    if (skipTriage) opts.skipTriage = true
    if (author) opts.author = author
    if (priority !== undefined) opts.priority = priority
    if (tags !== undefined) opts.tags = tags
    if (spec) opts.spec = spec
    if (intent !== undefined) opts.intent = intent
    if (originSessionId !== undefined) opts.originSessionId = originSessionId
    if (workflow != null) opts.workflow = workflow
    if (qa !== undefined) opts.qa = qa
    if (deferrable === true) opts.deferrable = true
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
    // Track whether we parked this task as 'blocked' after adding edges so
    // we suppress the task.queued/task.added events that would race dispatch.
    let blockedByIncomplete = false
    if (blockerIds && blockerIds.length > 0) {
      try {
        await addBlockers(task.id, blockerIds)
        // Mirror handleBlock's post-add re-evaluation: if the task is still in
        // a pre-dispatch state and at least one blocker is not yet done, park
        // it as 'blocked' so the dispatcher never picks it up while a
        // prerequisite is outstanding.  The blocker-resolution drain (outbox
        // subscriber) flips it to 'queued' when the last blocker completes and
        // the periodic interval emits task.queued to trigger drain().
        if (
          (task.status === 'queued' || task.status === 'draft') &&
          (await hasIncompleteBlockers(task.id))
        ) {
          await updateTask(task.id, { status: 'blocked' })
          blockedByIncomplete = true
        }
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
    if (!blockedByIncomplete) {
      if (task.status === 'queued') {
        bus.emit('task.queued', { taskId: task.id })
      } else if (task.status === 'draft') {
        bus.emit('task.added', { taskId: task.id })
      }
    }
    return blockedByIncomplete ? { ...task, status: 'blocked' } : task
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
                payload.integrationBranch,
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
        //
        // EXCEPTION — main-committer recoveries (recipe='main-commiter'): their
        // role is to clean the integration branch, NOT to deliver the origin
        // task's work. Calling propagateRecoveryDone() for them would falsely
        // mark the origin task done and cascade-unblock its dependents before
        // the work is actually shipped (bug mars-4d66145d). Skip propagation
        // for main-committers; the Arc.unblockByCompletion() path below will
        // re-queue the source task so it retries against the now-clean branch.
        if (after.kind === 'fix' && after.fixForTaskId !== null) {
          try {
            const { parseMainCommiterPayload: parseMCP, MAIN_COMMITER_RECIPE: MCR } =
              await import('../lib/main-dirty')
            if (parseMCP(after.recoveryPayload)?.recipe === MCR) {
              log(
                `[propagate] main-committer ${id} done; skipping propagateRecoveryDone for origin ${after.fixForTaskId} — source task will be re-queued via unblockByCompletion`,
              )
            } else {
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
            } else if (o.outcome === 'done-via-recovery') {
              log(
                `[unblock] task ${o.taskId} propagated to done (own recovery ${id} succeeded)`,
              )
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
  const handleRestart = async (
    id: string,
    force?: boolean,
  ): Promise<{ status: 'queued' | 'blocked' }> => {
    const { coreRestartTask } = await import('./restart-task')
    const { createQueueWorkflowStore } = await import('../../workflows/queue-workflow-store')
    const result = await coreRestartTask(
      id,
      new Set(['failed', 'done', 'vega-reconciling', 'merging']),
      createQueueWorkflowStore(),
      { force },
    )
    // Only emit task.queued when the task actually reached 'queued'. A task
    // that landed in 'blocked' (incomplete live blockers remain) must NOT be
    // dispatched — emitting task.queued for a blocked task would violate the
    // blocker invariant and could cause the dispatcher to start work on a task
    // whose prerequisite is not done.
    if (result.status === 'queued') {
      bus.emit('task.queued', { taskId: id })
    }
    return result
  }

  // 'mars remerge <id>' re-enters the pipeline at verify on the task's
  // EXISTING branch, skipping setup + code. The branch must exist and be
  // ahead of the integration branch. See daemon/remerge-task.ts.
  const handleRemerge = async (id: string): Promise<{ status: 'queued' }> => {
    const { coreRemergeTask } = await import('./remerge-task')
    const { createQueueWorkflowStore } = await import('../../workflows/queue-workflow-store')
    const result = await coreRemergeTask(
      id,
      new Set(['failed', 'done', 'vega-reconciling', 'merging', 'verifying']),
      createQueueWorkflowStore(),
    )
    bus.emit('task.queued', { taskId: id })
    return result
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

  // `mars task stop <id>` aborts only a currently dispatched workflow. The
  // task is left failed (not dropped), preserving its branch and worktree for
  // an explicit `mars continue <id>`.
  const handleStop = async (id: string): Promise<void> => {
    if (!tracker.abort(id)) {
      throw new Error(`task ${id} is not in flight`)
    }
    await handleUpdate(id, {
      status: 'failed',
      error: 'stopped by operator via `mars task stop`',
      failureReason: CANCELLED_FAILURE_REASON,
      failureReasonCode: 'task-stopped',
    })
    log(`[stop-task] ${id}: abort requested; worktree and branch preserved for continue`)
  }

  const handlePurge = async (
    id: string,
    force: boolean,
  ): Promise<{ compensationTaskId?: string }> => {
    const { corePurgeTask } = await import('./purge-task')
    const { getRepoRoot } = await import('../context')
    const result = await corePurgeTask(id, force, integrationBranch, getRepoRoot())
    // Action-queue rows for the purged task are closed by the Invalidator,
    // which consumes the task.terminal{purged} event dropTask emits in-tx
    // before deleting the row. No inline supersede here — that best-effort
    // path was lost when the daemon was down and is the staleness class this
    // design removes (ADR-0027/0030).
    return result.compensationTaskId !== undefined
      ? { compensationTaskId: result.compensationTaskId }
      : {}
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
    const repoRoot = getRepoRoot()

    // Refuse to silently discard unmerged work. Mirror the `restart` guard:
    // if the branch has commits ahead of the integration branch and --force
    // is not set, tell the operator how many commits are at risk.
    if (!force) {
      const { listUniqueCommitsAhead } = await import('../lib/sweep')
      const { integrationBranchName } = await import('../blocker-resolution')
      const integrationBranch = integrationBranchName()
      const commitsAhead = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot)
      if (commitsAhead.length > 0) {
        throw new Error(
          `refusing to drop task ${id}: branch ${branch} has ${commitsAhead.length} commit(s) ` +
            `ahead of ${integrationBranch} that drop would discard. ` +
            `Review or land the branch, or rerun with --force to discard it.`,
        )
      }
    }

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
      cwd: repoRoot,
    })
      .then(() => true)
      .catch(() => false)

    const result = await dropTask(id)
    // Action-queue rows are closed by Arc.drop() inline (belt-and-suspenders
    // resolveAllRowsForTask + supersedeActionQueueItemsForOrigin before the
    // DELETE) AND by the Invalidator consuming the task.dropped event emitted
    // in the same atomic tx as DELETE FROM tasks (ADR-0027/0030/0041/0048).
    log(
      `[drop] ${id} (was ${result.previousStatus}; force=${force}, ` +
        `incoming=${result.edgesRemoved.incoming}, outgoing=${result.edgesRemoved.outgoing}, ` +
        `cascadedFix=${result.cascadedFixTaskIds.length}, worktree=${worktreeRemoved}, branch=${branchDeleteResult}, ` +
        `merge-jobs=${result.mergeJobsDeleted})`,
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
    priority?: number,
    coordinated = false,
  ): Promise<{ proposalId: string; status: string }> => {
    assertProposalsSourceFresh(proposalsStamp)
    const proposal = await promoteProposal(proposalId, { coordinated })
    // Auto-slice: chain slicing fire-and-forget so the RPC stays fast and a
    // slicer failure (e.g. malformed PRD) leaves the proposal in prd-ready for
    // the operator to inspect and re-promote without aborting the promote itself.
    if (proposal.status === 'prd-ready') {
      void handleProposalSlice(proposal.id, undefined, priority).catch((err) =>
        log(`[auto-slice] proposal ${proposal.id} failed: ${(err as Error).message}`),
      )
    }
    return { proposalId: proposal.id, status: proposal.status }
  }

  const proposalSliceRuns = new Map<string, number>()

  const handleProposalSlice = async (
    proposalId: string,
    resliceFeedback?: string,
    priority?: number,
    acceptDefaults?: boolean,
  ): Promise<{ proposalId: string; status: string; taskIds: string[] }> => {
    proposalSliceRuns.set(proposalId, (proposalSliceRuns.get(proposalId) ?? 0) + 1)
    try {
      assertProposalsSourceFresh(proposalsStamp)

      // Gate: hard-fail if the proposal's notes contain an unresolved
      // open-questions block and the caller has not explicitly opted in.
      {
        const { getProposal, hasUnresolvedOpenQuestions, appendProposalNotes } =
          await import('../proposals')
        const proposal = await getProposal(proposalId)
        if (proposal && hasUnresolvedOpenQuestions(proposal.notes)) {
          if (!acceptDefaults) {
            throw new Error(
              `proposal ${proposalId} has an unresolved open-questions block in its notes. ` +
                `Slicing would silently take every option marked "(recommended)". ` +
                `Resolve the questions via \`/mars:grill ${proposalId}\` or pass --accept-defaults to proceed knowingly.`,
            )
          }
          // Record the acceptance so it's auditable later.
          const ts = new Date().toISOString()
          await appendProposalNotes(
            proposalId,
            `DEFAULTS ACCEPTED at ${ts} — open questions above were not resolved before slicing.`,
          )
        }
      }

      const { runSlice } = await import('../../workflows/slice-workflow')
      const sliceTaskStore = await getDefaultTaskStore()
      const result = await runSlice(proposalId, resliceFeedback, {
        store: sliceTaskStore,
        traceStore,
        ...(priority !== undefined && { priority }),
      })
      // Slicing always makes dispatchable work live immediately; notify the
      // in-memory dispatcher about each queued task after its lifecycle write.
      for (const taskId of result.queuedTaskIds) {
        bus.emit('task.queued', { taskId })
      }
      return result
    } finally {
      const remaining = (proposalSliceRuns.get(proposalId) ?? 1) - 1
      if (remaining === 0) proposalSliceRuns.delete(proposalId)
      else proposalSliceRuns.set(proposalId, remaining)
    }
  }

  const handleProposalReslice = async (
    proposalId: string,
    feedback: string,
    priority?: number,
  ): Promise<{ proposalId: string; status: string; taskIds: string[] }> => {
    const { getProposal, revertSlicedProposalToReady } = await import('../proposals')

    // Validate status.
    const proposal = await getProposal(proposalId)
    if (!proposal) throw new Error(`proposal ${proposalId} not found`)
    if (proposal.status !== 'sliced') {
      throw new Error(
        `proposal ${proposalId} is '${proposal.status}'; only 'sliced' proposals can be resliced`,
      )
    }

    const taskStore = await getDefaultTaskStore()
    const slices = await taskStore.listTasksForProposal(proposalId)
    const activeSliceIds = slices
      .filter((task) => task.status !== 'queued' && task.status !== 'blocked')
      .map((task) => task.id)
    if (activeSliceIds.length > 0) {
      throw new Error(
        `proposal ${proposalId} cannot be resliced: slice task(s) already left the queue: ${activeSliceIds.join(', ')}`,
      )
    }

    // Every old slice is still inert, so clean it up through the same Arc
    // lifecycle path as `mars drop` before cutting replacement work.
    await Arc.dropProposalSlices(taskStore, proposalId, 'reslice')

    // Revert the proposal to 'prd-ready' so the slice workflow can claim it.
    await revertSlicedProposalToReady(proposalId)

    // Re-slice with the operator's feedback appended to the Slicer prompt.
    return handleProposalSlice(proposalId, feedback, priority)
  }

  const handleProposalTake = async (
    proposalId: string,
    workflow?: string,
  ): Promise<{ proposalId: string; taskId: string }> => {
    assertProposalsSourceFresh(proposalsStamp)
    const {
      claimProposalForSlicing,
      markProposalTaken,
      resolveProposalId,
      getProposal,
      validateProposalShaped,
    } = await import('../proposals')

    const resolvedWorkflow = workflow ?? 'live'

    const resolved = await resolveProposalId(proposalId)
    if (resolved.kind === 'ambiguous') {
      throw new Error(
        `ambiguous prefix '${proposalId}' matches ${resolved.count} proposals`,
      )
    }
    if (resolved.kind === 'none') {
      throw new Error(`proposal ${proposalId} not found`)
    }

    const proposal = await getProposal(resolved.id)
    if (!proposal) throw new Error(`proposal ${resolved.id} not found`)

    // Validate PRD body before attempting status transitions.
    const missing = validateProposalShaped(proposal)
    if (missing.length > 0) {
      throw new Error(
        `proposal ${proposal.id} is not fully shaped; missing: ${missing.join(', ')}. ` +
          `Shape it with 'mars proposal set ${proposal.id} <field> <value>' and ` +
          `'mars proposal add-user-story ${proposal.id} <story>'.`,
      )
    }

    if (proposal.status !== 'prd-ready') {
      throw new Error(
        `proposal ${proposal.id} is '${proposal.status}'; only 'prd-ready' proposals can be taken. ` +
          `Run 'mars proposal promote ${proposal.id}' to promote it first.`,
      )
    }

    // Atomically claim: prd-ready → slicing (CAS guard against concurrent take/slice).
    const claimed = await claimProposalForSlicing(resolved.id)
    if (!claimed) {
      throw new Error(
        `proposal ${resolved.id} is no longer 'prd-ready'; another take or slice may be in progress`,
      )
    }

    // Compose the PRD body as the task prompt.
    const parts: string[] = [`# ${proposal.title}`]
    if (proposal.problem.trim().length > 0) {
      parts.push(`\n## Problem\n\n${proposal.problem.trim()}`)
    }
    if (proposal.solution.trim().length > 0) {
      parts.push(`\n## Solution\n\n${proposal.solution.trim()}`)
    }
    if (proposal.userStories.length > 0) {
      const storiesBody = proposal.userStories.map((s) => `- [ ] ${s}`).join('\n')
      parts.push(`\n## Acceptance criteria\n\n${storiesBody}`)
    }
    if (proposal.outOfScope.trim().length > 0) {
      parts.push(`\n## Out of scope\n\n${proposal.outOfScope.trim()}`)
    }
    if (proposal.notes.trim().length > 0) {
      parts.push(`\n## Notes\n\n${proposal.notes.trim()}`)
    }
    parts.push(
      `\n---\n\nThis task carries the full PRD (proposal ${resolved.id}).` +
        ` No slicer decomposition — one Foreground session drives the entire scope under journal discipline.`,
    )
    const prompt = parts.join('\n')

    // Derive done criteria from user stories when present.
    const doneCriteria = proposal.userStories

    let task: import('../queue').Task
    try {
      task = await enqueueTask(prompt, undefined, {
        author: proposal.author ?? undefined,
        originId: resolved.id,
        parentProposalId: resolved.id,
        workflow: resolvedWorkflow,
        spec: {
          files: [],
          verifyCmd: null,
          doneCriteria,
          mergeMode: 'auto',
        },
      })
    } catch (err) {
      // Compensate: revert slicing claim so the proposal stays actionable.
      const { revertSlicingProposalToReady } = await import('../proposals')
      await revertSlicingProposalToReady(resolved.id).catch(() => {})
      throw err
    }

    // Transition: slicing → taken (distinct from slice's slicing→sliced).
    await markProposalTaken(resolved.id)

    // Notify the dispatch loop that the task is ready to run.
    bus.emit('task.queued', { taskId: task.id })

    return { proposalId: resolved.id, taskId: task.id }
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
    // Effective vs configured implement cap. `configured` is re-read from
    // .mars/daemon.json at call time — the operator's complaint was seeing
    // `implement: 3` in the file while the daemon ran at 1 with nothing
    // reporting the discrepancy.
    let configuredImplement = initialCaps.implement
    try {
      configuredImplement = loadDaemonConfig().caps.implement
    } catch {
      // Unreadable/edited config — fall back to the boot-time value.
    }
    const effectiveImplement = sems.implement.limit
    const implementCap = {
      configured: configuredImplement,
      effective: effectiveImplement,
      reason:
        effectiveImplement === configuredImplement
          ? null
          : (implementCapReason ??
            (effectiveImplement < configuredImplement
              ? 'daemon started before the current .mars/daemon.json; run `mars daemon reload`'
              : 'raised above the configured cap at runtime')),
    }
    // Read the durable breaker state from the DB so status always reflects the
    // actual persisted row — not just the in-memory pause reason. A stale
    // `tripped=true` row (from a past episode) is indistinguishable from a
    // genuine live storm without this read.
    const { readSignatureStormState } = await import('../lib/signature-storm-monitor')
    const signatureStorm = await readSignatureStormState(getCompositionRootClient())
    return {
      pid: process.pid,
      startedAt,
      inFlight: tracker.inFlightSnapshot(),
      counts,
      implementCap,
      sourceSha,
      currentSha,
      isStale,
      pause: pause.get(),
      signatureStorm,
      draining: !acceptingWork,
    }
  }

  // ── Reconcile on startup ──────────────────────────────────────────────────

  const reconcile = async (): Promise<void> => {
    const { runStartupReconcile } = await import('./startup-reconcile')
    await runStartupReconcile({
      log,
      bus,
      traceStore,
      handleProposalSlice,
      isProposalSliceInFlight: (proposalId) => proposalSliceRuns.has(proposalId),
    })
  }

  // The 'sync' RPC op: same reconcile as startup, but the summary is returned
  // to the caller rather than discarded.
  const runSync = async (): Promise<unknown> => {
    const { runStartupReconcile } = await import('./startup-reconcile')
    return runStartupReconcile({
      log,
      bus,
      traceStore,
      handleProposalSlice,
      isProposalSliceInFlight: (proposalId) => proposalSliceRuns.has(proposalId),
    })
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
        const { runHeadlessProvider } = await import('../workers/providers')
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

            const result = await runHeadlessProvider(investigatePrompt, {
              cwd: worktreePath,
              modelTier: 'fast',
              permissionMode: 'default',
              disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
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
        const { runHeadlessProvider } = await import('../workers/providers')
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

        const result = await runHeadlessProvider(promptParts.join('\n'), {
          cwd,
          modelTier: 'balanced',
          permissionMode: 'default',
          disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
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

  // `mars release <id>` / `mars release --abort <id>`: release the worktree
  // lease on an 'awaiting-human' task. Normal release re-queues the task for
  // pipeline continuation; --abort routes it through the failure path.
  const handleReleaseLease = async (id: string, abort: boolean, note?: string): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    if (task.status !== 'awaiting-human') {
      throw new Error(
        `task ${id} is in status '${task.status}'; can only release a lease on an 'awaiting-human' task`,
      )
    }
    if (task.leaseOwner === null) {
      throw new Error(`task ${id} has no active lease`)
    }
    if (abort) {
      await updateTask(id, {
        status: 'failed',
        leaseOwner: null,
        leasedAt: null,
        leaseNote: null,
        error: 'aborted by operator via `mars release --abort`',
        failureReason: 'operator aborted human work',
      })
      bus.emit('task.failed', {
        taskId: id,
        error: 'operator aborted human work',
        // Thread the optional QA note into the event so the recovery-spawn
        // outbox subscriber can attach it to the fix-task prompt.
        ...(note !== undefined ? { note } : {}),
      })
    } else {
      await Arc.load(id).releaseLease(id)
      bus.emit('task.queued', { taskId: id })
    }
  }

  // `mars step done <id>`: complete the current manual step. Two paths:
  //
  // 1. Promise-based (new): if an in-process workflow is awaiting the manual
  //    step via awaitManualDone(), resolveManualStep() unblocks it in place.
  //    The workflow transitions the task itself; no re-queue is needed.
  //    The task status is updated to 'running' here so the UI reflects the
  //    correct state while the in-process workflow resumes to the next step.
  //
  // 2. Sentinel fallback (legacy / after daemon restart): no in-memory promise
  //    exists; fall back to releaseLease(keepLease:true) + bus.emit so the
  //    task is re-queued and the engine re-enters past the parked step.
  //
  // The lease identity is preserved in both paths — no re-attach is required
  // when the workflow parks at the task's next manual step.
  const handleStepDone = async (id: string): Promise<void> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    if (task.status !== 'awaiting-human') {
      throw new Error(
        `task ${id} is in status '${task.status}'; 'mars step done' only applies to an 'awaiting-human' task`,
      )
    }
    if (task.leaseOwner === null) {
      throw new Error(`task ${id} has no active lease`)
    }
    const stepName = task.currentStepName ?? 'unknown'
    // Close the awaiting-human row for this step. The row uses signature=taskId
    // (level-triggered, ADR-0048). Without this call the row stays open after
    // the step advances, pointing the operator at a completed step.
    await supersedeActionQueueItemsBySignature('awaiting-human', id, 'step-done', 'daemon:step-done')
    // Path 1: promise-based — resolve the in-flight workflow's pending park.
    const resolved = resolveManualStep(id, stepName)
    if (resolved) {
      // Workflow continues in-process. Transition task to 'running' so the
      // UI reflects the correct state; the workflow will update further as it
      // executes subsequent steps.
      await updateTask(id, { status: 'running' })
      return
    }
    // Path 2: sentinel fallback — re-queue for engine re-entry.
    await Arc.load(id).releaseLease(id, { keepLease: true })
    bus.emit('task.queued', { taskId: id })
  }

  // `mars step reset <task-id> <step-name>`: rewind a stuck task to an earlier
  // named workflow step. Clears checkpoints for the selected step and all
  // downstream steps so the next dispatch re-executes them from scratch;
  // preserves committed work (branch/worktreePath are not touched). Refuses
  // active (in-flight) tasks and tasks with an active operator lease.
  const STEP_RESET_ALLOWED_STATUSES = new Set<Task['status']>([
    'failed',
    'blocked',
    'queued',
    'awaiting-human',
  ])

  const handleStepReset = async (
    id: string,
    stepName: string,
  ): Promise<{ nextStep: string; queued: boolean; cleared: string[] }> => {
    const task = await getTask(id)
    if (!task) throw new Error(`task ${id} not found`)

    if (!STEP_RESET_ALLOWED_STATUSES.has(task.status)) {
      throw new Error(
        `task ${id} is ${task.status}; 'mars step reset' requires a task in ` +
          `failed, blocked, queued, or awaiting-human status`,
      )
    }
    if (task.leaseOwner !== null) {
      throw new Error(
        `task ${id} is leased by '${task.leaseOwner}'; ` +
          `release the lease first with 'mars release --abort ${id}'`,
      )
    }

    const { clearStepsFromCheckpoint } = await import(
      '../../workflows/queue-workflow-store'
    )
    const cleared = await clearStepsFromCheckpoint(id, stepName)
    if (cleared === null) {
      throw new Error(
        `step '${stepName}' has no recorded checkpoint for task ${id} — ` +
          `the task may not have reached this step yet or the name is incorrect`,
      )
    }

    // Check whether the task still has incomplete blockers so we can restore
    // it to 'blocked' rather than 'queued' (same invariant as coreRestartTask).
    const hasBlockers = await hasIncompleteBlockers(id)

    // Clear stale failure markers so a re-queued task is never mistakenly
    // tagged as failed or daemon-killed (matches coreRestartTask clean-up).
    // Also clear claudeSessionId so the next dispatch gets a fresh session.
    await updateTask(id, {
      status: hasBlockers ? 'blocked' : 'queued',
      claudeSessionId: null,
      error: null,
      failedPhase: null,
      failureSignature: null,
      failureReasonCode: null,
      currentStepName: null,
      currentStepGuide: null,
    })

    if (hasBlockers) {
      bus.emit('task.blocked', { taskId: id })
    } else {
      bus.emit('task.queued', { taskId: id })
    }

    return { nextStep: stepName, queued: !hasBlockers, cleared }
  }

  // `mars task note <id> "<text>"` / `mars task check <id> <n> [--uncheck]`:
  // append a journal entry to the progress journal (Foreground-session discipline).
  const appendProgress = (params: Parameters<typeof Arc.appendProgress>[0]) =>
    Arc.appendProgress(params)

  // Preview-process registry: manages long-lived stack children spawned by the
  // preview.spawn / preview.status / preview.teardown RPC ops.
  const previewRegistry = new PreviewRegistry(resolveContext().stateDir)

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
      verify: verifySem,
    },
    getAcceptingWork: () => acceptingWork,
    setAcceptingWork: (value: boolean) => {
      acceptingWork = value
      heartbeatHandle?.setDispatchEnabled(acceptingWork && !pause.isPaused())
    },
    getPauseState: () => pause.get(),
    pauseDispatch: (reason, detail) => pause.pause(reason, detail),
    // Operator resume clears BOTH halves of a storm pause (in-memory pause and
    // the durable breaker flag); every other reason is a plain clear.
    resumeDispatch: () => {
      if (pause.get().reason === 'storm') {
        void stormBreaker.resume('operator resume')
        return
      }
      pause.resume()
    },
    resetSignatureStorm: async () => {
      const { resetFailureSignatureStreak } = await import('../lib/signature-storm-monitor')
      await resetFailureSignatureStreak(getCompositionRootClient())
    },
    drain: () => drain(),
    shutdown: (force?: boolean) => shutdown(force),
    paths: { socketPath, pidFile, httpPortFile },
    handleAdd,
    setTaskPriority,
    handleUpdate,
    handleContinue,
    handleStop,
    handleRestart,
    handleRemerge,
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
    handleProposalReslice,
    handleProposalTake,
    handleRefine,
    dispatchGlossaryWrite,
    dispatchAdrAdd,
    dispatchAdrSupersede,
    dispatchVisionWrite,
    handleInit,
    handleStatus,
    investigateWorktree,
    diagnoseFailure,
    handleReleaseLease,
    handleStepDone,
    handleStepReset,
    appendProgress,
    appendMcpWorkerAudit: async ({ toolName, taskId, argsJson, ok, errorMessage }) => {
      await dbClient.execute({
        sql: `INSERT INTO mcp_worker_audit
                (tool_name, task_id, args_json, ok, error_message)
              VALUES (?, ?, ?::jsonb, ?, ?)`,
        args: [toolName, taskId, JSON.stringify(argsJson), ok, errorMessage],
      })
    },
    handlePreviewSpawn: (taskId, cmd, cwd) => previewRegistry.spawn(taskId, cmd, cwd),
    handlePreviewStatus: (taskId) => previewRegistry.status(taskId),
    handlePreviewTeardown: (taskId) => previewRegistry.teardown(taskId),
    handleCancelMergeJob: async (jobId: string) => {
      const { getDefaultMergeJobStore: getMergeJobStore } = await import(
        '../store/merge-job-store'
      )
      const updated = await getMergeJobStore().markCanceled(jobId, 'canceled by operator')
      const workerAborted = mergeWorkerHandle !== null
        ? mergeWorkerHandle.cancelJob(jobId)
        : false
      return { canceled: updated !== null, workerAborted }
    },
    handleSpendControlShow: () => loadSpendControl(dbClient),
    handleSpendControlSet: (patch) => upsertSpendControl(dbClient, patch),
  })

  const handleRequest = async (req: DaemonRequest): Promise<DaemonResponse> => {
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
  // Running marker: written here (after startup guards pass) and deleted at
  // the end of shutdown(). Its presence on the NEXT startup indicates this
  // run exited uncleanly — see the unclean-exit detection block at the top of
  // startDaemon and the daemon-died-sweep reconciler.
  writeFileSync(
    runningMarker,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    'utf8',
  )
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
  const { coreRemergeTask: coreRemerge } = await import('./remerge-task')
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

          // Count tasks blocked behind this arc: tasks whose blocker_task_id
          // is any task in the arc AND whose status is 'blocked'.
          const arcTaskIds = arcTasks.map((t) => t.id)
          let blockedCount = 0
          try {
            const placeholders = arcTaskIds.map(() => '?').join(', ')
            const blockedResult = await store.query({
              sql: `SELECT COUNT(DISTINCT tb.task_id) AS cnt
                      FROM task_blockers tb
                      JOIN tasks t ON t.id = tb.task_id
                     WHERE tb.blocker_task_id IN (${placeholders})
                       AND t.status = 'blocked'`,
              args: arcTaskIds,
            })
            const row = blockedResult.rows[0] as
              | Record<string, unknown>
              | undefined
            blockedCount =
              typeof row?.cnt === 'number'
                ? row.cnt
                : parseInt(String(row?.cnt ?? '0'), 10) || 0
          } catch {
            // Non-fatal: blocked count unavailable — omit it by leaving 0.
          }

          records.push({
            arcId,
            goal: origin.intent || origin.prompt,
            failureSignature: failing.failureSignature,
            capturedError,
            traceTail: capturedError,
            descendants,
            chain,
            failedPhase: failing.failedPhase ?? null,
            blockedCount,
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
      listVerifyUncovered: async () => {
        const client = getCompositionRootClient()
        const records: {
          fingerprint: string
          recipe: string | null
          scope: string
          changedPaths: string[]
        }[] = []
        const seenFingerprints = new Set<string>()
        try {
          const r = await client.execute(
            `SELECT fingerprint, payload
               FROM action_queue_items
              WHERE kind = 'verify-uncovered' AND state = 'open'
              ORDER BY raised_at DESC`,
          )
          for (const row of r.rows) {
            const r0 = row as unknown as Record<string, unknown>
            const fingerprint = typeof r0.fingerprint === 'string' ? r0.fingerprint : null
            if (!fingerprint || seenFingerprints.has(fingerprint)) continue
            seenFingerprints.add(fingerprint)
            let payload: Record<string, unknown> = {}
            try {
              const parsed = JSON.parse(r0.payload as string)
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                payload = parsed as Record<string, unknown>
              }
            } catch {
              /* ignore malformed historical payloads */
            }
            const changedPaths = Array.isArray(payload.changedPaths)
              ? payload.changedPaths.filter((path): path is string => typeof path === 'string')
              : []
            records.push({
              fingerprint,
              recipe: typeof payload.recipe === 'string' ? payload.recipe : null,
              scope: typeof payload.scope === 'string' ? payload.scope : '.',
              changedPaths,
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
    getPauseState: () => pause.get(),
    getSituationSemaphoreSnapshot: () => {
      const workerSems = [...new Set([...Object.values(sems), verifySem])]
      return {
        inUse: workerSems.reduce((total, sem) => total + sem.inUse, 0),
        limit: workerSems.reduce((total, sem) => total + sem.limit, 0),
      }
    },
    getStepResultsForRun: async (runId: string) => {
      const { createQueueWorkflowStore } = await import('../../workflows/queue-workflow-store')
      const wfStore = createQueueWorkflowStore()
      const steps = await wfStore.listSteps(runId)
      const m = new Map<string, string | null>()
      for (const s of steps) {
        m.set(s.name, s.resultJson)
      }
      return m
    },
  })

  // The chat stream hub is the per-thread UIMessageChunk source: the ChatRunner
  // publishes mapped+buffered chunks into it, and the GET /chat/threads/:id/
  // ui-stream route replays/follows them. One instance shared by both.
  const { ChatStreamHub } = await import('./chat-stream-hub')
  const chatStreamHub = new ChatStreamHub()
  const chatRunner = new ChatRunner(chatStreamHub)

  const httpHandle = await startHttpServer({
    chatRunner,
    chatStreamHub,
    restartTask: async (id) => {
      const result = await coreRestart(id, new Set(['failed', 'done', 'vega-reconciling', 'merging']), makeWorkflowStore())
      if (result.status === 'queued') {
        bus.emit('task.queued', { taskId: id })
      }
    },
    remergeTask: async (id) => {
      await coreRemerge(id, new Set(['failed', 'done', 'vega-reconciling', 'merging', 'verifying']), makeWorkflowStore())
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
      const { dismissProposal } = await import('../proposals')
      await dismissProposal(id)
    },
    promoteProposal: async (id) => {
      await promoteProposal(id)
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
    landWork: async (id) => {
      const { landWorkForTask } = await import('./land-work')
      await landWorkForTask(id)
      bus.emit('task.queued', { taskId: id })
    },
    investigateWorktree,
    diagnoseFailure,
    restartDaemon: async () => {
      // Re-exec a detached `mars daemon start` and let this process drain +
      // exit. Spawned detached so it survives our shutdown.
      await spawnReplacementDaemon()
      log(`restart-daemon requested; spawned replacement, draining self`)
      // Trigger our own graceful shutdown after the response flushes.
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
    },
    restartAllDaemonKilled: async () => {
      // Find every failed task stamped with the daemon-killed signature and
      // re-queue each one. Partial failures are tolerated: tasks that fail to
      // restart (e.g. wrong status race) are skipped; only successfully
      // restarted ids are returned.
      //
      // Cancellation guard: skip tasks with failureReason='cancelled' — the user
      // explicitly stopped that work and a bulk restart must not override that
      // intent. The user can still explicitly re-queue a cancelled task via the
      // per-task 'restart' action if they change their mind.
      const failed = await listTasks('failed')
      const killed = failed.filter(
        (t) =>
          t.failureSignature === DAEMON_KILLED_SIGNATURE &&
          t.failureReason !== CANCELLED_FAILURE_REASON,
      )
      const restarted: string[] = []
      for (const task of killed) {
        try {
          const result = await coreRestart(task.id, new Set(['failed']), makeWorkflowStore())
          if (result.status === 'queued') {
            bus.emit('task.queued', { taskId: task.id })
          }
          restarted.push(task.id)
        } catch {
          // Skip tasks that can't be restarted (e.g. raced to a different
          // status between the list and the restart). The others still proceed.
        }
      }
      log(`restart-all-daemon-killed: restarted ${restarted.length}/${killed.length} task(s)`)
      return restarted
    },
    runReflect: async () => {
      // Run the same reflect pipeline as `mars reflect` and close the level-triggered
      // reflect-recommended action-queue row when done.
      const { loadRecentTaskCorpus } = await import('../lib/reflect-query')
      const { runReflector, persistSuggestions } = await import('../lib/reflector')
      const { closeReflectRecommendedRow } = await import('../lib/self-evolve-trigger')
      const { insertReflectionTask } = await import('../queue')
      const corpus = await loadRecentTaskCorpus({ limit: 10 })
      let proposalsRaised = 0
      if (corpus.entries.length > 0) {
        const result = await runReflector(corpus)
        if (result.suggestions.length > 0) {
          const sourceTaskId = await insertReflectionTask(corpus.entries.length)
          await persistSuggestions(result.suggestions, sourceTaskId)
          proposalsRaised = result.suggestions.length
          log(`[run-reflect] raised ${proposalsRaised} proposal(s)`)
          viewStreamHub.broadcast('proposals')
          viewStreamHub.broadcast('action-queue')
        }
      }
      // Close the reflect-recommended row regardless of whether proposals were raised.
      await closeReflectRecommendedRow()
      viewStreamHub.broadcast('action-queue')
      return { proposalsRaised }
    },
    enableAutoReflect: async () => {
      const { persistSelfEvolveAutoTrigger } = await import('./config')
      const { closeReflectRecommendedRow } = await import('../lib/self-evolve-trigger')
      persistSelfEvolveAutoTrigger(true)
      log('[enable-auto-reflect] selfEvolve.autoTrigger set to true in daemon.json')
      await closeReflectRecommendedRow()
      viewStreamHub.broadcast('action-queue')
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
            await spawnReplacementDaemon()
            log('self-update complete; spawned replacement daemon, draining self')
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
          },
        }),
      )
    },
    stepDone: async (id: string): Promise<{ next: string | null }> => {
      const task = await getTask(id)
      if (!task) {
        throw Object.assign(new Error(`task ${id} not found`), {
          code: 'NOT_FOUND' as const,
        })
      }
      // Idempotency: task already advanced past awaiting-human (queued / running /
      // verifying / merging / done) — return success without mutating anything.
      if (
        task.status === 'queued' ||
        task.status === 'running' ||
        task.status === 'verifying' ||
        task.status === 'merging' ||
        task.status === 'done'
      ) {
        return { next: null }
      }
      if (task.status !== 'awaiting-human') {
        throw Object.assign(
          new Error(
            `task ${id} is ${task.status}; step-done only applies to awaiting-human tasks`,
          ),
          { code: 'WRONG_STATUS' as const },
        )
      }
      if (task.leaseOwner === null) {
        throw Object.assign(
          new Error(`task ${id} has no active lease`),
          { code: 'WRONG_STATUS' as const },
        )
      }
      await handleStepDone(id)
      return { next: null }
    },
    snoozeItem: async (id: string, until: string) => {
      const { snoozeActionQueueItem } = await import('../lib/action-queue')
      await snoozeActionQueueItem(id, until)
      viewStreamHub.broadcast('action-queue')
    },
    recipeCatalog,
    traceStore,
    viewStreamHub,
    appServices,
    getStewardRuntimeState: () => ({
      liveCap: sems.implement.limit,
      baselineCap: initialCaps.implement,
      isPaused: pause.get().paused,
    }),
    getLiveAgentsRoster: () =>
      buildLiveAgentsRoster({
        flights: tracker.inFlightSnapshot().map((e) => ({
          taskId: e.taskId,
          workerName: e.kind,
          startedAt: e.startedAt,
          lastActivityMs: e.lastActivityMs,
        })),
        reflectors: [],
      }),
  })
  writeFileSync(httpPortFile, String(httpHandle.port), 'utf8')
  log(`HTTP action endpoint on http://127.0.0.1:${httpHandle.port} (port → ${httpPortFile})`)

  // ── Storm-breaker ⇄ pause-state reconcile ────────────────────────────────
  // The breaker's `tripped` flag is durable (the `failure_signature_streak`
  // singleton row); the pause is in-memory. A daemon that came up with
  // `tripped=true` used to dispatch happily while the DB still said the fleet
  // was stormed — the exact drift that made `mars daemon status` report PAUSED
  // with nothing on disk to explain it. Restore the pause WITH its reason
  // ('storm') and re-arm the bounded fallback so the restart cannot leave
  // dispatch dead forever either.
  //
  // Awaited deliberately, BEFORE reconcile() triggers the first drain(), so
  // queued tasks cannot dispatch through the gap during an active storm.
  //
  // Single source of truth: `tripped` drives both "never re-raise the action-
  // queue row" (recordFailureSignature's alreadyTripped guard) and "keep the
  // queue paused" (here). Note the operator pause restored from daemon.json
  // above already holds the first-cause slot when both are set — one resume
  // then clears the pause and this flag together.
  //
  // `mars operator set dispatch on` clears `tripped` and zeroes the streak,
  // so the NEXT restart does NOT re-pause a queue the operator unblocked.
  try {
    const { readSignatureStormState } = await import('../lib/signature-storm-monitor')
    const stormState = await readSignatureStormState(getCompositionRootClient())
    if (stormState.tripped) {
      const sig = stormState.signature ?? 'unknown'
      if (pause.pause('storm', `signature storm: ${sig} x${stormState.streak} (restored at startup)`)) {
        log(`[signature-storm] breaker was tripped on "${sig}" — dispatch restored to paused`)
      } else {
        log(
          `[signature-storm] breaker was tripped on "${sig}" — dispatch already paused (reason=${pause.get().reason})`,
        )
      }
      // Armed in both branches: whichever cause holds the pause, the durable
      // breaker flag must not be able to wedge dispatch indefinitely. No
      // Steward is in flight after a restart, so this is exactly the
      // "nobody is going to report an outcome" case the fallback exists for.
      stormBreaker.armFallback(sig)
    }
  } catch (err) {
    log(
      `[signature-storm] startup breaker reconcile failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // Re-check durable usage deferrals at the same cadence as the other daemon
  // sweepers. The flight tracker retains ownership of its pending set, so the
  // sweeper gets only the narrow capability it needs to re-queue a task.
  const deferralWakeSweeper = startDeferralWakeSweeper({
    drain,
    pendingImplement: {
      add: (taskId) => tracker.enqueuePending(taskId, 'implement'),
    },
    getLatestSnapshot: () => getLatestUsageSnapshot(dbClient),
    getTask,
  })

  // Boot reconcile after server is listening (so any reconcile-driven dispatch
  // is fully wired). Once it is complete, reconcile durable deferrals as well:
  // a daemon that was down over a reset window can immediately resume work.
  void reconcile()
    .then(() => deferralWakeSweeper.tick())
    .catch((err) => log(`[reconcile] failed: ${(err as Error).message}`))

  // ── API endpoint probe ────────────────────────────────────────────────────
  // While the circuit breaker is open, probe the Anthropic API every 30 s
  // (default; override via MARS_API_PROBE_INTERVAL_MS). On a successful probe
  // the breaker is closed and dispatch resumes on the next dispatcher tick.
  // .unref() inside startApiEndpointProbe ensures the interval never prevents
  // a clean shutdown. The stop handle is called in shutdown() below.
  const ENDPOINT_PROBE_INTERVAL_MS = Number(
    process.env.MARS_API_PROBE_INTERVAL_MS ?? 30_000,
  )
  const stopEndpointProbe = startApiEndpointProbe({ intervalMs: ENDPOINT_PROBE_INTERVAL_MS })
  log(`[api-probe] started (intervalMs=${ENDPOINT_PROBE_INTERVAL_MS})`)

  // Boot drain for the alert-dismisser outbox subscriber: register it (no
  // replay — chokepoint already reconciles history) and clear alerts for any
  // status changes published while the daemon was down.
  //
  // reconcileTerminalTasks is deliberately NOT part of the RECONCILERS
  // startup registry (see ./reconciler.ts): it is an action-queue concern,
  // takes a DbClient rather than ReconcileDeps, and must run *here* —
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

  // A verify-gate.quarantined event is durable evidence of a new quarantine
  // episode. Register before the periodic drain so an event emitted while the
  // daemon was down is diagnosed exactly once when it returns.
  void (async () => {
    try {
      await ensureGateFixStewardSubscriber(getCompositionRootClient())
      const { processed } = await drainGateFixSteward(
        getCompositionRootClient(),
        runGateFixStewardDispatch,
        undefined,
        log,
      )
      if (processed > 0) log(`[gate-fix-steward] dispatched ${processed} quarantined gate diagnosis(es) on boot`)
    } catch (err) {
      log(`[gate-fix-steward] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // Blocked tasks with the same canonical failure are narrated together. The
  // per-batch timer is armed from the persisted opened_at value, so the Notice
  // appears after its full coalescing window rather than on this poll cadence.
  void (async () => {
    try {
      await ensureFailureConversationNoticeSubscriber(getCompositionRootClient())
      const { processed } = await drainFailureConversationNotices(
        getCompositionRootClient(),
        Date.now,
        log,
      )
      await scheduleFailureConversationNoticeFlush(getCompositionRootClient(), log)
      if (processed > 0) log(`[failure-conversation-notices] batched ${processed} blocked task(s) on boot`)
    } catch (err) {
      log(`[failure-conversation-notices] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // Recipe autoruns are operational changes, not a new Subthread: replay their
  // durable events into the shared conversation as zero-token Notices.
  void (async () => {
    try {
      await ensureRecipeConversationNoticeSubscriber(getCompositionRootClient())
      const { processed } = await drainRecipeConversationNotices(
        getCompositionRootClient(),
        log,
      )
      if (processed > 0) log(`[recipe-conversation-notice] posted ${processed} Notice(s) on boot`)
    } catch (err) {
      log(`[recipe-conversation-notice] boot drain failed: ${(err as Error).message}`)
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

  // Boot drain for the recovery-spawner outbox subscriber: register it and
  // spawn fix tasks for any task.failed events published while the daemon was
  // down. This is the durable backstop that guarantees ADR-0061's
  // "every regular-task failure spawns a fix" — wired here so the subscriber
  // cursor is always registered on daemon start.
  void (async () => {
    try {
      await ensureRecoverySpawner(getCompositionRootClient())
      const { processed } = await drainRecoverySpawner(
        getCompositionRootClient(),
        log,
        handleSignatureStorm,
      )
      if (processed > 0)
        log(`[recovery-spawner] spawned fix tasks for ${processed} failure(s) on boot`)
    } catch (err) {
      log(`[recovery-spawner] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // A Subthread's terminal event is a durable domain boundary. Register and
  // drain on boot so events published while the daemon was down still close
  // their matching Subthread after restart.
  void (async () => {
    try {
      await ensureSubthreadCloser(getCompositionRootClient())
      const { processed } = await drainSubthreadCloser(getCompositionRootClient(), log)
      if (processed > 0) {
        viewStreamHub.broadcast('chat')
        log(`[subthread-closer] closed ${processed} Subthread(s) on boot`)
      }
    } catch (err) {
      log(`[subthread-closer] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // An alert mutating is grounds to ask whether its Subthread can be filed
  // away. Boot-drain alongside the closer so mutations published while the
  // daemon was down still raise their prompt after restart.
  void (async () => {
    try {
      await ensureArchivePrompter(getCompositionRootClient())
      const { processed } = await drainArchivePrompter(getCompositionRootClient(), log)
      if (processed > 0) {
        viewStreamHub.broadcast('chat')
        log(`[archive-prompter] raised ${processed} archive prompt(s) on boot`)
      }
    } catch (err) {
      log(`[archive-prompter] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // Boot drain for the arc-verifier outbox subscriber: register it and trigger
  // any pending arc verifications for task.terminal { reason: 'done' } events
  // that were published while the daemon was down.
  void (async () => {
    try {
      await ensureArcVerifierSubscriber(getCompositionRootClient())
      const { processed } = await drainArcVerifier(
        getCompositionRootClient(),
        scheduleArcVerification,
        log,
      )
      if (processed > 0)
        log(`[arc-verifier] triggered ${processed} verification(s) on boot`)
    } catch (err) {
      log(`[arc-verifier] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // Boot drain for the archive-entries outbox subscriber: register it and
  // insert entries for any action-queue.resolved / task.terminal { reason:
  // 'done' } events that were published while the daemon was down.
  void (async () => {
    try {
      await ensureArchiveEntriesSubscriber(getCompositionRootClient())
      const { processed } = await drainArchiveEntries(getCompositionRootClient())
      if (processed > 0)
        log(`[archive-entries] archived ${processed} event(s) on boot`)
    } catch (err) {
      log(`[archive-entries] boot drain failed: ${(err as Error).message}`)
    }
  })()

  // ── Merge worker ──────────────────────────────────────────────────────────
  // Single-consumer loop that claims merge_jobs rows and executes them
  // serially. Always started — the merge queue is unconditionally on.
  // The AbortController is aborted in shutdown(); stop() then waits for any
  // in-flight job to finish.
  const mergeWorkerAc = new AbortController()
  mergeWorkerHandle = startMergeWorker({
    store: getDefaultMergeJobStore(),
    log,
    bus,
    signal: mergeWorkerAc.signal,
  })
  log('[merge-worker] started')

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
  // Relevant, stable local code drift automatically restarts an idle dev
  // daemon by default. Busy daemons, dependency manifest drift, and
  // MARS_DEV_AUTORESTART=0 retain the level-triggered restart nudge instead.
  // Active only for dev installs (prod is handled by self-update.ts). On any
  // git error the check is a no-op — we never flip isStale to false once it is
  // true. .unref() so the interval never prevents a clean shutdown. Override
  // cadence via MARS_DEV_STALENESS_CHECK_MS. The startup reconciler
  // (code-drift-clear-sweep) resolves open drift rows after a restart.
  const DEV_STALENESS_CHECK_MS = Number(process.env.MARS_DEV_STALENESS_CHECK_MS ?? 60_000)
  let lastDevDriftHead: string | null = null
  let stableDevDriftChecks = 0
  const devStalenessCheck = setInterval(() => {
    void (async () => {
      try {
        const { stdout } = await exec(resolveGitBin(), ['rev-parse', 'HEAD'], { cwd: sourceDir })
        const head = stdout.trim() || null
        if (!(await hasRelevantDevDrift(sourceSha, head, installRoute, sourceRepoDir))) {
          lastDevDriftHead = null
          stableDevDriftChecks = 0
          return
        }

        currentSha = head
        isStale = true
        stableDevDriftChecks = head === lastDevDriftHead ? stableDevDriftChecks + 1 : 1
        lastDevDriftHead = head
        const dependencyDrift = await hasDevDependencyDrift(sourceSha, head, sourceRepoDir)
        const action = decideDevStalenessAction({
          sourceSha,
          currentSha: head,
          installRoute,
          inFlightCount: tracker.inFlightCount(),
          dependencyDrift,
          stabilityCount: stableDevDriftChecks,
          autoRestartEnabled: devAutoRestartEnabled,
        })

        if (action === 'restart') {
          const shortSrc = sourceSha?.slice(0, 7) ?? '?'
          const shortHead = head?.slice(0, 7) ?? '?'
          log(`[dev-autorestart] HEAD ${shortSrc} -> ${shortHead}, restarting daemon`)
          // Mirror the restartDaemon RPC handler. The replacement startup
          // reconciler clears any pre-existing daemon-code-drift row.
          await spawnReplacementDaemon()
          setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
          return
        }

        if (action === 'nudge') {
          // Raise a level-triggered action-queue row so operators see the drift
          // without having to poll `mars daemon status`. Idempotent: if a row
          // with signature 'daemon-code-drift' is already open, raiseActionQueueItem
          // bumps its seen_count instead of inserting a duplicate.
          try {
            const { raiseActionQueueItem } = await import('../lib/action-queue')
            const shortSrc = sourceSha?.slice(0, 7) ?? '?'
            const shortHead = head?.slice(0, 7) ?? '?'
            await raiseActionQueueItem({
              kind: 'daemon-code-drift',
              category: 'daemon',
              priority: 'high',
              title: `Daemon running stale code — ${shortSrc} → ${shortHead}`,
              body:
                dependencyDrift
                  ? `daemon running ${shortSrc}, main is at ${shortHead}; dependencies changed — ` +
                    `run your package install, then \`mars daemon restart\``
                  : `daemon running ${shortSrc}, main is at ${shortHead} — ` +
                    `run \`mars daemon restart\` to load current verify/dispatch code`,
              payload: { sourceSha, currentSha: head },
              context: {},
              raisedBy: 'daemon:dev-staleness-check',
              // Singleton signature: one open row per daemon lifetime.
              signature: 'daemon-code-drift',
              occurrence: { detectedAt: new Date().toISOString() },
            })
          } catch (aqErr) {
            log(
              `[dev-staleness] failed to raise action-queue item: ${(aqErr as Error).message}`,
            )
          }
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
  //
  // Re-queue loop defence (mars-c11be862 post-mortem, 2026-07-02): before
  // re-seeding any queued task, we check its retry duration. A task retrying
  // longer than MARS_REQUEUE_MAX_RETRY_MS of dispatch uptime (default 2 h)
  // without completing is
  // escalated to 'failed' + an operator action-queue item rather than re-seeded.
  // Retry count and elapsed time are logged for any task that has been attempted
  // at least once so the state is visible before the bound is reached.
  // See orchestrator/src/core/daemon/requeue-ceiling.ts for the ceiling logic.
  const POLL_FALLBACK_MS = Number(process.env.MARS_DRAIN_POLL_MS ?? 30_000)
  const pollFallback = setInterval(() => {
    if (!acceptingWork || pause.isPaused() || drainRunning || tracker.inFlightCount() > 0) return
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
        const { createQueueWorkflowStore: makeWFStore } = await import(
          '../../workflows/queue-workflow-store'
        )
        const { checkAndEscalateRequeueCeiling } = await import('./requeue-ceiling')
        const wfStore = makeWFStore()
        for (const t of queued) {
          if (tracker.isInFlight(t.id)) continue
          const escalated = await checkAndEscalateRequeueCeiling(
            t,
            wfStore,
            log,
            Date.now(),
            heartbeatHandle?.getDispatchUptimeMs(),
          )
          if (!escalated) tracker.enqueuePending(t.id, 'implement')
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

  // ── Queued-dispatch sweep ─────────────────────────────────────────────────
  // Writers inside the daemon normally call the dispatch-hint seam immediately
  // after their transaction commits. This periodic DB re-read is the durable
  // backstop for a missed hint: unlike pollFallback it also runs while other
  // workers are active, so one forgotten handoff cannot strand a queued row
  // until the daemon goes idle or restarts. Re-emitting task.queued intentionally
  // takes the normal bus path, which feeds pendingImplement and invokes drain();
  // drain then re-reads the row and validates its status and blockers before it
  // can claim a worker slot.
  const QUEUED_DISPATCH_SWEEP_MS = Number(
    process.env.MARS_QUEUED_DISPATCH_SWEEP_MS ?? 30_000,
  )
  const queuedDispatchSweep = setInterval(() => {
    if (!acceptingWork || pause.isPaused()) return
    void (async () => {
      try {
        const queued = await listTasks('queued')
        for (const task of queued) {
          if (!tracker.isInFlight(task.id)) {
            bus.emit('task.queued', { taskId: task.id })
          }
        }
      } catch (err) {
        log(`[queued-dispatch-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, QUEUED_DISPATCH_SWEEP_MS)
  queuedDispatchSweep.unref()

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

  // ── Stale-merge sweep (merging + vega-reconciling) ───────────────────────
  // Defense-in-depth: periodically re-queues any task whose status is still
  // 'merging' or 'vega-reconciling' but whose updated_at exceeds the stale
  // threshold. This handles two residual windows:
  //   - 'merging': mergeBranch threw (releasing the lock) but the calling
  //     workflow failed before flipping the task out of 'merging', leaving it
  //     stranded until the next daemon restart.
  //   - 'vega-reconciling': the vcs-supervisor (Vega) subprocess was killed or
  //     crashed without advancing the task status; unlike the boot reconcile
  //     that catches daemon-restart stranding, this sweep catches a live daemon
  //     whose Vega session died mid-conflict-resolution without a restart.
  //
  // The threshold (15 min) is deliberately conservative: the maximum possible
  // time for a legitimate in-flight merge is lockTimeoutMs (5 min) + watchdogMs
  // (5 min default) = 10 min. Any 'merging' or 'vega-reconciling' row older
  // than 15 min is therefore guaranteed to be stale and safe to recover.
  //
  // IMPORTANT: only tasks exceeding the threshold are recovered. This prevents
  // racing a legitimately in-progress merge or Vega session set recently.
  // .unref() so the interval never prevents a clean shutdown.
  const STALE_MERGING_THRESHOLD_MS = 15 * 60_000
  const STALE_MERGING_SWEEP_MS = 5 * 60_000
  const staleMergingSweep = setInterval(() => {
    void (async () => {
      try {
        const { listTasks: listTasksForSweep } = await import('../queue')
        const now = Date.now()
        const mergingTasks = await listTasksForSweep('merging')
        const vegaTasks = await listTasksForSweep('vega-reconciling')
        const staleMerging = mergingTasks.filter(
          (t) => now - new Date(t.updatedAt).getTime() > STALE_MERGING_THRESHOLD_MS,
        )
        const staleVega = vegaTasks.filter(
          (t) => now - new Date(t.updatedAt).getTime() > STALE_MERGING_THRESHOLD_MS,
        )
        if (staleMerging.length === 0 && staleVega.length === 0) return

        const { recoverPhase } = await import('./phase-recovery')
        const { getRepoRoot } = await import('../context')
        const repoRoot = getRepoRoot()

        if (staleMerging.length > 0) {
          log(
            `[stale-merging-sweep] found ${staleMerging.length} stale merging task(s) (>15 min); recovering`,
          )
          const r = await recoverPhase('merging', { log, bus, repoRoot })
          if (r.requeued.length > 0) {
            log(
              `[stale-merging-sweep] requeued ${r.requeued.length} task(s) from stale merging state`,
            )
            viewStreamHub.broadcast('tasks')
          }
          if (r.finalized > 0) {
            log(
              `[stale-merging-sweep] finalized ${r.finalized} task(s) whose FF already landed`,
            )
            viewStreamHub.broadcast('tasks')
          }
        }

        if (staleVega.length > 0) {
          log(
            `[stale-merging-sweep] found ${staleVega.length} stale vega-reconciling task(s) (>15 min); recovering`,
          )
          const rv = await recoverPhase('vega-reconciling', { log, bus, repoRoot })
          if (rv.requeued.length > 0) {
            log(
              `[stale-merging-sweep] requeued ${rv.requeued.length} vega-reconciling task(s) from stale state`,
            )
            viewStreamHub.broadcast('tasks')
          }
          if (rv.finalized > 0) {
            log(
              `[stale-merging-sweep] finalized ${rv.finalized} vega-reconciling task(s) whose FF already landed`,
            )
            viewStreamHub.broadcast('tasks')
          }
        }
      } catch (err) {
        log(`[stale-merging-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, STALE_MERGING_SWEEP_MS)
  staleMergingSweep.unref()

  // ── Stale queued-committer sweep ─────────────────────────────────────────
  // Periodically re-seeds `main-commiter` fix tasks stuck in `queued` with
  // `blocked` dependents whose `updated_at` exceeds the 15-minute threshold.
  // This mirrors the boot-time `queued-committer-reseed` reconciler and covers
  // the runtime case: the reconciler fires once at boot, but the committer can
  // be spawned long after boot (e.g. when dirty-main is first detected mid-run).
  // Emitting `task.queued` on the bus triggers the handler that pushes the id
  // into `pendingImplement` and calls `drain()`. The primary fix (emitting
  // `task.queued` immediately on spawn in `dispatchImplement`) eliminates the
  // gap for new daemons; this sweep is belt-and-suspenders for any race window
  // or daemon that predates that fix. .unref() so it never prevents shutdown.
  const STALE_QUEUED_COMMITTER_SWEEP_MS = 5 * 60_000
  const STALE_QUEUED_COMMITTER_THRESHOLD_MS = 15 * 60_000
  const staleQueuedCommitterSweep = setInterval(() => {
    void (async () => {
      try {
        const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
          '../lib/main-dirty'
        )
        const { getDefaultDomainTaskStore: getDomainStore } = await import('../store/task-store')
        const threshold = new Date(Date.now() - STALE_QUEUED_COMMITTER_THRESHOLD_MS).toISOString()
        const r = await getDomainStore().query(
          `SELECT DISTINCT t.id AS id, t.recovery_payload AS recovery_payload
             FROM tasks t
             JOIN task_blockers tb ON tb.blocker_task_id = t.id
             JOIN tasks dep ON dep.id = tb.task_id
            WHERE t.kind = 'fix'
              AND t.status = 'queued'
              AND dep.status = 'blocked'
              AND t.updated_at < ?`,
          [threshold],
        )
        let reseeded = 0
        for (const row of r.rows as unknown as Array<{
          id: string
          recovery_payload: string | null
        }>) {
          if (parseMainCommiterPayload(row.recovery_payload)?.recipe !== MAIN_COMMITER_RECIPE) {
            continue
          }
          bus.emit('task.queued', { taskId: row.id })
          reseeded++
        }
        if (reseeded > 0) {
          log(
            `[stale-queued-committer-sweep] re-seeded ${reseeded} stale queued main-commiter(s) with blocked dependents`,
          )
        }
      } catch (err) {
        log(`[stale-queued-committer-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, STALE_QUEUED_COMMITTER_SWEEP_MS)
  staleQueuedCommitterSweep.unref()

  // ── Reflect-recommended detector sweep ───────────────────────────────────
  // Periodically evaluates reflect-worthiness (KPI drift, failure clusters,
  // token spikes) and raises / clears the level-triggered reflect-recommended
  // action-queue row. Mirrors the stale-worktree sweep cadence. .unref() so
  // the interval never prevents a clean shutdown.
  const REFLECT_DETECTOR_MS = Number(
    process.env.MARS_REFLECT_DETECTOR_MS ?? 5 * 60_000,
  )
  const { runReflectRecommendedDetector } = await import('../lib/self-evolve-trigger')
  const reflectDetectorSweep = setInterval(() => {
    void (async () => {
      try {
        const result = await runReflectRecommendedDetector()
        if (result.raised) {
          log(
            `[reflect-detector] raised reflect-recommended row (row=${result.rowId})`,
          )
          viewStreamHub.broadcast('action-queue')
        } else if (result.skipReason === 'auto-trigger-on') {
          log(
            '[reflect-detector] no row raised — selfEvolve.autoTrigger=true handles proposals directly via KPI-drift trigger',
          )
        } else {
          log(
            '[reflect-detector] no signals: kpiDrift=0 failureClusters=0 tokenSpike=null; reflection not yet needed',
          )
        }
      } catch (err) {
        log(`[reflect-detector] errored: ${(err as Error).message}; check logs for details`)
      }
    })()
  }, REFLECT_DETECTOR_MS)
  reflectDetectorSweep.unref()

  // ── Observational Notice sweep ───────────────────────────────────────────
  // The proactive half of the main thread: nothing here reacts to an event,
  // so nothing else would ever run it. Deliberately infrequent — every Notice
  // it can produce describes a *trend* or a *habit*, and neither changes
  // between one hour and the next. Delivery still waits for a pause, so a
  // sweep landing mid-grill queues rather than interrupts.
  const NOTICE_SWEEP_MS = Number(process.env.MARS_NOTICE_SWEEP_MS ?? 60 * 60_000)
  const runObservationalNotices = async (): Promise<void> => {
    const { runNoticeSweep } = await import('../lib/notices/sweep.js')
    const { resolveStateClient: stateClient } = await import('../store/state-client.js')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const repoRoot = resolveContext().repoRoot
    const integrationBranch = process.env.INTEGRATION_BRANCH ?? 'main'
    const result = await runNoticeSweep({
      client: stateClient(),
      repoRoot,
      integrationBranch,
      log,
      listCommits: async (branch, sinceMs) => {
        const { stdout } = await promisify(execFile)(
          'git',
          ['log', branch, '--format=%H', `--since=${new Date(sinceMs).toISOString()}`],
          { cwd: repoRoot },
        )
        return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      },
    })
    if (result.posted > 0) {
      log(`[notice-sweep] spoke ${result.posted} Notice(s)`)
      viewStreamHub.broadcast('chat')
    }
  }
  const noticeSweep = setInterval(() => {
    void runObservationalNotices().catch((err: unknown) => {
      log(`[notice-sweep] errored: ${(err as Error).message}`)
    })
  }, NOTICE_SWEEP_MS)
  noticeSweep.unref()
  // Run once at startup so a fresh session opens on something to do rather
  // than on an empty feed that fills an hour later.
  void runObservationalNotices().catch((err: unknown) => {
    log(`[notice-sweep] startup sweep errored: ${(err as Error).message}`)
  })

  // ── Orphan-subprocess sweep ──────────────────────────────────────────────
  // Verify/test runners that outlive their task (abort, timeout, or a daemon
  // that died before it could kill the group) get reparented to init and burn
  // CPU indefinitely. The Steward reaps them on its own schedule here, in
  // addition to the boot sweep and the sweep on the autotuner's hold path.
  // .unref() so the interval never prevents a clean shutdown.
  const ORPHAN_SWEEP_MS = Number(process.env.MARS_ORPHAN_SWEEP_MS ?? 5 * 60_000)
  const { sweepOrphans: sweepOrphanProcesses, formatSweepSummary: formatOrphanSweep } =
    await import('../lib/orphan-reaper')
  const orphanSweep = setInterval(() => {
    void (async () => {
      try {
        const summary = await sweepOrphanProcesses({
          repoRoot: resolveContext().repoRoot,
          inFlightTaskIds: liveInFlightTaskIds(),
          log,
        })
        if (summary.reaped > 0) {
          log(`[orphan-reaper] periodic sweep: ${formatOrphanSweep(summary)}`)
        }
      } catch (err) {
        log(`[orphan-reaper] periodic sweep errored: ${(err as Error).message}`)
      }
    })()
  }, ORPHAN_SWEEP_MS)
  orphanSweep.unref()

  // ── Steward runtime-knob tuning ──────────────────────────────────────────
  // When the implement queue is backlogged (pending > cap × 0.75) for a
  // sustained window (default 60 s), emit kpi.backlog.degraded so the
  // steward subscriber bumps the cap autonomously. .unref() so the
  // interval never prevents a clean shutdown.
  const BACKLOG_CHECK_MS = Number(process.env.MARS_BACKLOG_CHECK_MS ?? 10_000)
  const BACKLOG_SUSTAIN_MS = Number(process.env.MARS_BACKLOG_SUSTAIN_MS ?? 60_000)
  let backlogSince: number | null = null
  const { startStewardRuntimeTune } = await import('../../outbox/subscribers/steward-runtime-tune')
  startStewardRuntimeTune({
    bus,
    implementSem: sems.implement,
    baselineCap: initialCaps.implement,
    log,
    repoRoot: resolveContext().repoRoot,
    getInFlightTaskIds: liveInFlightTaskIds,
    recordCapDecision: (reason) => {
      implementCapReason = reason
    },
  })
  // Prompt health follows the same daemon event bus as the other autonomous
  // Steward capabilities. Its own autonomy lever decides whether a degraded
  // prompt is merely proposed or changed.
  const { startStewardPromptOptimization } = await import('../steward-prompt-optimizer')
  startStewardPromptOptimization(bus)
  const backlogCheck = setInterval(() => {
    const pending = tracker.pendingCount('implement')
    const threshold = Math.floor(sems.implement.limit * 0.75)
    if (pending > threshold) {
      if (backlogSince === null) backlogSince = Date.now()
      const elapsed = Date.now() - backlogSince
      if (elapsed >= BACKLOG_SUSTAIN_MS) {
        bus.emit('kpi.backlog.degraded', {
          pending,
          cap: sems.implement.limit,
          sustainedMs: elapsed,
        })
        backlogSince = null
      }
    } else {
      backlogSince = null
    }
  }, BACKLOG_CHECK_MS)
  backlogCheck.unref()

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
        const itemId = await checkObservabilityStoreSize(resolveDbTarget())
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

  // ── DB busy-storm watchdog ────────────────────────────────────────────────
  // Detects when the database layer is saturated with persistent errors
  // (deadlock-retry budget exhausted) and escalates in three stages:
  //   1. Log loudly (STORM DETECTED in watch.log).
  //   2. Attempt a connection-pool recycle.
  //   3. Trigger a daemon self-restart (safe since mars-c11be862 landed).
  // Each stage fires on a separate watchdog tick (default 30 s).
  // Override cadence via MARS_DB_BUSY_WATCHDOG_MS.
  // Disable self-restart via MARS_DB_BUSY_STORM_RESTART=false.
  // .unref() so the interval never prevents a clean shutdown.
  const MARS_DB_BUSY_WATCHDOG_MS = Number(
    process.env.MARS_DB_BUSY_WATCHDOG_MS ?? 30_000,
  )
  const { checkAndEscalateDbBusyStorm } = await import('./db-busy-watchdog')
  let dbBusyStage: import('./db-busy-watchdog').BusyEscalationStage | null = null
  const dbBusyWatchdog = setInterval(() => {
    void (async () => {
      try {
        const result = await checkAndEscalateDbBusyStorm(
          resolveDbTarget(),
          log,
          recycleDbPool,
          () => {
            // Mirror the restartDaemon RPC handler: spawn a replacement, then
            // gracefully shut down this process after a brief flush delay.
            void spawnReplacementDaemon()
              .then(() => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100))
              .catch((err: unknown) =>
                log(`[db-busy-watchdog] replacement spawn failed: ${(err as Error).message}`),
              )
          },
          dbBusyStage,
        )
        dbBusyStage = result.nextStage
      } catch (err) {
        log(`[db-busy-watchdog] errored: ${(err as Error).message}`)
      }
    })()
  }, MARS_DB_BUSY_WATCHDOG_MS)
  dbBusyWatchdog.unref()

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
        await sweepOutbox(resolveDbTarget())
      } catch (err) {
        log(`[outbox-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, MARS_OUTBOX_PRUNE_INTERVAL_MS)
  outboxSweep.unref()

  // ── Deployment-status sweeper ─────────────────────────────────────────────
  // Periodically polls task_deployments rows with status='pending' and
  // updates them once the provider reports ready or failed.  On a ready
  // transition the sweeper also patches the awaiting-validation action-queue
  // payload so operators see the preview URL without restarting the daemon.
  // Interval defaults to 5 s (MARS_DEPLOY_POLL_INTERVAL_MS to override).
  // .unref() is handled inside startDeploymentStatusSweeper so the interval
  // never prevents a clean daemon shutdown.
  const { startDeploymentStatusSweeper } = await import('./deployment-status-sweeper.js')
  startDeploymentStatusSweeper()
  log('[deployment-sweep] started')

  // ── Phantom-task watchdog ─────────────────────────────────────────────────
  // Periodically sweeps for tasks stuck in 'running' or 'verifying' with no
  // live subprocess, preventing a dead worker from holding an in-flight slot
  // indefinitely (the root cause of the mars-f35b1c7f 12-hour freeze).
  //
  // Two detection mechanisms (belt and suspenders):
  //  1. PID liveness: if an in-flight entry carries a recorded PID and
  //     isProcessAlive(pid) returns false, the task is auto-failed immediately
  //     without waiting for the wall-clock ceiling.
  //  2. Wall-clock ceiling: applied differently by PID availability:
  //     a. No PID: checked against task.updatedAt (bare-ceiling backstop).
  //     b. Alive PID + lastActivityMs set: checked against lastActivityMs so
  //        a healthy long-running coder is never killed for having a stale row.
  //        The dispatchImplement onEvent callback keeps lastActivityMs fresh
  //        (~once per minute) via tracker.recordActivity().
  //     c. Alive PID + no lastActivityMs: NOT ceiling-killed. Dead-PID is the
  //        only kill path until the first heartbeat arrives.
  //
  // Recovery: phantom kills do NOT spawn a recovery task. The operator receives
  // an action-queue item and can restart or drop the task explicitly. This is
  // intentional for both dead-PID kills (the coder is gone; recovery would
  // start from whatever state the row was in) and alive-PID hung-process kills
  // (the process is stuck; recovery would likely re-hang). An operator restart
  // (`mars restart`) is the appropriate resolution in both cases.
  //
  // For each phantom: marks the task failed with failedPhase set, calls
  // forceRelease (tracker-only; the dispatcher's own finally is the sole
  // semaphore releaser — see the reclaim callback below) to free the slot,
  // triggers drain() so queued work resumes, and raises exactly one
  // action-queue item (dedup by taskId prevents a retry storm). .unref() so
  // the timer never prevents shutdown.
  const PHANTOM_WATCHDOG_MS = Number(
    process.env.MARS_PHANTOM_WATCHDOG_MS ?? 5 * 60_000,
  )
  const { sweepPhantomTasks } = await import('./phantom-task-watchdog')
  const phantomWatchdog = setInterval(() => {
    void (async () => {
      try {
        const { failed, requeued } = await sweepPhantomTasks(
          tracker.inFlightSnapshot(),
          (id, _kind) => {
            // Mirror handleDrop(force=true): force-clear ONLY the tracker entry
            // and let drain() reclaim the slot once the dispatcher's own release
            // closure runs. Do NOT release(sems[kind]) here — the phantom task's
            // dispatchImplement is (almost always) still awaiting its workflow
            // (an alive-but-stalled verify, or a dead subprocess whose awaited
            // runWorkflow will still reject and unwind), and its `finally`
            // (release(sems.implement)) is the SOLE semaphore releaser. Releasing
            // here as well double-releases one acquire: each spurious release
            // either wakes an extra waiter (dispatch past the cap) or drives
            // inUse below the true in-flight count, permanently defeating the
            // implement cap. Under overload this is self-reinforcing (more
            // concurrent verifies -> more 30-min stalls -> more double-releases).
            tracker.forceRelease(id)
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
        if (requeued.length > 0) {
          log(
            `[phantom-watchdog] re-queued ${requeued.length} orphaned running task(s) with no in-flight entry: ${requeued.join(', ')}`,
          )
          for (const taskId of requeued) {
            bus.emit('task.queued', { taskId })
          }
          viewStreamHub.broadcast('tasks')
          void drain()
        }
      } catch (err) {
        log(`[phantom-watchdog] errored: ${(err as Error).message}`)
      }
    })()
  }, PHANTOM_WATCHDOG_MS)
  phantomWatchdog.unref()

  // ── Stale-queued watchdog ─────────────────────────────────────────────────
  // Periodically scans for tasks that have been sitting in 'queued' past
  // MARS_STALE_QUEUED_MS (default 10 min) and raises a 'stale-queued'
  // action-queue alert for each one. The alert payload includes the queued age,
  // active worker count, and total queue depth so the operator can tell whether
  // the pool is saturated or the dispatcher is stuck.
  //
  // Duplicate suppression: raiseActionQueueItem deduplicates on
  // sha1('stale-queued:<taskId>'), so repeated sweeps while the task remains
  // queued bump seen_count rather than spawning sibling rows.
  //
  // Runs on the same interval as the phantom-task watchdog (MARS_PHANTOM_WATCHDOG_MS).
  // .unref() so the timer never prevents shutdown.
  const { runStaleQueuedSweep } = await import('./stale-queued-watchdog')
  const staleQueuedWatchdog = setInterval(() => {
    void (async () => {
      try {
        const activeWorkerCount = tracker.inFlightCount()
        const queuedTasks = await listTasks('queued')
        const queueDepth = queuedTasks.length
        const { alerted } = await runStaleQueuedSweep({
          activeWorkerCount,
          implementCap: sems.implement.limit,
          queueDepth,
          dispatchDecisionSummary: [],
        })
        if (alerted.length > 0) {
          log(
            `[stale-queued-watchdog] raised alert for ${alerted.length} stale-queued task(s): ${alerted.join(', ')}`,
          )
          viewStreamHub.broadcast('action-queue')
        }
      } catch (err) {
        log(`[stale-queued-watchdog] errored: ${(err as Error).message}`)
      }
    })()
  }, PHANTOM_WATCHDOG_MS)
  staleQueuedWatchdog.unref()

  // ── Awaiting-validation watchdog ─────────────────────────────────────────
  // Reuse the stale-queued / phantom cadence: preview-gated tasks are parked
  // deliberately, but a dead preview must be demoted immediately and expires
  // after 48h so it cannot pollute the operator queue forever.
  const { runAwaitingValidationSweep } = await import('./awaiting-validation-watchdog')
  const awaitingValidationWatchdog = setInterval(() => {
    void (async () => {
      try {
        const { demoted, failed } = await runAwaitingValidationSweep()
        if (demoted.length > 0 || failed.length > 0) {
          log(
            `[awaiting-validation-watchdog] demoted ${demoted.length} dead preview(s); expired ${failed.length} task(s)`,
          )
          viewStreamHub.broadcast('action-queue')
          viewStreamHub.broadcast('tasks')
        }
      } catch (err) {
        log(`[awaiting-validation-watchdog] errored: ${(err as Error).message}`)
      }
    })()
  }, PHANTOM_WATCHDOG_MS)
  awaitingValidationWatchdog.unref()

  // ── Observability telemetry sweeper ───────────────────────────────────────
  // Periodically deletes trace_events rows older than three days so the
  // state store stays bounded across multi-day sessions. The sweep reuses
  // the same pruneObservability routine that `mars observability prune` calls —
  // the retention window is always 3 days and is never shortened by the sweeper.
  // Logs the row count when any rows are removed. .unref() so the timer never
  // keeps the daemon process alive after shutdown.
  const OBSERVABILITY_SWEEP_MS = Number(
    process.env.MARS_OBSERVABILITY_SWEEP_MS ?? 60 * 60_000,
  )
  const { sweepObservability, sweepRetention } = await import('./observability-sweeper')
  const observabilitySweep = setInterval(() => {
    void (async () => {
      try {
        const dbTarget = resolveDbTarget()

        // Primary time-based telemetry prune (3-day window).
        const deleted = await sweepObservability(dbTarget)
        if (deleted > 0) {
          log(
            `[observability-sweep] pruned ${deleted} telemetry row(s) older than 3 days`,
          )
        }

        // Secondary retention sweep: row-count cap on trace_events (50 000
        // rows / 30 days) and orphan prune of subscriber_processed_events.
        // Runs in the same interval so no extra timer is needed.
        const retention = await sweepRetention(dbTarget)
        const retentionDeleted =
          retention.traceEventsByAge +
          retention.traceEventsByLogLineAge +
          retention.traceEventsByCount +
          retention.subscriberProcessedEvents
        // Always log the gauge so drift (e.g. 180k rows vs 50k cap) is visible
        // in watch.log rather than silent until a deletion threshold is crossed.
        log(
          `[retention-sweep] trace_events: ${retention.traceEventsRemaining} rows` +
            ` (cap ${RETENTION_MAX_ROWS_DEFAULT}),` +
            ` deleted ${retentionDeleted}` +
            ` (${retention.traceEventsByAge} by age,` +
            ` ${retention.traceEventsByLogLineAge} log_line age,` +
            ` ${retention.traceEventsByCount} by count);` +
            ` ${retention.subscriberProcessedEvents} subscriber_processed_events orphans`,
        )
      } catch (err) {
        log(`[observability-sweep] errored: ${(err as Error).message}`)
      }
    })()
  }, OBSERVABILITY_SWEEP_MS)
  observabilitySweep.unref()

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

  // ── Subscriber drain single-flight gate ───────────────────────────────────
  // Every subscriber drain below runs on a setInterval whose body can outlast
  // its own period (a drain awaits provider calls and verify commands, each of
  // which can take minutes). Unguarded, each tick stacks another concurrent
  // drain of the SAME subscriber on top of the last.
  //
  // That is not merely wasteful. `drainWithStall` runs the handler BEFORE
  // claiming the `subscriber_processed_events` row, so concurrent drains all
  // pass the "already processed?" check and all execute the side effect; only
  // the bookkeeping is deduped, not the work. For handlers that spawn agents
  // this multiplies into a host-melting fan-out — the duplicate-key errors on
  // `subscriber_processed_events_pkey` in the daemon log are the direct
  // signature of this race.
  //
  // Ticks arriving while a drain is in flight are DROPPED, not queued: a drain
  // always resumes from the durable cursor, so a skipped tick loses no work —
  // the next one picks up exactly where this one stopped.
  const singleFlight = (fn: () => Promise<void>): (() => void) => {
    let running = false
    return () => {
      if (running) return
      running = true
      void fn().finally(() => {
        running = false
      })
    }
  }

  // ── Alert-dismisser drain ─────────────────────────────────────────────────
  // Polls the outbox for status-transition events and clears the implicated
  // task's action-queue alert(s). This keeps the "status change clears
  // alerts" invariant whole for raw-SQL status writes that bypass the
  // updateTask chokepoint. .unref() so it never holds the process open.
  const ALERT_DRAIN_MS = Number(process.env.MARS_ALERT_DRAIN_MS ?? 30_000)
  const alertDrain = setInterval(
    singleFlight(async () => {
      try {
        await drainAlertDismissals(getCompositionRootClient(), log)
      } catch (err) {
        log(`[alert-dismisser] drain errored: ${(err as Error).message}`)
      }
    }),
    ALERT_DRAIN_MS,
  )
  alertDrain.unref()

  // ── Action queue repopulator drain ───────────────────────────────────────────────
  // Polls the outbox for task/proposal lifecycle events and applies the
  // corresponding action_queue_items mutations. .unref() so it never holds the
  // process open.
  const ACTION_QUEUE_REPOPULATOR_DRAIN_MS = Number(
    process.env.MARS_ACTION_QUEUE_REPOPULATOR_DRAIN_MS ?? 30_000,
  )
  const actionQueueRepopulatorDrain = setInterval(
    singleFlight(async () => {
      try {
        const { processed } = await drainActionQueueRepopulations(getCompositionRootClient(), log)
        if (processed > 0) viewStreamHub.broadcast('action-queue')
      } catch (err) {
        log(`[action-queue-repopulator] drain errored: ${(err as Error).message}`)
      }
    }),
    ACTION_QUEUE_REPOPULATOR_DRAIN_MS,
  )
  actionQueueRepopulatorDrain.unref()

  // ── Blocker-resolution drain ──────────────────────────────────────────────
  // Polls the outbox for task.terminal { reason: 'done' } events and unblocks
  // any dependents whose every blocker is now done. .unref() so it never holds
  // the process open.
  const BLOCKER_RESOLUTION_DRAIN_MS = Number(
    process.env.MARS_BLOCKER_RESOLUTION_DRAIN_MS ?? 30_000,
  )
  const blockerResolutionDrain = setInterval(
    singleFlight(async () => {
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
    }),
    BLOCKER_RESOLUTION_DRAIN_MS,
  )
  blockerResolutionDrain.unref()

  // ── Recovery-spawner drain ────────────────────────────────────────────────
  // Polls the outbox for task.failed events and spawns fix tasks for any
  // regular-task failures not yet handled. This is the durable backstop that
  // guarantees ADR-0061's "every regular-task failure spawns a fix" even when
  // the inline dispatch path in the verify primitive is skipped or crashes.
  // .unref() so it never holds the process open.
  const RECOVERY_SPAWNER_DRAIN_MS = Number(
    process.env.MARS_RECOVERY_SPAWNER_DRAIN_MS ?? 30_000,
  )
  const recoverySpawnerDrain = setInterval(
    singleFlight(async () => {
      try {
        await drainRecoverySpawner(getCompositionRootClient(), log, handleSignatureStorm)
      } catch (err) {
        log(`[recovery-spawner] drain errored: ${(err as Error).message}`)
      }
    }),
    RECOVERY_SPAWNER_DRAIN_MS,
  )
  recoverySpawnerDrain.unref()

  // ── Subthread terminal-event drain ────────────────────────────────────────
  const CLOSE_SUBTHREAD_ON_TERMINAL_EVENT_DRAIN_MS = Number(
    process.env.MARS_CLOSE_SUBTHREAD_ON_TERMINAL_EVENT_DRAIN_MS ?? 30_000,
  )
  const closeSubthreadOnTerminalEventDrain = setInterval(
    singleFlight(async () => {
      try {
        const { processed } = await drainSubthreadCloser(getCompositionRootClient(), log)
        if (processed > 0) viewStreamHub.broadcast('chat')
      } catch (err) {
        log(`[subthread-closer] drain errored: ${(err as Error).message}`)
      }
    }),
    CLOSE_SUBTHREAD_ON_TERMINAL_EVENT_DRAIN_MS,
  )
  closeSubthreadOnTerminalEventDrain.unref()

  // ── Subthread archive-prompt drain ────────────────────────────────────────
  const ARCHIVE_PROMPT_DRAIN_MS = Number(
    process.env.MARS_ARCHIVE_PROMPT_DRAIN_MS ?? 30_000,
  )
  const archivePromptDrain = setInterval(
    singleFlight(async () => {
      try {
        const { processed } = await drainArchivePrompter(getCompositionRootClient(), log)
        if (processed > 0) viewStreamHub.broadcast('chat')
      } catch (err) {
        log(`[archive-prompter] drain errored: ${(err as Error).message}`)
      }
    }),
    ARCHIVE_PROMPT_DRAIN_MS,
  )
  archivePromptDrain.unref()

  // ── Recipe conversation Notice drain ────────────────────────────────────
  const RECIPE_CONVERSATION_NOTICE_DRAIN_MS = Number(
    process.env.MARS_RECIPE_CONVERSATION_NOTICE_DRAIN_MS ?? 30_000,
  )
  const recipeConversationNoticeDrain = setInterval(
    singleFlight(async () => {
      try {
        await drainRecipeConversationNotices(getCompositionRootClient(), log)
      } catch (err) {
        log(`[recipe-conversation-notice] drain errored: ${(err as Error).message}`)
      }
    }),
    RECIPE_CONVERSATION_NOTICE_DRAIN_MS,
  )
  recipeConversationNoticeDrain.unref()

  // ── Failure conversation Notice drain ───────────────────────────────────
  // Polling picks up durable outbox events written by another process; the
  // scheduler above still flushes each batch at its exact opened_at deadline.
  const FAILURE_CONVERSATION_NOTICE_DRAIN_MS = Number(
    process.env.MARS_FAILURE_CONVERSATION_NOTICE_DRAIN_MS ?? 1_000,
  )
  const failureConversationNoticeDrain = setInterval(
    singleFlight(async () => {
      try {
        await drainFailureConversationNotices(getCompositionRootClient(), Date.now, log)
        await scheduleFailureConversationNoticeFlush(getCompositionRootClient(), log)
      } catch (err) {
        log(`[failure-conversation-notices] drain errored: ${(err as Error).message}`)
      }
    }),
    FAILURE_CONVERSATION_NOTICE_DRAIN_MS,
  )
  failureConversationNoticeDrain.unref()

  // ── Arc-verifier drain ───────────────────────────────────────────────────
  // Polls the outbox for task.terminal { reason: 'done' } events and triggers
  // arc-outcome verification for any arc that has fully completed with merged
  // commits. Fire-and-forget: the verifier runs asynchronously and never blocks
  // the merge path or dispatch loop. .unref() so it never holds the process open.
  const ARC_VERIFIER_DRAIN_MS = Number(
    process.env.MARS_ARC_VERIFIER_DRAIN_MS ?? 30_000,
  )
  const arcVerifierDrain = setInterval(
    singleFlight(async () => {
      try {
        await drainArcVerifier(
          getCompositionRootClient(),
          scheduleArcVerification,
          log,
        )
      } catch (err) {
        log(`[arc-verifier] drain errored: ${(err as Error).message}`)
      }
    }),
    ARC_VERIFIER_DRAIN_MS,
  )
  arcVerifierDrain.unref()

  // ── Archive-entries drain ────────────────────────────────────────────────
  // Polls the outbox for action-queue.resolved and task.terminal { reason:
  // 'done' } events and inserts archive_entries. Insertion is always silent.
  const ARCHIVE_ENTRIES_DRAIN_MS = Number(
    process.env.MARS_ARCHIVE_ENTRIES_DRAIN_MS ?? 30_000,
  )
  const archiveEntriesDrain = setInterval(
    singleFlight(async () => {
      try {
        await drainArchiveEntries(getCompositionRootClient())
      } catch (err) {
        log(`[archive-entries] drain errored: ${(err as Error).message}`)
      }
    }),
    ARCHIVE_ENTRIES_DRAIN_MS,
  )
  archiveEntriesDrain.unref()

  const GATE_FIX_STEWARD_DRAIN_MS = Number(
    process.env.MARS_GATE_FIX_STEWARD_DRAIN_MS ?? 30_000,
  )
  const gateFixStewardDrain = setInterval(
    singleFlight(async () => {
      try {
        await drainGateFixSteward(getCompositionRootClient(), runGateFixStewardDispatch, undefined, log)
      } catch (err) {
        log(`[gate-fix-steward] drain errored: ${(err as Error).message}`)
      }
    }),
    GATE_FIX_STEWARD_DRAIN_MS,
  )
  gateFixStewardDrain.unref()

  // ── Usage snapshot sampler ────────────────────────────────────────────────
  const { startUsageSampler } = await import('./usage-sampler')
  const usageSamplerInterval = startUsageSampler(
    getCompositionRootClient(),
    log,
    () => deferralWakeSweeper.tick(),
  )
  usageSamplerInterval.unref()

  // ── Shutdown ──────────────────────────────────────────────────────────────

  const shutdown = async (force = false): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(pollFallback)
    clearInterval(queuedDispatchSweep)
    clearInterval(githubUpdatePoll)
    clearInterval(devStalenessCheck)
    clearInterval(staleSweep)
    clearInterval(staleMergingSweep)
    clearInterval(observabilityWatchdog)
    clearInterval(noticeSweep)
    clearInterval(orphanSweep)
    clearInterval(dbBusyWatchdog)
    clearInterval(phantomWatchdog)
    clearInterval(observabilitySweep)
    clearInterval(kpiSnapshotSweep)
    clearInterval(alertDrain)
    clearInterval(actionQueueRepopulatorDrain)
    clearInterval(blockerResolutionDrain)
    clearInterval(recoverySpawnerDrain)
    clearInterval(closeSubthreadOnTerminalEventDrain)
    clearInterval(recipeConversationNoticeDrain)
    clearInterval(failureConversationNoticeDrain)
    clearFailureConversationNoticeFlush(getCompositionRootClient())
    clearInterval(arcVerifierDrain)
    clearInterval(gateFixStewardDrain)
    clearInterval(usageSamplerInterval)
    deferralWakeSweeper.stop()
    // Drop the dispatch hint before the tracker is torn down, so a writer that
    // creates a task during shutdown does not fan out into a dead tracker.
    unregisterDispatchHint()
    // Same reasoning for the liveness probe: once this daemon stops
    // dispatching, its tracker no longer describes reality, and an in-process
    // caller must fall back to 'unknown' rather than read a frozen map.
    setWorkerLivenessProbe(null)
    stopEndpointProbe()
    // Once shutdown starts, stop dispatching new work even if drain wasn't
    // explicitly requested — a SIGINT/SIGTERM that arrives while the
    // dispatcher is mid-pick must not strand an extra worktree.
    acceptingWork = false
    heartbeatHandle?.setDispatchEnabled(false)
    // Stop recurring writes before the final flush and database teardown. An
    // already-running write remains best-effort and has its own rejection
    // handler in the writer.
    heartbeatHandle?.stop()
    await heartbeatHandle?.flush().catch((err) => {
      log(`[heartbeat] final flush failed (non-fatal): ${(err as Error).message}`)
    })
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

    // Stop the merge worker (if running) before closing the DB so any in-flight
    // job can complete its markDone / markFailed store call cleanly.
    mergeWorkerAc.abort()
    if (mergeWorkerHandle !== null) {
      await mergeWorkerHandle.stop()
    }

    // Drain in-flight chat runs before closing servers. If a run has not yet
    // produced any text (e.g. it triggered the restart itself), the shutdown
    // message is written as its assistant reply so the thread does not end
    // with the default "[no output]" placeholder. Bounded by CHAT_TIMEOUT_MS;
    // killAll() below is the safety net for any run that outlives the window.
    await chatRunner.shutdownDrain(
      'Daemon is restarting — this reply did not complete. Please reconnect and try again.',
      CHAT_TIMEOUT_MS,
    )
    chatRunner.killAll()
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      httpHandle.close(),
    ])
    // Close the trace-event store handle so its pool reference is released.
    // process.exit below would also do this, but be explicit so the handle
    // never lingers if exit is delayed.
    await traceStore.close()
    // Release the boot-time DB handle, then stop the embedded PostgreSQL
    // server — AFTER the trace store closed so no live consumer loses its
    // backend mid-write. stop() is a no-op for an adopted postmaster (owned
    // by an overlapping daemon or a deliberate orphan; see pg-server.ts).
    try {
      await dbClient.close()
    } catch {
      // best-effort
    }
    if (pgHandle !== null) {
      try {
        await pgHandle.stop()
      } catch (err) {
        log(`[pg] stop failed: ${(err as Error).message}`)
      }
    }
    // Delete all sentinel/marker files so the next startup sees a clean state.
    // runningMarker deletion is load-bearing for unclean-exit detection: its
    // absence on the next start means this shutdown completed cleanly.
    // crashMarker deletion clears the crash record once the daemon has run its
    // startup reconcile and raised (or bumped) the daemon-died action-queue item.
    // pg.port/pg.dsn join the list ONLY when this daemon started the PG server
    // — an adopted server stays up, so its published files must stay valid.
    const pgPublishFiles =
      pgHandle !== null && !pgHandle.adopted
        ? [
            resolvePath(resolveContext().stateDir, 'pg.port'),
            resolvePath(resolveContext().stateDir, 'pg.dsn'),
          ]
        : []
    for (const f of [socketPath, pidFile, httpPortFile, runningMarker, crashMarker, lockFile, ...pgPublishFiles]) {
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
    // runners, DuckDB handles, PG pool sockets, and child Claude processes
    // keep the event loop alive otherwise, which leaks the DuckDB
    // single-writer lock across restarts. SIGINT/SIGTERM already exit;
    // mirror that for RPC.
    process.exit(0)
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      log(`received ${sig}`)
      void shutdown(false)
    })
  }

  // ── Fatal error handlers ──────────────────────────────────────────────────
  // Log fatal errors synchronously to watch.log and exit immediately.
  //
  // Intentionally do NOT call shutdown() here: shutdown() would delete the
  // runningMarker, which is the crash-detection sentinel read on the next
  // daemon start. An unhandledRejection / uncaughtException is always an
  // unclean exit — preserving the running marker ensures the daemon-died-sweep
  // reconciler raises an action-queue alert on restart.
  //
  // process.exit(1) instead of process.exit(0) so the pid stays in the pid
  // file (cleanup did not run), ensuring isDaemonAlive() returns 'dead-pid'
  // rather than 'no-pid', giving the operator a stronger signal.
  process.on('uncaughtException', (err: Error) => {
    try {
      writeLog(
        logFile,
        `[fatal] uncaughtException: ${err.message}\n${err.stack ?? '(no stack)'}`,
      )
    } catch {
      // best-effort: if even writeLog fails, just exit
    }
    process.exit(1)
  })

  process.on('unhandledRejection', (reason: unknown) => {
    try {
      const msg =
        reason instanceof Error
          ? `${reason.message}\n${reason.stack ?? '(no stack)'}`
          : String(reason)
      writeLog(logFile, `[fatal] unhandledRejection: ${msg}`)
    } catch {
      // best-effort
    }
    process.exit(1)
  })

  return {
    stop: shutdown,
    inFlightCount: () => tracker.inFlightCount(),
  }
}
