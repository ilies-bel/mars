import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  cursorAfter,
  deriveSeverity,
  openTraceEventStore,
  TRACE_EVENT_KINDS,
  type TraceEventKind,
} from '../trace-events-store'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-trace-events-'))
  return join(dir, 'mars.db')
}

describe('deriveSeverity', () => {
  it('returns error for task_failed regardless of payload', () => {
    expect(deriveSeverity('task_failed', {})).toBe('error')
    expect(deriveSeverity('task_failed', { failureReason: 'x' })).toBe('error')
  })

  it('returns error for step_ended with outcome=failed', () => {
    expect(
      deriveSeverity('step_ended', { stepName: 'verify', outcome: 'failed' }),
    ).toBe('error')
  })

  it('returns error for step_ended with outcome=failed (non-LLM step vocabulary)', () => {
    expect(
      deriveSeverity('step_ended', { stepName: 'setup-worktree', outcome: 'failed' }),
    ).toBe('error')
    expect(
      deriveSeverity('step_ended', { stepName: 'merge', outcome: 'failed' }),
    ).toBe('error')
  })

  it('returns warn for step_ended with outcome=killed (watchdog-terminated session)', () => {
    expect(
      deriveSeverity('step_ended', { stepName: 'code', outcome: 'killed' }),
    ).toBe('warn')
  })

  it('returns info for step_ended with outcome=completed', () => {
    expect(
      deriveSeverity('step_ended', { stepName: 'code', outcome: 'completed' }),
    ).toBe('info')
  })

  it('returns warn for task_blocked and recovery_spawned', () => {
    expect(deriveSeverity('task_blocked', {})).toBe('warn')
    expect(deriveSeverity('recovery_spawned', {})).toBe('warn')
  })

  it('returns info for origin_created and step_started', () => {
    expect(deriveSeverity('origin_created', { kind: 'task', id: 't1', source: 'cli' })).toBe('info')
    expect(deriveSeverity('step_started', { stepName: 'code' })).toBe('info')
  })

  it('returns info for tool_invoked with exitCode=0', () => {
    expect(
      deriveSeverity('tool_invoked', {
        tool: 'git',
        argv: ['status'],
        exitCode: 0,
        durationMs: 5,
      }),
    ).toBe('info')
  })

  it('returns warn for tool_invoked with non-zero exit when expectsFailure=true', () => {
    expect(
      deriveSeverity('tool_invoked', {
        tool: 'git',
        argv: ['diff', '--quiet'],
        exitCode: 1,
        durationMs: 7,
        expectsFailure: true,
      }),
    ).toBe('warn')
  })

  it('returns error for tool_invoked with non-zero exit when expectsFailure is not set', () => {
    expect(
      deriveSeverity('tool_invoked', {
        tool: 'git',
        argv: ['push'],
        exitCode: 128,
        durationMs: 12,
      }),
    ).toBe('error')
    expect(
      deriveSeverity('tool_invoked', {
        tool: 'npm',
        argv: ['ci'],
        exitCode: 1,
        durationMs: 999,
        expectsFailure: false,
      }),
    ).toBe('error')
  })

  it('covers every kind in the closed enum without throwing', () => {
    for (const kind of TRACE_EVENT_KINDS) {
      const sev = deriveSeverity(kind, {})
      expect(['info', 'warn', 'error']).toContain(sev)
    }
  })
})

describe('openTraceEventStore — record + query roundtrip', () => {
  it('records a step_started event and retrieves it via query', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'step_started',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'code',
        payload: { stepName: 'run-claude-code', workerName: 'Coder' },
      })
      const events = await store.query({ taskId: 'task-1' })
      expect(events).toHaveLength(1)
      const e = events[0]
      expect(e.kind).toBe('step_started')
      expect(e.severity).toBe('info')
      expect(e.taskId).toBe('task-1')
      expect(e.originId).toBe('task-1')
      expect(e.phase).toBe('code')
      expect(e.payload).toEqual({
        stepName: 'run-claude-code',
        workerName: 'Coder',
      })
      expect(typeof e.id).toBe('string')
      expect(e.id.length).toBeGreaterThan(0)
      expect(typeof e.timestamp).toBe('string')
    } finally {
      await store.close()
    }
  })

  it('derives severity at write time from kind+payload', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({ kind: 'task_failed', taskId: 'a' })
      await store.record({
        kind: 'step_ended',
        taskId: 'a',
        payload: { stepName: 'verify', outcome: 'failed', durationMs: 12 },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'a',
        payload: { stepName: 'code', outcome: 'completed', durationMs: 7 },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'a',
        payload: { stepName: 'code', outcome: 'killed', durationMs: 3 },
      })
      await store.record({ kind: 'task_blocked', taskId: 'a' })
      await store.record({ kind: 'recovery_spawned', taskId: 'a' })
      await store.record({ kind: 'step_started', taskId: 'a' })

      const events = await store.query({ taskId: 'a', limit: 50 })
      const byKindOutcome = events.map((e) => ({
        kind: e.kind,
        outcome: e.payload.outcome ?? null,
        severity: e.severity,
      }))
      expect(byKindOutcome).toEqual(
        expect.arrayContaining([
          { kind: 'task_failed', outcome: null, severity: 'error' },
          { kind: 'step_ended', outcome: 'failed', severity: 'error' },
          { kind: 'step_ended', outcome: 'completed', severity: 'info' },
          { kind: 'step_ended', outcome: 'killed', severity: 'warn' },
          { kind: 'task_blocked', outcome: null, severity: 'warn' },
          { kind: 'recovery_spawned', outcome: null, severity: 'warn' },
          { kind: 'step_started', outcome: null, severity: 'info' },
        ]),
      )
    } finally {
      await store.close()
    }
  })

  it('null taskId and null originId are accepted and round-trip', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      // origin_created before a task exists: both ids may be null.
      await store.record({
        kind: 'origin_created',
        payload: { kind: 'idea', id: 'i-1', source: 'reflection' },
      })
      const all = await store.query({})
      expect(all).toHaveLength(1)
      expect(all[0].taskId).toBeNull()
      expect(all[0].originId).toBeNull()
      expect(all[0].phase).toBeNull()
      expect(all[0].payload).toEqual({
        kind: 'idea',
        id: 'i-1',
        source: 'reflection',
      })
    } finally {
      await store.close()
    }
  })

  it('omitted payload defaults to {}', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({ kind: 'task_failed', taskId: 'a' })
      const events = await store.query({ taskId: 'a' })
      expect(events[0].payload).toEqual({})
    } finally {
      await store.close()
    }
  })
})

