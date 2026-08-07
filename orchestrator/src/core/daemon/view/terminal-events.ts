type EventKind = 'completed' | 'failed' | 'dropped'

export interface TerminalEvent {
  taskId: string
  kind: EventKind
  occurredAt: string
  recoverySpawnedCount: number
  summary: string
}

/** Minimal task shape the terminal-events view needs — satisfied by DomainTaskStore. */
export interface TaskStoreForEvents {
  listTasks(): Promise<
    Array<{
      id: string
      prompt: string
      status: string
      recoverySpawnedCount: number
      updatedAt: string
    }>
  >
}

/**
 * Hard cap on entries returned by the events feed. Keeps responses
 * bounded for situational-awareness UIs that don't paginate yet.
 */
const EVENT_FEED_LIMIT = 200

const SUMMARY_MAX = 120

const summarise = (prompt: string): string => {
  // Single-line, length-capped projection of the task prompt — enough to
  // recognise the task on a feed without leaking multi-line context.
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= SUMMARY_MAX) return collapsed
  return `${collapsed.slice(0, SUMMARY_MAX - 1)}…`
}

const eventsForTask = (task: {
  id: string
  prompt: string
  status: string
  recoverySpawnedCount: number
  updatedAt: string
}): TerminalEvent[] => {
  const summary = summarise(task.prompt)
  const occurredAt = task.updatedAt
  const recoverySpawnedCount = task.recoverySpawnedCount

  if (task.status === 'done') {
    return [
      {
        taskId: task.id,
        kind: 'completed',
        occurredAt,
        recoverySpawnedCount,
        summary,
      },
    ]
  }

  if (task.status === 'failed') {
    // Each individual failed attempt earns a 'failed' event. A task that
    // is currently failed but has no retries yet still represents one
    // observed failure, so we always emit at least one.
    const count = Math.max(recoverySpawnedCount, 1)
    return Array.from({ length: count }, (_, i) => ({
      taskId: task.id,
      kind: 'failed' as const,
      occurredAt,
      recoverySpawnedCount: i + 1,
      summary,
    }))
  }

  if (task.status === 'dropped') {
    // Drop implies the retry budget was exhausted: each prior attempt
    // failed, then the orchestrator gave up. Emit one 'failed' per prior
    // attempt followed by the terminal 'dropped'.
    const failed: TerminalEvent[] = Array.from(
      { length: recoverySpawnedCount },
      (_, i) => ({
        taskId: task.id,
        kind: 'failed' as const,
        occurredAt,
        recoverySpawnedCount: i + 1,
        summary,
      }),
    )
    return [
      ...failed,
      {
        taskId: task.id,
        kind: 'dropped',
        occurredAt,
        recoverySpawnedCount,
        summary,
      },
    ]
  }

  return []
}

/**
 * Build the reverse-chronological feed of terminal-state task moments.
 *
 * Uses only the existing `tasks.updated_at` timestamp as the moment of
 * occurrence — no schema migration is required. When a single task
 * produced multiple events (e.g. two failures plus a drop), all of them
 * share the row's `updated_at`; the ordering between same-task events
 * is stabilised by emission order (failed attempts ascending, drop last).
 */
export const listTerminalEvents = async (
  taskStore: TaskStoreForEvents,
): Promise<TerminalEvent[]> => {
  const tasks = await taskStore.listTasks()
  const all: TerminalEvent[] = []
  for (const task of tasks) {
    for (const ev of eventsForTask(task)) {
      all.push(ev)
    }
  }

  all.sort((a, b) => {
    if (a.occurredAt < b.occurredAt) return 1
    if (a.occurredAt > b.occurredAt) return -1
    return 0
  })

  return all.slice(0, EVENT_FEED_LIMIT)
}
