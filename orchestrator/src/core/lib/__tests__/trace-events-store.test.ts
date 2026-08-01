import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  cursorAfter,
  deriveSeverity,
  openTraceEventStore,
  TRACE_EVENT_KINDS,
  TRANSCRIPT_RETENTION_DAYS,
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

  it('returns info for tool_invoked with non-zero exit when expectsFailure=true', () => {
    // Expected-failure probes (e.g. git show-ref branch-existence checks) exit
    // nonzero BY DESIGN — log at info so they don't pollute warn/error channels.
    expect(
      deriveSeverity('tool_invoked', {
        tool: 'git',
        argv: ['show-ref', '--verify', '--quiet', 'refs/heads/task/abc'],
        exitCode: 1,
        durationMs: 7,
        expectsFailure: true,
      }),
    ).toBe('info')
    expect(
      deriveSeverity('tool_invoked', {
        tool: 'git',
        argv: ['merge-base', '--is-ancestor', 'HEAD', 'main'],
        exitCode: 1,
        durationMs: 4,
        expectsFailure: true,
      }),
    ).toBe('info')
  })

  it('returns warn for tool_invoked with non-zero exit when expectsFailure is not set', () => {
    // Unexpected nonzero exits (e.g. pnpm install failures) stay at warn so
    // they remain visible without elevating to error-channel noise.
    expect(
      deriveSeverity('tool_invoked', {
        tool: 'git',
        argv: ['push'],
        exitCode: 128,
        durationMs: 12,
      }),
    ).toBe('warn')
    expect(
      deriveSeverity('tool_invoked', {
        tool: 'npm',
        argv: ['ci'],
        exitCode: 1,
        durationMs: 999,
        expectsFailure: false,
      }),
    ).toBe('warn')
  })

  it('covers every kind in the closed enum without throwing', () => {
    for (const kind of TRACE_EVENT_KINDS) {
      const sev = deriveSeverity(kind, {})
      expect(['info', 'warn', 'error']).toContain(sev)
    }
  })

  it('log_line: reads severity from payload.level', () => {
    expect(deriveSeverity('log_line', { level: 'warn', msg: 'disk near full', source: 'daemon' })).toBe('warn')
    expect(deriveSeverity('log_line', { level: 'error', msg: 'crash', source: 'workflow' })).toBe('error')
    expect(deriveSeverity('log_line', { level: 'info', msg: 'started', source: 'bus' })).toBe('info')
  })

  it('log_line: unknown or missing level falls back to info', () => {
    expect(deriveSeverity('log_line', { level: 'bogus', msg: 'x', source: 'daemon' })).toBe('info')
    expect(deriveSeverity('log_line', { msg: 'no level', source: 'sweeper' })).toBe('info')
    expect(deriveSeverity('log_line', {})).toBe('info')
  })

  it('returns warn for worker-model-mismatch', () => {
    // A subprocess running a different model than the Worker pin is a budget
    // risk but not a hard failure — warn so it surfaces in reflect.
    expect(
      deriveSeverity('worker-model-mismatch', {
        expected: 'claude-sonnet-4-6',
        actual: 'claude-opus-4-7',
        worker: 'Fixer',
      }),
    ).toBe('warn')
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
      expect(typeof e.timestamp).toBe('number')
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

  it('log_line round-trips through record+query with correct kind, severity, and payload', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'log_line',
        taskId: 'task-log-1',
        payload: { level: 'warn', msg: 'disk near full', source: 'sweeper', fields: { pct: 91 } },
      })
      const events = await store.query({ taskId: 'task-log-1' })
      expect(events).toHaveLength(1)
      const e = events[0]
      expect(e.kind).toBe('log_line')
      expect(e.severity).toBe('warn')
      expect(e.taskId).toBe('task-log-1')
      expect(e.payload).toEqual({ level: 'warn', msg: 'disk near full', source: 'sweeper', fields: { pct: 91 } })
    } finally {
      await store.close()
    }
  })

  it('log_line with null taskId/originId round-trips for daemon-global lines', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'log_line',
        payload: { level: 'error', msg: 'daemon crashed', source: 'daemon' },
      })
      const events = await store.query({ kind: ['log_line'] })
      expect(events).toHaveLength(1)
      expect(events[0].taskId).toBeNull()
      expect(events[0].originId).toBeNull()
      expect(events[0].severity).toBe('error')
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

      const future = Date.now() + 60_000
      const past = Date.now() - 60_000
      const inWindow = await store.query({ sinceMs: past, untilMs: future })
      expect(inWindow).toHaveLength(4)
      expect(typeof inWindow[0]?.timestamp).toBe('number')
      const outOfWindow = await store.query({ sinceMs: future })
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