describe('openTraceEventStore — filters', () => {
  it('filters by kind, severity, phase, originId, time window', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'step_started',
        taskId: 't1',
        originId: 'origin-1',
        phase: 'code',
      })
      await store.record({
        kind: 'step_ended',
        taskId: 't1',
        originId: 'origin-1',
        phase: 'verify',
        payload: { stepName: 'verify', outcome: 'failed', durationMs: 1 },
      })
      await store.record({
        kind: 'task_blocked',
        taskId: 't2',
        originId: 'origin-2',
      })
      await store.record({ kind: 'task_failed', taskId: 't3', originId: 'origin-1' })

      const kinds: TraceEventKind[] = ['step_started', 'step_ended']
      const byKind = await store.query({ kind: kinds })
      expect(byKind.map((e) => e.kind).sort()).toEqual(['step_ended', 'step_started'])

      const bySeverity = await store.query({ severity: ['warn'] })
      expect(bySeverity).toHaveLength(1)
      expect(bySeverity[0].kind).toBe('task_blocked')

      const byPhase = await store.query({ phase: ['verify'] })
      expect(byPhase).toHaveLength(1)
      expect(byPhase[0].kind).toBe('step_ended')

      const byOrigin = await store.query({ originId: 'origin-1' })
      expect(byOrigin.map((e) => e.kind).sort()).toEqual([
        'step_ended',
        'step_started',
        'task_failed',
      ])

      const future = new Date(Date.now() + 60_000).toISOString()
      const past = new Date(Date.now() - 60_000).toISOString()
      const inWindow = await store.query({ sinceIso: past, untilIso: future })
      expect(inWindow).toHaveLength(4)
      const outOfWindow = await store.query({ sinceIso: future })
      expect(outOfWindow).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('combines task_id + kind + severity filters', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'step_ended',
        taskId: 'tA',
        payload: { stepName: 'verify', outcome: 'failed', durationMs: 1 },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'tA',
        payload: { stepName: 'verify', outcome: 'completed', durationMs: 2 },
      })
      await store.record({ kind: 'task_blocked', taskId: 'tA' })
      await store.record({ kind: 'task_failed', taskId: 'tB' })

      const errOnA = await store.query({
        taskId: 'tA',
        kind: ['step_ended'],
        severity: ['error'],
      })
      expect(errOnA).toHaveLength(1)
      expect(errOnA[0].payload.outcome).toBe('failed')
    } finally {
      await store.close()
    }
  })

  it('returns rows newest-first', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({ kind: 'step_started', taskId: 'x', payload: { ord: 1 } })
      // Tiny delay so the second timestamp is strictly later.
      await new Promise((r) => setTimeout(r, 5))
      await store.record({ kind: 'step_started', taskId: 'x', payload: { ord: 2 } })
      await new Promise((r) => setTimeout(r, 5))
      await store.record({ kind: 'step_started', taskId: 'x', payload: { ord: 3 } })
      const events = await store.query({ taskId: 'x' })
      expect(events.map((e) => e.payload.ord)).toEqual([3, 2, 1])
    } finally {
      await store.close()
    }
  })
})

describe('openTraceEventStore — cursor pagination', () => {
  it('walks the timeline in pages of limit N via cursorAfter', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      for (let i = 0; i < 7; i += 1) {
        await store.record({
          kind: 'step_started',
          taskId: 'paged',
          payload: { ord: i },
        })
        // Spread timestamps so DESC ordering is deterministic.
        await new Promise((r) => setTimeout(r, 3))
      }

      const page1 = await store.query({ taskId: 'paged', limit: 3 })
      expect(page1).toHaveLength(3)
      expect(page1.map((e) => e.payload.ord)).toEqual([6, 5, 4])

      const cursor1 = cursorAfter(page1[page1.length - 1])
      const page2 = await store.query({
        taskId: 'paged',
        limit: 3,
        cursor: cursor1,
      })
      expect(page2.map((e) => e.payload.ord)).toEqual([3, 2, 1])

      const cursor2 = cursorAfter(page2[page2.length - 1])
      const page3 = await store.query({
        taskId: 'paged',
        limit: 3,
        cursor: cursor2,
      })
      expect(page3.map((e) => e.payload.ord)).toEqual([0])

      const cursor3 = cursorAfter(page3[page3.length - 1])
      const empty = await store.query({
        taskId: 'paged',
        limit: 3,
        cursor: cursor3,
      })
      expect(empty).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('an unparseable cursor is ignored (returns the first page)', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({ kind: 'step_started', taskId: 'c' })
      const events = await store.query({ taskId: 'c', cursor: 'not-a-cursor' })
      expect(events).toHaveLength(1)
    } finally {
      await store.close()
    }
  })
})
