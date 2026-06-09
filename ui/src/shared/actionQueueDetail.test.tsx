/**
 * Unit tests for the actionQueue detail-panel helpers.
 *
 * Pure functions — no React render, no React Query. These pin the
 * catalog-lookup fallback, the catalog-action → ActionDescriptor binding
 * with its disabled-button cliHint surfacing, and the trace event payload
 * summary that the Traces section renders for each event.
 */
import { describe, expect, it } from 'bun:test'
import {
  originKindLabel,
  severityColor,
  summarizeTraceEvent,
  isMarsToolEvent,
  marsToolTextClass,
} from './actionQueueDetail'
import type { TraceEvent } from './schemas'

describe('summarizeTraceEvent', () => {
  const make = (
    kind: TraceEvent['kind'],
    payload: Record<string, unknown> = {},
    severity: TraceEvent['severity'] = 'info',
    phase: string | null = 'code',
  ): TraceEvent => ({
    id: 'e1',
    timestamp: '2026-01-01T00:00:00Z',
    kind,
    severity,
    taskId: 't1',
    originId: null,
    phase,
    payload,
  })

  // tool_invoked
  it('tool_invoked: non-zero exit with phase reads as a failure sentence', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'tsc', exitCode: 2 })),
    ).toBe('tsc exited 2 during the code step')
  })

  it('tool_invoked: non-zero exit without phase omits the step clause', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'git', exitCode: 1 }, 'info', null)),
    ).toBe('git exited 1')
  })

  it('tool_invoked: extracts basename from a full path', () => {
    expect(
      summarizeTraceEvent(
        make('tool_invoked', { tool: '/usr/bin/git', exitCode: 1 }, 'info', 'merge'),
      ),
    ).toBe('git exited 1 during the merge step')
  })

  it('tool_invoked: exit 0 reads as a terse ran-line', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'tsc', exitCode: 0 })),
    ).toBe('ran tsc')
  })

  it('tool_invoked: no exit code is also terse', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'git' })),
    ).toBe('ran git')
  })

  // step_started / step_ended
  it('summarises step_started with just the step name', () => {
    expect(
      summarizeTraceEvent(make('step_started', { stepName: 'verify' })),
    ).toBe('verify')
  })

  it('step_ended: failure outcome reads as "<step> step failed"', () => {
    expect(
      summarizeTraceEvent(
        make('step_ended', { stepName: 'verify', outcome: 'failure' }),
      ),
    ).toBe('verify step failed')
  })

  it('step_ended: completed outcome reads as "<step> step completed"', () => {
    expect(
      summarizeTraceEvent(
        make('step_ended', { stepName: 'merge', outcome: 'completed' }),
      ),
    ).toBe('merge step completed')
  })

  // task_failed
  it('task_failed: prefers failureReason prose over the code', () => {
    expect(
      summarizeTraceEvent(
        make('task_failed', {
          failureReasonCode: 'verify:typecheck',
          failureReason: 'TypeScript type-check failed',
        }),
      ),
    ).toBe('TypeScript type-check failed')
  })

  it('task_failed: humanizes a step:detail code when no prose is present', () => {
    expect(
      summarizeTraceEvent(
        make('task_failed', { failureReasonCode: 'verify:typecheck' }),
      ),
    ).toBe('typecheck (verify step)')
  })

  it('task_failed: humanizes a bare code with no colon separator', () => {
    expect(
      summarizeTraceEvent(
        make('task_failed', { failureReasonCode: 'tool_timeout' }),
      ),
    ).toBe('tool timeout')
  })

  // task_blocked
  it('task_blocked: frames the blocker id with "waiting on"', () => {
    expect(
      summarizeTraceEvent(
        make('task_blocked', { blockerTaskId: 'mars-9c045304' }),
      ),
    ).toBe('waiting on mars-9c045304')
  })

  it('falls back to origin_created form unchanged', () => {
    expect(summarizeTraceEvent(make('origin_created', { source: 'cli' }))).toBe(
      'origin (cli)',
    )
  })
})

describe('isMarsToolEvent / marsToolTextClass', () => {
  const make = (
    kind: TraceEvent['kind'],
    payload: Record<string, unknown> = {},
  ): TraceEvent => ({
    id: 'e1',
    timestamp: '2026-01-01T00:00:00Z',
    kind,
    severity: 'info',
    taskId: 't1',
    originId: null,
    phase: 'code',
    payload,
  })

  it('flags a tool_invoked event whose tool is mars', () => {
    expect(isMarsToolEvent(make('tool_invoked', { tool: 'mars' }))).toBe(true)
  })

  it('flags a full-path mars binary by basename', () => {
    expect(
      isMarsToolEvent(make('tool_invoked', { tool: '/usr/local/bin/mars' })),
    ).toBe(true)
  })

  it('does not flag git/npx plumbing', () => {
    expect(isMarsToolEvent(make('tool_invoked', { tool: 'git' }))).toBe(false)
    expect(isMarsToolEvent(make('tool_invoked', { tool: 'npx' }))).toBe(false)
  })

  it('does not flag non-tool_invoked kinds even if payload.tool says mars', () => {
    expect(isMarsToolEvent(make('step_started', { tool: 'mars' }))).toBe(false)
  })

  it('does not match a tool that merely starts with mars (e.g. marsenv)', () => {
    expect(isMarsToolEvent(make('tool_invoked', { tool: 'marsenv' }))).toBe(false)
  })

  it('marsToolTextClass returns the blue token for mars, empty otherwise', () => {
    expect(marsToolTextClass(make('tool_invoked', { tool: 'mars' }))).toContain(
      'text-trace-mars',
    )
    expect(marsToolTextClass(make('tool_invoked', { tool: 'git' }))).toBe('')
  })
})

describe('severityColor', () => {
  it('uses design-token classes for error, warn, and info', () => {
    expect(severityColor('error')).toBe('text-error')
    expect(severityColor('warn')).toBe('text-warn')
    expect(severityColor('info')).toContain('iron')
  })
})

describe('originKindLabel', () => {
  it('labels each kind distinctly', () => {
    expect(originKindLabel('proposal')).toBe('PROPOSAL')
    expect(originKindLabel('prd')).toBe('PRD')
    expect(originKindLabel('fix')).toBe('FIX')
    expect(originKindLabel('task')).toBe('TASK')
  })
})
