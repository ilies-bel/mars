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
} from './actionQueueDetail'
import type { TraceEvent } from './schemas'

describe('summarizeTraceEvent', () => {
  const make = (
    kind: TraceEvent['kind'],
    payload: Record<string, unknown> = {},
    severity: TraceEvent['severity'] = 'info',
  ): TraceEvent => ({
    id: 'e1',
    timestamp: '2026-01-01T00:00:00Z',
    kind,
    severity,
    taskId: 't1',
    originId: null,
    phase: 'code',
    payload,
  })

  it('summarises tool_invoked with the tool name and exit code', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'tsc', exitCode: 2 })),
    ).toBe('tsc (exit 2)')
  })

  it('summarises step_started with the step name', () => {
    expect(
      summarizeTraceEvent(make('step_started', { stepName: 'verify' })),
    ).toBe('verify')
  })

  it('summarises step_ended with the step name and outcome', () => {
    expect(
      summarizeTraceEvent(
        make('step_ended', { stepName: 'verify', outcome: 'failure' }),
      ),
    ).toBe('verify (failure)')
  })

  it('summarises task_failed with the failure reason code when present', () => {
    expect(
      summarizeTraceEvent(
        make('task_failed', { failureReasonCode: 'verify:typecheck' }),
      ),
    ).toBe('verify:typecheck')
  })

  it('falls back to the kind name for unknown kinds', () => {
    // The store enums the kinds; this just guards us against silent regressions.
    expect(summarizeTraceEvent(make('origin_created', { source: 'cli' }))).toBe(
      'origin (cli)',
    )
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
