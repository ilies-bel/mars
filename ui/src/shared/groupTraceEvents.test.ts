import { describe, it, expect } from 'vitest'
import { groupByArc } from './groupTraceEvents'
import type { TraceEvent } from './schemas'

const makeEvent = (overrides: Partial<TraceEvent> & { id: string }): TraceEvent => ({
  id: overrides.id,
  timestamp: overrides.timestamp ?? '2024-01-01T00:00:00Z',
  kind: overrides.kind ?? 'log_line',
  severity: overrides.severity ?? 'info',
  taskId: overrides.taskId ?? null,
  originId: overrides.originId ?? null,
  phase: overrides.phase ?? null,
  payload: overrides.payload ?? {},
})

describe('groupByArc', () => {
  it('groups events by originId', () => {
    const events: TraceEvent[] = [
      makeEvent({ id: '1', originId: 'arc-a', taskId: 't1' }),
      makeEvent({ id: '2', originId: 'arc-a', taskId: 't2' }),
      makeEvent({ id: '3', originId: 'arc-b', taskId: 't3' }),
    ]
    const groups = groupByArc(events)
    expect(groups).toHaveLength(2)
    expect(groups[0].arcId).toBe('arc-a')
    expect(groups[0].taskGroups).toHaveLength(2)
    expect(groups[1].arcId).toBe('arc-b')
    expect(groups[1].taskGroups).toHaveLength(1)
  })

  it('falls back to taskId when originId is null', () => {
    const events: TraceEvent[] = [
      makeEvent({ id: '1', originId: null, taskId: 'task-x' }),
      makeEvent({ id: '2', originId: null, taskId: 'task-x' }),
    ]
    const groups = groupByArc(events)
    expect(groups).toHaveLength(1)
    expect(groups[0].arcId).toBe('task-x')
  })

  it('uses __unlinked__ for events with no originId and no taskId', () => {
    const events: TraceEvent[] = [
      makeEvent({ id: '1', originId: null, taskId: null }),
    ]
    const groups = groupByArc(events)
    expect(groups[0].arcId).toBe('__unlinked__')
  })

  it('computes worst severity across all events in an arc', () => {
    const events: TraceEvent[] = [
      makeEvent({ id: '1', originId: 'arc', taskId: 't', severity: 'info' }),
      makeEvent({ id: '2', originId: 'arc', taskId: 't', severity: 'error' }),
    ]
    const groups = groupByArc(events)
    expect(groups[0].severity).toBe('error')
  })

  it('nests tool_invoked events under their parent step', () => {
    const events: TraceEvent[] = [
      makeEvent({
        id: 's1',
        originId: 'arc',
        taskId: 't',
        kind: 'step_started',
        timestamp: '2024-01-01T00:00:00Z',
        payload: { stepName: 'code' },
      }),
      makeEvent({
        id: 'tool1',
        originId: 'arc',
        taskId: 't',
        kind: 'tool_invoked',
        timestamp: '2024-01-01T00:01:00Z',
        payload: { tool: 'git' },
      }),
      makeEvent({
        id: 's1e',
        originId: 'arc',
        taskId: 't',
        kind: 'step_ended',
        timestamp: '2024-01-01T00:02:00Z',
        payload: { stepName: 'code', outcome: 'completed' },
      }),
    ]
    const groups = groupByArc(events)
    const taskGroup = groups[0].taskGroups[0]
    expect(taskGroup.steps).toHaveLength(1)
    expect(taskGroup.steps[0].tools).toHaveLength(1)
    expect(taskGroup.steps[0].tools[0].id).toBe('tool1')
  })

  it('tracks first and last timestamps', () => {
    const events: TraceEvent[] = [
      makeEvent({ id: '1', originId: 'arc', taskId: 't', timestamp: '2024-01-01T00:05:00Z' }),
      makeEvent({ id: '2', originId: 'arc', taskId: 't', timestamp: '2024-01-01T00:01:00Z' }),
      makeEvent({ id: '3', originId: 'arc', taskId: 't', timestamp: '2024-01-01T00:10:00Z' }),
    ]
    const groups = groupByArc(events)
    expect(groups[0].firstTimestamp).toBe('2024-01-01T00:01:00Z')
    expect(groups[0].lastTimestamp).toBe('2024-01-01T00:10:00Z')
  })

  it('returns empty array for empty input', () => {
    expect(groupByArc([])).toEqual([])
  })
})
