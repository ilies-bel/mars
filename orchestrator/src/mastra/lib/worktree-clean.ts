import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveContext } from '../context'
import { getTask, type Task, type TaskStatus } from '../queue'
import { isBranchMergedIntoMain, isZeroCommitBranch } from './git'

const exec = promisify(execFile)

const IN_FLIGHT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'verifying',
  'merging',
])

export type Verdict =
  | 'remove-done-merged'
  | 'remove-failed-zero-commit'
  | 'remove-orphan-zero-commit'
  | 'report-orphan-committed'
  | 'skip-in-flight'
  | 'skip-desync'
  | 'skip-other'

export interface DiscoveredWorktree {
  path: string
  branch: string
  taskId: string
}

export interface ClassifiedWorktree {
  worktree: DiscoveredWorktree
  task: Task | null
  verdict: Verdict
}

interface ClassifyDeps {
  getTask: (id: string) => Promise<Task | null>
  isBranchMergedIntoMain: (branch: string, repoRoot: string) => Promise<boolean>
  isZeroCommitBranch: (branch: string, repoRoot: string) => Promise<boolean>
}

export const classifyWorktree = async (
  wt: DiscoveredWorktree,
  repoRoot: string,
  deps: ClassifyDeps,
): Promise<ClassifiedWorktree> => {
  const task = await deps.getTask(wt.taskId)

  if (!task) {
    const zero = await deps.isZeroCommitBranch(wt.branch, repoRoot)
    return {
      worktree: wt,
      task: null,
      verdict: zero ? 'remove-orphan-zero-commit' : 'report-orphan-committed',
    }
  }

  if (IN_FLIGHT_STATUSES.has(task.status)) {
    return { worktree: wt, task, verdict: 'skip-in-flight' }
  }

  if (task.status === 'done') {
    const merged = await deps.isBranchMergedIntoMain(wt.branch, repoRoot)
    return {
      worktree: wt,
      task,
      verdict: merged ? 'remove-done-merged' : 'skip-desync',
    }
  }

  if (task.status === 'failed' || task.status === 'dropped') {
    const zero = await deps.isZeroCommitBranch(wt.branch, repoRoot)
    return {
      worktree: wt,
      task,
      verdict: zero ? 'remove-failed-zero-commit' : 'skip-other',
    }
  }

  // draft, blocked: not a sweep candidate.
  return { worktree: wt, task, verdict: 'skip-other' }
}

const REMOVE_VERDICTS: ReadonlySet<Verdict> = new Set([
  'remove-done-merged',
  'remove-failed-zero-commit',
  'remove-orphan-zero-commit',
])

export interface RunSummary {
  removed: number
  keptInFlight: number
  keptDesync: number
  keptOrphan: number
  keptOther: number
  errors: number
}

export interface RunOptions {
  dryRun?: boolean
  forceOrphans?: boolean
  log?: (line: string) => void
}

export const discoverWorktreesIn = (root: string): DiscoveredWorktree[] => {
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
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    out.push({ path, branch: `task/${name}`, taskId: name })
  }
  return out
}

export const discoverAllWorktrees = (
  repoRoot: string,
): DiscoveredWorktree[] => {
  const primary = resolve(repoRoot, '.mars', 'worktrees')
  const legacy = resolve(repoRoot, '.worktrees')
  const seen = new Set<string>()
  const merged: DiscoveredWorktree[] = []
  for (const wt of [...discoverWorktreesIn(primary), ...discoverWorktreesIn(legacy)]) {
    if (seen.has(wt.path)) continue
    seen.add(wt.path)
    merged.push(wt)
  }
  return merged
}

const removeWorktreeAt = async (
  wt: DiscoveredWorktree,
  repoRoot: string,
): Promise<void> => {
  try {
    await exec('git', ['worktree', 'remove', '--force', wt.path], {
      cwd: repoRoot,
    })
  } catch {
    // git refused (e.g. not a registered worktree, locked); fall through to
    // rm -rf so we still clean the dead directory.
  }
  if (existsSync(wt.path)) {
    await rm(wt.path, { recursive: true, force: true })
  }
  await exec('git', ['branch', '-D', wt.branch], { cwd: repoRoot }).catch(
    () => {},
  )
}

export const runWorktreeClean = async (
  opts: RunOptions = {},
): Promise<RunSummary> => {
  const ctx = resolveContext()
  const log = opts.log ?? ((line) => console.log(line))
  const summary: RunSummary = {
    removed: 0,
    keptInFlight: 0,
    keptDesync: 0,
    keptOrphan: 0,
    keptOther: 0,
    errors: 0,
  }

  const discovered = discoverAllWorktrees(ctx.repoRoot)
  if (discovered.length === 0) {
    log('no worktrees found under .mars/worktrees/ or .worktrees/')
    return summary
  }

  for (const wt of discovered) {
    let classified: ClassifiedWorktree
    try {
      classified = await classifyWorktree(wt, ctx.repoRoot, {
        getTask,
        isBranchMergedIntoMain,
        isZeroCommitBranch,
      })
    } catch (err) {
      summary.errors += 1
      log(
        `[error] classify ${wt.path}: ${(err as Error).message}`,
      )
      continue
    }

    const { verdict, task } = classified
    const status = task?.status ?? '(orphan)'

    if (verdict === 'skip-in-flight') {
      summary.keptInFlight += 1
      log(`[keep] in-flight ${wt.branch} (${status})`)
      continue
    }
    if (verdict === 'skip-desync') {
      summary.keptDesync += 1
      log(`[keep] desync ${wt.branch} (done but not merged)`)
      continue
    }
    if (verdict === 'skip-other') {
      summary.keptOther += 1
      log(`[keep] ${wt.branch} (${status}; not a sweep candidate)`)
      continue
    }
    if (verdict === 'report-orphan-committed') {
      if (!opts.forceOrphans) {
        summary.keptOrphan += 1
        log(
          `[keep] orphan ${wt.branch} (no queue row, branch has commits; pass --force-orphans to remove)`,
        )
        continue
      }
      // fall through to removal
    }

    if (REMOVE_VERDICTS.has(verdict) || verdict === 'report-orphan-committed') {
      const reason =
        verdict === 'remove-done-merged'
          ? 'done+merged'
          : verdict === 'remove-failed-zero-commit'
            ? `${status}+zero-commit`
            : verdict === 'remove-orphan-zero-commit'
              ? 'orphan+zero-commit'
              : 'orphan+committed (--force-orphans)'

      if (opts.dryRun) {
        log(`[would-remove] ${wt.branch} (${reason})`)
        summary.removed += 1
        continue
      }

      try {
        await removeWorktreeAt(wt, ctx.repoRoot)
        summary.removed += 1
        log(`[remove] ${wt.branch} (${reason})`)
      } catch (err) {
        summary.errors += 1
        log(`[error] remove ${wt.path}: ${(err as Error).message}`)
      }
    }
  }

  log(
    `summary: removed=${summary.removed}, kept-in-flight=${summary.keptInFlight}, kept-desync=${summary.keptDesync}, kept-orphan=${summary.keptOrphan}, kept-other=${summary.keptOther}, errors=${summary.errors}`,
  )
  return summary
}

export const isDaemonRunning = async (socketPath: string): Promise<boolean> => {
  if (!existsSync(socketPath)) return false
  const { createConnection } = await import('node:net')
  return new Promise((resolveFn) => {
    const sock = createConnection(socketPath)
    sock.once('connect', () => {
      sock.end()
      resolveFn(true)
    })
    sock.once('error', () => resolveFn(false))
  })
}
