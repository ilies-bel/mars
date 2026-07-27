/**
 * Pure helpers for the `mars worktree reclaim` command.
 *
 * - `classifyWorktree(input)` — classify a worktree directory by task status.
 * - `computeDirBytes(path)` — walk a directory tree and sum file sizes.
 *
 * No I/O side-effects beyond the filesystem reads in `computeDirBytes`.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Task } from '../queue'

export type ReclaimCategory = 'absent-task' | 'terminal-clean' | 'unknown'

export interface WorktreeClassification {
  id: string
  category: ReclaimCategory
  reason: string
  bytes: number
}

/**
 * Terminal statuses: a worktree belonging to a task in one of these states
 * is safe to remove (no in-flight work can be lost).
 */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'dropped'])

/**
 * Classify a single worktree entry.
 *
 * - No matching task row → `absent-task` (orphaned directory)
 * - Task in a terminal status → `terminal-clean` (safe to reclaim)
 * - Task in any other status → `unknown` (in-flight or human-held)
 */
export const classifyWorktree = (input: {
  id: string
  task: Task | null
}): { category: ReclaimCategory; reason: string } => {
  const { task } = input

  if (!task) {
    return {
      category: 'absent-task',
      reason: 'no task row found for this worktree id',
    }
  }

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
    // `entry.parentPath` (Node >=22) or `entry.path` (Node 18.17–21) holds the
    // absolute path of the directory containing this entry. Prefer `parentPath`;
    // fall back to `path`; fall back to the base path argument for old builds.
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
