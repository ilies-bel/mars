/**
 * The `finalizeReport` primitive shell — read-only task completion (no merge,
 * no verify). Split out of `workflows/primitives/index.ts` (TARGET §2.1); the
 * terminal status write goes through `ctx.services.store` (ADR-0052).
 */
import { resolveVcs } from '../../core/ports/vcs/registry'
import { type WorktreeResult as WorktreeRef } from '../../core/ports/vcs/types'
import { updateTask } from '../../core/queue'
import { Arc } from '../../core/arc'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import {
  type MarsCtx,
  resolveTrace,
  resolveWorktree,
  resolveTaskId,
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
  /**
   * The agent's final report text. When non-empty, persisted as a task
   * progress note (kind='note', author='orchestrator') via
   * {@link Arc.appendProgress} so the findings are reachable through a
   * normal Mars read (`mars task show <id>` / `Arc.listProgress`) and not
   * only inside the compressed transcript blob.
   *
   * Leave `undefined` (or omit) for a legitimately empty audit ("I checked
   * everything, all clear") — that is a valid outcome and must stay
   * expressible without forcing a note. The pipeline provides the mechanism;
   * the workflow decides whether to use it.
   *
   * **Why a task note?** `task_progress` rows (kind='note') are the same
   * store surface that `mars task note <id> "..."` writes to. They are
   * displayed by `mars task show`, indexed by `Arc.listProgress`, and never
   * compressed or removed with the worktree. The worktree is reclaimed by
   * this step; only content persisted to the DB survives beyond it.
   */
  reportText?: string
}

/**
 * Finalise a read-only / report task without merging.
 *
 * This primitive:
 *   1. Removes the task's worktree directory and deletes the `task/<id>` branch.
 *   2. If `opts.reportText` is non-empty, persists it as a task progress note
 *      (kind='note') via {@link Arc.appendProgress} so it is reachable through
 *      a normal Mars read and not only inside the compressed transcript blob.
 *   3. Transitions the task row to `status='done'`, `failedPhase=null`.
 *   4. Returns `{ taskId, success: true, message }`.
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
  // Populate the per-ctx trace cache for any downstream step; the trace
  // context itself is no longer threaded into removeWorktree (the Vcs port
  // narrows out non-serializable options — see core/ports/vcs/types.ts).
  await resolveTrace(ctx, taskId)

  await resolveVcs().removeWorktree({
    path: worktree.path,
    branch: worktree.branch,
    force: true,
    keepBranch: false,
  })

  // Persist the agent's report text as a task progress note before marking
  // done, so it survives worktree removal and is reachable via `mars task
  // show` / Arc.listProgress. Omitted for legitimately empty audits.
  const reportText = opts.reportText?.trim()
  if (reportText) {
    await Arc.appendProgress(
      { taskId, author: 'orchestrator', kind: 'note', body: reportText },
      store,
    )
  }

  await updateTask(taskId, { status: 'done', failedPhase: null }, store)

  return { taskId, success: true, message: 'report complete' }
}
