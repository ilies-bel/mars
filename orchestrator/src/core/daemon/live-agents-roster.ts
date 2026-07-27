import { z } from 'zod'

export const AgentRosterEntrySchema = z.object({
  id: z.string(),
  workerName: z.string(),
  bindingKind: z.enum(['task', 'event']),
  relatedTaskId: z.string().nullable(),
  relatedProposalId: z.string().nullable(),
  purpose: z.string(),
  startedAt: z.string(), // ISO 8601
  lastEventAt: z.string().nullable(), // ISO 8601 | null
})

export type AgentRosterEntry = z.infer<typeof AgentRosterEntrySchema>

/** A point-in-time snapshot of one in-flight task worker. */
export interface TaskFlightSnapshot {
  taskId: string
  workerName: string
  stepName?: string
  phase?: string
  /** Millisecond epoch timestamp when this entry was committed to in-flight. */
  startedAt: number
  /** Millisecond epoch timestamp of the most recent event, if any. */
  lastActivityMs?: number
}

/** A point-in-time view of one active Reflector run. */
export interface ReflectorLifecycleEntry {
  /** What caused this reflection run (e.g. 'scheduled', 'manual'). */
  trigger?: string
  /** Millisecond epoch timestamp when the reflector started. */
  startedAt: number
  /** Millisecond epoch timestamp of the most recent activity, if any. */
  lastActivityMs?: number
}

export interface BuildLiveAgentsRosterInput {
  flights: TaskFlightSnapshot[]
  reflectors: ReflectorLifecycleEntry[]
}

const msToIso = (ms: number): string => new Date(ms).toISOString()

/**
 * Build a sorted AgentRosterEntry[] from in-flight task snapshots and active
 * reflector lifecycle entries. Rows are sorted by startedAt descending (most
 * recent first).
 */
export const buildLiveAgentsRoster = (
  input: BuildLiveAgentsRosterInput,
): AgentRosterEntry[] => {
  const entries: AgentRosterEntry[] = []

  for (const flight of input.flights) {
    entries.push({
      id: flight.taskId,
      workerName: flight.workerName,
      bindingKind: 'task',
      relatedTaskId: flight.taskId,
      relatedProposalId: null,
      purpose: flight.stepName ?? flight.phase ?? '',
      startedAt: msToIso(flight.startedAt),
      lastEventAt: flight.lastActivityMs != null ? msToIso(flight.lastActivityMs) : null,
    })
  }

  for (const entry of input.reflectors) {
    entries.push({
      id: `reflector-${entry.startedAt}`,
      workerName: 'Reflector',
      bindingKind: 'event',
      relatedTaskId: null,
      relatedProposalId: null,
      purpose: entry.trigger ?? 'reflection',
      startedAt: msToIso(entry.startedAt),
      lastEventAt: entry.lastActivityMs != null ? msToIso(entry.lastActivityMs) : null,
    })
  }

  // Sort descending by startedAt ISO string (lexicographic order is correct for ISO 8601).
  entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))

  return entries
}