// ── task_transcripts: streaming chunk store ───────────────────────────────

describe('openTraceEventStore — appendTranscriptChunk + readTranscriptChunks', () => {
  it('stores chunks and reads them back in (session_id, seq) order', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const events1 = [{ type: 'assistant', message: { content: 'hello' } }]
      const events2 = [{ type: 'result', result: 'work complete' }]
      await store.appendTranscriptChunk!('task-1', 'sess-abc', 0, events1)
      await store.appendTranscriptChunk!('task-1', 'sess-abc', 1, events2)

      const all = await store.readTranscriptChunks!('task-1')
      expect(all).toHaveLength(2)
      expect((all[0] as { type: string }).type).toBe('assistant')
      expect((all[1] as { type: string }).type).toBe('result')
    } finally {
      await store.close()
    }
  })

  it('readTranscriptChunks returns events across multiple sessions in session_id order', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      // Two sessions for the same task (origin + recovery)
      await store.appendTranscriptChunk!('task-2', 'sess-origin', 0, [{ type: 'assistant', ord: 1 }])
      await store.appendTranscriptChunk!('task-2', 'sess-recovery', 0, [{ type: 'assistant', ord: 2 }])

      const all = await store.readTranscriptChunks!('task-2')
      expect(all).toHaveLength(2)
      // sess-origin < sess-recovery alphabetically
      expect((all[0] as { ord: number }).ord).toBe(1)
      expect((all[1] as { ord: number }).ord).toBe(2)
    } finally {
      await store.close()
    }
  })

  it('readTranscriptChunks with sessionId filter returns only that session', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.appendTranscriptChunk!('task-3', 'sess-a', 0, [{ type: 'assistant', ord: 1 }])
      await store.appendTranscriptChunk!('task-3', 'sess-b', 0, [{ type: 'assistant', ord: 2 }])

      const fromA = await store.readTranscriptChunks!('task-3', 'sess-a')
      expect(fromA).toHaveLength(1)
      expect((fromA[0] as { ord: number }).ord).toBe(1)
    } finally {
      await store.close()
    }
  })

  it('readTranscriptChunks returns empty array when no chunks exist for the task', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const result = await store.readTranscriptChunks!('task-nonexistent')
      expect(result).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('does not mix chunks from different tasks', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.appendTranscriptChunk!('task-A', 'sess-x', 0, [{ type: 'assistant', src: 'A' }])
      await store.appendTranscriptChunk!('task-B', 'sess-x', 0, [{ type: 'assistant', src: 'B' }])

      const forA = await store.readTranscriptChunks!('task-A')
      expect(forA).toHaveLength(1)
      expect((forA[0] as { src: string }).src).toBe('A')
    } finally {
      await store.close()
    }
  })

  it('TRANSCRIPT_RETENTION_DAYS is exported and reasonable', () => {
    expect(typeof TRANSCRIPT_RETENTION_DAYS).toBe('number')
    expect(TRANSCRIPT_RETENTION_DAYS).toBeGreaterThan(0)
  })
})

describe('openTraceEventStore — pruneTranscripts', () => {
  it('deletes chunk rows whose ts is before the cutoff', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      // Insert a chunk — ts will be ~now
      await store.appendTranscriptChunk!('task-p', 'sess-p', 0, [{ type: 'assistant' }])

      // A cutoff in the future covers all currently-written rows
      const futureCutoff = Date.now() + 60_000
      const deleted = await store.pruneTranscripts!(futureCutoff)
      expect(deleted).toBe(1)

      // Row is gone
      const remaining = await store.readTranscriptChunks!('task-p')
      expect(remaining).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('returns 0 when no rows are older than the cutoff', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.appendTranscriptChunk!('task-q', 'sess-q', 0, [{ type: 'assistant' }])
      // A cutoff in the past does not match any row written now
      const pastCutoff = Date.now() - 60_000
      const deleted = await store.pruneTranscripts!(pastCutoff)
      expect(deleted).toBe(0)

      // Row is still there
      const remaining = await store.readTranscriptChunks!('task-q')
      expect(remaining).toHaveLength(1)
    } finally {
      await store.close()
    }
  })
})

// ── log_line volume filtering ─────────────────────────────────────────────────
//
// info-level log_line rows are dropped at write time to prevent trace_events
// bloat. warn/error log_lines carry signal and are retained.

