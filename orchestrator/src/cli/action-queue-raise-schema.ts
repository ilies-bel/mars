import { z } from 'zod'
import { ACTION_QUEUE_KINDS } from '../core/lib/action-queue-kinds'

const actionQueuePriority = z.enum(['urgent', 'high', 'normal', 'low'])
const knownCategory = z.enum(['orchestrator', 'reflector', 'daemon', 'user'])

const recordOfUnknown = z.record(z.string(), z.unknown())

export const actionQueueRaiseSchema = z.object({
  kind: z.enum(ACTION_QUEUE_KINDS),
  category: z.union([knownCategory, z.string().min(1)]),
  priority: actionQueuePriority,
  title: z.string().min(1, 'title must be a non-empty string'),
  body: z.string(),
  payload: recordOfUnknown,
  context: recordOfUnknown,
  raisedBy: z.string(),
  signature: z.string().min(1, 'signature must be a non-empty string'),
  occurrence: recordOfUnknown.optional(),
})

export type ActionQueueRaiseInput = z.infer<typeof actionQueueRaiseSchema>
