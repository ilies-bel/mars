/**
 * Live-task view: structured data for the UI's LiveTaskPanel.
 *
 * Backs GET /view/task/:id/live. Returns the three operator-facing sections
 * the terminal briefing shows — step guide, done-criteria checklist, and the
 * progress journal — as structured JSON so the browser can render each section
 * independently (markdown, checkboxes, timestamped notes).
 *
 * The task must be in status='awaiting-human'; any other status (including
 * not-found) returns null so the HTTP layer can emit a clean 404.
 */

import { Arc } from '../../arc.js'
import { getTask } from '../../queue.js'

/** One done-criterion with its current checked state. */
export interface LiveTaskCriterion {
  text: string
  checked: boolean
}

/** One progress-journal note entry. */
export interface LiveTaskNote {
  /** Epoch-milliseconds creation timestamp. */
  ts: number
  text: string
}

/** Shape returned by GET /view/task/:id/live. */
export interface LiveTaskView {
  /** Body of the currently-parked manual step's guide. Null when absent. */
  stepGuide: string | null
  /** Ordered list of done criteria with their current checked state. */
  doneCriteria: LiveTaskCriterion[]
  /** Progress-journal notes, oldest-first (newest-last), capped at 20. */
  notes: LiveTaskNote[]
  /**
   * Machine name of the step the task is currently parked at.
   * `'merge-gate'` means the task is waiting for operator approval before
   * merging. Null when the step name is not recorded.
   */
  stepName: string | null
  /**
   * Absolute path to the task's git worktree on the host. Null when not set.
   * Used by the UI to render the "Enter session" / "Open in terminal" action.
   */
  worktreePath: string | null
}

/** Maximum number of progress-journal notes to include. */
const RECENT_NOTES_LIMIT = 20

/**
 * Build the live-task panel payload for the given task.
 *
 * Returns null when the task is not found or is not in status='awaiting-human'.
 */
export async function buildLiveTaskView(taskId: string): Promise<LiveTaskView | null> {
  const task = await getTask(taskId)
  if (!task || task.status !== 'awaiting-human') {
    return null
  }

  // Fetch acceptance verdicts and progress entries in parallel.
  const [acceptances, progressEntries] = await Promise.all([
    Arc.listAcceptance(task.id),
    Arc.listProgress(task.id),
  ])

  // Done criteria — prefer the 4-state acceptance table when seeded,
  // else fold from the progress journal (same logic as composeLiveBriefing).
  let doneCriteria: LiveTaskCriterion[]
  if (acceptances.length > 0) {
    doneCriteria = acceptances.map((a) => ({
      text: a.text,
      checked: a.status === 'met',
    }))
  } else {
    const checklist = Arc.deriveChecklist(progressEntries, task.spec?.doneCriteria ?? [])
    doneCriteria = checklist.map(({ criterion, checked }) => ({
      text: criterion,
      checked,
    }))
  }

  // Notes — 'note' kind only, last N entries, oldest-first (newest-last).
  const notes = progressEntries
    .filter((e) => e.kind === 'note')
    .slice(-RECENT_NOTES_LIMIT)
    .map((n) => ({ ts: n.createdAt, text: n.body }))

  return {
    stepGuide: task.currentStepGuide ?? null,
    doneCriteria,
    notes,
    stepName: task.currentStepName ?? null,
    worktreePath: task.worktreePath ?? null,
  }
}
