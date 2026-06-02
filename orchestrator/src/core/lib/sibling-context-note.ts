import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getDefaultDomainTaskStore } from '../store/task-store'

/**
 * Short-circuit recovery when sibling CONTEXT note already exists.
 *
 * When the no-action-after-reads watchdog aborts a task and the recovery
 * path is about to queue a context-gathering child, callers consult
 * {@link tryShortCircuitOnSiblingContextNote} first. The check is
 * filesystem-only — no LLM call — so repeated abort cycles for the same
 * parent stop spawning third-order chains of identical context-gathering
 * tasks.
 *
 * See PRD 5e69e526-watchdog-fix-when-no-action-after-reads.
 */

/**
 * Filename convention for a per-parent sibling CONTEXT note. A parent task
 * id like `mars-abc12345` corresponds to `CONTEXT-mars-abc12345.md` at the
 * worktree root. Matches the names actually observed on disk (e.g.
 * `CONTEXT-mars-17a82963.md`).
 */
export const siblingContextNoteName = (taskId: string): string =>
  `CONTEXT-${taskId}.md`

/**
 * Presence-only check for the sibling CONTEXT note in the parent's worktree.
 * Returns the absolute path of the note when it exists, else `null`. No LLM
 * call; pure filesystem inspection. Contents are not validated — the slice
 * deliberately treats any file with the expected name as authoritative.
 */
export const findSiblingContextNote = (
  worktreePath: string,
  taskId: string,
): string | null => {
  const candidate = resolve(worktreePath, siblingContextNoteName(taskId))
  return existsSync(candidate) ? candidate : null
}

export interface ShortCircuitResult {
  /** Whether the short-circuit fired (a sibling note was present). */
  shortCircuited: boolean
  /** Absolute path of the note that triggered the short-circuit, if any. */
  notePath: string | null
}

/**
 * If the parent task's worktree already carries a sibling CONTEXT note
 * named after its task id, short-circuit the recovery path:
 *
 *   - the parent is marked `done` (the terminal status that represents
 *     "context already gathered" — no further recovery work is needed);
 *   - the existing note path is recorded as the task's artifact in
 *     `error` (the closest existing field for an out-of-band reference);
 *   - exactly one log line is emitted announcing the short-circuit;
 *   - no new context-gathering child task is queued.
 *
 * Returns `{ shortCircuited: false, notePath: null }` when the note is
 * absent so the caller proceeds with its normal recovery (queueing a
 * context-gathering child as before). Idempotent: re-marking a `done`
 * parent is a no-op transition.
 */
export const tryShortCircuitOnSiblingContextNote = async (
  parentTaskId: string,
): Promise<ShortCircuitResult> => {
  const store = getDefaultDomainTaskStore()
  const parent = await store.getTask(parentTaskId)
  if (!parent || !parent.worktreePath) {
    return { shortCircuited: false, notePath: null }
  }
  const notePath = findSiblingContextNote(parent.worktreePath, parentTaskId)
  if (notePath === null) {
    return { shortCircuited: false, notePath: null }
  }
  await store.updateTask(parentTaskId, {
    status: 'done',
    // Record the existing note as the artifact. The `error` column is the
    // only free-form metadata slot on a Task today; the prefix makes it
    // greppable and unambiguous.
    error: `context-already-gathered: ${notePath}`,
  })
  console.log(
    `[short-circuit] task ${parentTaskId}: sibling CONTEXT note already present at ${notePath} — skipping context-gathering child.`,
  )
  return { shortCircuited: true, notePath }
}
