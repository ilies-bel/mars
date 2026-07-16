/**
 * Release-notes feed — arc-grouped landed tasks.
 *
 * Provides a pure function {@link buildReleaseNotes} that can be unit-tested
 * without a DB, mirroring the placement pattern of events.ts. The daemon owns
 * the actual query (via its own view/release-notes module) and the UI server
 * proxies to the daemon's /view/release-notes endpoint.
 */

/**
 * Hard cap on entries returned by the release-notes feed. Keeps responses
 * bounded for situational-awareness UIs that don't paginate yet.
 */
export const RELEASE_NOTES_LIMIT = 200

const TITLE_MAX = 120

/**
 * Structured-task spec fields included in the release-note detail. A subset
 * of the full TaskSpec — only the fields relevant to a release summary.
 */
export interface ReleaseNoteSpec {
  files: readonly string[]
  verifyCmd: string | null
  doneCriteria: readonly string[]
}

/**
 * Per-arc release-note entry. One entry per arc that has fully landed
 * (at least the origin task is done). Recovery tasks are folded in and
 * counted via {@link detail.recoveryCount}.
 */
export interface ReleaseNoteEntry {
  originId: string
  /** One-line title: `intent` when present, else first sentence of `prompt`. */
  title: string
  /** ISO-8601 — the LATEST `updated_at` among done tasks in the arc. */
  landedAt: string
  detail: {
    prompt: string
    spec: ReleaseNoteSpec | null
    /** Number of recovery (fix/diagnose) tasks folded into this arc entry. */
    recoveryCount: number
  }
}

/**
 * Minimal task shape required by {@link buildReleaseNotes}. Satisfied by the
 * daemon's queue.ts Task and by hand-authored test fixtures.
 */
export interface TaskForReleaseNotes {
  id: string
  /** One-line intent. Empty string on legacy rows; null when the column is absent. */
  intent: string | null
  prompt: string
  status: string
  updatedAt: string
  /** Arc identity. Tasks with no origin_id are their own single-task arc. */
  originId: string | null
  /** Set on recovery/fix tasks; null on origin tasks. */
  fixForTaskId: string | null
  /** 'fix' or 'diagnose' for recovery tasks; 'task' or undefined for origin tasks. */
  kind?: string
  spec: ReleaseNoteSpec | null
}

const isRecovery = (task: TaskForReleaseNotes): boolean =>
  task.fixForTaskId !== null || task.kind === 'fix' || task.kind === 'diagnose'

const extractFirstSentence = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const match = collapsed.match(/^(.+?[.!?])(?:\s|$)/)
  return match ? match[1]! : collapsed
}

const buildTitle = (intent: string | null, prompt: string): string => {
  const raw = intent && intent.length > 0 ? intent : extractFirstSentence(prompt)
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (clean.length <= TITLE_MAX) return clean
  return `${clean.slice(0, TITLE_MAX - 1)}…`
}

/**
 * Build the reverse-chronological arc-grouped release-notes feed.
 *
 * Pure function — no I/O. Only done tasks contribute. Recovery tasks
 * (fixForTaskId set or kind 'fix'/'diagnose') are folded into their origin arc
 * rather than emitting their own entries. The arc's `landedAt` is the latest
 * `updatedAt` among all done tasks in the arc.
 *
 * Arcs without a landed (done, non-recovery) origin task are excluded. A bare
 * recovery with no landed origin does not represent shipped work.
 */
export const buildReleaseNotes = (
  tasks: TaskForReleaseNotes[],
): ReleaseNoteEntry[] => {
  // Only done tasks land in the feed.
  const done = tasks.filter((t) => t.status === 'done')

  // Group done tasks by arc key (originId if set, else own id).
  const arcMap = new Map<string, TaskForReleaseNotes[]>()
  for (const task of done) {
    const key = task.originId ?? task.id
    const group = arcMap.get(key)
    if (group) {
      group.push(task)
    } else {
      arcMap.set(key, [task])
    }
  }

  const entries: ReleaseNoteEntry[] = []
  for (const [arcKey, group] of arcMap) {
    // Origin task: the task whose id === arcKey and is not a recovery task.
    // If no landed origin exists in the done-set, the arc is excluded — a
    // recovery task with no landed origin is not a release note.
    const originTask = group.find((t) => t.id === arcKey && !isRecovery(t))
    if (!originTask) continue

    // landedAt = latest updated_at among all done tasks in the arc.
    let landedAt = originTask.updatedAt
    for (const t of group) {
      if (t.updatedAt > landedAt) landedAt = t.updatedAt
    }

    const recoveryCount = group.filter(isRecovery).length

    entries.push({
      originId: arcKey,
      title: buildTitle(originTask.intent, originTask.prompt),
      landedAt,
      detail: {
        prompt: originTask.prompt,
        spec: originTask.spec,
        recoveryCount,
      },
    })
  }

  entries.sort((a, b) => {
    if (a.landedAt < b.landedAt) return 1
    if (a.landedAt > b.landedAt) return -1
    return 0
  })

  return entries.slice(0, RELEASE_NOTES_LIMIT)
}
