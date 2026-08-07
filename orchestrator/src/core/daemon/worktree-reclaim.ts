/**
 * Worktree reclamation: automatic disk-space recovery for `.mars/worktrees/`.
 *
 * Three distinct problems addressed here:
 *
 * 1. **Settled tasks with surviving worktrees.** Tasks that reached `done` or
 *    `dropped` should have their worktrees removed — the work is either merged
 *    or abandoned. `failed` worktrees are intentionally retained so that `mars
 *    continue` can resume on the existing branch and commits.
 *
 * 2. **Orphaned directories.** Directories under `.mars/worktrees/` with no
 *    owning task row in the database — left behind when tasks were purged/dropped
 *    without cleaning up their on-disk state. Nothing in Mars can name these;
 *    they accumulate silently.
 *
 * 3. **Excess failed worktrees.** Even retained `failed` worktrees must not
 *    accumulate without bound. When the count exceeds a configurable cap the
 *    oldest (by mtime) are removed first. A log line names each release.
 *
 * None of these functions touch worktrees for tasks in live statuses
 * (running / verifying / merging / awaiting-*). Removal is driven by task
 * state from the database, never by directory mtime alone.
 *
 * Additionally exposes:
 *   - `getWorktreeFootprint` — count + total bytes for the `.mars/worktrees/`
 *     tree, suitable for surfacing in `mars daemon status`.
 *   - `getWorktreeFreeBytes` — bytes available to unprivileged users on the
 *     filesystem hosting the worktrees directory. Returns null when the path
 *     does not yet exist.
 */

