/**
 * Pure helpers for the `mars worktree reclaim` command.
 *
 * - `classifyWorktree(input)` — classify a worktree directory by task status.
 * - `probeWorktreeGitState(path, integrationBranch)` — detect dirty/ahead state.
 * - `computeDirBytes(path)` — walk a directory tree and sum file sizes.
 *
 * No I/O side-effects beyond the filesystem reads in `computeDirBytes`
 * and the git probes in `probeWorktreeGitState`.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execProbe } from './git/internal'
import type { Task } from '../queue'

export type ReclaimCategory =
  | 'absent-task'
  | 'terminal-clean'
  | 'protected-dirty'
  | 'protected-ahead'
  | 'protected-leased'
  | 'protected-awaiting-human'
  | 'protected-awaiting-validation'
  | 'unknown'

export const SAFE_CATEGORIES = new Set<ReclaimCategory>([
  'absent-task',
  'terminal-clean',
])

export interface WorktreeClassification {
  id: string
  category: ReclaimCategory
  reason: string
  bytes: number
}

export interface WorktreeGitState {
  dirty: boolean
  ahead: number
}

/**
 * Probe a worktree directory for dirty files and commits ahead of the
 * integration branch. Returns `null` when the path is not a valid git
 * worktree (e.g. the directory is absent or not initialised).
 */
export const probeWorktreeGitState = async (
  path: string,
  integrationBranch: string,
): Promise<WorktreeGitState | null> => {
  const porcelain = await execProbe('git', ['status', '--porcelain'], { cwd: path })
  if (porcelain.exitCode !== 0) return null
  const dirty = porcelain.stdout.trim().length > 0

  const revList = await execProbe(
    'git',
    ['rev-list', '--count', `${integrationBranch}..HEAD`],
    { cwd: path },
  )
  const ahead = revList.exitCode === 0 ? Number(revList.stdout.trim()) || 0 : 0

  return { dirty, ahead }
}

/**
 * Terminal statuses: a worktree belonging to a task in one of these states
 * is safe to remove (no in-flight work can be lost).
 */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'dropped'])

/**
 * Classify a single worktree entry.
 *
 * Protection precedence (highest wins):
 *   awaiting-validation > awaiting-human > leased > ahead > dirty
 *
 * Protections are checked BEFORE terminal status — a done task with
 * unmerged commits must NOT be classified terminal-clean.
 */
export const classifyWorktree = (input: {
  id: string
  task: Task | null
  gitState?: WorktreeGitState | null
  lease?: { owner: string } | null
}): { category: ReclaimCategory; reason: string } => {
  const { task, gitState, lease } = input

  if (!task) {
    return {
      category: 'absent-task',
      reason: 'no task row found for this worktree id',
    }
  }

  // --- Protection guards (highest precedence first) ---

  if (task.status === 'awaiting-validation') {
    return {
      category: 'protected-awaiting-validation',
      reason: 'task is awaiting operator validation',
    }
  }

  if (task.status === 'awaiting-human') {
    return {
      category: 'protected-awaiting-human',
      reason: 'task is parked for human input',
    }
  }

  if (lease?.owner) {
    return {
      category: 'protected-leased',
      reason: `worktree is leased by ${lease.owner}`,
    }
  }

  if (gitState && gitState.ahead > 0) {
    return {
      category: 'protected-ahead',
      reason: `branch has ${gitState.ahead} commit(s) ahead of integration`,
    }
  }

  if (gitState?.dirty) {
    return {
      category: 'protected-dirty',
      reason: 'worktree has uncommitted changes',
    }
  }

  // --- Terminal / fallback ---

  if (TERMINAL_STATUSES.has(task.status)) {
    return {
      category: 'terminal-clean',
      reason: `task is ${task.status}`,
    }
  }

  return {
    category: 'unknown',
    reason: `task is ${task.status} (in-flight or human-held)`,
  }
}

/**
 * Recursively sum the sizes of all files under `path`.
 *
 * Uses `readdir` with `recursive: true` (Node >=18.17) to enumerate every
 * entry, then `stat` for each file. Directories contribute 0 bytes.
 * Returns 0 when the path does not exist or is not a directory.
 */
export const computeDirBytes = async (path: string): Promise<number> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let entries: any[]
  try {
    entries = await readdir(path, { withFileTypes: true, recursive: true } as Parameters<typeof readdir>[1])
  } catch {
    return 0
  }

  let total = 0
  for (const entry of entries) {
    if (typeof entry.isFile !== 'function' || !entry.isFile()) continue
    const dir: string = String(entry.parentPath ?? entry.path ?? path)
    const filePath = join(dir, String(entry.name))
    try {
      const s = await stat(filePath)
      total += s.size
    } catch {
      // Race: file removed between readdir and stat — skip it.
    }
  }
  return total
}
