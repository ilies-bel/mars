import { defineWorkflow, runWorkflow, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'
import { getTask } from '../core/queue'
import { createProposal } from '../core/proposals'
import { Workers } from '../core/workers'
import { parseClaudeJsonResult } from '../core/lib/claude-json'
import { getRepoRoot } from '../core/context'
import { type DomainTaskStore as TaskStore, getDefaultTaskStore } from '../core/store/task-store'
import { createQueueWorkflowStore } from './queue-workflow-store'
import { type TraceEventStore } from '../core/lib/trace-events-store'
import { nullTraceStore } from '../core/lib/run-tool'
import { runWorkerWithSpan } from '../core/lib/run-worker-with-span'

const planInputSchema = z.object({
  taskId: z.string(),
  refresh: z.boolean().default(false),
})

type PlanInput = z.infer<typeof planInputSchema>

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

// The plan workflow reads the task and writes Proposal rows; the daemon
// wires the TaskStore and TraceEventStore from the composition root, read
// inside as `ctx.services.store` and `ctx.services.traceStore`.
export interface PlanServices {
  store: TaskStore
  traceStore: TraceEventStore
}

const buildPrompt = (spec: string): string =>
  `You analyze a draft software task spec and surface discrete follow-up tasks it implies but does not state.

Each suggestion is a separate runnable task (title + prompt). 0–5 max. No filler, no restating the spec.

Return ONLY a single JSON object matching exactly this shape, with no surrounding prose, no code fences, and no commentary:

{"suggestions":[{"title":"...","prompt":"...","rationale":"..."}]}

Spec to analyze:

${spec}`

const parsePlannerOutput = (claudeStdout: string): z.infer<typeof plannerOutputSchema> =>
  plannerOutputSchema.parse(parseClaudeJsonResult(claudeStdout))

export interface RunPlanResult {
  taskId: string
  suggestionCount: number
}

// Contract: the planner emits follow-up suggestions as ideas (source='planner')
// only. It MUST NOT insert question rows or otherwise produce a mid-run
// human-question artefact — the orchestrator commits to a "plan fully up
// front, then run autonomously" model. The question/answer feature has been
// removed from the orchestrator (PRD eb6f8cc6); a planner run on a task with
// incomplete information either completes a plan or leaves the task in draft,
// with no question artefact created. Do not reintroduce a question-emission
// branch here.
//
// One imperative step ('generate-plan', load-bearing as the trace-view node
// label). Failures THROW; the engine records the step failed.
export const planWorkflow = defineWorkflow<PlanInput, RunPlanResult, PlanServices>({
  id: 'plan',
  inputSchema: planInputSchema,
  fn: async (
    ctx: WorkflowCtx<PlanServices>,
    input: PlanInput,
  ): Promise<RunPlanResult> => {
    const store = ctx.services.store
    return await ctx.step('generate-plan', async (): Promise<RunPlanResult> => {
      const task = await getTask(input.taskId, store)
      if (!task) throw new Error(`task ${input.taskId} not found`)

      const traceStore = ctx.services.traceStore
      const r = await runWorkerWithSpan({
        worker: Workers.Planner,
        prompt: buildPrompt(task.prompt),
        runOptions: { cwd: getRepoRoot() },
        traceStore,
        stepName: 'generate-plan',
        workflowInstanceId: ctx.runId,
        originId: input.taskId,
        taskId: input.taskId,
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
    })
  },
})

export const runPlan = async (
  taskId: string,
  refresh = false,
  store?: TaskStore,
  traceStore?: TraceEventStore,
): Promise<RunPlanResult> => {
  const result = await runWorkflow(planWorkflow, { taskId, refresh }, {
    store: createQueueWorkflowStore(),
    services: {
      store: store ?? (await getDefaultTaskStore()),
      traceStore: traceStore ?? nullTraceStore,
    },
  })
  if (result.status !== 'completed' || !result.output) {
    const cause = result.error instanceof Error ? `: ${result.error.message}` : ''
    throw new Error(`plan workflow ${result.status}${cause}`)
  }
  return result.output
}
