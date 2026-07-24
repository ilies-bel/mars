import { resolveContext } from '../context'
import { getTask, type Task, type TaskStatus } from '../queue'
import { isBranchMergedIntoMain } from './git/merge'
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
  | 'skip-desync'
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
  /** Check whether the branch has been merged into the integration branch.
   *  Injectable so tests can avoid hitting real git. */
  isBranchMergedIntoMain: (branch: string, repoRoot: string) => Promise<boolean>
  /** Absolute path to the repository root. Passed to isBranchMergedIntoMain. */
  repoRoot: string
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
    // Mirror worktree-clean's classifyWorktree: only remove if the branch has
    // been merged. An unmerged done branch means the worktree still holds
    // unique commits that haven't landed in main — deleting it would be
    // data loss (skip-desync, matching clean's behaviour).
    const merged = await deps.isBranchMergedIntoMain(wt.branch, deps.repoRoot)
    return {
      worktree: wt,
      task,
      verdict: merged ? 'remove-done' : 'skip-desync',
    }
  }

  if (task.status === 'dropped') {
    return { worktree: wt, task, verdict: 'remove-dropped' }
  }

  // All remaining statuses — awaiting-human, blocked, draft, and any future
  // live/non-terminal status — are treated as live work and never removed.
  //
  // The former remove-stale rule (age-based directory-mtime pruning) has been
  // dropped entirely. Every status that fell through to it (blocked, draft,
  // awaiting-human) represents live work — a parked human task is not stale,
  // and an old mtime is not evidence that it's safe to destroy. There is no
  // remaining status for which age-based deletion would be both safe and
  // useful, so the simpler provably-safe invariant is: if prune cannot
  // positively identify a worktree as terminal and merged, it keeps it.
  return { worktree: wt, task, verdict: 'skip-other' }
}

export interface PruneRunSummary {
  removed: number
  keptInFlight: number
  keptFailed: number
  keptDesync: number
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
    keptDesync: 0,
    keptOther: 0,
    errors: 0,
  }

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
        isBranchMergedIntoMain,
        repoRoot: ctx.repoRoot,
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
    if (verdict === 'skip-desync') {
      summary.keptDesync += 1
      log(`[keep] desync ${wt.branch} (done but not merged)`)
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
    `summary: removed=${summary.removed}, kept-in-flight=${summary.keptInFlight}, kept-failed=${summary.keptFailed}, kept-desync=${summary.keptDesync}, kept-other=${summary.keptOther}, errors=${summary.errors}`,
  )
  return summary
}
