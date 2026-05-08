import { execFile } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { resolveContext } from '../context'
import { sendRequest } from '../daemon/client'
import { removeWorktree } from '../lib/git'
import { raiseInboxItem } from '../lib/inbox'
import { getTask, type Task } from '../queue'
import { sweeperPaths } from './paths'

const exec = promisify(execFile)

const LOG_ROTATE_BYTES = 10 * 1024 * 1024
const DEFAULT_TICK_MS = 60 * 60 * 1000
const STALE_AFTER_MS = 60 * 60 * 1000

export const sweeperPayloadSchema = z.object({
  taskId: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  status: z.string(),
  lastSweptAt: z.string(),
  ageHours: z.number(),
})

export type SweeperPayload = z.infer<typeof sweeperPayloadSchema>

export interface SweeperHandle {
  stop: () => Promise<void>
  tick: () => Promise<void>
}

export interface SweeperOptions {
  intervalMs?: number
  log?: (line: string) => void
}

const writeLog = (logFile: string, line: string): void => {
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  try {
    if (existsSync(logFile)) {
      const size = statSync(logFile).size
      if (size > LOG_ROTATE_BYTES) renameSync(logFile, `${logFile}.1`)
    } else {
      mkdirSync(dirname(logFile), { recursive: true })
    }
    appendFileSync(logFile, stamped)
  } catch {
    // best-effort
  }
}

interface DiscoveredWorktree {
  path: string
  branch: string
  taskId: string
  mtimeMs: number
}

const sweepRoot = (): string =>
  resolve(resolveContext().repoRoot, '.mars', 'worktrees')

