import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { getTask } from '../mastra/queue'
import { createProposal } from '../mastra/proposals'
import { Workers } from '../mastra/workers'
import { parseClaudeJsonResult } from '../mastra/lib/claude-json'
import { getRepoRoot } from '../mastra/context'
import { type TaskStore, getDefaultTaskStore } from '../mastra/lib/task-store'
import { RequestContext } from '@mastra/core/di'

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

// Contract: the planner emits follow-up suggestions as ideas (source='planner')
// only. It MUST NOT insert question rows or otherwise produce a mid-run
// human-question artefact — the orchestrator commits to a "plan fully up
// front, then run autonomously" model. The question/answer feature has been
// removed from the orchestrator (PRD eb6f8cc6); a planner run on a task with
// incomplete information either completes a plan or leaves the task in draft,
// with no question artefact created. Do not reintroduce a question-emission
// branch here.
const generateStep = createStep({
  id: 'generate-plan',
  inputSchema: planInputSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData, tracingContext, requestContext }) => {
    const store: TaskStore = (requestContext.get('taskStore') as TaskStore | undefined) ?? await getDefaultTaskStore()
    const task = await getTask(inputData.taskId, store)
    if (!task) throw new Error(`task ${inputData.taskId} not found`)

    tracingContext?.currentSpan?.update({
      metadata: { originId: task.originId, taskId: task.id },
    })

    const r = await Workers.Planner.run(buildPrompt(task.prompt), {
      cwd: getRepoRoot(),
    })
    if (r.exitCode !== 0) {
      throw new Error(
        `claude -p exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
      )
    }

    const parsed = parsePlannerOutput(r.stdout)

    for (const s of parsed.suggestions) {
      await createProposal(s.title, {
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
  requestContext?: RequestContext,
): Promise<RunPlanResult> => {
  const run = await planWorkflow.createRun()
  const result = await run.start({ inputData: { taskId, refresh }, requestContext })
  if (result.status !== 'success') {
    throw new Error(`plan workflow ${result.status}`)
  }
  return result.result
}
