/**
 * The `finalizeMockup` primitive shell — read-only mockup task completion.
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1); the terminal
 * status write goes through `ctx.services.store` (ADR-0052).
 */
import { resolveVcs } from '../../core/ports/vcs/registry'
import { type WorktreeResult as WorktreeRef } from '../../core/ports/vcs/types'
import { getStateDir } from '../../core/context'
import { updateTask } from '../../core/queue'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  type MarsCtx,
  resolveTrace,
  resolveWorktree,
  resolveTaskId,
} from '../context'
import { validationRecorder } from '../validate-recorder'

// ---------------------------------------------------------------------------
// finalizeMockup — read-only mockup task completion
// ---------------------------------------------------------------------------

/**
 * Options for {@link finalizeMockup}. All fields are optional; the primitive
 * resolves defaults from `ctx.input` exactly like the other primitives.
 */
export interface FinalizeMockupOpts {
  /** Override the task id (defaults to `ctx.input.taskId ?? ctx.runId`). */
  taskId?: string
  /** Override the resolved worktree ref (useful in tests). */
  worktree?: WorktreeRef
  /**
   * Override the proposal id to associate the mockup with. When absent, the
   * primitive looks up `parent_proposal_id` on the task row.
   */
  proposalId?: string
}

/**
 * Finalise a mockup task without merging.
 *
 * This primitive:
 *   1. Reads `mockup.html` from the worktree root (written by the agent).
 *   2. Copies it to `<stateDir>/mockups/<proposalId>.html` (mkdir -p).
 *   3. Raises a `mockup-ready` notice in the action queue.
 *   4. Removes the worktree directory and deletes the `task/<id>` branch.
 *   5. Transitions the task row to `status='done'`, `failedPhase=null`.
 *
 * If the mockup file is missing or the proposal id cannot be resolved,
 * the worktree/task cleanup still runs — only the copy step is skipped with
 * a warning. Use it as the last step of the `mockup` workflow.
 */
export const finalizeMockup = async (
  ctx: MarsCtx,
  opts: FinalizeMockupOpts = {},
): Promise<{ taskId: string; proposalId: string | null; success: true; message: string }> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'finalizeMockup',
      mode: 'auto',
      guide: null,
    })
    return {
      taskId: resolveTaskId(ctx, opts.taskId),
      proposalId: opts.proposalId ?? null,
      success: true,
      message: '(validation dry-run)',
    }
  }
  const taskId = resolveTaskId(ctx, opts.taskId)
  const store: TaskStore = ctx.services.store
  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  // Populate the per-ctx trace cache for any downstream step; the trace
  // context itself is no longer threaded into removeWorktree (the Vcs port
  // narrows out non-serializable options — see core/ports/vcs/types.ts).
  await resolveTrace(ctx, taskId)

  // Resolve the proposalId from opts or from the task's parent_proposal_id column.
  let proposalId: string | null = opts.proposalId ?? null
  if (!proposalId) {
    try {
      const result = await store.query({
        sql: 'SELECT parent_proposal_id FROM tasks WHERE id = ?',
        args: [taskId],
      })
      proposalId = (result.rows[0]?.parent_proposal_id as string | null) ?? null
    } catch (err) {
      console.warn(`[finalize-mockup] task ${taskId}: could not resolve parent_proposal_id: ${(err as Error).message}`)
    }
  }

  // Copy the generated mockup HTML to the state directory.
  if (proposalId) {
    const stateDir = getStateDir()
    const mockupsDir = join(stateDir, 'mockups')
    const srcPath = join(worktree.path, 'mockup.html')
    try {
      const html = await readFile(srcPath, 'utf8')
      mkdirSync(mockupsDir, { recursive: true })
      writeFileSync(join(mockupsDir, `${proposalId}.html`), html, 'utf8')
    } catch (err) {
      console.warn(`[finalize-mockup] task ${taskId}: could not copy mockup HTML: ${(err as Error).message}`)
    }

    // Raise a notice so the operator sees the mockup is ready.
    raiseActionQueueItem({
      kind: 'mockup-ready',
      category: 'daemon',
      priority: 'normal',
      title: `Mockup ready for proposal ${proposalId}`,
      body: `A visual HTML mockup for proposal ${proposalId} has been generated. View it in the UI at /mockups/${proposalId}.html`,
      payload: { proposalId, taskId },
      context: { taskId },
      raisedBy: 'primitive:finalize-mockup',
      signature: `mockup-ready:${proposalId}`,
      originTaskId: taskId,
    }).catch((err) => {
      console.error(
        `[finalize-mockup] task ${taskId} action-queue raise errored:`,
        err,
      )
    })
  }

  await resolveVcs().removeWorktree({
    path: worktree.path,
    branch: worktree.branch,
    force: true,
    keepBranch: false,
  })
  await updateTask(taskId, { status: 'done', failedPhase: null }, store)

  return { taskId, proposalId, success: true, message: 'mockup complete' }
}
