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
import { z } from 'zod'
import { resolveContext } from '../context'
import { listTasks, type Task } from '../queue'
import { removeWorktree } from '../lib/git'
import { raiseInboxItem } from '../lib/inbox'
import { upsertSweeperPayload } from './payload'
import { sweeperPaths } from './paths'

const LOG_ROTATE_BYTES = 10 * 1024 * 1024
const DEFAULT_TICK_MS = 60 * 60 * 1000

const criticalityFromAge = (ageHours: number): 'low' | 'medium' | 'high' => {
  if (ageHours < 24) return 'low'
  if (ageHours < 72) return 'medium'
  return 'high'
}

export const sweeperPayloadSchema = z.object({
  taskId: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  lastSweptAt: z.string(),
  ageHours: z.number(),
  criticality: z.enum(['low', 'medium', 'high']),
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

const isStaleStatus = (status: Task['status']): boolean =>
  status === 'dropped' || status === 'failed'

const isMergedStatus = (status: Task['status']): boolean => status === 'done'

interface DiscoveredWorktree {
  path: string
  branch: string
  taskId: string
  mtimeMs: number
}

const collectWorktreeRoots = (): readonly string[] => {
  const ctx = resolveContext()
  return [
    resolve(ctx.repoRoot, '.worktrees'),
    resolve(ctx.stateDir, 'worktrees'),
  ]
}

const discoverWorktrees = (): DiscoveredWorktree[] => {
  const out: DiscoveredWorktree[] = []
  for (const root of collectWorktreeRoots()) {
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
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
  }
  return out
}

const ageHoursFrom = (mtimeMs: number, now: number): number => {
  const diffMs = Math.max(0, now - mtimeMs)
  return diffMs / (1000 * 60 * 60)
}

const buildSignature = (taskId: string, path: string): string =>
  `stale-worktree:${taskId}:${path}`

export const runSweep = async (
  log: (line: string) => void,
): Promise<void> => {
  const tasks = await listTasks()
  const taskById = new Map<string, Task>()
  for (const t of tasks) taskById.set(t.id, t)

  const discovered = discoverWorktrees()
  if (discovered.length === 0) {
    log('[sweep] no worktrees to inspect')
    return
  }

  const now = Date.now()
  for (const wt of discovered) {
    const task = taskById.get(wt.taskId) ?? null
    if (task && isMergedStatus(task.status)) {
      try {
        await removeWorktree({ path: wt.path, branch: wt.branch }, true).catch(
          () => {},
        )
        log(`[sweep] removed merged worktree task=${wt.taskId} path=${wt.path}`)
      } catch (err) {
        log(
          `[sweep] failed to remove merged worktree ${wt.taskId}: ${(err as Error).message}`,
        )
      }
      continue
    }

    if (task && isStaleStatus(task.status)) {
      const ageHours = ageHoursFrom(wt.mtimeMs, now)
      const payload: SweeperPayload = sweeperPayloadSchema.parse({
        taskId: wt.taskId,
        branch: wt.branch,
        worktreePath: wt.path,
        lastSweptAt: new Date(now).toISOString(),
        ageHours,
        criticality: criticalityFromAge(ageHours),
      })
      const signature = buildSignature(wt.taskId, wt.path)
      try {
        const id = await raiseInboxItem({
          kind: 'stale-worktree',
          category: 'daemon',
          priority: payload.criticality === 'high' ? 'high' : 'normal',
          title: `stale worktree for ${wt.branch} (${task.status})`,
          body:
            `Task ${wt.taskId} is ${task.status} but its worktree is still on disk.\n` +
            `Path: ${wt.path}\nBranch: ${wt.branch}\n` +
            `Age: ${ageHours.toFixed(1)}h (${payload.criticality}).`,
          payload,
          context: { worktreePath: wt.path, branch: wt.branch },
          raisedBy: 'sweeper',
          signature,
        })
        await upsertSweeperPayload(id, payload)
        log(
          `[sweep] alert task=${wt.taskId} status=${task.status} criticality=${payload.criticality} id=${id}`,
        )
      } catch (err) {
        log(
          `[sweep] failed to raise alert for ${wt.taskId}: ${(err as Error).message}`,
        )
      }
      continue
    }

    if (!task) {
      log(`[sweep] orphan worktree (no task row) task=${wt.taskId} path=${wt.path}`)
    }
  }
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
      log(`[sweep] tick failed: ${(err as Error).message}`)
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  // Don't keep the process alive solely on the timer — the PID file presence
  // and explicit shutdown signals control lifetime.
  if (typeof timer.unref === 'function') timer.unref()

  // Fire one tick immediately so newly-spawned sweepers do useful work without
  // waiting a full interval.
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
