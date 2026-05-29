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

export type SweepAction = 'keep' | 'delete' | 'cherry-pick'

export interface SweepVerbDeps extends SweepDeps {
  /** Prompt the operator for an action on the given orphan branch. */
  prompt: (orphan: OrphanBranch) => Promise<SweepAction>
  /** Force-delete the given local branch. */
  deleteBranch: (branch: string) => Promise<void>
  /**
   * Apply commits (oldest-first) onto the integration branch. On conflict,
   * aborts the cherry-pick and returns the conflicting commit.
   */
  cherryPickCommits: (
    commits: OrphanCommit[],
  ) => Promise<{ ok: true } | { ok: false; conflictingCommit: OrphanCommit }>
}

export interface RunSweepVerbOptions {
  integrationBranch?: string
  log?: (line: string) => void
  deps: SweepVerbDeps
}

export interface SweepVerbResult {
  orphans: OrphanBranch[]
  kept: string[]
  deleted: string[]
  cherryPicked: string[]
  conflicted: string[]
}

/**
 * Interactive sweep verb: for each orphan branch, prompt the operator for an
 * action (keep / delete / cherry-pick-then-delete) and execute it.
 *
 * - keep: no-op.
 * - delete: force-removes the local branch.
 * - cherry-pick: applies each unique commit onto the integration branch
 *   (oldest-first), then force-removes the source branch. On conflict, halts
 *   on that branch and leaves it intact for manual resolution.
 */
export const runSweepVerb = async (
  opts: RunSweepVerbOptions,
): Promise<SweepVerbResult> => {
  const integrationBranch = opts.integrationBranch ?? 'main'
  const log = opts.log ?? ((line: string): void => console.log(line))
  const { prompt, deleteBranch, cherryPickCommits, ...sweepDeps } = opts.deps

  const orphans = await findOrphanTaskBranches(integrationBranch, sweepDeps)

  if (orphans.length === 0) {
    log('no orphan task branches')
    return { orphans, kept: [], deleted: [], cherryPicked: [], conflicted: [] }
  }

  const kept: string[] = []
  const deleted: string[] = []
  const cherryPicked: string[] = []
  const conflicted: string[] = []

  for (const orphan of orphans) {
    log(orphan.branch)
    if (orphan.commits.length === 0) {
      log('  (no unique commits ahead of integration branch)')
    } else {
      for (const commit of orphan.commits) {
        log(`  ${commit.shortSha} ${commit.subject}`)
      }
    }

    const action = await prompt(orphan)

    if (action === 'keep') {
      log('  → kept')
      kept.push(orphan.branch)
    } else if (action === 'delete') {
      await deleteBranch(orphan.branch)
      log('  → deleted')
      deleted.push(orphan.branch)
    } else {
      // cherry-pick: git log order is newest-first; apply oldest-first
      const commitsOldestFirst = orphan.commits.slice().reverse()
      const result = await cherryPickCommits(commitsOldestFirst)
      if (!result.ok) {
        log(
          `  → cherry-pick conflict on ${result.conflictingCommit.shortSha} ${result.conflictingCommit.subject}; branch left intact`,
        )
        conflicted.push(orphan.branch)
      } else {
        await deleteBranch(orphan.branch)
        log(`  → cherry-picked onto ${integrationBranch} and deleted`)
        cherryPicked.push(orphan.branch)
      }
    }
  }

  return { orphans, kept, deleted, cherryPicked, conflicted }
}

/**
 * Real git implementation of cherry-picking commits onto the integration
 * branch. Checks out the integration branch first, then applies each commit
 * (oldest-first) by SHA. On conflict, aborts the cherry-pick and returns the
 * conflicting commit; the working tree is left clean on the integration branch.
 *
 * Exported so integration tests can exercise the real git path directly.
 */
export const applyCommitsCherryPick = async (
  commits: OrphanCommit[],
  integrationBranch: string,
  repoRoot: string,
): Promise<{ ok: true } | { ok: false; conflictingCommit: OrphanCommit }> => {
  await exec('git', ['checkout', integrationBranch], { cwd: repoRoot })
  for (const commit of commits) {
    try {
      await exec('git', ['cherry-pick', commit.shortSha], { cwd: repoRoot })
    } catch {
      await exec('git', ['cherry-pick', '--abort'], { cwd: repoRoot }).catch(
        () => {},
      )
      return { ok: false, conflictingCommit: commit }
    }
  }
  return { ok: true }
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
