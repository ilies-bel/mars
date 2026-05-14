import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { getIdea, getIdeasClient } from '../ideas'
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

const buildSlicerPrompt = (idea: {
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

Return ONLY a single JSON object matching exactly this shape, with no
surrounding prose, no code fences, and no commentary:

{"slices":[{"title":"...","type":"AFK","whatToBuild":"...","acceptanceCriteria":["...","..."],"blockedBy":[]}]}

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
    const idea = await getIdea(inputData.ideaId)
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
      timeoutMs: 5 * 60 * 1000,
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
    const ideasClient = getIdeasClient()
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
        const task = await enqueueTask(prompt, undefined, {
          author: idea.author ?? undefined,
          originId: idea.id,
          parentIdeaId: idea.id,
          sliceIndex: i + 1,
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
        sql: `UPDATE ideas SET status = 'sliced', updated_at = ? WHERE id = ?`,
        args: [Date.now(), idea.id],
      })
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

export const runSlice = async (ideaId: string): Promise<RunSliceResult> => {
  const run = await sliceWorkflow.createRun()
  const result = await run.start({ inputData: { ideaId } })
  if (result.status !== 'success') {
    throw new Error(`slice workflow ${result.status}`)
  }
  return result.result
}
