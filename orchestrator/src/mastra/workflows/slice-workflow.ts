import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { getProposal, getProposalsClient } from '../proposals'
import {
  getClient as getQueueClient,
  enqueueTask,
  initQueue,
} from '../queue'
import { Workers } from '../workers'
import { parseClaudeJsonResult } from '../lib/claude-json'
import { getRepoRoot } from '../context'
import { TDD_WORKER_BRIEF } from './tdd-brief'

const sliceInputSchema = z.object({
  ideaId: z.string(),
})

const sliceOutputSchema = z.object({
  ideaId: z.string(),
  status: z.string(),
  taskIds: z.array(z.string()),
})

const slicerOutputSchema = z.object({
  slices: z
    .array(
      z.object({
        title: z.string(),
        type: z.enum(['HITL', 'AFK']).default('AFK'),
        whatToBuild: z.string(),
        acceptanceCriteria: z.array(z.string()).min(1),
        blockedBy: z.array(z.number().int().min(1)),
        // gsd-style structured-task spec. The slicer now names the files
        // it expects the implementor to touch, the command that verifies
        // the slice, and an explicit task type. Defaults preserve forward
        // compatibility with planner outputs that don't yet emit these.
        files: z.array(z.string()).default([]),
        verifyCmd: z.string().nullable().default(null),
        taskType: z.enum(['auto', 'checkpoint']).default('auto'),
      }),
    )
    .min(1)
    .max(20),
})

type SliceSpec = z.infer<typeof slicerOutputSchema>['slices'][number]

const renderUserStories = (stories: readonly string[]): string => {
  if (stories.length === 0) return '(none)'
  return stories.map((s, i) => `${i + 1}. ${s}`).join('\n')
}

export const buildSlicerPrompt = (idea: {
  id: string
  title: string
  problem: string
  solution: string
  outOfScope: string
  notes: string
  userStories: string[]
}): string => `Break this PRD into independently-grabbable issues using vertical
slices (tracer bullets). Each issue is a thin vertical slice that cuts
through ALL integration layers end-to-end, NOT a horizontal slice of one
layer.

Vertical-slice rules
--------------------
- Each slice delivers a narrow but COMPLETE path through every layer
  (schema, API, UI, tests where relevant).
- A completed slice is demoable or verifiable on its own.
- Prefer many thin slices over few thick ones.

HITL vs AFK
-----------
Slices may be 'HITL' or 'AFK'. HITL slices require human interaction
(architectural decision, design review). AFK slices can be implemented
and merged without human interaction. Prefer AFK over HITL where possible.

Structured-writes are settled at grill time — never slice one
-------------------------------------------------------------
A STRUCTURED-WRITE is a glossary or ADR mutation. Per ADR 0019,
structured-writes are never a dispatched slice's deliverable: glossary
terms and ADRs are decided and recorded during GRILLING, before a PRD is
ever promoted. By the time a PRD reaches you the structured-write has
already happened and the vocabulary is settled. Therefore: NEVER produce
a slice whose sole deliverable is a structured-write — i.e. a glossary
change or an ADR change. If this PRD still describes such a
structured-write as its own deliverable, treat that as an upstream
process violation — a PRD that was promoted before its vocabulary was
settled at grill time — not a case to accommodate. Do not add a slice
for it, do not branch your output around it, do not "detect" it: this is
guidance only. Just decompose the remaining real work and leave the
structured-write out, because it should already have happened during
grilling.

Output shape
------------
For each slice, produce:
- title — a short descriptive name
- type — "HITL" or "AFK"
- whatToBuild — concise end-to-end behaviour description. NO file paths,
  NO module names, NO code snippets, NO library choices. Describe what
  the user observes when this slice is done.
- acceptanceCriteria — a list of checkbox items the slice must satisfy
  to be considered complete. Each item is a single concrete observable.
- blockedBy — 1-based indices of other slices in the same response that
  this one must wait for. Use sparingly; most slices should parallelise.
- files — array of relative file paths (or directory globs) the
  implementor is allowed to touch for this slice. Be specific; broad
  globs ("**") signal you have not narrowed the scope. Anything outside
  this set the agent encounters becomes a deferred-idea or a follow-up
  task, not in-scope work.
- verifyCmd — a single shell command that the implementor must run to
  prove the slice landed (e.g. "pnpm test src/foo.test.ts" or
  "pnpm typecheck"). Empty string if the project's default verify is
  sufficient.
- taskType — "auto" for slices the implementor can drive end-to-end and
  commit, or "checkpoint" for slices that need human verification before
  merge. Default "auto"; reach for "checkpoint" only when a human must
  visually confirm an output the verifier cannot.

Return ONLY a single JSON object matching exactly this shape, with no
surrounding prose, no code fences, and no commentary:

{"slices":[{"title":"...","type":"AFK","whatToBuild":"...","acceptanceCriteria":["...","..."],"blockedBy":[],"files":["src/foo.ts"],"verifyCmd":"pnpm test src/foo.test.ts","taskType":"auto"}]}

PRD to decompose
================

Title: ${idea.title}

Problem
-------
${idea.problem || '(not specified)'}

Solution
--------
${idea.solution || '(not specified)'}

User stories
------------
${renderUserStories(idea.userStories)}

Out of scope
------------
${idea.outOfScope || '(not specified)'}

Notes
-----
${idea.notes || '(not specified)'}
`

