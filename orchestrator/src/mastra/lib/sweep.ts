import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveContext } from '../context'
import { getTask, type Task } from '../queue'

const exec = promisify(execFile)

export interface OrphanCommit {
  shortSha: string
  subject: string
}

export interface OrphanBranch {
  branch: string
  taskId: string
  commits: OrphanCommit[]
}

export interface SweepDeps {
  listTaskBranches: () => Promise<string[]>
  getTask: (id: string) => Promise<Task | null>
  listUniqueCommits: (
    branch: string,
    integrationBranch: string,
  ) => Promise<OrphanCommit[]>
}

const TASK_BRANCH_PREFIX = 'task/'

/**
 * Enumerate local git branches matching `task/<id>` whose id has no
 * corresponding row in the queue. Pure logic — all I/O is injected via
 * `deps` so the classifier can be tested without git or the queue DB.
 *
 * Read-only: never mutates git state or the queue.
 */
export const findOrphanTaskBranches = async (
  integrationBranch: string,
  deps: SweepDeps,
): Promise<OrphanBranch[]> => {
  const branches = await deps.listTaskBranches()
  const orphans: OrphanBranch[] = []
  for (const branch of branches) {
    if (!branch.startsWith(TASK_BRANCH_PREFIX)) continue
    const taskId = branch.slice(TASK_BRANCH_PREFIX.length)
    if (taskId.length === 0) continue
    const task = await deps.getTask(taskId)
    if (task !== null) continue
    const commits = await deps.listUniqueCommits(branch, integrationBranch)
    orphans.push({ branch, taskId, commits })
  }
  return orphans
}

/**
 * List every local branch whose name begins with `task/`. Uses
 * `git for-each-ref` for stable machine-readable output.
 */
export const listLocalTaskBranches = async (
  repoRoot: string,
): Promise<string[]> => {
  try {
    const { stdout } = await exec(
      'git',
      [
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${TASK_BRANCH_PREFIX}`,
      ],
      { cwd: repoRoot },
    )
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/**
 * Return commits reachable from `branch` but not from `integrationBranch`,
 * formatted as `<short-sha> <subject>` pairs. Order matches `git log`
 * (newest first).
 */
export const listUniqueCommitsAhead = async (
  branch: string,
  integrationBranch: string,
  repoRoot: string,
): Promise<OrphanCommit[]> => {
  try {
    const { stdout } = await exec(
      'git',
      ['log', '--format=%h %s', `${integrationBranch}..${branch}`],
      { cwd: repoRoot },
    )
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const space = line.indexOf(' ')
        if (space === -1) return { shortSha: line, subject: '' }
        return {
          shortSha: line.slice(0, space),
          subject: line.slice(space + 1),
        }
      })
  } catch {
    return []
  }
}

export interface RunSweepOptions {
  integrationBranch?: string
  log?: (line: string) => void
  deps?: Partial<SweepDeps>
}

export interface RunSweepSummary {
  orphans: OrphanBranch[]
}

/**
 * CLI entry point — wires the real git/queue dependencies into
 * `findOrphanTaskBranches`, prints results, and returns the structured
 * summary for callers/tests. Dependencies may be overridden via
 * `opts.deps` for tests.
 */
export const runSweep = async (
  opts: RunSweepOptions = {},
): Promise<RunSweepSummary> => {
  const ctx = resolveContext()
  const integrationBranch =
    opts.integrationBranch ?? process.env.INTEGRATION_BRANCH ?? 'main'
  const log = opts.log ?? ((line: string): void => console.log(line))

  const deps: SweepDeps = {
    listTaskBranches:
      opts.deps?.listTaskBranches ??
      (() => listLocalTaskBranches(ctx.repoRoot)),
    getTask: opts.deps?.getTask ?? ((id) => getTask(id)),
    listUniqueCommits:
      opts.deps?.listUniqueCommits ??
      ((branch, integration) =>
        listUniqueCommitsAhead(branch, integration, ctx.repoRoot)),
  }

  const orphans = await findOrphanTaskBranches(integrationBranch, deps)

  if (orphans.length === 0) {
    log('no orphan task branches')
    return { orphans }
  }

  for (const orphan of orphans) {
    log(orphan.branch)
    if (orphan.commits.length === 0) {
      log('  (no unique commits ahead of integration branch)')
      continue
    }
    for (const commit of orphan.commits) {
      log(`  ${commit.shortSha} ${commit.subject}`)
    }
  }
  return { orphans }
}
