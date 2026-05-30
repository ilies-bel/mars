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
  catalogActionsForDetail,
  opForCatalogAction,
  originKindLabel,
  resolveFailureReason,
  severityColor,
  substituteTaskId,
  summarizeTraceEvent,
  UNKNOWN_FAILURE_CODE,
} from './actionQueueDetail'
import type {
  FailureReasonCatalogEntry,
  TraceEvent,
} from './schemas'

const buildEntry = (
  code: string,
  userMessage = `msg for ${code}`,
): FailureReasonCatalogEntry => ({
  code,
  userMessage,
  recipe: null,
  availableActions: [
    { id: 'restart', label: 'Restart', cliHint: 'mars restart <id>' },
    { id: 'purge', label: 'Purge', cliHint: 'mars purge <id>' },
  ],
})

const catalog: FailureReasonCatalogEntry[] = [
  buildEntry(UNKNOWN_FAILURE_CODE, 'Inspect the transcript.'),
  buildEntry('verify:typecheck', 'TypeScript typecheck failed.'),
  {
    code: 'verify:custom',
    userMessage: 'Custom check failed.',
    recipe: null,
    availableActions: [
      // An action with no UI binding — should render disabled with a CLI hint.
      { id: 'reflect', label: 'Reflect', cliHint: 'mars reflect <id>' },
    ],
  },
]

describe('resolveFailureReason', () => {
  it('returns the entry matching the code', () => {
    const r = resolveFailureReason('verify:typecheck', catalog)
    expect(r?.code).toBe('verify:typecheck')
    expect(r?.userMessage).toBe('TypeScript typecheck failed.')
  })

  it('falls back to the unknown entry when the code is null', () => {
    const r = resolveFailureReason(null, catalog)
    expect(r?.code).toBe(UNKNOWN_FAILURE_CODE)
    expect(r?.userMessage).toBe('Inspect the transcript.')
  })

  it('falls back to the unknown entry when the code is missing from the catalog', () => {
    const r = resolveFailureReason('verify:never-existed', catalog)
    expect(r?.code).toBe(UNKNOWN_FAILURE_CODE)
  })

  it('returns null when the catalog has no `unknown` and the code is missing', () => {
    const noUnknown = catalog.filter((c) => c.code !== UNKNOWN_FAILURE_CODE)
    expect(resolveFailureReason('verify:never-existed', noUnknown)).toBeNull()
  })
})

describe('opForCatalogAction', () => {
  it('binds the standard catalog ids to existing UI ops', () => {
    expect(
      opForCatalogAction({ id: 'restart', label: 'Restart', cliHint: null }),
    ).toBe('restart')
    expect(
      opForCatalogAction({ id: 'purge', label: 'Purge', cliHint: null }),
    ).toBe('purge')
    expect(
      opForCatalogAction({
        id: 'investigate',
        label: 'Investigate',
        cliHint: null,
      }),
    ).toBe('investigate')
  })

  it('returns null for unbound catalog ids', () => {
    expect(
      opForCatalogAction({ id: 'reflect', label: 'Reflect', cliHint: null }),
    ).toBeNull()
  })
})

describe('substituteTaskId', () => {
  it('replaces every <id> with the task id', () => {
    expect(substituteTaskId('mars restart <id> --force <id>', 'task-abc')).toBe(
      'mars restart task-abc --force task-abc',
    )
  })
})

describe('catalogActionsForDetail', () => {
  it('renders bound actions with op + enabled, and unbound ones disabled with CLI hint', () => {
    const verifyCustom = catalog.find((c) => c.code === 'verify:custom')!
    const verifyTypecheck = catalog.find((c) => c.code === 'verify:typecheck')!

    const enabled = catalogActionsForDetail(
      verifyTypecheck.availableActions,
      'task-zzz',
    )
    expect(enabled.map((a) => ({ id: a.id, op: a.op, disabled: a.disabled }))).toEqual([
      { id: 'restart', op: 'restart', disabled: false },
      { id: 'purge', op: 'purge', disabled: false },
    ])
    expect(enabled[0]!.label).toBe('Restart')

    const disabled = catalogActionsForDetail(
      verifyCustom.availableActions,
      'task-zzz',
    )
    expect(disabled).toHaveLength(1)
    expect(disabled[0]!.id).toBe('reflect')
    expect(disabled[0]!.op).toBe('')
    expect(disabled[0]!.disabled).toBe(true)
    // The disabled label exposes the CLI hint with the id substituted in.
    expect(disabled[0]!.label).toBe('Reflect (CLI only: mars reflect task-zzz)')
  })
})

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