const discoverWorktrees = (): DiscoveredWorktree[] => {
  const root = sweepRoot()
  if (!existsSync(root)) return []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const out: DiscoveredWorktree[] = []
  for (const name of entries) {
    const path = resolve(root, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    out.push({
      path,
      branch: `task/${name}`,
      taskId: name,
      mtimeMs: st.mtimeMs,
    })
  }
  return out
}

const IN_FLIGHT_STATUSES: ReadonlySet<Task['status']> = new Set([
  'queued',
  'running',
  'verifying',
  'merging',
])

const TERMINAL_STATUSES: ReadonlySet<Task['status']> = new Set([
  'done',
  'dropped',
  'failed',
])

const isAncestorOfMain = async (
  branch: string,
  repoRoot: string,
): Promise<boolean> => {
  try {
    await exec('git', ['merge-base', '--is-ancestor', branch, 'main'], {
      cwd: repoRoot,
    })
    return true
  } catch (err: unknown) {
    const code = (err as { code?: number }).code
    if (code === 1) return false
    // Any other error (e.g. branch missing): treat as not-an-ancestor so
    // the desync path runs and the operator gets a self-heal task.
    return false
  }
}

const buildDesyncPrompt = (
  taskId: string,
  branch: string,
  status: Task['status'],
): string => {
  const symptom =
    status === 'done'
      ? `task ${taskId} reports done in queue.db but ${branch} is not an ancestor of main`
      : `task ${taskId} reports ${status} in queue.db but ${branch} IS an ancestor of main (terminal-failure status with a landed branch)`
  return [
    `Self-heal a desynced task. Mars and git disagree about whether ${branch} landed.`,
    ``,
    `Symptom: ${symptom}.`,
    ``,
    `Investigate:`,
    `  - Compare the branch tip of ${branch} against main (git log main..${branch} and ${branch}..main).`,
    `  - Look for amended/rebased commits, force pushes, or a partial merge.`,
    `  - Check the orchestrator merge log entries for this task.`,
    ``,
    `Resolve by EITHER:`,
    `  (a) landing ${branch} cleanly into main (rebase + fast-forward, same path the orchestrator uses), or`,
    `  (b) updating the task row for ${taskId} to status='failed' with an explanatory error explaining why the desync exists and why landing it is wrong.`,
    ``,
    `If you cannot decide between (a) and (b), call \`mars inbox\` programmatically (use addInboxItem from orchestrator/src/mastra/lib/inbox.ts via raiseInboxItem) with the desync details (taskId=${taskId}, branch=${branch}, current status=${status}, what you investigated, what blocks a decision) and exit. Do NOT remove the worktree. Do NOT silently flip statuses without a clear reason recorded in the error column.`,
    ``,
    `Save your work: stage and commit any code or doc changes you make. The orchestrator does not commit on your behalf.`,
  ].join('\n')
}

interface SweepCounters {
  cleaned: number
  keptInFlight: number
  keptFresh: number
  alerted: number
  desyncTasks: number
}

const handleCandidate = async (
  wt: DiscoveredWorktree,
  task: Task,
  repoRoot: string,
  now: number,
  log: (line: string) => void,
  counters: SweepCounters,
): Promise<void> => {
  const merged = await isAncestorOfMain(wt.branch, repoRoot)
  const status = task.status
  const ageMs = Math.max(0, now - new Date(task.updatedAt).getTime())
  const ageHours = ageMs / (1000 * 60 * 60)

  if (status === 'done' && merged) {
    await removeWorktree({ path: wt.path, branch: wt.branch }, true, true)
    counters.cleaned += 1
    log(`[sweeper] cleaned ${wt.branch} (done+merged)`)
    return
  }

  if ((status === 'done' && !merged) || (status !== 'done' && merged)) {
    // DESYNC. Enqueue one self-heal task per worktree, do not remove.
    const prompt = buildDesyncPrompt(wt.taskId, wt.branch, status)
    try {
      const data = (await sendRequest({
        op: 'add',
        prompt,
        skipTriage: true,
        author: { kind: 'agent', name: 'sweeper' },
      })) as { id?: string } | undefined
      const id = typeof data?.id === 'string' ? data.id : '?'
      counters.desyncTasks += 1
      log(
        `[sweeper] desync ${wt.branch} (mars=${status}, merged=${merged}); enqueued self-heal task ${id}`,
      )
    } catch (err) {
      log(
        `[sweeper] desync ${wt.branch} (mars=${status}, merged=${merged}); failed to enqueue self-heal: ${(err as Error).message}`,
      )
    }
    return
  }

  // status in {dropped, failed} AND not merged → expected stale; refire inbox
  // every tick (no dedup).
  const lastSweptAt = new Date(now).toISOString()
  const payload: SweeperPayload = sweeperPayloadSchema.parse({
    taskId: wt.taskId,
    branch: wt.branch,
    worktreePath: wt.path,
    status,
    lastSweptAt,
    ageHours,
  })
  try {
    const id = await raiseInboxItem({
      kind: 'stale-worktree',
      category: 'daemon',
      priority: 'normal',
      title: `stale worktree for ${wt.branch} (${status})`,
      body:
        `Task ${wt.taskId} is ${status} but its worktree is still on disk and the branch is not an ancestor of main.\n` +
        `Path: ${wt.path}\nBranch: ${wt.branch}\nAge since last update: ${ageHours.toFixed(1)}h.`,
      payload,
      context: { worktreePath: wt.path, branch: wt.branch },
      raisedBy: 'sweeper',
      // Unique signature per sweep tick → fingerprint differs each time, so
      // raiseInboxItem inserts a fresh row instead of bumping seen_count.
      signature: `stale-worktree:${wt.taskId}:${wt.path}:${lastSweptAt}`,
    })
    counters.alerted += 1
    log(
      `[sweeper] alert ${wt.branch} status=${status} age=${ageHours.toFixed(1)}h id=${id}`,
    )
  } catch (err) {
    log(
      `[sweeper] failed to raise alert for ${wt.taskId}: ${(err as Error).message}`,
    )
  }
}

export const runSweep = async (
  log: (line: string) => void,
): Promise<void> => {
  const ctx = resolveContext()
  const discovered = discoverWorktrees()
  if (discovered.length === 0) {
    log('[sweeper] tick: cleaned=0, kept-in-flight=0, kept-fresh=0, alerted=0, desync-tasks=0')
    return
  }

  const now = Date.now()
  const counters: SweepCounters = {
    cleaned: 0,
    keptInFlight: 0,
    keptFresh: 0,
    alerted: 0,
    desyncTasks: 0,
  }

  for (const wt of discovered) {
    try {
      const task = await getTask(wt.taskId)

      // Missing task row → could be racy mid-setup. Leave alone.
      if (!task) continue

      // In-flight → skip.
      if (IN_FLIGHT_STATUSES.has(task.status)) {
        counters.keptInFlight += 1
        continue
      }

      // Not terminal (e.g. draft, blocked) → skip; not a sweep candidate.
      if (!TERMINAL_STATUSES.has(task.status)) continue

      // Terminal but too fresh → skip.
      const ageMs = now - new Date(task.updatedAt).getTime()
      if (ageMs < STALE_AFTER_MS) {
        counters.keptFresh += 1
        continue
      }

      await handleCandidate(wt, task, ctx.repoRoot, now, log, counters)
    } catch (err) {
      log(
        `[sweeper] error on ${wt.path}: ${(err as Error).message}`,
      )
    }
  }

  log(
    `[sweeper] tick: cleaned=${counters.cleaned}, kept-in-flight=${counters.keptInFlight}, kept-fresh=${counters.keptFresh}, alerted=${counters.alerted}, desync-tasks=${counters.desyncTasks}`,
  )
}

export const startSweeper = async (
  opts: SweeperOptions = {},
): Promise<SweeperHandle> => {
  const intervalMs = opts.intervalMs ?? DEFAULT_TICK_MS
  const { pidFile, logFile } = sweeperPaths()

  const log = (line: string): void => {
    writeLog(logFile, line)
    opts.log?.(line)
  }

  mkdirSync(dirname(pidFile), { recursive: true })
  writeFileSync(pidFile, String(process.pid), 'utf8')
  log(
    `sweeper started (pid ${process.pid}, repo ${resolveContext().repoRoot}, intervalMs ${intervalMs})`,
  )

  let stopping = false
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (inFlight || stopping) return
    inFlight = true
    try {
      await runSweep(log)
    } catch (err) {
      log(`[sweeper] tick failed: ${(err as Error).message}`)
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  void tick()

  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    if (existsSync(pidFile)) {
      try {
        unlinkSync(pidFile)
      } catch {
        // best-effort
      }
    }
    log('sweeper stopped')
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      log(`received ${sig}`)
      void shutdown().then(() => process.exit(0))
    })
  }

  return { stop: shutdown, tick }
}
