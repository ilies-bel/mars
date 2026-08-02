import { describe, expect, it } from 'vitest'
import type { TraceEvent as DaemonTraceEvent } from '../../../orchestrator/src/core/lib/trace-events-store.ts'
import { eventsResponseSchema, traceEventSchema } from './schemas'

// Keep this payload typed by the daemon rather than reproducing the UI's
// inferred type. The dedicated Vitest typecheck project checks this assertion
// on every test run, while the test below verifies the runtime Zod boundary.
const daemonTraceEvent = {
  id: 'evt-1',
  timestamp: 1_785_675_704_026,
  kind: 'task_failed',
  severity: 'error',
  taskId: 'task-1',
  originId: null,
  phase: 'verify',
  payload: { failureReasonCode: 'verify:typecheck' },
} satisfies DaemonTraceEvent

describe('trace event daemon contract', () => {
  it('accepts a TraceEvent payload emitted by the daemon', () => {
    expect(traceEventSchema.parse(daemonTraceEvent)).toEqual(daemonTraceEvent)
    expect(eventsResponseSchema.parse({ events: [daemonTraceEvent], nextCursor: null })).toEqual({
      events: [daemonTraceEvent],
      nextCursor: null,
    })
  })
})
