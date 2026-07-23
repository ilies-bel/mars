import type { TaskStatus } from './types'

/**
 * Human substep label derived from a task's status — the fine-grained step the
 * task is on, surfaced on board cards ("coding", "merging", …). The board data
 * carries only `status`; there is no distinct "preparing worktree" state
 * (setup folds into `running`), so these are the substeps that actually exist.
 *
 * Terminal / gated states (blocked, done, failed, dropped) return null: they
 * already carry their own chip treatment and a substep line would be noise.
 */
const SUBSTEP_LABEL: Partial<Record<TaskStatus, string>> = {
  queued: 'queued',
  running: 'coding',
  verifying: 'verifying',
  merging: 'merging',
  'vega-reconciling': 'reconciling',
  under_investigation: 'investigating',
  draft: 'draft',
}

export const substepLabel = (status: TaskStatus): string | null =>
  SUBSTEP_LABEL[status] ?? null

/**
 * The actively-executing statuses — a task in one of these is doing live work
 * in its worktree (coder running, verify gate, merge, or Vega reconcile). Drives
 * the live substep label and the subtle in-progress card animation.
 */
const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
])

export const isLiveStatus = (status: TaskStatus): boolean =>
  LIVE_STATUSES.has(status)
