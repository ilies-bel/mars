/**
 * Integration test: trace context propagates through the Vcs port.
 *
 * Calling a `localGitVcs` method with a `TraceIdentity` on the spec and an
 * ambient store armed via `setAmbientTraceStore` must record a `tool_invoked`
 * event carrying the correct `taskId`, `originId`, and `phase`. Omitting the
 * identity, or clearing the ambient store before the call, must record nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// Import via the registry so the module-init circular chain (local-git →
// checkpoint → registry → local-git) resolves correctly: registry is always
// the entry point, which means localGitVcs is fully defined before
// registerVcs(localGitVcs) runs.
import { getVcs } from '../registry'
import { setAmbientTraceStore } from '../ambient-trace-store'
import type { TraceEventStore, TraceEventInput } from '../../../lib/trace-events-store'

const localGitVcs = getVcs('local-git')!

// ---------------------------------------------------------------------------
// Shared mock store
// ---------------------------------------------------------------------------

let events: TraceEventInput[] = []

const mockStore: TraceEventStore = {
  record: async (e: TraceEventInput) => {
    events.push(e)
  },
  query: async () => [],
  close: async () => {},
}

beforeEach(() => {
  events = []
  setAmbientTraceStore(mockStore)
})

afterEach(() => {
  setAmbientTraceStore(null)
})

// ---------------------------------------------------------------------------

describe('Vcs port trace propagation', () => {
  it('records a tool_invoked event when trace identity is present', async () => {
    await localGitVcs.revParse({
      cwd: process.cwd(),
      rev: 'HEAD',
      trace: { taskId: 'test-task', originId: 'test-origin', phase: 'verify' },
    })

    expect(events.length).toBeGreaterThanOrEqual(1)
    const evt = events[0]
    expect(evt.kind).toBe('tool_invoked')
    expect(evt.taskId).toBe('test-task')
    expect(evt.originId).toBe('test-origin')
    expect(evt.phase).toBe('verify')
  })

  it('records no trace event when trace identity is absent', async () => {
    await localGitVcs.revParse({
      cwd: process.cwd(),
      rev: 'HEAD',
      // no trace field
    })

    expect(events.length).toBe(0)
  })

  it('records no trace event when ambient store is null', async () => {
    setAmbientTraceStore(null)

    await localGitVcs.revParse({
      cwd: process.cwd(),
      rev: 'HEAD',
      trace: { taskId: 'test-task', originId: 'test-origin', phase: 'verify' },
    })

    expect(events.length).toBe(0)
  })
})
