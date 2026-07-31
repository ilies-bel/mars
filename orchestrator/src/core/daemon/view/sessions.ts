import type { TraceEventStore } from '../../lib/trace-events-store'

/** Wire shape for a single session record returned by GET /view/sessions. */
export interface Session {
  id: string
  sessionId: string | null
  workerName: string
  stepName: string
  workflowInstanceId: string
  outcome: string
  endedAt: string
  durationMs: number | null
  /**
   * The arc this session's step ran for: the trace event's origin_id when
   * set (the arc root), else its task_id. Lets consumers join sessions
   * against per-arc data such as the spend meter's over-ceiling arcs.
   * Null for daemon-global spans with no task attribution.
   */
  arcId: string | null
}

/**
 * Build the sessions view for a given agentName.
 * Queries step_started / step_ended events from the trace store, pairs them
 * up, and returns running + finished sessions sorted newest-first, capped at 50.
 * This is the canonical implementation; the UI proxies GET /view/sessions
 * instead of opening the trace store directly.
 */
export async function buildSessionsView(
  traceStore: TraceEventStore,
  agentName: string,
): Promise<{ sessions: Session[] }> {
  // Use a worker-name substring filter for both event kinds.
  // The payload is stored as JSON.stringify(payload), so the worker
  // name will appear as "workerName":"<name>" in the serialised form.
  const workerFilter = `"workerName":"${agentName}"`
  const [startedEvents, endedEvents] = await Promise.all([
    traceStore.query({ kind: ['step_started'], q: workerFilter, limit: 100 }),
    traceStore.query({ kind: ['step_ended'], q: workerFilter, limit: 100 }),
  ])

  // Build a set of closed (workflowInstanceId, stepName) keys so that
  // step_started events with a matching step_ended are not counted again
  // as running. The null-byte separator avoids collisions between
  // adjacent string values (same logic as sweepOrphanRunningSpans).
  const closedKeys = new Set<string>()
  for (const e of endedEvents) {
    const wfId = e.payload.workflowInstanceId
    const stepName = e.payload.stepName
    if (typeof wfId === 'string' && typeof stepName === 'string') {
      closedKeys.add(`${wfId}\0${stepName}`)
    }
  }

  const runningSessions: Session[] = startedEvents
    .filter((e) => {
      const wfId = e.payload.workflowInstanceId
      const stepName = e.payload.stepName
      if (typeof wfId !== 'string' || typeof stepName !== 'string') return false
      return !closedKeys.has(`${wfId}\0${stepName}`)
    })
    .map((e) => ({
      id: e.id,
      sessionId: typeof e.payload.sessionId === 'string' ? e.payload.sessionId : null,
      workerName: typeof e.payload.workerName === 'string' ? e.payload.workerName : agentName,
      stepName: typeof e.payload.stepName === 'string' ? e.payload.stepName : '',
      workflowInstanceId:
        typeof e.payload.workflowInstanceId === 'string' ? e.payload.workflowInstanceId : '',
      outcome: 'running',
      endedAt: new Date(e.timestamp).toISOString(),
      durationMs: null,
      arcId: e.originId ?? e.taskId,
    }))

  const finishedSessions: Session[] = endedEvents.map((e) => ({
    id: e.id,
    sessionId: typeof e.payload.sessionId === 'string' ? e.payload.sessionId : null,
    workerName: typeof e.payload.workerName === 'string' ? e.payload.workerName : agentName,
    stepName: typeof e.payload.stepName === 'string' ? e.payload.stepName : '',
    workflowInstanceId:
      typeof e.payload.workflowInstanceId === 'string' ? e.payload.workflowInstanceId : '',
    outcome: typeof e.payload.outcome === 'string' ? e.payload.outcome : 'failed',
    endedAt: new Date(e.timestamp).toISOString(),
    durationMs: typeof e.payload.durationMs === 'number' ? e.payload.durationMs : null,
    arcId: e.originId ?? e.taskId,
  }))

  // Merge running + finished, sort newest-first, cap at 50.
  const sessions = [...runningSessions, ...finishedSessions]
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
    .slice(0, 50)

  return { sessions }
}