describe('openTraceEventStore — log_line write-time filtering', () => {
  it('info-level log_line is not persisted to trace_events', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'log_line',
        payload: { level: 'info', msg: 'daemon started', source: 'daemon' },
      })
      const events = await store.query({})
      expect(events).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('log_line without an explicit level (defaults to info) is not persisted', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'log_line',
        payload: { msg: 'heartbeat', source: 'bus' },
      })
      const events = await store.query({})
      expect(events).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('warn-level log_line is persisted and queryable', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'log_line',
        payload: { level: 'warn', msg: 'disk near full', source: 'sweeper' },
      })
      const events = await store.query({ kind: ['log_line'] })
      expect(events).toHaveLength(1)
      expect(events[0].severity).toBe('warn')
    } finally {
      await store.close()
    }
  })

  it('error-level log_line is persisted and queryable', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'log_line',
        payload: { level: 'error', msg: 'daemon crashed', source: 'daemon' },
      })
      const events = await store.query({ kind: ['log_line'] })
      expect(events).toHaveLength(1)
      expect(events[0].severity).toBe('error')
    } finally {
      await store.close()
    }
  })

  it('info log_lines do not pollute the event count alongside other kinds', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      // One real event and several info log_lines that should be silently dropped.
      await store.record({ kind: 'task_failed', taskId: 'x' })
      await store.record({ kind: 'log_line', payload: { level: 'info', msg: 'tick', source: 'daemon' } })
      await store.record({ kind: 'log_line', payload: { level: 'info', msg: 'tock', source: 'bus' } })
      await store.record({ kind: 'log_line', payload: { level: 'warn', msg: 'alert', source: 'sweeper' } })

      const all = await store.query({})
      // Only task_failed and the warn log_line should be present.
      expect(all).toHaveLength(2)
      expect(all.map((e) => e.kind).sort()).toEqual(['log_line', 'task_failed'])
    } finally {
      await store.close()
    }
  })
})

// ── Durable compressed transcripts ────────────────────────────────────────────

describe('appendDurableTranscript / readDurableTranscript — compressed round-trip', () => {
  it('writes a transcript compressed and reads it back as the original JSON string', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const events = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } },
        { type: 'result', result: 'done' },
      ]
      const json = JSON.stringify(events)

      await store.appendDurableTranscript!('task-rt-01', 'sess-rt-01', 'run-claude-code', json)
      const result = await store.readDurableTranscript!('task-rt-01')

      expect(result).not.toBeNull()
      expect(JSON.parse(result!)).toEqual(events)
    } finally {
      await store.close()
    }
  })

  it('returns null when no transcript row exists for the task', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const result = await store.readDurableTranscript!('task-missing')
      expect(result).toBeNull()
    } finally {
      await store.close()
    }
  })

  it('a large synthetic transcript round-trips correctly', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const bigEvent = { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(4096) }] } }
      const events = Array.from({ length: 200 }, () => bigEvent)
      const json = JSON.stringify(events)
      expect(json.length).toBeGreaterThan(800_000)

      await store.appendDurableTranscript!('task-large-01', 'sess-large-01', 'run-claude-code', json)
      const result = await store.readDurableTranscript!('task-large-01')

      expect(result).not.toBeNull()
      expect(JSON.parse(result!) as unknown[]).toHaveLength(events.length)
    } finally {
      await store.close()
    }
  })

  it('INSERT OR REPLACE: a second call updates the row for the same taskId', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const first = JSON.stringify([{ type: 'assistant', message: 'first' }])
      const second = JSON.stringify([{ type: 'assistant', message: 'second' }, { type: 'result' }])

      await store.appendDurableTranscript!('task-upsert', 'sess-upsert', 'run-claude-code', first)
      await store.appendDurableTranscript!('task-upsert', 'sess-upsert', 'run-claude-code', second)
      const result = await store.readDurableTranscript!('task-upsert')

      expect(result).not.toBeNull()
      const parsed = JSON.parse(result!) as unknown[]
      expect(parsed).toHaveLength(2) // second write wins
    } finally {
      await store.close()
    }
  })
})

