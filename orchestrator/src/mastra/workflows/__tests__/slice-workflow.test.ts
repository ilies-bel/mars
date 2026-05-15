import { describe, it, expect } from 'vitest'
import { describeSliceFailure } from '../slice-workflow'

describe('describeSliceFailure', () => {
  it('includes the failing step error text, not just the status word', () => {
    const result = {
      status: 'failed',
      error: new Error('top-level run aborted'),
      steps: {
        'some-other-step': { status: 'success', output: {} },
        generate: {
          status: 'failed',
          error: new Error('slicer agent returned invalid JSON: unexpected token'),
        },
      },
    }

    const msg = describeSliceFailure(result)

    expect(msg).toContain('slice workflow failed')
    expect(msg).toContain('top-level run aborted')
    expect(msg).toContain('step "generate" failed')
    expect(msg).toContain('slicer agent returned invalid JSON: unexpected token')
    // The whole point: the cause is present, not discarded.
    expect(msg).not.toBe('slice workflow failed')
  })

  it('handles a serialized (storage-rehydrated) step error object', () => {
    const result = {
      status: 'failed',
      steps: {
        generate: {
          status: 'failed',
          error: {
            name: 'TimeoutError',
            message: 'claude -p exceeded deadline after 600000ms',
            stack: 'TimeoutError: ...',
          },
        },
      },
    }

    const msg = describeSliceFailure(result)

    expect(msg).toContain('step "generate" failed')
    expect(msg).toContain('TimeoutError')
    expect(msg).toContain('claude -p exceeded deadline after 600000ms')
  })

  it('handles a bare string error', () => {
    const msg = describeSliceFailure({
      status: 'failed',
      error: 'database is locked',
    })

    expect(msg).toContain('slice workflow failed')
    expect(msg).toContain('database is locked')
  })

  it('still produces a useful message when no error detail is present', () => {
    const msg = describeSliceFailure({ status: 'suspended', steps: {} })

    expect(msg).toBe('slice workflow suspended')
  })

  it('bounds the message length so it stays log-friendly', () => {
    const huge = 'x'.repeat(5000)
    const msg = describeSliceFailure({
      status: 'failed',
      steps: { generate: { status: 'failed', error: new Error(huge) } },
    })

    expect(msg.length).toBeLessThanOrEqual(1001) // 1000 + ellipsis
    expect(msg.endsWith('…')).toBe(true)
  })

  it('reports only the first failing step', () => {
    const msg = describeSliceFailure({
      status: 'failed',
      steps: {
        a: { status: 'failed', error: new Error('first failure') },
        b: { status: 'failed', error: new Error('second failure') },
      },
    })

    expect(msg).toContain('first failure')
    expect(msg).not.toContain('second failure')
  })
})
