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
   * **Three distinct shapes:**
   * - `undefined` (omitted) — legitimately empty audit ("I checked everything,
   *   all clear"). No note is written; the task reaches `done` normally. Use
   *   only when the workflow deliberately skips text capture.
   * - `null` or empty string — agent ran but produced no output. Treated as a
   *   failure: the task cannot reach `done` with no findings and no explicit
   *   empty-audit decision. This prevents silent data loss.
   * - Non-empty string — the agent's findings. Persisted as a task progress
   *   note before the task is marked done.
   *
   * The scaffolded `report-workflow.js` passes `{ reportText }` from
   * `runAgent`'s return value. Never omit it when the agent ran — an omitted
   * `reportText` after a real agent run silently discards the findings.
   *
   * **Why a task note?** `task_progress` rows (kind='note') are the same
   * store surface that `mars task note <id> "..."` writes to. They are
   * displayed by `mars task show`, indexed by `Arc.listProgress`, and never
   * compressed or removed with the worktree. The worktree is reclaimed by
   * this step; only content persisted to the DB survives beyond it.
   *
   * **Retrieving the report:** `mars task show <id>` prints the last 10
   * journal entries, including any note written here.
   */
  reportText?: string | null
}

/**
 * Finalise a read-only / report task without merging.
 *
 * This primitive:
 *   1. Removes the task's worktree directory and deletes the `task/<id>` branch.
 *   2. Validates `opts.reportText`:
 *      - `undefined` → legitimately empty audit, skip the note.
 *      - `null` or empty string → agent ran but produced no text; throws rather
 *        than silently reaching `done` with nothing persisted.
 *      - non-empty string → persisted as a task progress note (kind='note',
 *        author='orchestrator') via {@link Arc.appendProgress}, reachable via
 *        `mars task show <id>`.
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
  // show` / Arc.listProgress.
  //
  // opts.reportText === undefined  → legitimately empty audit; skip the note.
  // opts.reportText === null or '' → agent ran but produced no text; this is
  //   a failure (a lost report is worse than a failed report), so throw rather
  //   than silently reaching `done` with nothing persisted.
  if (opts.reportText !== undefined) {
    const reportText = opts.reportText?.trim() ?? ''
    if (!reportText) {
      throw new Error(
        `finalizeReport: reportText was provided but is empty after trimming — ` +
        `the report agent ran but produced no text output. ` +
        `A report task that captures nothing is a failed report task. ` +
        `Check the task transcript: mars task show ${taskId}`,
      )
    }
    await Arc.appendProgress(
      { taskId, author: 'orchestrator', kind: 'note', body: reportText },
      store,
    )
  }

  // The branch was just deleted and a report task never merges. Detach it from
  // the row first: the done-implies-merged guard in updateTask reads the row's
  // branch, sees a missing ref, and would redirect this to 'failed' as
  // 'done-with-unverifiable-merge'. A NULL branch means "nothing to verify".
  await updateTask(taskId, { branch: null, worktreePath: null }, store)
  await updateTask(taskId, { status: 'done', failedPhase: null }, store)

  return { taskId, success: true, message: 'report complete' }
}
