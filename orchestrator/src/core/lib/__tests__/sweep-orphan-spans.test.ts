import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openTraceEventStore, sweepOrphanRunningSpans } from '../trace-events-store'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-orphan-sweep-'))
  return join(dir, 'mars.db')
}

describe('sweepOrphanRunningSpans — daemon-crash orphan', () => {
  it('transitions a running span (step_started with no step_ended) to outcome=killed', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    // Simulate a running span left by a crashed daemon
    await store.record({
      kind: 'step_started',
      taskId: 'task-orphan-1',
      originId: 'task-orphan-1',
      phase: 'code',
      payload: {
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-orphan-001',
        workerName: 'Coder',
      },
    })

    // Before sweep: step_started is present, step_ended is absent (span is "running")
    const startedBefore = await store.query({ taskId: 'task-orphan-1', kind: ['step_started'] })
    expect(startedBefore).toHaveLength(1)
    const endedBefore = await store.query({ taskId: 'task-orphan-1', kind: ['step_ended'] })
    expect(endedBefore).toHaveLength(0)

    const swept = await sweepOrphanRunningSpans(store)
    expect(swept).toBe(1)

    // After sweep: step_ended present with outcome=killed
    const endedAfter = await store.query({ taskId: 'task-orphan-1', kind: ['step_ended'] })
    expect(endedAfter).toHaveLength(1)
    expect(endedAfter[0].payload.outcome).toBe('killed')
    // severity derives from outcome=killed → warn (watchdog-killed convention)
    expect(endedAfter[0].severity).toBe('warn')
    // end time is set (the step_ended timestamp)
    expect(typeof endedAfter[0].timestamp).toBe('string')
    expect(endedAfter[0].timestamp.length).toBeGreaterThan(0)
    // step identity fields are preserved
    expect(endedAfter[0].payload.workflowInstanceId).toBe('wf-orphan-001')
    expect(endedAfter[0].payload.stepName).toBe('run-claude-code')
    await store.close()
  })

  it('preserves workerName on the step_ended so Sessions remain identifiable', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    await store.record({
      kind: 'step_started',
      taskId: 'task-worker-1',
      originId: 'task-worker-1',
      phase: 'code',
      payload: {
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-worker-001',
        workerName: 'Fixer',
      },
    })

    await sweepOrphanRunningSpans(store)

    const ended = (await store.query({ taskId: 'task-worker-1', kind: ['step_ended'] }))[0]
    expect(ended.payload.workerName).toBe('Fixer')
    await store.close()
  })

  it('does not introduce a new outcome value — uses killed, not orphaned', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    await store.record({
      kind: 'step_started',
      taskId: 'task-outcome-check',
      originId: 'task-outcome-check',
      phase: 'setup',
      payload: {
        stepName: 'setup-worktree',
        workflowInstanceId: 'wf-outcome-001',
      },
    })

    await sweepOrphanRunningSpans(store)

    const ended = (await store.query({ taskId: 'task-outcome-check', kind: ['step_ended'] }))[0]
    expect(ended.payload.outcome).toBe('killed')
    expect(ended.payload.outcome).not.toBe('orphaned')
    await store.close()
  })
})

describe('sweepOrphanRunningSpans — already-closed spans are left untouched', () => {
  it('skips a span that already has a step_ended with outcome=completed', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    await store.record({
      kind: 'step_started',
      taskId: 'task-completed',
      originId: 'task-completed',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-completed-001', workerName: 'Coder' },
    })
    await store.record({
      kind: 'step_ended',
      taskId: 'task-completed',
      originId: 'task-completed',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-completed-001', workerName: 'Coder', outcome: 'completed', durationMs: 1000 },
    })

    const swept = await sweepOrphanRunningSpans(store)
    expect(swept).toBe(0)

    // Still exactly one step_ended (not doubled)
    const ended = await store.query({ taskId: 'task-completed', kind: ['step_ended'] })
    expect(ended).toHaveLength(1)
    expect(ended[0].payload.outcome).toBe('completed')
    await store.close()
  })

  it('skips a span that already has a step_ended with outcome=failed', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    await store.record({
      kind: 'step_started',
      taskId: 'task-failed',
      originId: 'task-failed',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-failed-001', workerName: 'Coder' },
    })
    await store.record({
      kind: 'step_ended',
      taskId: 'task-failed',
      originId: 'task-failed',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-failed-001', workerName: 'Coder', outcome: 'failed', durationMs: 500 },
    })

    const swept = await sweepOrphanRunningSpans(store)
    expect(swept).toBe(0)
    await store.close()
  })

  it('skips a span already killed by the watchdog (not double-swept)', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    await store.record({
      kind: 'step_started',
      taskId: 'task-watchdog',
      originId: 'task-watchdog',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-watchdog-001', workerName: 'Coder' },
    })
    await store.record({
      kind: 'step_ended',
      taskId: 'task-watchdog',
      originId: 'task-watchdog',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-watchdog-001', workerName: 'Coder', outcome: 'killed', durationMs: 200 },
    })

    const swept = await sweepOrphanRunningSpans(store)
    expect(swept).toBe(0)
    await store.close()
  })
})

