import { defineWorkflow, runWorkflow, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'
import { type Task } from '../core/queue'
import { type DomainTaskStore, getDefaultDomainTaskStore } from '../core/store/task-store'
import { Workers } from '../core/workers'
import { parseWorkerJsonResult } from '../core/lib/worker-json'
import { getRepoRoot } from '../core/context'
import { createQueueWorkflowStore } from './queue-workflow-store'
import { type TraceEventStore } from '../core/lib/trace-events-store'
import { nullTraceStore } from '../core/lib/run-tool'
import { runWorkerWithSpan } from '../core/lib/run-worker-with-span'
import { diagnoseClaudeFailure } from '../core/lib/claude-stream'

const TASK_GRAPH_LIMIT = 30
const PROMPT_PREVIEW_CHARS = 200

/**
 * Maximum number of other non-done tasks in the open graph for triage to
 * consider the graph "trivially small" and skip the LLM call.
 *
 * The graph size counted here is the row count from
 * `listNonDoneTasks(task.id, TASK_GRAPH_LIMIT)` — the non-done tasks other than
 * the one being triaged, capped at the number the prompt can render. The LLM's
 * blocker references are checked against the ID-only task index before they
 * are written, so a verdict can only ever name an existing task other than
 * itself. (The threshold sits well below TASK_GRAPH_LIMIT, so the cap never
 * distorts the comparison.)
 *
 * Set to 5. Rationale:
 *  - 0 (the previous value) means "skip only when the graph is empty", i.e.
 *    never in practice. It fired the LLM for every single task — 1,303 runs
 *    and ~31M tokens in production for a question a rule can answer.
 *  - The skip verdict (`actionable: true`, no new blocker edges) matches the
 *    LLM's verdict whenever the LLM would have found no blocker among the
 *    candidates. With ≤ 5 other open tasks the operator has the whole queue in
 *    view and declares real prerequisites explicitly with `--blocked-by`,
 *    which the `has-blockers` rule (checked first) already honours.
 *  - Above ~5 the graph is large enough that a genuine unwritten-prerequisite
 *    relation the operator did not declare becomes plausible, which is exactly
 *    the judgement worth paying an LLM for.
 *
 * Note this rule, at ANY value including the old 0, gives up the non-graph
 * axis of the verdict (a task that needs a user decision before it can start).
 * Raising the threshold does not change that trade-off; it only widens the
 * range over which the blocker-detection axis is answered by rule.
 */
const TRIVIAL_GRAPH_SIZE = 5

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

// Pure formatter: the query (listNonDoneTasks) already guarantees the tasks
// are non-done and exclude the triaged task. Callers reverse the DESC result
// before passing it in so the rendered order is oldest-first (matching the
// pre-optimisation behaviour where listTasks returned ASC and slice(-30)
// produced the same 30 newest rows).
export const buildTaskGraph = (tasks: readonly Task[]): string => {
  const rows = tasks.map((t) => {
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

      const traceStore = ctx.services.traceStore

      // Helper shared by all three skip paths.
      const skipWith = async (
        reason: string,
        blockerCount: number,
      ): Promise<TriageResult> => {
        await traceStore
          ?.record({
            kind: 'log_line',
            taskId: task.id,
            originId: input.taskId,
            payload: {
              level: 'info',
              msg: `triage skipped: ${reason}`,
              source: 'workflow',
              fields: { skipReason: reason },
            },
          })
          .catch(() => undefined)
        await store.promoteDraftToQueued(task.id)
        return {
          taskId: task.id,
          actionable: true,
          blockerCount,
          reason: `triage skipped: ${reason}`,
          triageSkipReason: reason,
        }
      }

      // ── Skip rule 1: has-blockers ────────────────────────────────────────
      // Author declared explicit blocker edges; no graph query needed at all.
      const existingBlockers = await store.listBlockers(task.id)
      if (existingBlockers.length > 0) {
        return skipWith('has-blockers', existingBlockers.length)
      }

      // ── Skip rule 2: structured-spec ─────────────────────────────────────
      // Task carries files + done-criteria; scope is known without graph context.
      if (
        task.spec !== null &&
        task.spec.files.length > 0 &&
        task.spec.doneCriteria.length > 0
      ) {
        return skipWith('structured-spec', 0)
      }

      // ── Skip rule 3: trivial-graph ───────────────────────────────────────
      // Fetch only the rows we need for the task graph. When at most
      // TRIVIAL_GRAPH_SIZE come back there is nothing meaningful to be blocked
      // by, so we skip immediately rather than pay for an LLM call.
      const graphTasks = await store.listNonDoneTasks(task.id, TASK_GRAPH_LIMIT)
      if (graphTasks.length <= TRIVIAL_GRAPH_SIZE) {
        return skipWith('trivial-graph', 0)
      }

      // listNonDoneTasks returns newest-first (DESC); reverse to render
      // oldest-first, matching the pre-optimisation display order.
      const taskGraph = buildTaskGraph([...graphTasks].reverse())
      const knownIds = new Set(await store.listAllTaskIds())

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
          `provider worker exited ${r.exitCode}: ${diagnoseClaudeFailure(r.stdout, r.stderr)}`,
        )
      }

      const parsed = triageJsonSchema.parse(
        parseWorkerJsonResult(Workers.Triager.config.provider, r.stdout),
      )

      // Cap the LLM output before validating it, then retain only real task
      // references. listAllTaskIds returns scalar ids rather than full tasks,
      // avoiding prompt/transcript loading for this validation step.
      const filteredBlockers = parsed.blockerTaskIds
        .filter((id) => id !== task.id)
        .slice(0, MAX_BLOCKERS)
        .filter((id) => knownIds.has(id))

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
