import { statSync } from 'node:fs'
import { resolveContext } from '../context'
import { getTask, type Task, type TaskStatus } from '../queue'
import { type TraceCtx } from './run-tool'
import {
  discoverAllWorktrees,
  removeWorktreeAt,
  DEFAULT_WORKTREE_REMOVE_TIMEOUT_MS,
  type DiscoveredWorktree,
} from './worktree-clean'

export type PruneVerdict =
  | 'remove-done'
  | 'remove-dropped'
  | 'remove-orphan'
  | 'remove-stale'
  | 'skip-in-flight'
  | 'skip-failed'
  | 'skip-other'

export interface PruneClassifiedWorktree {
  worktree: DiscoveredWorktree
  task: Task | null
  verdict: PruneVerdict
}

interface PruneClassifyDeps {
  getTask: (id: string) => Promise<Task | null>
  /** Unix timestamp (ms) of today's local midnight. When provided alongside
   *  getDirMtimeMs, a non-in-flight, non-failed worktree whose directory was
   *  last modified before this timestamp gets verdict 'remove-stale'. */
  todayMidnightMs?: number
  /** Returns the mtime of the given directory path in milliseconds. Only
   *  called when todayMidnightMs is also provided. */
  getDirMtimeMs?: (path: string) => number
}

const IN_FLIGHT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
])

const PRUNE_REMOVE_VERDICTS: ReadonlySet<PruneVerdict> = new Set([
  'remove-done',
  'remove-dropped',
  'remove-orphan',
  'remove-stale',
])

export const classifyWorktreeForPrune = async (
  wt: DiscoveredWorktree,
  deps: PruneClassifyDeps,
): Promise<PruneClassifiedWorktree> => {
  const task = await deps.getTask(wt.taskId)

  if (!task) {
    return { worktree: wt, task: null, verdict: 'remove-orphan' }
  }

  if (IN_FLIGHT_STATUSES.has(task.status)) {
    return { worktree: wt, task, verdict: 'skip-in-flight' }
  }

  if (task.status === 'failed') {
    return { worktree: wt, task, verdict: 'skip-failed' }
  }

  if (task.status === 'done') {
    return { worktree: wt, task, verdict: 'remove-done' }
  }

  if (task.status === 'dropped') {
    return { worktree: wt, task, verdict: 'remove-dropped' }
  }

  // draft, blocked, or any other status: keep unless the directory is stale
  if (deps.todayMidnightMs !== undefined && deps.getDirMtimeMs !== undefined) {
    if (deps.getDirMtimeMs(wt.path) < deps.todayMidnightMs) {
      return { worktree: wt, task, verdict: 'remove-stale' }
    }
  }
  return { worktree: wt, task, verdict: 'skip-other' }
}

export interface PruneRunSummary {
  removed: number
  keptInFlight: number
  keptFailed: number
  keptOther: number
  errors: number
}

export interface PruneRunOptions {
  dryRun?: boolean
  log?: (line: string) => void
  /** Optional trace context. Populated when called from a workflow phase;
   *  omitted by the CLI admin entry point. */
  traceCtx?: TraceCtx
}

export const runWorktreePrune = async (
  opts: PruneRunOptions = {},
): Promise<PruneRunSummary> => {
  const ctx = resolveContext()
  const log = opts.log ?? ((line) => console.log(line))
  const summary: PruneRunSummary = {
    removed: 0,
    keptInFlight: 0,
    keptFailed: 0,
    keptOther: 0,
    errors: 0,
  }

  // Compute today's local midnight once for the whole prune run.
  const midnightDate = new Date()
  midnightDate.setHours(0, 0, 0, 0)
  const todayMidnightMs = midnightDate.getTime()

  const discovered = discoverAllWorktrees(ctx.repoRoot)
  if (discovered.length === 0) {
    log('no worktrees found under .mars/worktrees/ or .worktrees/')
    return summary
  }

  for (const wt of discovered) {
    let classified: PruneClassifiedWorktree
    try {
      classified = await classifyWorktreeForPrune(wt, {
        getTask,
        todayMidnightMs,
        getDirMtimeMs: (path) => statSync(path).mtimeMs,
      })
    } catch (err) {
      summary.errors += 1
      log(`[error] classify ${wt.path}: ${(err as Error).message}`)
      continue
    }

    const { verdict, task } = classified
    const status = task?.status ?? '(orphan)'

    if (verdict === 'skip-in-flight') {
      summary.keptInFlight += 1
      log(`[keep] in-flight ${wt.branch} (${status})`)
      continue
    }
    if (verdict === 'skip-failed') {
      summary.keptFailed += 1
      log(`[keep] failed ${wt.branch} (${status})`)
      continue
    }
    if (verdict === 'skip-other') {
      summary.keptOther += 1
      log(`[keep] ${wt.branch} (${status})`)
      continue
    }

    if (PRUNE_REMOVE_VERDICTS.has(verdict)) {
      const reason =
        verdict === 'remove-done'
          ? 'done'
          : verdict === 'remove-dropped'
            ? 'dropped'
            : verdict === 'remove-stale'
              ? 'stale'
              : 'orphan'

      if (opts.dryRun) {
        log(`[would-remove] ${wt.branch} (${reason})`)
        summary.removed += 1
        continue
      }

      try {
        await removeWorktreeAt(
          wt,
          ctx.repoRoot,
          DEFAULT_WORKTREE_REMOVE_TIMEOUT_MS,
          opts.traceCtx,
        )
        summary.removed += 1
        log(`[remove] ${wt.branch} (${reason})`)
      } catch (err) {
        summary.errors += 1
        log(`[error] remove ${wt.path}: ${(err as Error).message}`)
      }
    }
  }

  log(
    `summary: removed=${summary.removed}, kept-in-flight=${summary.keptInFlight}, kept-failed=${summary.keptFailed}, kept-other=${summary.keptOther}, errors=${summary.errors}`,
  )
  return summary
}
