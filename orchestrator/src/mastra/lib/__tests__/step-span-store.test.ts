import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openStepSpanStore } from '../step-span-store'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-step-spans-'))
  return join(dir, 'state.db')
}

describe('openStepSpanStore', () => {
  it('opening a span returns an id the caller can use to close it', async () => {
    const store = await openStepSpanStore(tmpDbPath())
    const id = await store.openSpan({
      stepName: 'code',
      workflowInstanceId: 'wf-001',
      originId: 'task-abc',
    })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('closing a span sets ended_at, outcome, and optional payload fields', async () => {
    const store = await openStepSpanStore(tmpDbPath())
    const id = await store.openSpan({
      stepName: 'verify',
      workflowInstanceId: 'wf-002',
      originId: 'task-def',
    })
    await store.closeSpan(id, {
      outcome: 'success',
      transcript: 'all tests passed',
      usageSignals: { tokens: 1500 },
      verifyOutput: 'exit 0',
    })
    const spans = await store.listSpans('task-def')
    expect(spans).toHaveLength(1)
    const span = spans[0]
    expect(span.outcome).toBe('success')
    expect(span.endedAt).not.toBeNull()
    expect(span.transcript).toBe('all tests passed')
    expect(span.usageSignals).toEqual({ tokens: 1500 })
    expect(span.verifyOutput).toBe('exit 0')
  })

  it('closing a span does not disturb other spans', async () => {
    const store = await openStepSpanStore(tmpDbPath())
    const id1 = await store.openSpan({
      stepName: 'setup',
      workflowInstanceId: 'wf-003',
      originId: 'task-ghi',
    })
    const id2 = await store.openSpan({
      stepName: 'code',
      workflowInstanceId: 'wf-003',
      originId: 'task-ghi',
    })
    await store.closeSpan(id2, { outcome: 'failed' })
    const spans = await store.listSpans('task-ghi')
    const setupSpan = spans.find((s) => s.id === id1)
    expect(setupSpan?.outcome).toBeNull()
    expect(setupSpan?.endedAt).toBeNull()
  })

  it('opening the same step name twice yields two distinct rows in started_at order', async () => {
    const store = await openStepSpanStore(tmpDbPath())
    const t1 = new Date('2026-05-25T10:00:00.000Z')
    const t2 = new Date('2026-05-25T10:05:00.000Z')
    const id1 = await store.openSpan({
      stepName: 'code',
      workflowInstanceId: 'wf-004',
      originId: 'task-jkl',
      startedAt: t1,
    })
    const id2 = await store.openSpan({
      stepName: 'code',
      workflowInstanceId: 'wf-004',
      originId: 'task-jkl',
      startedAt: t2,
    })
    expect(id1).not.toBe(id2)
    const spans = await store.listSpans('task-jkl')
    expect(spans).toHaveLength(2)
    expect(spans[0].id).toBe(id1)
    expect(spans[1].id).toBe(id2)
    expect(new Date(spans[0].startedAt) < new Date(spans[1].startedAt)).toBe(
      true,
    )
  })

  it('listSpans returns in-flight spans (outcome = null) alongside completed ones', async () => {
    const store = await openStepSpanStore(tmpDbPath())
    const inFlightId = await store.openSpan({
      stepName: 'code',
      workflowInstanceId: 'wf-005',
      originId: 'task-mno',
    })
    const completedId = await store.openSpan({
      stepName: 'verify',
      workflowInstanceId: 'wf-005',
      originId: 'task-mno',
    })
    await store.closeSpan(completedId, { outcome: 'success' })

    const spans = await store.listSpans('task-mno')
    expect(spans).toHaveLength(2)
    const inFlight = spans.find((s) => s.id === inFlightId)
    const completed = spans.find((s) => s.id === completedId)
    expect(inFlight?.outcome).toBeNull()
    expect(inFlight?.endedAt).toBeNull()
    expect(completed?.outcome).toBe('success')
  })

  it('records optional worker name and session id at open time', async () => {
    const store = await openStepSpanStore(tmpDbPath())
    const id = await store.openSpan({
      stepName: 'code',
      workflowInstanceId: 'wf-006',
      originId: 'task-pqr',
      workerName: 'claude-sonnet-4-6',
      sessionId: 'sess-xyz',
    })
    await store.closeSpan(id, { outcome: 'success' })
    const spans = await store.listSpans('task-pqr')
    expect(spans[0].workerName).toBe('claude-sonnet-4-6')
    expect(spans[0].sessionId).toBe('sess-xyz')
  })

  it('verify_output set at open time is preserved when closeSpan does not supply it', async () => {
    const store = await openStepSpanStore(tmpDbPath())
    const id = await store.openSpan({
      stepName: 'verify',
      workflowInstanceId: 'wf-007',
      originId: 'task-stu',
      verifyOutput: 'pending',
    })
    await store.closeSpan(id, { outcome: 'success' })
    const spans = await store.listSpans('task-stu')
    expect(spans[0].verifyOutput).toBe('pending')
  })

  it('listSpans returns only spans belonging to the requested origin', async () => {
    const store = await openStepSpanStore(tmpDbPath())
    await store.openSpan({
      stepName: 'code',
      workflowInstanceId: 'wf-008',
      originId: 'task-vwx',
    })
    await store.openSpan({
      stepName: 'code',
      workflowInstanceId: 'wf-009',
      originId: 'task-yz0',
    })
    const spans = await store.listSpans('task-vwx')
    expect(spans).toHaveLength(1)
    expect(spans[0].originId).toBe('task-vwx')
  })
})
