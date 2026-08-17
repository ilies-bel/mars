/**
 * The `finalizeReport` primitive shell — read-only task completion (no merge,
 * no verify). Split out of `workflows/primitives/index.ts` (TARGET §2.1); the
 * terminal status write goes through `ctx.services.store` (ADR-0052).
 */
import { removeWorktree, type WorktreeRef } from '../../core/lib/git/worktree'
import { updateTask } from '../../core/queue'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import {
  type MarsCtx,
  resolveTrace,
  resolveWorktree,
  resolveTaskId,
  buildPhaseCtx,
} from '../context'
import { validationRecorder } from '../validate-recorder'

// ---------------------------------------------------------------------------
// finalizeReport — read-only task completion (no merge, no verify)
// ---------------------------------------------------------------------------

/**
 * Options for {@link finalizeReport}. All fields are optional; the primitive
 * resolves defaults from `ctx.input` exactly like the other four primitives.
 */
export interface FinalizeReportOpts {
  /** Override the task id (defaults to `ctx.input.taskId ?? ctx.runId`). */
  taskId?: string
  /** Override the resolved worktree ref (useful in tests). */
  worktree?: WorktreeRef
}

/**
 * Finalise a read-only / report task without merging.
 *
 * This primitive:
 *   1. Removes the task's worktree directory and deletes the `task/<id>` branch.
 *   2. Transitions the task row to `status='done'`, `failedPhase=null`.
 *   3. Returns `{ taskId, success: true, message }`.
 *
 * It NEVER touches the integration branch, NEVER runs verify, and NEVER
 * invokes vcs-supervisor. Use it as the last step of a report-style workflow.
 */
export const finalizeReport = async (
  ctx: MarsCtx,
  opts: FinalizeReportOpts = {},
): Promise<{ taskId: string; success: true; message: string }> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'finalizeReport',
      mode: 'auto',
      guide: null,
    })
    return { taskId: resolveTaskId(ctx, opts.taskId), success: true, message: '(validation dry-run)' }
  }
  const taskId = resolveTaskId(ctx, opts.taskId)
  const store: TaskStore = ctx.services.store
  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)

  await removeWorktree(
    { path: worktree.path, branch: worktree.branch },
    true,
    false,
    buildPhaseCtx(trace, taskId, 'merge'),
  )
  await updateTask(taskId, { status: 'done', failedPhase: null }, store)

  return { taskId, success: true, message: 'report complete' }
}
