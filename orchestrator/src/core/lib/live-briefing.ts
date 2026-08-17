import { Arc } from '../arc'
import { getTask } from '../queue'

/** Thrown when composeLiveBriefing is called for a task that is not parked. */
export class LiveBriefingError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly actualStatus: string,
  ) {
    super(`Task ${taskId} is not awaiting-human (status=${actualStatus})`)
    this.name = 'LiveBriefingError'
  }
}

/** Maximum number of progress-journal notes to include (newest-last). */
const RECENT_NOTES_LIMIT = 20

/**
 * Assemble the operator-facing briefing for a parked task as a plain string.
 *
 * Sections (in order):
 *   ## Task           — task id + prompt
 *   ## Done criteria  — [x]/[ ] markers reflecting current check state
 *   ## Step guide     — body of the currently-parked manual step's guide
 *   ## Progress journal — last N notes, oldest-first (newest-last)
 *
 * @throws {LiveBriefingError} when the task is not in status='awaiting-human'
 */
export async function composeLiveBriefing(taskId: string): Promise<string> {
  const task = await getTask(taskId)
  if (task === null) {
    throw new LiveBriefingError(taskId, 'not-found')
  }
  if (task.status !== 'awaiting-human') {
    throw new LiveBriefingError(taskId, task.status)
  }

  // Fetch criteria state and progress entries in parallel.
  const [acceptances, progressEntries] = await Promise.all([
    Arc.listAcceptance(task.id),
    Arc.listProgress(task.id),
  ])

  // ## Task
  const taskSection = `## Task\n\n${task.id}\n\n${task.prompt}`

  // ## Done criteria — use the 4-state acceptance table when seeded, else fold from journal.
  let criteriaLines: string[]
  if (acceptances.length > 0) {
    criteriaLines = acceptances.map(a => `- [${a.status === 'met' ? 'x' : ' '}] ${a.text}`)
  } else {
    const checklist = Arc.deriveChecklist(progressEntries, task.spec?.doneCriteria ?? [])
    criteriaLines = checklist.map(({ criterion, checked }) => `- [${checked ? 'x' : ' '}] ${criterion}`)
  }
  const criteriaSection = `## Done criteria\n\n${criteriaLines.join('\n')}`

  // ## Step guide
  const stepGuideSection = `## Step guide\n\n${task.currentStepGuide ?? '(none)'}`

  // ## Progress journal — notes only, last N entries, oldest-first = newest-last.
  const notes = progressEntries.filter(e => e.kind === 'note').slice(-RECENT_NOTES_LIMIT)
  const journalSection =
    `## Progress journal\n\n` +
    (notes.length > 0 ? notes.map(n => `- ${n.body}`).join('\n') : '(none)')

  return [taskSection, criteriaSection, stepGuideSection, journalSection].join('\n\n')
}
