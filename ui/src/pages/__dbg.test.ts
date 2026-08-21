import { describe, it, expect } from 'vitest'
import { summarizeTraceEvent } from '@/shared/actionQueueDetail'

describe('dbg', () => {
  it('prints', () => {
    const mk = (payload: any) => ({
      id: 'x', timestamp: Date.now(), kind: 'task.failed' as any,
      severity: 'error' as any, taskId: 't-1', originId: null,
      phase: 'verify', payload,
    })
    const a = summarizeTraceEvent(mk({ failureReasonCode: 'verify:typecheck' }) as any)
    const b = summarizeTraceEvent(mk({ taskId: 't-1', failureSignature: 'verify:typecheck' }) as any)
    expect(`A=${a} || B=${b}`).toBe('FORCE_FAIL')
  })
})
