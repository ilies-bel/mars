import type { TraceEvent } from './schemas'

export interface StepGroup {
  step: TraceEvent
  endEvent: TraceEvent | null
  tools: TraceEvent[]
}

export interface TaskGroup {
  taskId: string
  events: TraceEvent[]
  steps: StepGroup[]
  severity: 'info' | 'warn' | 'error'
}

export interface ArcGroup {
  arcId: string
  taskGroups: TaskGroup[]
  severity: 'info' | 'warn' | 'error'
  firstTimestamp: number
  lastTimestamp: number
}

function worstSeverity(
  a: TraceEvent['severity'],
  b: TraceEvent['severity'],
): TraceEvent['severity'] {
  if (a === 'error' || b === 'error') return 'error'
  if (a === 'warn' || b === 'warn') return 'warn'
  return 'info'
}

function nestToolsUnderSteps(events: readonly TraceEvent[]): StepGroup[] {
  const steps: StepGroup[] = []
  const stepStarts: TraceEvent[] = []
  const stepEnds = new Map<string, TraceEvent>()
  const tools: TraceEvent[] = []

  for (const e of events) {
    if (e.kind === 'step_started') {
      stepStarts.push(e)
    } else if (e.kind === 'step_ended') {
      const name =
        typeof e.payload.stepName === 'string' ? e.payload.stepName : ''
      stepEnds.set(name, e)
    } else if (e.kind === 'tool_invoked') {
      tools.push(e)
    }
  }

  for (const start of stepStarts) {
    const stepName =
      typeof start.payload.stepName === 'string' ? start.payload.stepName : ''
    const end = stepEnds.get(stepName) ?? null
    const startTs = start.timestamp
    const endTs = end?.timestamp ?? Infinity

    const stepTools = tools.filter((t) => {
      const ts = t.timestamp
      return ts >= startTs && ts <= endTs
    })

    steps.push({ step: start, endEvent: end, tools: stepTools })
  }

  return steps
}

function buildTaskGroup(taskId: string, events: TraceEvent[]): TaskGroup {
  let severity: TraceEvent['severity'] = 'info'
  for (const e of events) {
    severity = worstSeverity(severity, e.severity)
  }
  return {
    taskId,
    events,
    steps: nestToolsUnderSteps(events),
    severity,
  }
}

export function groupByArc(events: readonly TraceEvent[]): ArcGroup[] {
  const arcMap = new Map<string, TraceEvent[]>()

  for (const e of events) {
    const arcId = e.originId ?? e.taskId ?? '__unlinked__'
    let list = arcMap.get(arcId)
    if (!list) {
      list = []
      arcMap.set(arcId, list)
    }
    list.push(e)
  }

  const result: ArcGroup[] = []

  for (const [arcId, arcEvents] of arcMap) {
    const taskMap = new Map<string, TraceEvent[]>()
    for (const e of arcEvents) {
      const tid = e.taskId ?? '__no-task__'
      let list = taskMap.get(tid)
      if (!list) {
        list = []
        taskMap.set(tid, list)
      }
      list.push(e)
    }

    const taskGroups: TaskGroup[] = []
    for (const [tid, tEvents] of taskMap) {
      taskGroups.push(buildTaskGroup(tid, tEvents))
    }

    let severity: TraceEvent['severity'] = 'info'
    let firstTs = Infinity
    let lastTs = -Infinity
    for (const e of arcEvents) {
      severity = worstSeverity(severity, e.severity)
      if (e.timestamp < firstTs) firstTs = e.timestamp
      if (e.timestamp > lastTs) lastTs = e.timestamp
    }

    result.push({
      arcId,
      taskGroups,
      severity,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
    })
  }

  return result
}
