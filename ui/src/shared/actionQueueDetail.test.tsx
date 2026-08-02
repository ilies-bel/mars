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
    timestamp: 1_767_225_600_000,
    kind,
    severity,
    taskId: 't1',
    originId: null,
    phase,
    payload,
  })

  // tool_invoked
  it('tool_invoked: non-zero exit shows command and exit code', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'tsc', exitCode: 2 })),
    ).toBe('tsc → exit 2')
  })

  it('tool_invoked: shows argv when present', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'git', argv: ['status', '--porcelain'], exitCode: 0 })),
    ).toBe('git status --porcelain')
  })

  it('tool_invoked: non-zero exit with argv shows full command', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'git', argv: ['rebase', 'main'], exitCode: 1 }, 'info', null)),
    ).toBe('git rebase main → exit 1')
  })

  it('tool_invoked: extracts basename from a full path', () => {
    expect(
      summarizeTraceEvent(
        make('tool_invoked', { tool: '/usr/bin/git', argv: ['merge-base', 'main'], exitCode: 1 }, 'info', 'merge'),
      ),
    ).toBe('git merge-base main → exit 1')
  })

  it('tool_invoked: exit 0 shows the command without exit code', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'tsc', exitCode: 0 })),
    ).toBe('tsc')
  })

  it('tool_invoked: no exit code shows just the tool name', () => {
    expect(
      summarizeTraceEvent(make('tool_invoked', { tool: 'git' })),
    ).toBe('git')
  })

  it('tool_invoked: truncates long commands to 80 chars', () => {
    const longArgs = Array.from({ length: 20 }, (_, i) => `arg${i}`)
    const result = summarizeTraceEvent(make('tool_invoked', { tool: 'git', argv: longArgs, exitCode: 0 }))
    expect(result.length).toBeLessThanOrEqual(80)
    expect(result).toContain('…')
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

  // log_line
  it('log_line: returns the msg field as the summary', () => {
    expect(
      summarizeTraceEvent(make('log_line', { level: 'info', msg: 'daemon started', source: 'daemon' })),
    ).toBe('daemon started')
  })

  it('log_line: falls back to (no message) when msg is absent', () => {
    expect(
      summarizeTraceEvent(make('log_line', { level: 'warn', source: 'workflow' })),
    ).toBe('(no message)')
  })

  it('log_line: returns msg regardless of whether fields are present', () => {
    expect(
      summarizeTraceEvent(
        make('log_line', {
          level: 'error',
          msg: 'something failed',
          source: 'bus',
          fields: { taskId: 'mars-abc123', retries: 3 },
        }),
      ),
    ).toBe('something failed')
  })
})

describe('isMarsToolEvent / marsToolTextClass', () => {
  const make = (
    kind: TraceEvent['kind'],
    payload: Record<string, unknown> = {},
  ): TraceEvent => ({
    id: 'e1',
    timestamp: 1_767_225_600_000,
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

describe('summarizeTraceEvent — log_line claude-event gist', () => {
  const makeClaudeLogLine = (fields: Record<string, unknown>): TraceEvent => ({
    id: 'e-ce',
    timestamp: 1_767_225_600_000,
    kind: 'log_line',
    severity: 'info',
    taskId: 't1',
    originId: null,
    phase: 'code',
    payload: {
      level: 'info',
      msg: 'claude-event',
      source: 'workflow',
      fields,
    },
  })

  it('tool_use: produces → ToolName: <description>', () => {
    expect(
      summarizeTraceEvent(
        makeClaudeLogLine({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'ls -la', description: 'List files in directory' },
              },
            ],
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 },
          },
        }),
      ),
    ).toBe('→ Bash: List files in directory')
  })

  it('tool_use: falls back to command when description is absent', () => {
    expect(
      summarizeTraceEvent(
        makeClaudeLogLine({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'git status' },
              },
            ],
          },
        }),
      ),
    ).toBe('→ Bash: git status')
  })

  it('tool_use: truncates long description at 60 chars with ellipsis', () => {
    const longDesc = 'a'.repeat(80)
    const result = summarizeTraceEvent(
      makeClaudeLogLine({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: longDesc },
            },
          ],
        },
      }),
    )
    expect(result.startsWith('→ Bash: ')).toBe(true)
    expect(result.endsWith('…')).toBe(true)
    // prefix + 60 chars + ellipsis
    expect(result.length).toBeLessThanOrEqual('→ Bash: '.length + 60 + 1)
  })

  it('tool_result: produces ← result (N chars, ok) for user message with tool_result', () => {
    expect(
      summarizeTraceEvent(
        makeClaudeLogLine({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu1',
                content: 'hello world',
                is_error: false,
              },
            ],
          },
        }),
      ),
    ).toBe('← result (11 chars, ok)')
  })

  it('tool_result: produces ← result (N chars, error) when is_error is true', () => {
    expect(
      summarizeTraceEvent(
        makeClaudeLogLine({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu1',
                content: 'Permission denied',
                is_error: true,
              },
            ],
          },
        }),
      ),
    ).toBe('← result (17 chars, error)')
  })

  it('thinking_tokens: produces thinking (+N tokens)', () => {
    expect(
      summarizeTraceEvent(
        makeClaudeLogLine({
          type: 'thinking_tokens',
          budget_tokens: 5000,
        }),
      ),
    ).toBe('thinking (+5000 tokens)')
  })

  it('system event: produces thinking (+N tokens) when budget is present', () => {
    expect(
      summarizeTraceEvent(
        makeClaudeLogLine({
          type: 'system',
          budget_tokens: 2048,
        }),
      ),
    ).toBe('thinking (+2048 tokens)')
  })

  it('usage: produces assistant turn (in N / out N / cache N) when no tool_use', () => {
    expect(
      summarizeTraceEvent(
        makeClaudeLogLine({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello, world!' }],
            usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 150 },
          },
        }),
      ),
    ).toBe('assistant turn (in 200 / out 30 / cache 150)')
  })

  it('non-claude-event log_line: still returns payload.msg unchanged', () => {
    expect(
      summarizeTraceEvent({
        id: 'e2',
        timestamp: 1_767_225_600_000,
        kind: 'log_line',
        severity: 'info',
        taskId: null,
        originId: null,
        phase: null,
        payload: { level: 'info', msg: 'daemon started', source: 'daemon' },
      }),
    ).toBe('daemon started')
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
