/**
 * Steward agent spec — event-driven Mars companion.
 *
 * The Steward responds to four classes of signals emitted by the orchestrator:
 *   kpi-degraded        — a tracked metric has worsened beyond threshold
 *   resource-load       — a compute/memory metric is elevated
 *   onboarding          — a new stack is being bootstrapped
 *   workflow-suggestion — the system proposes a new workflow pattern
 *
 * This module exports the input schema and the agent spec so the next slices
 * can dispatch the Steward without duplicating schema definitions.
 */

import { z } from 'zod'

export const StewardEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('kpi-degraded'),
    signal: z.string(),
    delta: z.number(),
  }),
  z.object({
    kind: z.literal('resource-load'),
    metric: z.string(),
    value: z.number(),
  }),
  z.object({
    kind: z.literal('onboarding'),
    stack: z.string(),
  }),
  z.object({
    kind: z.literal('workflow-suggestion'),
    workflowName: z.string(),
    rationale: z.string(),
  }),
])

export type StewardEvent = z.infer<typeof StewardEventSchema>

const STEWARD_SYSTEM_PROMPT = [
  'You are the Steward — the Mars orchestrator\'s first-person voice.',
  '',
  'You receive structured events (kpi-degraded, resource-load, onboarding,',
  'workflow-suggestion) and respond with concise, actionable analysis or',
  'recommendations addressed directly to the operator.',
  '',
  'Use PromptOptimize when a Worker standing prompt is structurally costly or',
  'a relevant KPI degrades. It only changes Mars-owned standing Worker blocks;',
  'it never rewrites operator task prompts. Explain every autonomous change',
  'to the operator and include the ledger reference so it can be reverted.',
].join('\n')

export const stewardAgent = {
  name: 'steward' as const,
  displayName: 'Steward',
  description:
    'Event-driven Mars companion that responds to KPI, resource, onboarding, and workflow-suggestion signals.',
  model: 'claude-sonnet-4-6',
  systemPrompt: STEWARD_SYSTEM_PROMPT,
  allowedTools: ['Read', 'Bash', 'Grep', 'Glob', 'PromptOptimize'] as readonly string[],
  deniedTools: [] as readonly string[],
  inputSchema: StewardEventSchema,
} as const satisfies {
  name: 'steward'
  displayName: string
  description: string
  model: string
  systemPrompt: string
  allowedTools: readonly string[]
  deniedTools: readonly string[]
  inputSchema: typeof StewardEventSchema
}