describe('backfillInlineTranscripts — move step_ended inline transcripts to task_durable_transcripts', () => {
  it('migrates an inline transcript from step_ended payload to task_durable_transcripts', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const events = [{ type: 'assistant', content: 'from inline payload' }]
      const transcriptJson = JSON.stringify(events)
      await store.record({
        kind: 'step_ended',
        taskId: 'task-backfill-01',
        phase: 'code',
        payload: {
          stepName: 'run-claude-code',
          workflowInstanceId: 'wf-backfill-01',
          outcome: 'completed',
          sessionId: 'sess-backfill-01',
          transcript: transcriptJson,
        },
      })

      const count = await store.backfillInlineTranscripts!()
      expect(count).toBe(1)

      // Transcript must now be readable from task_durable_transcripts
      const durableJson = await store.readDurableTranscript!('task-backfill-01')
      expect(durableJson).not.toBeNull()
      expect(JSON.parse(durableJson!)).toEqual(events)

      // The inline transcript must no longer appear in the step_ended payload
      const stepEnded = await store.query({ taskId: 'task-backfill-01', kind: ['step_ended'] })
      expect(stepEnded).toHaveLength(1)
      expect(stepEnded[0]!.payload.transcript).toBeUndefined()
      // A lightweight transcriptRef marker replaces it
      expect(stepEnded[0]!.payload.transcriptRef).toBeDefined()
    } finally {
      await store.close()
    }
  })

  it('is idempotent: calling backfill a second time returns 0', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await store.record({
        kind: 'step_ended',
        taskId: 'task-backfill-idem',
        phase: 'code',
        payload: {
          stepName: 'run-claude-code',
          workflowInstanceId: 'wf-backfill-idem',
          outcome: 'completed',
          transcript: JSON.stringify([{ type: 'result' }]),
        },
      })

      const first = await store.backfillInlineTranscripts!()
      const second = await store.backfillInlineTranscripts!()

      expect(first).toBe(1)
      expect(second).toBe(0)
    } finally {
      await store.close()
    }
  })

  it('does not overwrite an existing task_durable_transcripts row (INSERT OR IGNORE)', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const existingJson = JSON.stringify([{ type: 'assistant', message: 'existing durable' }])
      await store.appendDurableTranscript!('task-backfill-noover', 'sess-A', 'run-claude-code', existingJson)

      const inlineJson = JSON.stringify([{ type: 'assistant', message: 'inline older' }])
      await store.record({
        kind: 'step_ended',
        taskId: 'task-backfill-noover',
        phase: 'code',
        payload: {
          stepName: 'run-claude-code',
          workflowInstanceId: 'wf-backfill-noover',
          outcome: 'completed',
          transcript: inlineJson,
        },
      })

      await store.backfillInlineTranscripts!()

      // Existing durable transcript must not be overwritten
      const result = await store.readDurableTranscript!('task-backfill-noover')
      expect(JSON.parse(result!)).toEqual(JSON.parse(existingJson))
    } finally {
      await store.close()
    }
  })

  it('a 3 MB synthetic transcript no longer appears in trace_events payloads after backfill', async () => {
    // Regression guard: the measured symptom was 3.53 MB step_ended payloads.
    // This test simulates that exact scenario and verifies backfill eliminates
    // the inline blob entirely from trace_events.
    const store = await openTraceEventStore(tmpDbPath())
    try {
      // Construct a synthetic transcript whose JSON serialisation is ≥ 3 MB.
      const bigEvent = { type: 'assistant', content: 'x'.repeat(10_000) }
      const events = Array.from({ length: 300 }, () => bigEvent)
      const transcriptJson = JSON.stringify(events)
      expect(transcriptJson.length).toBeGreaterThan(3_000_000)

      // Write it inline inside a step_ended payload (the pre-migration pattern).
      await store.record({
        kind: 'step_ended',
        taskId: 'task-3mb-backfill',
        phase: 'code',
        payload: {
          stepName: 'run-claude-code',
          workflowInstanceId: 'wf-3mb',
          outcome: 'completed',
          sessionId: 'sess-3mb',
          transcript: transcriptJson,
        },
      })

      const migrated = await store.backfillInlineTranscripts!()
      expect(migrated).toBe(1)

      // The 3 MB blob must no longer appear in trace_events.
      const stepEnded = await store.query({ taskId: 'task-3mb-backfill', kind: ['step_ended'] })
      expect(stepEnded).toHaveLength(1)
      expect(stepEnded[0]!.payload.transcript).toBeUndefined()

      // A lightweight transcriptRef marker replaces it (byte length only).
      const ref = stepEnded[0]!.payload.transcriptRef as Record<string, unknown>
      expect(typeof ref.byteLen).toBe('number')
      expect(ref.byteLen as number).toBeGreaterThan(3_000_000)

      // The 3 MB transcript must be accessible from task_durable_transcripts.
      const result = await store.readDurableTranscript!('task-3mb-backfill')
      expect(result).not.toBeNull()
      expect((JSON.parse(result!) as unknown[]).length).toBe(events.length)
    } finally {
      await store.close()
    }
  })
})
