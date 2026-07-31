/**
 * Steward agent spec — event-driven Mars companion.
 *
 * The Steward responds to five classes of signals emitted by the orchestrator:
 *   kpi-degraded        — a tracked metric has worsened beyond threshold
 *   resource-load       — a compute/memory metric is elevated
 *   onboarding          — a new stack is being bootstrapped
 *   workflow-suggestion — the system proposes a new workflow pattern
 *   signature-storm     — the all-gate circuit breaker tripped; dispatch is
 *                         PAUSED and the Steward must land a fix
 *
 * `signature-storm` is the one WRITE-CAPABLE dispatch: the daemon runs the
 * Steward inside its own git worktree with edit tools enabled, because the
 * breaker pausing dispatch and then producing only prose is what left the
 * queue dead until a human noticed. Every other event class remains advisory.
 */

import { z } from 'zod'

/** One task's failure context, handed to the Steward so it can diagnose. */
export const StormFailureExcerptSchema = z.object({
  taskId: z.string(),
  /** The failing step / signature recorded for this task. */
  signature: z.string(),
  /** Truncated tail of the task's recorded error output. */
  excerpt: z.string(),
})

export type StormFailureExcerpt = z.infer<typeof StormFailureExcerptSchema>

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
  z.object({
    kind: z.literal('signature-storm'),
    /** The `<failingStep>/<errorClass>` signature that tripped the breaker. */
    signature: z.string(),
    /** Consecutive distinct tasks that failed with this signature. */
    streak: z.number().int().nonnegative(),
    /** Task ids observed failing with this signature, newest first. */
    affectedTaskIds: z.array(z.string()),
    /** Failure context for those tasks, so the brief is self-contained. */
    failureExcerpts: z.array(StormFailureExcerptSchema).default([]),
  }),
])

export type StewardEvent = z.infer<typeof StewardEventSchema>
export type StewardStormEvent = Extract<StewardEvent, { kind: 'signature-storm' }>

const STEWARD_SYSTEM_PROMPT = [
  'You are the Steward — the Mars orchestrator\'s first-person voice.',
  '',
  'You receive structured events (kpi-degraded, resource-load, onboarding,',
  'workflow-suggestion, signature-storm) and respond with concise, actionable',
  'analysis addressed directly to the operator.',
  '',
  'For advisory events (kpi-degraded, resource-load, onboarding,',
  'workflow-suggestion) you observe, reason, and report — you do not modify',
  'files.',
  '',
  'A signature-storm dispatch is different, and the brief will say so. The',
  'all-gate circuit breaker has tripped: the same failure signature killed',
  'several consecutive tasks, dispatch is PAUSED, and you are running',
  'write-capable inside your own git worktree. Prose alone leaves the queue',
  'dead. Diagnose the systemic cause, fix it, and commit the fix in the',
  'worktree before you finish. If the cause is environmental rather than a',
  'code defect (disk full, missing binary, broken credentials), repair the',
  'environment and say exactly what you changed. If you genuinely cannot fix',
  'it, say so plainly and name the single next action a human must take.',
  '',
  'Use PromptOptimize when a Worker standing prompt is structurally costly or',
  'a relevant KPI degrades. It only changes Mars-owned standing Worker blocks;',
  'it never rewrites operator task prompts. Explain every autonomous change',
  'to the operator and include the ledger reference so it can be reverted.',
].join('\n')

/** Tools the Steward may call on the write-capable signature-storm dispatch. */
export const STEWARD_STORM_TOOLS: readonly string[] = [
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'Edit',
  'Write',
]

/** Wall-clock ceiling for one storm Steward run (20 minutes). */
export const STEWARD_STORM_TIMEOUT_MS = 20 * 60_000

/** Cap on a single failure excerpt so the brief stays small. */
const EXCERPT_MAX_CHARS = 1_500

/**
 * Render the storm brief the Steward receives as its prompt. Everything the
 * agent needs to diagnose is inlined — signature, streak, affected task ids,
 * and a truncated excerpt of each task's error — so the run does not depend on
 * the agent discovering daemon state on its own.
 */
export const renderStewardStormBrief = (event: StewardStormEvent): string => {
  const lines: string[] = [
    '# Signature storm — dispatch is PAUSED',
    '',
    `Failure signature: ${event.signature}`,
    `Consecutive failing tasks: ${event.streak}`,
    `Affected task ids: ${
      event.affectedTaskIds.length > 0 ? event.affectedTaskIds.join(', ') : '(none recorded)'
    }`,
    '',
    'The same signature killed every one of those tasks, so the cause is',
    'systemic (environment, infrastructure, or a shared code path) rather than',
    'a per-task regression. The dispatch queue is paused until this is fixed.',
    '',
  ]

  if (event.failureExcerpts.length > 0) {
    lines.push('## Failure excerpts', '')
    for (const excerpt of event.failureExcerpts) {
      lines.push(
        `### ${excerpt.taskId} (${excerpt.signature})`,
        '```',
        excerpt.excerpt.slice(0, EXCERPT_MAX_CHARS),
        '```',
        '',
      )
    }
  }

  lines.push(
    '## What to do',
    '',
    'You are running WRITE-CAPABLE in your own git worktree. This is not a',
    'read-only investigation:',
    '',
    '1. Find the one cause these failures share.',
    '2. Fix it — edit code, or repair the environment when the cause is',
    '   environmental.',
    '3. Commit your work in this worktree (`git add -A && git commit`). Nothing',
    '   commits on your behalf.',
    '4. Finish with a short report: the root cause, what you changed, and',
    '   whether dispatch is safe to resume.',
    '',
    'If you cannot fix it, say so explicitly and name the single next action a',
    'human must take. Do not stop at an explanation of the diff.',
  )

  return lines.join('\n')
}

export const stewardAgent = {
  name: 'steward' as const,
  displayName: 'Steward',
  description:
    'Event-driven Mars companion that responds to KPI, resource, onboarding, workflow-suggestion, and signature-storm signals.',
  model: 'claude-sonnet-4-6',
  systemPrompt: STEWARD_SYSTEM_PROMPT,
  // The union of both dispatch shapes: the write-capable storm tools (Edit /
  // Write, so a tripped breaker produces a fix rather than prose) plus
  // PromptOptimize, which the advisory dispatches use to rewrite Mars-owned
  // standing Worker blocks. Edit/Write only ever fire on the storm dispatch —
  // the system prompt above holds advisory runs to observe-and-report.
  allowedTools: [...STEWARD_STORM_TOOLS, 'PromptOptimize'] as readonly string[],
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
