/**
 * Release-notes feed — arc-grouped landed tasks, plus the hero-delta feed.
 *
 * Provides two pure functions testable without a DB:
 *   - {@link buildReleaseNotes}  — arc-grouped landed-task feed
 *   - {@link buildHeroDelta}     — recipe auto-run hero feed lines
 *
 * The daemon owns the actual queries (via its own view/release-notes module)
 * and the UI server proxies to the daemon's endpoints.
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

// ── Hero-delta: grouped activity since the last visit ─────────────────────────

/**
 * One recipe auto-run event, as emitted by the orchestrator and stored in the
 * events table under kind='recipe-autorun'.
 */
export interface RecipeAutorunEvent {
  recipeId: string
  failureKind: string
  targetTaskId: string
  at: string
}

/** One hero-delta feed line for a recipe auto-run. */
export interface HeroDeltaEntry {
  kind: 'recipe-autorun'
  text: string
}

/** A task that fully landed (status done) since the last visit. */
export interface MergeEntry {
  kind: 'merge'
  taskId: string
  title: string
  at: string
}

/** A recovery (fix/diagnose) task that completed since the last visit. */
export interface RecoveryEntry {
  kind: 'recovery'
  taskId: string
  originTaskId: string
  title: string
  at: string
}

/** A thread that was throttled (rate-limited) since the last visit. */
export interface ThrottleEntry {
  kind: 'throttle'
  taskId: string
  reason: string
  at: string
}

/** A projection Thread whose alert resolved and the row evaporated. */
export interface EvaporatedEntry {
  kind: 'evaporated'
  threadId: string
  title: string
  at: string
}

/**
 * Hero-delta: grouped activity since the last visit.
 *
 * Five sections surface distinct event categories:
 *   - merges        — tasks that landed (done) since last visit
 *   - recoveries    — recovery tasks that completed
 *   - recipes       — recipe auto-run events (taught recipes that fired)
 *   - throttles     — threads that were rate-limited
 *   - evaporated    — projection Threads whose alert was resolved
 *
 * The `entries` field is kept for backward compatibility with consumers that
 * read only the recipe auto-run feed (e.g. WhatHappenedTodayView).
 */
export interface HeroDelta {
  merges: MergeEntry[]
  recoveries: RecoveryEntry[]
  /** Recipe auto-run events. Same data as `entries`; prefer this field. */
  recipes: HeroDeltaEntry[]
  throttles: ThrottleEntry[]
  evaporated: EvaporatedEntry[]
  /**
   * @deprecated Use `recipes` instead. Kept for backward compatibility with
   * consumers that only read the recipe auto-run feed.
   */
  entries: HeroDeltaEntry[]
}

const MONTH_ABBREVS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

function formatAutorunDate(iso: string): string {
  const d = new Date(iso)
  const month = MONTH_ABBREVS[d.getUTCMonth()] ?? 'Jan'
  return `${month} ${d.getUTCDate()}`
}

/**
 * Build the hero-delta feed.
 *
 * Pure function — no I/O. Recipe auto-run events are mapped to feed lines;
 * the other sections (merges, recoveries, throttles, evaporated) are passed
 * in pre-built by the caller from the relevant DB queries.
 *
 * Each recipe event produces one plain-English feed line:
 *   "Coder was killed by {failureKind} on task {targetTaskId} — auto-continued
 *    per your teach on {date}"
 */
export const buildHeroDelta = (
  events: RecipeAutorunEvent[],
  merges: MergeEntry[] = [],
  recoveries: RecoveryEntry[] = [],
  throttles: ThrottleEntry[] = [],
  evaporated: EvaporatedEntry[] = [],
): HeroDelta => {
  const recipes: HeroDeltaEntry[] = events.map((e) => ({
    kind: 'recipe-autorun' as const,
    text: `Coder was killed by ${e.failureKind} on task ${e.targetTaskId} — auto-continued per your teach on ${formatAutorunDate(e.at)}`,
  }))
  return {
    merges,
    recoveries,
    recipes,
    throttles,
    evaporated,
    entries: recipes,
  }
}