import { readdir, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { listTasks } from '../queue'

/** Default cap for retained `failed` worktrees. */
export const FAILED_WORKTREE_CAP_DEFAULT = 10

/** Minimum free bytes before dispatch is refused (1 GiB). */
export const LOW_DISK_THRESHOLD_BYTES = 1 * 1024 * 1024 * 1024

/** Env-var override: `MARS_FAILED_WORKTREE_CAP` (integer ≥ 0). */
const resolveFailedCap = (): number => {
  const raw = process.env.MARS_FAILED_WORKTREE_CAP
  if (!raw) return FAILED_WORKTREE_CAP_DEFAULT
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : FAILED_WORKTREE_CAP_DEFAULT
}

/** Env-var override: `MARS_LOW_DISK_THRESHOLD_BYTES` (integer ≥ 0). */
const resolveThresholdBytes = (): number => {
  const raw = process.env.MARS_LOW_DISK_THRESHOLD_BYTES
  if (!raw) return LOW_DISK_THRESHOLD_BYTES
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : LOW_DISK_THRESHOLD_BYTES
}

const worktreesDir = (repoRoot: string): string =>
  join(repoRoot, '.mars', 'worktrees')

// ── Helpers ───────────────────────────────────────────────────────────────────

/** List the direct child directory entries of `.mars/worktrees/`. Returns [] when absent. */
async function listWorktreeDirs(repoRoot: string): Promise<string[]> {
  const dir = worktreesDir(repoRoot)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Remove a worktree directory unconditionally (best-effort; errors are swallowed). */
async function removeDir(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Result type shared across reclaim functions. */
export interface ReclaimResult {
  /** Task IDs whose worktrees were removed (or orphan dir names). */
  removed: string[]
  /** Task IDs whose removal was attempted but failed. */
  failed: string[]
}

/**
 * Remove worktrees for tasks that have reached a settled terminal state
 * (`done` or `dropped`).
 *
 * `failed` worktrees are explicitly retained — `mars continue` resumes on the
 * existing worktree and its commits, so removing them would break that path.
 *
 * The worktree path is derived from `task.worktreePath` when available,
 * falling back to `<repoRoot>/.mars/worktrees/<taskId>`.
 *
 * @returns The ids of tasks whose worktrees were successfully removed.
 */
export async function reclaimSettledWorktrees(
  repoRoot: string,
  log?: (msg: string) => void,
): Promise<ReclaimResult> {
  const result: ReclaimResult = { removed: [], failed: [] }

  const [doneTasks, droppedTasks] = await Promise.all([
    listTasks('done'),
    listTasks('dropped'),
  ])
  const settled = [...doneTasks, ...droppedTasks]

  for (const task of settled) {
    const worktreePath = task.worktreePath ?? join(worktreesDir(repoRoot), task.id)
    let exists: boolean
    try {
      await stat(worktreePath)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) continue

    const ok = await removeDir(worktreePath)
    if (ok) {
      log?.(`[worktree-reclaim] removed settled (${task.status}) worktree for task ${task.id}`)
      result.removed.push(task.id)
    } else {
      log?.(`[worktree-reclaim] failed to remove worktree for task ${task.id}`)
      result.failed.push(task.id)
    }
  }

  return result
}

/**
 * Remove `.mars/worktrees/<name>` directories that have no owning task row in
 * the database. These are left behind when tasks are purged/dropped without
 * cleaning up their on-disk state.
 *
 * Only removes entries whose name matches the task-id convention (alphanumeric +
 * hyphens, 8–32 chars). Unexpected entries (e.g. a manually placed directory)
 * are skipped rather than destroyed silently.
 *
 * @returns The directory names that were removed.
 */
export async function sweepOrphanWorktrees(
  repoRoot: string,
  log?: (msg: string) => void,
): Promise<ReclaimResult> {
  const result: ReclaimResult = { removed: [], failed: [] }

  const dirs = await listWorktreeDirs(repoRoot)
  if (dirs.length === 0) return result

  // Build a set of all known task ids (any status).
  const allTasks = await listTasks()
  const knownIds = new Set(allTasks.map((t) => t.id))

  for (const name of dirs) {
    // Only handle names that look like task ids (mars-hex format or bare hex).
    if (knownIds.has(name)) continue

    // Safety: skip if the name doesn't look like a task id.
    if (!TASK_ID_RE.test(name)) {
      log?.(`[worktree-reclaim] skipping unrecognized orphan dir: ${name}`)
      continue
    }

    const path = join(worktreesDir(repoRoot), name)
    const ok = await removeDir(path)
    if (ok) {
      log?.(`[worktree-reclaim] removed orphan worktree dir: ${name}`)
      result.removed.push(name)
    } else {
      log?.(`[worktree-reclaim] failed to remove orphan dir: ${name}`)
      result.failed.push(name)
    }
  }

  return result
}

/**
 * Pattern for directory names that look like Mars task ids.
 * Matches `<hex8>` or `<hex8>-<suffix>` (with optional suffix).
 */
const TASK_ID_RE = /^[0-9a-f]{8}(-[a-z0-9-]+)?$/

/**
 * Cap the number of retained `failed` worktrees to `cap` (default from
 * `MARS_FAILED_WORKTREE_CAP`, default 10). When over cap, the oldest
 * (by directory mtime) are removed first.
 *
 * Rationale: `failed` worktrees must be kept for `mars continue`, but
 * unbounded accumulation is what caused the 2026-07 disk-full incident.
 * A finite cap gives the operator a guaranteed ceiling without breaking
 * the resume guarantee for recent failures.
 *
 * Each release is logged by name so the operator knows what was discarded.
 *
 * @returns The task IDs whose worktrees were removed to meet the cap.
 */
export async function reclaimExcessFailedWorktrees(
  repoRoot: string,
  log?: (msg: string) => void,
  cap?: number,
): Promise<ReclaimResult> {
  const effectiveCap = cap ?? resolveFailedCap()
  const result: ReclaimResult = { removed: [], failed: [] }

  const failedTasks = await listTasks('failed')
  const baseDir = worktreesDir(repoRoot)

  // Build (taskId, path, mtime) for failed tasks that have a worktree on disk.
  const withMtime: Array<{ id: string; path: string; mtimeMs: number }> = []
  for (const task of failedTasks) {
    const path = task.worktreePath ?? join(baseDir, task.id)
    let mtime: number
    try {
      const s = await stat(path)
      mtime = s.mtimeMs
    } catch {
      continue // No worktree on disk — skip.
    }
    withMtime.push({ id: task.id, path, mtimeMs: mtime })
  }

  if (withMtime.length <= effectiveCap) return result

  // Sort oldest first, remove the excess.
  withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const excess = withMtime.slice(0, withMtime.length - effectiveCap)
  for (const entry of excess) {
    const ok = await removeDir(entry.path)
    if (ok) {
      log?.(
        `[worktree-reclaim] cap=${effectiveCap}: removed oldest failed worktree for task ${entry.id}`,
      )
      result.removed.push(entry.id)
    } else {
      log?.(`[worktree-reclaim] cap=${effectiveCap}: failed to remove worktree for task ${entry.id}`)
      result.failed.push(entry.id)
    }
  }

  return result
}

/** Footprint of the `.mars/worktrees/` directory tree. */
export interface WorktreeFootprint {
  /** Number of direct-child directories. */
  count: number
  /** Approximate total bytes across all entries (recursive). */
  totalBytes: number
}

/**
 * Measure the footprint of `.mars/worktrees/` — directory count and total
 * size (recursive). Returns `{ count: 0, totalBytes: 0 }` when the directory
 * does not exist.
 *
 * Uses directory-entry `stat` rather than a recursive walk to avoid stalling
 * the daemon for gigabytes of worktree content. This gives a **lower bound**:
 * it sizes only direct-child entries. Callers should document this limitation.
 */
export async function getWorktreeFootprint(
  repoRoot: string,
): Promise<WorktreeFootprint> {
  const dir = worktreesDir(repoRoot)
  let entries: string[]
  try {
    const dirents = await readdir(dir, { withFileTypes: true })
    entries = dirents.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { count: 0, totalBytes: 0 }
  }

  const count = entries.length
  let totalBytes = 0
  for (const name of entries) {
    try {
      const s = await stat(join(dir, name))
      totalBytes += s.size
    } catch {
      // ignore missing entries
    }
  }
  return { count, totalBytes }
}

/**
 * Return the number of bytes available to unprivileged users on the filesystem
 * that hosts `.mars/worktrees/`. Returns `null` when the worktrees directory
 * does not exist yet (pre-first-dispatch).
 *
 * Uses `fs.statfs` (Node ≥ 19.6 / this project requires ≥ 22).
 */
export async function getWorktreeFreeBytes(repoRoot: string): Promise<number | null> {
  const dir = worktreesDir(repoRoot)
  try {
    const stats = await statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    // Fall back to the parent `.mars/` directory when worktrees/ doesn't exist yet.
    try {
      const stats = await statfs(join(repoRoot, '.mars'))
      return stats.bavail * stats.bsize
    } catch {
      return null
    }
  }
}

/**
 * Check whether free disk space is below the configured threshold.
 * Returns `{ ok: true }` when there is enough space, or
 * `{ ok: false; freeBytes: number; thresholdBytes: number }` when below.
 */
export type DiskSpaceCheck =
  | { ok: true }
  | { ok: false; freeBytes: number; thresholdBytes: number }

export async function checkDiskSpace(repoRoot: string): Promise<DiskSpaceCheck> {
  const threshold = resolveThresholdBytes()
  const freeBytes = await getWorktreeFreeBytes(repoRoot)
  if (freeBytes === null) return { ok: true } // Can't measure → allow dispatch.
  if (freeBytes < threshold) return { ok: false, freeBytes, thresholdBytes: threshold }
  return { ok: true }
}