const parseSlicerOutput = (
  claudeStdout: string,
): z.infer<typeof slicerOutputSchema> =>
  slicerOutputSchema.parse(parseClaudeJsonResult(claudeStdout))

const composeTaskPrompt = (
  ideaTitle: string,
  ideaId: string,
  slice: SliceSpec,
  index: number,
  total: number,
): string => {
  const acceptance = slice.acceptanceCriteria
    .map((c) => `- [ ] ${c}`)
    .join('\n')
  return `${TDD_WORKER_BRIEF}

---

# ${slice.title}

Slice ${index} of ${total} for PRD ${ideaId}: ${ideaTitle}
Type: ${slice.type}

## What to build

${slice.whatToBuild}

## Acceptance criteria

${acceptance}

## Context

This is a tracer-bullet vertical slice — implement the thinnest path through
every layer needed to satisfy the acceptance criteria, then stop. Other
slices in the same PRD will thicken this work; do not pre-build for them.

Read the parent PRD with \`mars idea show ${ideaId}\` to see the full intent
and the other slices' scope. Match the project's existing testing and
naming conventions.

Save your work: stage and commit when verify passes.
`
}

const generateStep = createStep({
  id: 'generate-slices',
  inputSchema: sliceInputSchema,
  outputSchema: sliceOutputSchema,
  execute: async ({ inputData, tracingContext }) => {
    const idea = await getProposal(inputData.ideaId)
    if (!idea) throw new Error(`idea ${inputData.ideaId} not found`)
    if (idea.status !== 'prd-ready') {
      throw new Error(
        `idea ${idea.id} is '${idea.status}'; only prd-ready ideas can be sliced`,
      )
    }

    tracingContext?.currentSpan?.update({
      metadata: { ideaId: idea.id, originId: idea.id },
    })

    const r = await Workers.Slicer.run(buildSlicerPrompt(idea), {
      cwd: getRepoRoot(),
    })
    if (r.exitCode !== 0) {
      throw new Error(
        `claude -p exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
      )
    }

    const parsed = parseSlicerOutput(r.stdout)
    const total = parsed.slices.length

    // Validate dependency indices before any DB writes.
    for (let i = 0; i < total; i += 1) {
      for (const dep of parsed.slices[i].blockedBy) {
        if (dep < 1 || dep > total) {
          throw new Error(
            `slice ${i + 1} declares blockedBy=${dep} which is out of range 1..${total}`,
          )
        }
        if (dep === i + 1) {
          throw new Error(`slice ${i + 1} cannot depend on itself`)
        }
      }
    }

    await initQueue()
    const queueClient = getQueueClient()
    const ideasClient = getProposalsClient()
    const taskIds: string[] = []

    // The writes span two DBs (queue.db for tasks/blockers, state.db for
    // the idea row), so we cannot wrap them in a single transaction. We
    // do best-effort with cleanup on error: if anything fails after task
    // inserts begin, delete the inserted slice tasks before re-throwing.
    try {
      // Phase 1: insert each slice as a 'draft' task carrying parent_idea_id
      // and slice_index. We transition status in Phase 3.
      for (let i = 0; i < total; i += 1) {
        const slice = parsed.slices[i]
        const prompt = composeTaskPrompt(idea.title, idea.id, slice, i + 1, total)
        const verifyCmd =
          slice.verifyCmd !== null && slice.verifyCmd.trim().length > 0
            ? slice.verifyCmd
            : null
        const task = await enqueueTask(prompt, undefined, {
          author: idea.author ?? undefined,
          originId: idea.id,
          parentProposalId: idea.id,
          sliceIndex: i + 1,
          spec: {
            files: slice.files,
            verifyCmd,
            doneCriteria: slice.acceptanceCriteria,
            taskType: slice.taskType,
          },
        })
        taskIds.push(task.id)
      }
      // Phase 2: wire blockers using the resolved task ids.
      const now = new Date().toISOString()
      for (let i = 0; i < total; i += 1) {
        const deps = parsed.slices[i].blockedBy
        for (const dep of deps) {
          await queueClient.execute({
            sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
                  VALUES (?, ?, ?)`,
            args: [taskIds[i], taskIds[dep - 1], now],
          })
        }
      }
      // Phase 3: transition each slice to 'queued' (no blockers) or
      // 'blocked' (has blockers). The daemon will pick up queued ones.
      for (let i = 0; i < total; i += 1) {
        const status = parsed.slices[i].blockedBy.length === 0 ? 'queued' : 'blocked'
        await queueClient.execute({
          sql: `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
          args: [status, now, taskIds[i]],
        })
      }
      // Phase 4: flip the idea row to 'sliced' so subsequent invocations
      // refuse to re-slice (the precondition above checks 'prd-ready').
      await ideasClient.execute({
        sql: `UPDATE proposals SET status = 'sliced', updated_at = ? WHERE id = ?`,
        args: [Date.now(), idea.id],
      })
      // Phase 5 (ADR-0015 promote transfer): any task that was blocked by
      // THIS idea via task_proposal_blockers must now be re-pointed at the
      // resulting work, atomically, so no dispatcher tick observes the
      // dependent with zero blockers between the delete and the insert.
      // transferProposalBlockerToTask does both writes (delete the
      // task_proposal_blockers row, insert the task_blockers row) in ONE
      // queue.db `batch(..., 'write')` transaction — both tables are in
      // queue.db, so this is genuinely atomic, not merely ordered.
      //
      // TODO(ADR-0015 fan-out): the ADR pins only the single
      // new_blocker_task_id case. A slice produces N tasks; ADR-0015 is
      // SILENT on whether the dependent should then wait on all N. Per the
      // task brief we implement the single-new-blocker case verbatim and
      // re-point dependents at the FIRST slice task (taskIds[0]) rather than
      // inventing fan-out semantics. taskIds[0] is the natural single
      // anchor: with the slicer's intra-slice blockers, completing the
      // whole arc still gates on it transitively in the common chained
      // shape. True N-fan-out is deferred and called out in the report.
      if (taskIds.length > 0) {
        const { transferProposalBlockerToTask } = await import('../queue')
        await transferProposalBlockerToTask(idea.id, taskIds[0])
      }
    } catch (error: unknown) {
      for (const id of taskIds) {
        await queueClient
          .execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [id] })
          .catch(() => {})
        await queueClient
          .execute({
            sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
            args: [id, id],
          })
          .catch(() => {})
      }
      throw error
    }

    return { ideaId: idea.id, status: 'sliced', taskIds }
  },
})

export const sliceWorkflow = createWorkflow({
  id: 'slice',
  inputSchema: sliceInputSchema,
  outputSchema: sliceOutputSchema,
})
  .then(generateStep)
  .commit()

export interface RunSliceResult {
  ideaId: string
  status: string
  taskIds: string[]
}

/** Bound on the synthesized failure message so it stays log-friendly even
 * when a step error carries a giant stack or serialized payload. */
const MAX_SLICE_FAILURE_CHARS = 1000

/**
 * Normalize an unknown error-ish value into a single human-readable line.
 * Mastra's `result.error` / step `error` is an `Error` in-process but a
 * serialized `{ name, message, stack }` object when the run is rehydrated
 * from storage, and older/other versions surface a bare string — handle
 * all three rather than assuming one shape.
 */
const stringifyErrorLike = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (value instanceof Error) {
    return value.message?.trim() || value.name || String(value)
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.message === 'string' && obj.message.trim().length > 0) {
      return typeof obj.name === 'string' && obj.name.length > 0
        ? `${obj.name}: ${obj.message.trim()}`
        : obj.message.trim()
    }
    try {
      const json = JSON.stringify(value)
      if (json && json !== '{}') return json
    } catch {
      // circular / non-serializable — fall through to String()
    }
  }
  return String(value)
}

/**
 * Build a diagnostic message from a non-success slice workflow result.
 * Surfaces Mastra's top-level `result.error` and the first failing step's
 * error so a live slicer outage is diagnosable from the daemon log / CLI
 * instead of the content-free status word. Exported for unit testing.
 */
export const describeSliceFailure = (result: unknown): string => {
  const r = (result ?? {}) as {
    status?: unknown
    error?: unknown
    steps?: unknown
  }
  const status = typeof r.status === 'string' ? r.status : 'failed'
  const parts: string[] = [`slice workflow ${status}`]

  const topError = stringifyErrorLike(r.error)
  if (topError) parts.push(`error: ${topError}`)

  if (r.steps && typeof r.steps === 'object') {
    for (const [stepId, stepResult] of Object.entries(
      r.steps as Record<string, unknown>,
    )) {
      if (
        stepResult &&
        typeof stepResult === 'object' &&
        (stepResult as { status?: unknown }).status === 'failed'
      ) {
        const stepError = stringifyErrorLike(
          (stepResult as { error?: unknown }).error,
        )
        parts.push(`step "${stepId}" failed${stepError ? `: ${stepError}` : ''}`)
        break
      }
    }
  }

  const message = parts.join(' — ')
  return message.length > MAX_SLICE_FAILURE_CHARS
    ? `${message.slice(0, MAX_SLICE_FAILURE_CHARS)}…`
    : message
}

export const runSlice = async (ideaId: string): Promise<RunSliceResult> => {
  const run = await sliceWorkflow.createRun()
  const result = await run.start({ inputData: { ideaId } })
  if (result.status !== 'success') {
    throw new Error(describeSliceFailure(result))
  }
  return result.result
}
