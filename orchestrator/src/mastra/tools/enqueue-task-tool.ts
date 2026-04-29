import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { enqueueTask } from '../queue'

export const enqueueTaskTool = createTool({
  id: 'enqueue-task',
  description:
    'Enqueue a new task in the orchestrator queue with an optional functional and/or technical plan.',
  inputSchema: z.object({
    prompt: z.string().min(1, 'prompt required'),
    functional: z.string().optional(),
    technical: z.string().optional(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    status: z.literal('queued'),
  }),
  execute: async (inputData) => {
    const plan =
      inputData.functional !== undefined || inputData.technical !== undefined
        ? {
            functional: inputData.functional ?? '',
            technical: inputData.technical ?? '',
          }
        : undefined
    const task = await enqueueTask(inputData.prompt, plan)
    return { taskId: task.id, status: 'queued' as const }
  },
})
