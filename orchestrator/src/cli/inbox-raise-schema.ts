import { z } from 'zod'
import { INBOX_KINDS } from '../mastra/lib/inbox'

const inboxPriority = z.enum(['urgent', 'high', 'normal', 'low'])
const knownCategory = z.enum(['orchestrator', 'reflector', 'daemon', 'user'])

const recordOfUnknown = z.record(z.string(), z.unknown())

export const inboxRaiseSchema = z.object({
  kind: z.enum(INBOX_KINDS),
  category: z.union([knownCategory, z.string().min(1)]),
  priority: inboxPriority,
  title: z.string().min(1, 'title must be a non-empty string'),
  body: z.string(),
  payload: recordOfUnknown,
  context: recordOfUnknown,
  raisedBy: z.string(),
  signature: z.string().min(1, 'signature must be a non-empty string'),
  occurrence: recordOfUnknown.optional(),
})

export type InboxRaiseInput = z.infer<typeof inboxRaiseSchema>
