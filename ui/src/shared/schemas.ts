import { z } from 'zod'

const taskStatusSchema = z.enum([
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

const proposalSourceSchema = z.enum(['reflection', 'human', 'planner'])

const draftFeatureSchema = z.object({
  id: z.string(),
  goal: z.string(),
  story: z.string(),
  technical: z.string(),
  status: z.string(),
  source: proposalSourceSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  acceptanceCount: z.number(),
})

const taskPlanSchema = z
  .object({
    functional: z.string(),
    technical: z.string(),
  })
  .nullable()

const taskSpecSchema = z
  .object({
    files: z.array(z.string()),
    readFirst: z.array(z.string()),
    prescriptiveAction: z.string().nullable(),
    verifyCmd: z.string().nullable(),
    doneCriteria: z.array(z.string()),
    taskType: z.string(),
  })
  .nullable()

const taskSchema = z.object({
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
  spec: taskSpecSchema.optional().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const clusterSchema = z.enum(['In progress', 'Blocked', 'Failed'])

const progressTaskSchema = taskSchema.extend({
  cluster: clusterSchema,
})

const staleWorktreeSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  ageHours: z.number(),
  updatedAt: z.string(),
  prompt: z.string(),
  error: z.string().nullable(),
  branch: z.string().nullable(),
  blockerTaskId: z.string().nullable(),
})

export const tasksResponseSchema = z.object({
  tasks: z.array(taskSchema),
})

export const progressResponseSchema = z.object({
  tasks: z.array(progressTaskSchema),
})

export const todoResponseSchema = z.object({
  drafts: z.array(draftFeatureSchema),
  staleWorktrees: z.array(staleWorktreeSchema),
})

export const inboxResponseSchema = z.object({
  drafts: z.array(draftFeatureSchema),
  blocked: z.array(taskSchema),
  failed: z.array(taskSchema),
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

export type InboxPayload = z.infer<typeof inboxResponseSchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
export type ProposalSource = z.infer<typeof proposalSourceSchema>
export type DraftFeature = z.infer<typeof draftFeatureSchema>
export type Task = z.infer<typeof taskSchema>
export type Cluster = z.infer<typeof clusterSchema>
export type ProgressTask = z.infer<typeof progressTaskSchema>
export type StaleWorktree = z.infer<typeof staleWorktreeSchema>
export type TodoPayload = z.infer<typeof todoResponseSchema>
export type Agent = z.infer<typeof agentSchema>
