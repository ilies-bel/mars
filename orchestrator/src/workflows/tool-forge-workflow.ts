import { defineWorkflow } from '@mars/workflow'
import { z } from 'zod'
import {
  setupWorktree,
  runAgent,
  review,
  merge as mergePrimitive,
  type MarsServices,
} from './primitives'
import {
  planSchema,
  tagSchema,
  kindSchema,
  specSchema,
} from './primitives/shared'

export type { MarsServices }

// ---------------------------------------------------------------------------
// Tool-forge pipeline
//
// Dispatched when the failure-signature detector identifies a recurring
// missing-helper pattern and enqueues a task to create the helper + benchmark.
//
// Steps mirror implement-workflow (same four primitives). The distinction is
// in the dispatched prompt: the coder is instructed to write BOTH the helper
// module AND a benchmark that replays each motivating arc id.
// ---------------------------------------------------------------------------

const toolForgeInputSchema = z.object({
  taskId: z.string(),
  prompt: z.string(),
  plan: planSchema.default(null),
  tags: tagSchema,
  kind: kindSchema,
  integrationBranch: z.string().default('main'),
  spec: specSchema,
  resumeFromPriorAttempt: z.boolean().default(false),
  verifyFailureOutput: z.string().nullable().default(null),
  recoveryPayload: z.string().nullable().default(null),
  fixForTaskId: z.string().nullable().default(null),
})

export type ToolForgeInput = z.infer<typeof toolForgeInputSchema>

export interface ToolForgeOutput {
  taskId: string
  success: boolean
  message: string
}

/**
 * Prompt template dispatched to the coder when a tool-forge task is enqueued.
 *
 * Placeholders (substituted by {@link buildToolForgePrompt}):
 *   - `<helper_key>`        — the camelCase/kebab-case key for the helper
 *   - `<motivating_arc_ids>` — comma-separated list of arc ids that motivated
 *                              creating this helper
 *
 * Target paths (literal; contain the `<helper_key>` placeholder verbatim until
 * rendered):
 *   - orchestrator/src/tools/<helper_key>/index.ts
 *   - orchestrator/benchmarks/<helper_key>.bench.ts
 */
export const TOOL_FORGE_PROMPT_TEMPLATE = `\
# Tool-forge: create helper <helper_key>

## What to build

Create a small helper module at orchestrator/src/tools/<helper_key>/index.ts and a
benchmark file at orchestrator/benchmarks/<helper_key>.bench.ts that replays each
motivating arc id: <motivating_arc_ids>.

The benchmark must exercise the helper in a way that can also be run without it, so
the verify step can confirm correctness in both configurations.

## Files

- NEW: orchestrator/src/tools/<helper_key>/index.ts
- NEW: orchestrator/benchmarks/<helper_key>.bench.ts

## Acceptance criteria

- [ ] orchestrator/src/tools/<helper_key>/index.ts exports the helper and is
  well-typed (no implicit \`any\`)
- [ ] orchestrator/benchmarks/<helper_key>.bench.ts imports from
  orchestrator/src/tools/<helper_key>/index.ts and replays each motivating arc
  id: <motivating_arc_ids>
- [ ] Benchmark passes without the helper (baseline run)
- [ ] Benchmark passes with the helper (regression guard)

## Verify

Run the benchmark twice:
  cd orchestrator && npx vitest bench benchmarks/<helper_key>.bench.ts
  cd orchestrator && npx vitest bench benchmarks/<helper_key>.bench.ts --reporter=verbose

## Save your work

Stage and commit when done:

\`\`\`
git add -A
git commit -m "feat(tools): add <helper_key> helper + benchmark"
\`\`\`
`

/**
 * Build the full coder prompt for a tool-forge task by substituting concrete
 * values into {@link TOOL_FORGE_PROMPT_TEMPLATE}.
 */
export const buildToolForgePrompt = (
  helperKey: string,
  motivatingArcIds: string[],
): string =>
  TOOL_FORGE_PROMPT_TEMPLATE.replace(/<helper_key>/g, helperKey).replace(
    /<motivating_arc_ids>/g,
    motivatingArcIds.join(', '),
  )

export const toolForgeWorkflow = defineWorkflow<
  ToolForgeInput,
  ToolForgeOutput,
  MarsServices
>({
  id: 'tool-forge',
  inputSchema: toolForgeInputSchema,
  fn: async (ctx): Promise<ToolForgeOutput> => {
    await ctx.step('setup-worktree', () => setupWorktree(ctx))
    await ctx.step('run-claude-code', () => runAgent(ctx))
    await ctx.step('review', () => review(ctx, { reviewType: 'auto' }))
    return await ctx.step('merge', () => mergePrimitive(ctx))
  },
})
