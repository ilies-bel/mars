import type { TaskStatus } from './schemas'

export type {
  TaskStatus,
  Task,
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
  blockerTaskId: string | null
  /**
   * Structured-task contract. Null for ad-hoc tasks. When present, the
   * kanban card renders files, readFirst, prescriptiveAction, and verifyCmd
   * in the same order as the implementor brief.
   */
  spec: UITaskSpec | null
  createdAt: string
  updatedAt: string
}

export interface Snapshot {
  columns: Record<ColumnKey, UITask[]>
  counts: { inProgress: number; todo: number; done: number }
}