describe('sweepOrphanRunningSpans — multiple spans mixed', () => {
  it('sweeps only the orphans from a mix of orphaned and closed spans', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    // Closed span (completed)
    await store.record({
      kind: 'step_started',
      taskId: 'task-closed',
      originId: 'task-closed',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-closed-001', workerName: 'Coder' },
    })
    await store.record({
      kind: 'step_ended',
      taskId: 'task-closed',
      originId: 'task-closed',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-closed-001', workerName: 'Coder', outcome: 'completed', durationMs: 1000 },
    })

    // Orphan span 1
    await store.record({
      kind: 'step_started',
      taskId: 'task-orphan-a',
      originId: 'task-orphan-a',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-orphan-a', workerName: 'Coder' },
    })

    // Orphan span 2 (non-LLM step)
    await store.record({
      kind: 'step_started',
      taskId: 'task-orphan-b',
      originId: 'task-orphan-b',
      phase: 'setup',
      payload: { stepName: 'setup-worktree', workflowInstanceId: 'wf-orphan-b' },
    })

    const swept = await sweepOrphanRunningSpans(store)
    expect(swept).toBe(2)

    // Both orphans now have step_ended with outcome=killed
    const endedA = await store.query({ taskId: 'task-orphan-a', kind: ['step_ended'] })
    expect(endedA).toHaveLength(1)
    expect(endedA[0].payload.outcome).toBe('killed')

    const endedB = await store.query({ taskId: 'task-orphan-b', kind: ['step_ended'] })
    expect(endedB).toHaveLength(1)
    expect(endedB[0].payload.outcome).toBe('killed')

    // Closed span untouched — still one step_ended
    const endedClosed = await store.query({ taskId: 'task-closed', kind: ['step_ended'] })
    expect(endedClosed).toHaveLength(1)
    expect(endedClosed[0].payload.outcome).toBe('completed')

    await store.close()
  })

  it('returns 0 when the store is empty', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    const swept = await sweepOrphanRunningSpans(store)
    expect(swept).toBe(0)
    await store.close()
  })
})

describe('sweepOrphanRunningSpans — resumed attempt is a fresh span', () => {
  it('after sweeping an orphan, a new step_started creates a separate row not a mutation', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    // Step 1: orphan span from crashed daemon
    await store.record({
      kind: 'step_started',
      taskId: 'task-resume',
      originId: 'task-resume',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-resume-old', workerName: 'Coder' },
    })

    await sweepOrphanRunningSpans(store)

    // Step 2: resumed workflow creates a NEW step_started with a new workflowInstanceId
    await store.record({
      kind: 'step_started',
      taskId: 'task-resume',
      originId: 'task-resume',
      phase: 'code',
      payload: { stepName: 'run-claude-code', workflowInstanceId: 'wf-resume-new', workerName: 'Coder' },
    })

    // Old instance: has both step_started and step_ended=killed (two events)
    const oldStarted = await store.query({ taskId: 'task-resume', kind: ['step_started'], limit: 1000 })
    const startedForOld = oldStarted.filter(e => e.payload.workflowInstanceId === 'wf-resume-old')
    expect(startedForOld).toHaveLength(1)

    const oldEnded = await store.query({ taskId: 'task-resume', kind: ['step_ended'], limit: 1000 })
    const endedForOld = oldEnded.filter(e => e.payload.workflowInstanceId === 'wf-resume-old')
    expect(endedForOld).toHaveLength(1)
    expect(endedForOld[0].payload.outcome).toBe('killed')

    // New instance: has step_started, no step_ended yet (it's running)
    const startedForNew = oldStarted.filter(e => e.payload.workflowInstanceId === 'wf-resume-new')
    expect(startedForNew).toHaveLength(1)

    const endedForNew = oldEnded.filter(e => e.payload.workflowInstanceId === 'wf-resume-new')
    expect(endedForNew).toHaveLength(0)

    // Running a second sweep doesn't kill the new in-flight span
    // (it's still running — the resumed attempt is live)
    // ... but the old orphan is already closed, so sweep finds only the new running one
    // In a real daemon the new run would still be in flight so we'd expect 1 more to be swept,
    // but here we're testing the isolation: old and new are separate rows.
    const allEvents = await store.query({ taskId: 'task-resume', limit: 1000 })
    // 3 events: old step_started, old step_ended(killed), new step_started
    expect(allEvents).toHaveLength(3)

    await store.close()
  })
})
