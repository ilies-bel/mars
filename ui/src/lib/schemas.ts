import { z } from 'zod'

export const taskStatusSchema = z.enum([
  'draft',
  'queued',
  'running',
  'verifying',
  'merging',
  'done',
  'failed',
  'dropped',
  'blocked',
])

export const ideaSourceSchema = z.enum(['reflection', 'human', 'planner'])

export const draftFeatureSchema = z.object({
  id: z.string(),
  goal: z.string(),
  story: z.string(),
  technical: z.string(),
  status: z.string(),
  source: ideaSourceSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  acceptanceCount: z.number(),
})

export const taskPlanSchema = z
  .object({
    functional: z.string(),
    technical: z.string(),
  })
  .nullable()

export const taskSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  status: taskStatusSchema,
  plan: taskPlanSchema,
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  error: z.string().nullable(),
  dropReason: z.string().nullable(),
  retryCount: z.number(),
  blockerTaskId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const staleWorktreeSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  ageHours: z.number(),
  updatedAt: z.string(),
})

export const tasksResponseSchema = z.object({
  tasks: z.array(taskSchema),
})

export const todoResponseSchema = z.object({
  drafts: z.array(draftFeatureSchema),
  staleWorktrees: z.array(staleWorktreeSchema),
})

export const agentSchema = z.object({
  name: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  permissionMode: z.string().nullable(),
  allowedTools: z.array(z.string()),
  deniedTools: z.array(z.string()),
  messageCap: z.number().nullable(),
  role: z.string(),
})

export const agentsResponseSchema = z.object({
  agents: z.array(agentSchema),
})

export type TaskStatus = z.infer<typeof taskStatusSchema>
export type IdeaSource = z.infer<typeof ideaSourceSchema>
export type DraftFeature = z.infer<typeof draftFeatureSchema>
export type Task = z.infer<typeof taskSchema>
export type StaleWorktree = z.infer<typeof staleWorktreeSchema>
export type TodoPayload = z.infer<typeof todoResponseSchema>
export type Agent = z.infer<typeof agentSchema>
