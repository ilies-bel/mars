import { z } from 'zod'

const AckSchema = z.object({
  text: z.string(),
  timestamp: z.string(),
  pair: z.object({ from: z.number(), to: z.number() }).nullable(),
})

const GateHealthEntrySchema = z.object({
  id: z.string(),
  scope: z.string(),
  name: z.string(),
  tier: z.string(),
  required: z.boolean(),
  state: z.enum(['active', 'quarantined']),
  source: z.string(),
  command: z.object({
    cmd: z.string(),
    args: z.array(z.string()),
  }),
  quarantinedAt: z.number().nullable(),
  quarantineSignature: z.string().nullable(),
  lastFailureSignature: z.string().nullable(),
  lastFailureOriginId: z.string().nullable(),
  lastFailureAt: z.number().nullable(),
})

export const StewardViewSchema = z.object({
  runtimeTuning: z.object({
    acks: z.array(AckSchema),
    liveCap: z.number(),
    baselineCap: z.number(),
    ceiling: z.number(),
    bumpFactor: z.number(),
    thresholdFactor: z.number(),
    sustainMs: z.number(),
    checkMs: z.number(),
  }),
  workflowPatches: z.object({
    rows: z.array(z.object({
      id: z.string(),
      workflow_path: z.string(),
      unified_diff: z.string(),
      rationale: z.string(),
      status: z.string(),
      created_at: z.string(),
    })),
    hasCallers: z.boolean(),
  }),
  signatureStorm: z.object({
    current_signature: z.string().nullable(),
    streak_count: z.number(),
    last_task_id: z.string().nullable(),
    tripped: z.boolean(),
    updated_at: z.string().nullable(),
    signatureStormAqCount: z.number(),
    tripThreshold: z.number(),
    isPaused: z.boolean(),
  }),
  agentSpec: z.object({
    name: z.string(),
    model: z.string(),
    allowedTools: z.array(z.string()),
    eventVariants: z.array(z.string()),
    dispatchSites: z.number(),
  }),
  gateHealth: z.object({
    scopes: z.array(z.object({
      scope: z.string(),
      gates: z.array(GateHealthEntrySchema),
    })),
  }),
})

export type StewardView = z.infer<typeof StewardViewSchema>
