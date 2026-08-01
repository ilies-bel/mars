/**
 * Daemon-side release-notes projection — arc-grouped landed tasks.
 *
 * Mirrors the wire shape of ui/server/releaseNotes.ts but operates over the
 * daemon's DomainTaskStore rather than raw arrays, so it can be called from
 * AppServices without a DB round-trip in tests. The pure grouping / sorting
 * logic is the same as the UI-side buildReleaseNotes; neither imports from
 * the other (same pattern as terminal-events.ts vs ui/server/events.ts).
 */

/** Spec fields included in the release-note detail. */
export interface ReleaseNoteSpec {
  files: readonly string[]
  verifyCmd: string | null
  doneCriteria: readonly string[]
  mergeMode: string
}

/**
 * Per-arc release-note entry, wire-compatible with the UI-side
 * ReleaseNoteEntry from ui/server/releaseNotes.ts.
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
 * Minimal task shape required by {@link listReleaseNotes}. Structurally
 * satisfied by the DomainTaskStore returned by getDefaultDomainTaskStore().
 */
export interface TaskStoreForReleaseNotes {
  listTasks(): Promise<
    Array<{
      id: string
      /** Always a string in the daemon (may be '' on legacy rows). */
      intent: string
      prompt: string
      status: string
      updatedAt: string
      /** Always populated after the schema migration. */
      originId: string
      fixForTaskId: string | null
      kind?: string
      spec: ReleaseNoteSpec | null
    }>
  >
}

const RELEASE_NOTES_LIMIT = 200
const TITLE_MAX = 120

const extractFirstSentence = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const match = collapsed.match(/^(.+?[.!?])(?:\s|$)/)
  return match ? match[1]! : collapsed
}

const buildTitle = (intent: string, prompt: string): string => {
  const raw = intent.length > 0 ? intent : extractFirstSentence(prompt)
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (clean.length <= TITLE_MAX) return clean
  return `${clean.slice(0, TITLE_MAX - 1)}…`
}

const isRecovery = (task: {
  fixForTaskId: string | null
  kind?: string
}): boolean =>
  task.fixForTaskId !== null || task.kind === 'fix' || task.kind === 'diagnose'

/**
 * Build the reverse-chronological arc-grouped release-notes feed.
 *
 * Only done tasks contribute. Recovery tasks are folded into their origin arc
 * entry. The arc's `landedAt` is the latest `updatedAt` among all done tasks
 * in the arc (i.e. the moment the arc fully landed).
 *
 * Arcs without a landed (done, non-recovery) origin task are excluded. A bare
 * recovery with no landed origin does not represent shipped work.
 */
export const listReleaseNotes = async (
  taskStore: TaskStoreForReleaseNotes,
): Promise<ReleaseNoteEntry[]> => {
  const allTasks = await taskStore.listTasks()
  const done = allTasks.filter((t) => t.status === 'done')

  // Group done tasks by arc key (originId, always set after migration).
  const arcMap = new Map<string, typeof done>()
  for (const task of done) {
    const key = task.originId
    const group = arcMap.get(key)
    if (group) {
      group.push(task)
    } else {
      arcMap.set(key, [task])
    }
  }

  const entries: ReleaseNoteEntry[] = []
  for (const [arcKey, group] of arcMap) {
    // Origin task: id === arcKey and not a recovery.
    // If no landed origin exists in the done-set, the arc is excluded — a
    // recovery task with no landed origin is not a release note.
    const originTask = group.find((t) => t.id === arcKey && !isRecovery(t))
    if (!originTask) continue

    // landedAt = latest updatedAt in the arc.
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
