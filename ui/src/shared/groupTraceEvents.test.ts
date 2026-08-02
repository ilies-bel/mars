import { describe, it, expect } from 'vitest'
import { groupByArc } from './groupTraceEvents'
import type { TraceEvent } from './schemas'

const makeEvent = (overrides: Partial<TraceEvent> & { id: string }): TraceEvent => ({
  id: overrides.id,
  timestamp: overrides.timestamp ?? 1_704_067_200_000,
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
        timestamp: 1_704_067_200_000,
        payload: { stepName: 'code' },
      }),
      makeEvent({
        id: 'tool1',
        originId: 'arc',
        taskId: 't',
        kind: 'tool_invoked',
        timestamp: 1_704_067_260_000,
        payload: { tool: 'git' },
      }),
      makeEvent({
        id: 's1e',
        originId: 'arc',
        taskId: 't',
        kind: 'step_ended',
        timestamp: 1_704_067_320_000,
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
      makeEvent({ id: '1', originId: 'arc', taskId: 't', timestamp: 1_704_067_500_000 }),
      makeEvent({ id: '2', originId: 'arc', taskId: 't', timestamp: 1_704_067_260_000 }),
      makeEvent({ id: '3', originId: 'arc', taskId: 't', timestamp: 1_704_067_800_000 }),
    ]
    const groups = groupByArc(events)
    expect(groups[0].firstTimestamp).toBe(1_704_067_260_000)
    expect(groups[0].lastTimestamp).toBe(1_704_067_800_000)
  })

  it('returns empty array for empty input', () => {
    expect(groupByArc([])).toEqual([])
  })
})
