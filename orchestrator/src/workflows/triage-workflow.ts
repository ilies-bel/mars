import { defineWorkflow, runWorkflow, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'
import { type Task } from '../core/queue'
import { type DomainTaskStore, getDefaultDomainTaskStore } from '../core/store/task-store'
import { Workers } from '../core/workers'
import { parseClaudeJsonResult } from '../core/lib/claude-json'
import { getRepoRoot } from '../core/context'
import { createQueueWorkflowStore } from './queue-workflow-store'
import { type TraceEventStore } from '../core/lib/trace-events-store'
import { nullTraceStore } from '../core/lib/run-tool'
import { runWorkerWithSpan } from '../core/lib/run-worker-with-span'

const TASK_GRAPH_LIMIT = 30
const PROMPT_PREVIEW_CHARS = 200

/**
 * Maximum number of other non-done tasks in the graph for triage to consider
 * the graph "trivially small". When the open graph has at most this many
 * other tasks there is nothing meaningful to be blocked by, so the LLM call
 * is skipped. Set to 0 (skip only when the graph is completely empty — no
 * other non-done tasks exist that could plausibly block the new task).
 */
const TRIVIAL_GRAPH_SIZE = 0

const triageInputSchema = z.object({
  taskId: z.string(),
})

type TriageInput = z.infer<typeof triageInputSchema>

const MAX_BLOCKERS = 10

const triageJsonSchema = z.object({
  actionable: z.boolean(),
  reason: z.string().default(''),
  blockerTaskIds: z.array(z.string()).default([]),
})

// The triage workflow reads + mutates the task graph; the daemon wires the
// DomainTaskStore and TraceEventStore from the composition root, read inside
// as `ctx.services.store` and `ctx.services.traceStore`.
export interface TriageServices {
  store: DomainTaskStore
  traceStore: TraceEventStore
}

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

If real prerequisites already exist as other tasks, list their ids in \`blockerTaskIds\`.
Default to \`actionable: true\` for any task that a competent engineer could pick up and implement
given access to the codebase. Only mark \`actionable: false\` when external input or another task
is genuinely required first. Never list the task being triaged as its own blocker.

Return ONLY this JSON, no prose, no fences:
{"actionable": bool, "reason": string, "blockerTaskIds": string[]}`

export interface TriageResult {
  taskId: string
  actionable: boolean
  blockerCount: number
  reason: string
  /**
   * When present, indicates that the LLM triage step was skipped because the
   * answer was already obvious from existing task structure. The value names
   * which rule fired:
   * - `'has-blockers'`   — the task already carried explicit blocker edges
   * - `'structured-spec'` — the task has a declared files + done-criteria spec
   * - `'trivial-graph'`  — the open task graph is empty or trivially small
   * Absent (undefined) when LLM triage ran normally.
   */
  triageSkipReason?: string
}

// One imperative step ('generate-triage', load-bearing as the trace-view
// node label). Failures THROW; the engine records the step failed and
// `runWorkflow` returns `{ status: 'failed', error }`.
export const triageWorkflow = defineWorkflow<TriageInput, TriageResult, TriageServices>({
  id: 'triage',
  inputSchema: triageInputSchema,
  fn: async (
    ctx: WorkflowCtx<TriageServices>,
    input: TriageInput,
  ): Promise<TriageResult> => {
    const store = ctx.services.store
    return await ctx.step('generate-triage', async (): Promise<TriageResult> => {
      const task = await store.getTask(input.taskId)
      if (!task) throw new Error(`task ${input.taskId} not found`)

      const allTasks = await store.listTasks()
      const knownIds = new Set(allTasks.map((t) => t.id))
      const taskGraph = buildTaskGraph(allTasks, task.id)

      const traceStore = ctx.services.traceStore

      // Skip the LLM call when the answer is already obvious from existing
      // task structure. Three rules (any one is sufficient):
      //   has-blockers   — author declared explicit blocker edges; respect them.
      //   structured-spec — task carries files + done-criteria; scope is known.
      //   trivial-graph  — open graph is empty or has ≤ TRIVIAL_GRAPH_SIZE tasks;
      //                    nothing meaningful to be blocked by.
      const openTasks = allTasks.filter((t) => t.id !== task.id && t.status !== 'done')
      const existingBlockers = await store.listBlockers(task.id)

      const triageSkipReason: string | null = (() => {
        if (existingBlockers.length > 0) return 'has-blockers'
        if (
          task.spec !== null &&
          task.spec.files.length > 0 &&
          task.spec.doneCriteria.length > 0
        ) return 'structured-spec'
        if (openTasks.length <= TRIVIAL_GRAPH_SIZE) return 'trivial-graph'
        return null
      })()

      if (triageSkipReason !== null) {
        await traceStore
          ?.record({
            kind: 'log_line',
            taskId: task.id,
            originId: input.taskId,
            payload: {
              level: 'info',
              msg: `triage skipped: ${triageSkipReason}`,
              source: 'workflow',
              fields: { skipReason: triageSkipReason },
            },
          })
          .catch(() => undefined)

        await store.promoteDraftToQueued(task.id)

        return {
          taskId: task.id,
          actionable: true,
          blockerCount: existingBlockers.length,
          reason: `triage skipped: ${triageSkipReason}`,
          triageSkipReason,
        }
      }

      const r = await runWorkerWithSpan({
        worker: Workers.Triager,
        prompt: buildPrompt(task, taskGraph),
        runOptions: { cwd: getRepoRoot() },
        traceStore,
        stepName: 'generate-triage',
        workflowInstanceId: ctx.runId,
        originId: input.taskId,
        taskId: input.taskId,
      })
      if (r.exitCode !== 0) {
        throw new Error(
          `provider worker exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
        )
      }

      const parsed = triageJsonSchema.parse(parseClaudeJsonResult(r.stdout))

      const filteredBlockers = parsed.blockerTaskIds
        .filter((id) => id !== task.id && knownIds.has(id))
        .slice(0, MAX_BLOCKERS)

      await store.clearBlockers(task.id)
      await store.addBlockers(task.id, filteredBlockers)

      if (parsed.actionable) {
        const remaining = await store.listBlockers(task.id)
        if (remaining.length === 0) {
          await store.promoteDraftToQueued(task.id)
        }
      }

      return {
        taskId: task.id,
        actionable: parsed.actionable,
        blockerCount: filteredBlockers.length,
        reason: parsed.reason,
      }
    })
  },
})

export const runTriage = async (
  taskId: string,
  store?: DomainTaskStore,
  traceStore?: TraceEventStore,
): Promise<TriageResult> => {
  const result = await runWorkflow(triageWorkflow, { taskId }, {
    store: createQueueWorkflowStore(),
    services: {
      store: store ?? getDefaultDomainTaskStore(),
      traceStore: traceStore ?? nullTraceStore,
    },
  })
  if (result.status !== 'completed' || !result.output) {
    const cause = result.error instanceof Error ? `: ${result.error.message}` : ''
    throw new Error(`triage workflow ${result.status}${cause}`)
  }
  return result.output
}
