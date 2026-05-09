import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import {
  addBlockers,
  clearBlockers,
  getTask,
  insertSuggestion,
  listBlockers,
  listTasks,
  promoteDraftToQueued,
  type Task,
} from '../queue'
import { runClaudeCode } from '../lib/git'
import { parseClaudeJsonResult } from '../lib/claude-json'
import { getRepoRoot } from '../context'

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001'
const TASK_GRAPH_LIMIT = 30
const PROMPT_PREVIEW_CHARS = 200

const triageInputSchema = z.object({
  taskId: z.string(),
})

const triageOutputSchema = z.object({
  taskId: z.string(),
  actionable: z.boolean(),
  blockerCount: z.number(),
  suggestionCount: z.number(),
  reason: z.string(),
})

const MAX_BLOCKERS = 10
const MAX_NEW_SUGGESTIONS = 5

const triageJsonSchema = z.object({
  actionable: z.boolean(),
  reason: z.string().default(''),
  blockerTaskIds: z.array(z.string()).default([]),
  newSuggestions: z
    .array(
      z.object({
        title: z.string(),
        prompt: z.string(),
        rationale: z.string().optional(),
      }),
    )
    .default([]),
})

const buildTaskGraph = (tasks: readonly Task[], excludeId: string): string => {
  const rows = tasks
    .filter((t) => t.id !== excludeId && t.status !== 'done')
    .slice(-TASK_GRAPH_LIMIT)
    .map((t) => {
      const preview = String(t.prompt).replace(/\s+/g, ' ').slice(0, PROMPT_PREVIEW_CHARS)
      return `${t.id} | ${t.status} | ${preview}`
    })
  return rows.length === 0 ? '(no other tasks)' : rows.join('\n')
}

const buildPrompt = (task: Task, taskGraph: string): string =>
  `You are a Mars triage assistant. Decide whether the task below is ready to execute.

Task to triage: ${task.id} — ${task.prompt}

Existing tasks (id | status | prompt):
${taskGraph}

Mark \`actionable: true\` when ALL of these hold:
- The task can be implemented end-to-end without further input from the user.
- Scope is bounded to the current codebase (any size is fine — small fix or large feature).
- It does not collide with the surface of another in-flight (queued/draft/running) task.
- All EXTERNAL prerequisites already exist as completed, queued, or draft tasks.

What is NOT a blocker (these are normal parts of implementation, not prerequisites):
- The implementing agent needing to read existing code, types, or function signatures before changing them.
- The implementing agent needing to load a skill, consult documentation, or verify an API version.
- The task prompt instructing the agent to "read X first", "load skill Y", or "inspect Z before modifying".
- Investigation, exploration, or research that the agent will perform itself inside its worktree.
- Large scope, many files touched, or multi-step implementation — size alone is not a blocker.

A real blocker is EXTERNAL: a missing user decision, an undefined requirement only the user can resolve,
a dependency on another task that hasn't been written yet, or a reference to a file/system that doesn't exist.

If real EXTERNAL prerequisites are missing, propose them in \`newSuggestions\` (title + prompt + rationale).
If real prerequisites already exist as other tasks, list their ids in \`blockerTaskIds\`.
Default to \`actionable: true\` for any task that a competent engineer could pick up and implement
given access to the codebase. Only mark \`actionable: false\` when external input or another task
is genuinely required first. Never list the task being triaged as its own blocker.

Return ONLY this JSON, no prose, no fences:
{"actionable": bool, "reason": string, "blockerTaskIds": string[], "newSuggestions": [{"title": string, "prompt": string, "rationale": string}]}`

const generateStep = createStep({
  id: 'generate-triage',
  inputSchema: triageInputSchema,
  outputSchema: triageOutputSchema,
  execute: async ({ inputData, tracingContext }) => {
    const task = await getTask(inputData.taskId)
    if (!task) throw new Error(`task ${inputData.taskId} not found`)

    tracingContext?.currentSpan?.update({
      metadata: { originId: task.originId, taskId: task.id },
    })

    const allTasks = await listTasks()
    const knownIds = new Set(allTasks.map((t) => t.id))
    const taskGraph = buildTaskGraph(allTasks, task.id)

    const r = await runClaudeCode({
      cwd: getRepoRoot(),
      prompt: buildPrompt(task, taskGraph),
      timeoutMs: 2 * 60 * 1000,
      model: TRIAGE_MODEL,
    })
    if (r.exitCode !== 0) {
      throw new Error(
        `claude -p exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
      )
    }

    const parsed = triageJsonSchema.parse(parseClaudeJsonResult(r.stdout))

    const filteredBlockers = parsed.blockerTaskIds
      .filter((id) => id !== task.id && knownIds.has(id))
      .slice(0, MAX_BLOCKERS)

    await clearBlockers(task.id)
    await addBlockers(task.id, filteredBlockers)

    const cappedSuggestions = parsed.newSuggestions.slice(0, MAX_NEW_SUGGESTIONS)
    for (const s of cappedSuggestions) {
      await insertSuggestion({
        sourceTaskId: task.id,
        title: s.title,
        prompt: s.prompt,
        rationale: s.rationale ?? null,
      })
    }

    if (parsed.actionable) {
      const remaining = await listBlockers(task.id)
      if (remaining.length === 0) {
        await promoteDraftToQueued(task.id)
      }
    }

    return {
      taskId: task.id,
      actionable: parsed.actionable,
      blockerCount: filteredBlockers.length,
      suggestionCount: cappedSuggestions.length,
      reason: parsed.reason,
    }
  },
})

export const triageWorkflow = createWorkflow({
  id: 'triage',
  inputSchema: triageInputSchema,
  outputSchema: triageOutputSchema,
})
  .then(generateStep)
  .commit()

export interface TriageResult {
  taskId: string
  actionable: boolean
  blockerCount: number
  suggestionCount: number
  reason: string
}

export const runTriage = async (taskId: string): Promise<TriageResult> => {
  const run = await triageWorkflow.createRun()
  const result = await run.start({ inputData: { taskId } })
  if (result.status !== 'success') {
    const cause =
      'error' in result && result.error instanceof Error
        ? `: ${result.error.message}`
        : ` (full result: ${JSON.stringify(result).slice(0, 500)})`
    throw new Error(`triage workflow ${result.status}${cause}`)
  }
  return result.result
}
