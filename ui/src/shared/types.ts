import type { TaskStatus } from './schemas'

export type {
  TaskStatus,
  Task,
  PurgeArchiveEntry,
} from './schemas'

export type ColumnKey = 'backlog' | 'in_progress' | 'done'

export type Role = 'planner' | 'builder' | 'reviewer' | 'orchestrator'

export interface UITaskSpec {
  files: string[]
  readFirst?: string[]
  prescriptiveAction?: string | null
  verifyCmd: string | null
  doneCriteria: string[]
  taskType: string
}

export interface UITask {
  id: string
  title: string
  status: TaskStatus
  role: Role
  failed: boolean
  dropReason: string | null
  retryCount: number
  priority: number
  blockerTaskId: string | null
  /**
   * Structured-task contract. Null for ad-hoc tasks. When present, the
   * kanban card renders files, readFirst, prescriptiveAction, and verifyCmd
   * in the same order as the implementor brief.
   */
  spec: UITaskSpec | null
  failureSignature?: string | null
  /**
   * When set, this task was created to compensate/cleanup a force-purged arc.
   * The value is the `origin_id` of the abandoned arc. Null/absent for regular tasks.
   */
  compensatesArcId?: string | null
  /**
   * Short-lived sub-phase label for an in-flight task (e.g. 'merge:fast-forward').
   * Null/absent for queued/done/failed tasks and tasks without activity tracking.
   */
  activityDetail?: string | null
  createdAt: string
  updatedAt: string
}

export interface Snapshot {
  columns: Record<ColumnKey, UITask[]>
  counts: { inProgress: number; todo: number; done: number }
}
