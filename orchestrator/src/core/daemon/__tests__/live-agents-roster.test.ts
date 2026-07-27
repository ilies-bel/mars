import { describe, expect, it } from 'vitest'
import {
  AgentRosterEntrySchema,
  buildLiveAgentsRoster,
  type TaskFlightSnapshot,
  type ReflectorLifecycleEntry,
} from '../live-agents-roster'

describe('buildLiveAgentsRoster', () => {
  it('empty input returns an empty array', () => {
    const result = buildLiveAgentsRoster({ flights: [], reflectors: [] })
    expect(result).toEqual([])
  })

  it('one flight-tracked worker produces one row with bindingKind=task', () => {
    const flight: TaskFlightSnapshot = {
      taskId: 'task-abc',
      workerName: 'Coder',
      stepName: 'code',
      startedAt: 1_700_000_000_000,
      lastActivityMs: 1_700_000_060_000,
    }

    const result = buildLiveAgentsRoster({ flights: [flight], reflectors: [] })

    expect(result).toHaveLength(1)
    const row = result[0]
    expect(row.id).toBe('task-abc')
    expect(row.workerName).toBe('Coder')
    expect(row.bindingKind).toBe('task')
    expect(row.relatedTaskId).toBe('task-abc')
    expect(row.relatedProposalId).toBeNull()
    expect(row.purpose).toBe('code')
    expect(row.startedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(row.lastEventAt).toBe(new Date(1_700_000_060_000).toISOString())
  })

  it('one active reflector produces one row with bindingKind=event and relatedTaskId=null', () => {
    const reflector: ReflectorLifecycleEntry = {
      trigger: 'scheduled',
      startedAt: 1_700_000_200_000,
    }

    const result = buildLiveAgentsRoster({ flights: [], reflectors: [reflector] })

    expect(result).toHaveLength(1)
    const row = result[0]
    expect(row.workerName).toBe('Reflector')
    expect(row.bindingKind).toBe('event')
    expect(row.relatedTaskId).toBeNull()
    expect(row.relatedProposalId).toBeNull()
    expect(row.purpose).toBe('scheduled')
    expect(row.startedAt).toBe(new Date(1_700_000_200_000).toISOString())
    expect(row.lastEventAt).toBeNull()
  })

  it('mixed input is sorted by startedAt descending', () => {
    const flights: TaskFlightSnapshot[] = [
      { taskId: 'task-1', workerName: 'Coder', startedAt: 1_700_000_100_000 },
      { taskId: 'task-2', workerName: 'Triager', startedAt: 1_700_000_300_000 },
    ]
    const reflectors: ReflectorLifecycleEntry[] = [
      { trigger: 'manual', startedAt: 1_700_000_200_000 },
    ]

    const result = buildLiveAgentsRoster({ flights, reflectors })

    expect(result).toHaveLength(3)
    // Sorted descending by startedAt
    expect(result[0].startedAt).toBe(new Date(1_700_000_300_000).toISOString()) // task-2
    expect(result[1].startedAt).toBe(new Date(1_700_000_200_000).toISOString()) // reflector
    expect(result[2].startedAt).toBe(new Date(1_700_000_100_000).toISOString()) // task-1
    expect(result[0].bindingKind).toBe('task')
    expect(result[1].bindingKind).toBe('event')
    expect(result[2].bindingKind).toBe('task')
  })

  it('all rows satisfy the AgentRosterEntry schema', () => {
    const flights: TaskFlightSnapshot[] = [
      { taskId: 'task-x', workerName: 'Coder', phase: 'verify', startedAt: 1_700_000_000_000 },
    ]
    const reflectors: ReflectorLifecycleEntry[] = [
      { startedAt: 1_700_000_100_000, lastActivityMs: 1_700_000_150_000 },
    ]

    const result = buildLiveAgentsRoster({ flights, reflectors })

    for (const row of result) {
      expect(() => AgentRosterEntrySchema.parse(row)).not.toThrow()
    }
  })

  it('falls back to phase when stepName is absent', () => {
    const flight: TaskFlightSnapshot = {
      taskId: 'task-p',
      workerName: 'Fixer',
      phase: 'fix',
      startedAt: 1_700_000_000_000,
    }

    const result = buildLiveAgentsRoster({ flights: [flight], reflectors: [] })

    expect(result[0].purpose).toBe('fix')
  })

  it('falls back to empty string when neither stepName nor phase is set', () => {
    const flight: TaskFlightSnapshot = {
      taskId: 'task-empty',
      workerName: 'Writer',
      startedAt: 1_700_000_000_000,
    }

    const result = buildLiveAgentsRoster({ flights: [flight], reflectors: [] })

    expect(result[0].purpose).toBe('')
  })

  it('reflector without trigger defaults purpose to "reflection"', () => {
    const reflector: ReflectorLifecycleEntry = { startedAt: 1_700_000_000_000 }

    const result = buildLiveAgentsRoster({ flights: [], reflectors: [reflector] })

    expect(result[0].purpose).toBe('reflection')
  })
})
