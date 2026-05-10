import type { TaskStatus } from './schemas'

export type {
  TaskStatus,
  IdeaSource,
  DraftFeature,
  Task,
  StaleWorktree,
  TodoPayload,
} from './schemas'

export type ColumnKey =
  | 'backlog'
  | 'planned'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'dropped'

export type Role = 'planner' | 'builder' | 'reviewer' | 'orchestrator'

export interface UITask {
  id: string
  shortId: string
  title: string
  status: TaskStatus
  role: Role
  failed: boolean
  dropReason: string | null
  retryCount: number
  blockerTaskId: string | null
  createdAt: string
}

export interface Snapshot {
  columns: Record<ColumnKey, UITask[]>
  counts: { inProgress: number; todo: number; done: number }
}
