export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'done'
  | 'failed'
  | 'dropped'
  | 'blocked'

export interface DraftFeature {
  id: string
  goal: string
  story: string
  technical: string
  status: string
  origin: string
  createdAt: number
  updatedAt: number
  acceptanceCount: number
}

export type SuggestionStatus = 'proposed' | 'accepted' | 'dismissed'

export interface TaskSuggestion {
  id: string
  sourceTaskId: string
  title: string
  prompt: string
  rationale: string | null
  status: SuggestionStatus
  createdTaskId: string | null
  createdAt: string
}

export interface Task {
  id: string
  prompt: string
  status: TaskStatus
  plan: { functional: string; technical: string } | null
  branch: string | null
  worktreePath: string | null
  error: string | null
  dropReason: string | null
  retryCount: number
  blockerSuggestionId: string | null
  createdAt: string
  updatedAt: string
}

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
  blockerSuggestionId: string | null
  createdAt: string
}

export interface Snapshot {
  columns: Record<ColumnKey, UITask[]>
  counts: { inProgress: number; todo: number; done: number }
}
