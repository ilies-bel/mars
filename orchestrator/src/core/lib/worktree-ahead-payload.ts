import { z } from 'zod'

export const WORKTREE_AHEAD_FAILURE_REASON =
  'worktree_ahead_of_integration_at_unblock'

const orphanCommitSchema = z.object({
  shortSha: z.string(),
  subject: z.string(),
})

export const WorktreeAheadPayloadSchema = z.object({
  taskId: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  integrationBranch: z.string(),
  commitsAhead: z.array(orphanCommitSchema),
  onMainLean: z.enum(['on-main', 'not-on-main', 'unknown']),
  leaseOwned: z.boolean(),
  failureReason: z.literal(WORKTREE_AHEAD_FAILURE_REASON),
})

export type WorktreeAheadPayload = z.infer<typeof WorktreeAheadPayloadSchema>
