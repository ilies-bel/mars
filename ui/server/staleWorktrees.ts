import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskDb } from './db.ts'

export interface StaleWorktree {
  taskId: string
  status: string
  ageHours: number
  updatedAt: string
}

const DEFAULT_THRESHOLD_HOURS = 24
let warnedInvalidEnv = false

const resolveThresholdHours = (): number => {
  const raw = process.env.MARS_STALE_WORKTREE_HOURS
  if (raw === undefined || raw === '') return DEFAULT_THRESHOLD_HOURS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (!warnedInvalidEnv) {
      warnedInvalidEnv = true
      console.error(
        `mars-ui: invalid MARS_STALE_WORKTREE_HOURS=${JSON.stringify(raw)}; falling back to ${DEFAULT_THRESHOLD_HOURS}`,
      )
    }
    return DEFAULT_THRESHOLD_HOURS
  }
  return parsed
}

const worktreeExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

export const listStaleWorktrees = async (
  db: TaskDb,
  repoRoot: string,
  dismissedIds: Set<string> = new Set(),
): Promise<StaleWorktree[]> => {
  const exists = await db.tableExists()
  if (!exists) return []
  const tasks = await db.listTasks()
  const thresholdHours = resolveThresholdHours()
  const thresholdMs = thresholdHours * 60 * 60 * 1000
  const now = Date.now()
  const out: StaleWorktree[] = []
  for (const task of tasks) {
    if (task.status === 'done') continue
    if (dismissedIds.has(task.id)) continue
    const updatedMs = Date.parse(task.updatedAt)
    if (!Number.isFinite(updatedMs)) continue
    const ageMs = now - updatedMs
    if (ageMs < thresholdMs) continue
    const worktreePath = join(repoRoot, '.mars', 'worktrees', task.id)
    if (!(await worktreeExists(worktreePath))) continue
    out.push({
      taskId: task.id,
      status: task.status,
      ageHours: Math.round((ageMs / 3_600_000) * 10) / 10,
      updatedAt: task.updatedAt,
    })
  }
  return out
}
