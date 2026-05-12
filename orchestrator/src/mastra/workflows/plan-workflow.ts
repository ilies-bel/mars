import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { getTask } from '../queue'
import { createIdea } from '../ideas'
import { runClaudeCode } from '../lib/git'
import { parseClaudeJsonResult } from '../lib/claude-json'
import { getRepoRoot } from '../context'

const planInputSchema = z.object({
  taskId: z.string(),
  refresh: z.boolean().default(false),
})

const planOutputSchema = z.object({
  taskId: z.string(),
  suggestionCount: z.number(),
})

const plannerOutputSchema = z.object({
  suggestions: z
    .array(
      z.object({
        title: z.string(),
        prompt: z.string(),
        rationale: z.string().optional(),
      }),
    )
    .max(10),
})

const buildPrompt = (spec: string): string =>
  `You analyze a draft software task spec and surface discrete follow-up tasks it implies but does not state.

Each suggestion is a separate runnable task (title + prompt). 0–5 max. No filler, no restating the spec.

Return ONLY a single JSON object matching exactly this shape, with no surrounding prose, no code fences, and no commentary:

{"suggestions":[{"title":"...","prompt":"...","rationale":"..."}]}

Spec to analyze:

${spec}`

const parsePlannerOutput = (claudeStdout: string): z.infer<typeof plannerOutputSchema> =>
  plannerOutputSchema.parse(parseClaudeJsonResult(claudeStdout))

const generateStep = createStep({
  id: 'generate-plan',
  inputSchema: planInputSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData, tracingContext }) => {
    const task = await getTask(inputData.taskId)
    if (!task) throw new Error(`task ${inputData.taskId} not found`)

    tracingContext?.currentSpan?.update({
      metadata: { originId: task.originId, taskId: task.id },
    })

    const r = await runClaudeCode({
      cwd: getRepoRoot(),
      prompt: buildPrompt(task.prompt),
      timeoutMs: 5 * 60 * 1000,
    })
    if (r.exitCode !== 0) {
      throw new Error(
        `claude -p exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
      )
    }

    const parsed = parsePlannerOutput(r.stdout)

    for (const s of parsed.suggestions) {
      await createIdea(s.title, {
        source: 'planner',
        author: { kind: 'agent', name: 'planner' },
        solution: s.prompt,
        notes: s.rationale ?? '',
      })
    }

    return {
      taskId: task.id,
      suggestionCount: parsed.suggestions.length,
    }
  },
})

export const planWorkflow = createWorkflow({
  id: 'plan',
  inputSchema: planInputSchema,
  outputSchema: planOutputSchema,
})
  .then(generateStep)
  .commit()

export interface RunPlanResult {
  taskId: string
  suggestionCount: number
}

export const runPlan = async (
  taskId: string,
  refresh = false,
): Promise<RunPlanResult> => {
  const run = await planWorkflow.createRun()
  const result = await run.start({ inputData: { taskId, refresh } })
  if (result.status !== 'success') {
    throw new Error(`plan workflow ${result.status}`)
  }
  return result.result
}
