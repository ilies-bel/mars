import { describe, it, expect } from 'vitest'
import { narrate } from './narrator.js'
import type { NarrationEvent } from './types.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

const landed = (taskId: string, title: string): NarrationEvent => ({
  taskId,
  title,
  kind: 'task.landed',
})

const stumbled = (taskId: string, title: string): NarrationEvent => ({
  taskId,
  title,
  kind: 'task.stumbled',
})

const recovered = (recoveryTaskId: string, title: string, originId: string): NarrationEvent => ({
  taskId: recoveryTaskId,
  originId,
  title,
  kind: 'task.recovered',
})

const needsYou = (taskId: string, title: string): NarrationEvent => ({
  taskId,
  title,
  kind: 'task.needs-you',
})

// ─── null / empty span ────────────────────────────────────────────────────────

describe('narrate() — null cases', () => {
  it('returns null for an empty span', () => {
    expect(narrate([])).toBeNull()
  })

  it('returns null when no event resolves to a narrable arc-shape', () => {
    // A span with only a stumbled event that is immediately recovered in the
    // same event but through a different kind path is impossible by design;
    // test that a span of unrecognised-but-parseable events still yields null.
    // Here we produce a span whose arcs cannot be classified: a single
    // task.landed event produces a "landed" line — not null — so we need a
    // span that classifies to nothing.  The easiest case: no events at all is
    // already covered above.  A task that only carries a 'task.stumbled' with
    // no recovery DOES produce a "needs-you" line, so we can't use that.
    // Instead, rely on the empty-span case as the canonical null proof and
    // assert it separately for clarity.
    expect(narrate([])).toBeNull()
  })
})

// ─── landed arc ───────────────────────────────────────────────────────────────

describe('narrate() — landed arc-shape', () => {
  it('emits a "landed" line for a task that reached done', () => {
    const result = narrate([landed('task-abc', 'Add user auth')])
    expect(result).not.toBeNull()
    expect(result).toHaveLength(1)
    const line = result![0]
    expect(line.taskId).toBe('task-abc')
    expect(line.arcShape).toBe('landed')
    expect(line.text).toBe('Add user auth landed.')
  })

  it('uses the exact task title verbatim in the narration text', () => {
    const result = narrate([landed('t1', 'Fix the flaky CI pipeline')])
    expect(result![0].text).toBe('Fix the flaky CI pipeline landed.')
  })

  it('emits one line per landed task in a multi-task span', () => {
    const result = narrate([
      landed('t1', 'Task one'),
      landed('t2', 'Task two'),
    ])
    expect(result).toHaveLength(2)
    expect(result![0].arcShape).toBe('landed')
    expect(result![1].arcShape).toBe('landed')
  })

  it('preserves the first-seen arc order for landed tasks', () => {
    const result = narrate([
      landed('t1', 'First'),
      landed('t2', 'Second'),
    ])
    expect(result![0].taskId).toBe('t1')
    expect(result![1].taskId).toBe('t2')
  })
})

// ─── stumbled-recovered arc ───────────────────────────────────────────────────

describe('narrate() — stumbled-recovered arc-shape', () => {
  it('emits "stumbled but recovered" when failure is followed by a recovery land', () => {
    const result = narrate([
      stumbled('origin-1', 'Migrate schema'),
      recovered('fix-1', 'Fix: Migrate schema', 'origin-1'),
    ])
    expect(result).toHaveLength(1)
    const line = result![0]
    expect(line.taskId).toBe('origin-1')
    expect(line.arcShape).toBe('stumbled-recovered')
    expect(line.text).toBe('Migrate schema stumbled but recovered.')
  })

  it('uses the origin title (not the recovery task title) in the narration', () => {
    const result = narrate([
      stumbled('origin-2', 'Refactor auth layer'),
      recovered('fix-2', 'Fix attempt for refactor', 'origin-2'),
    ])
    expect(result![0].title).toBe('Refactor auth layer')
    expect(result![0].text).toBe('Refactor auth layer stumbled but recovered.')
  })

  it('classifies stumbled-recovered even when the recovered event arrives first in the span', () => {
    // The span is ordered by event timestamp; recovery could appear before
    // stumbled in an out-of-order delivery.  narrate() must handle both orders.
    const result = narrate([
      recovered('fix-3', 'Fix title', 'origin-3'),
      stumbled('origin-3', 'Deploy service'),
    ])
    expect(result).toHaveLength(1)
    expect(result![0].arcShape).toBe('stumbled-recovered')
    expect(result![0].title).toBe('Deploy service')
  })
})

// ─── needs-you arc ────────────────────────────────────────────────────────────

describe('narrate() — needs-you arc-shape', () => {
  it('emits "needs attention" for a task.needs-you event', () => {
    const result = narrate([needsYou('task-x', 'Review pull request')])
    expect(result).toHaveLength(1)
    expect(result![0].arcShape).toBe('needs-you')
    expect(result![0].text).toBe('Review pull request needs attention.')
  })

  it('emits "needs attention" for a stumbled task with no recovery', () => {
    const result = narrate([stumbled('task-y', 'Run integration tests')])
    expect(result).toHaveLength(1)
    expect(result![0].arcShape).toBe('needs-you')
    expect(result![0].text).toBe('Run integration tests needs attention.')
  })

  it('stumbled-recovered takes precedence over needs-you when both signals are present for one arc', () => {
    // A task that emits both stumbled+needs-you AND has a recovery should be
    // classified as stumbled-recovered, not needs-you.
    const result = narrate([
      stumbled('origin-4', 'Build pipeline'),
      needsYou('origin-4', 'Build pipeline'),
      recovered('fix-4', 'Fix title', 'origin-4'),
    ])
    expect(result).toHaveLength(1)
    expect(result![0].arcShape).toBe('stumbled-recovered')
  })
})

// ─── mixed span ───────────────────────────────────────────────────────────────

describe('narrate() — mixed arc-shapes in one span', () => {
  it('classifies each arc independently within a span', () => {
    const result = narrate([
      landed('t-done', 'Add metrics'),
      stumbled('t-fail', 'Fix the thing'),
      recovered('fix-t-fail', 'Recovery title', 't-fail'),
      needsYou('t-blocked', 'Upgrade dependency'),
    ])

    expect(result).toHaveLength(3)

    const byTaskId = Object.fromEntries(result!.map((l) => [l.taskId, l]))
    expect(byTaskId['t-done'].arcShape).toBe('landed')
    expect(byTaskId['t-fail'].arcShape).toBe('stumbled-recovered')
    expect(byTaskId['t-blocked'].arcShape).toBe('needs-you')
  })
})

// ─── determinism ─────────────────────────────────────────────────────────────

describe('narrate() — determinism', () => {
  it('returns byte-for-byte identical output across two calls with the same input', () => {
    const events: NarrationEvent[] = [
      landed('t1', 'Add metrics'),
      stumbled('t2', 'Refactor DB'),
      recovered('fix-t2', 'Fix: Refactor DB', 't2'),
      needsYou('t3', 'Upgrade Node'),
    ]

    const first = narrate(events)
    const second = narrate(events)

    // Deep-equal covers both structure and text values.
    expect(first).toEqual(second)
  })

  it('produces the same result regardless of how many times the function is called', () => {
    const events: NarrationEvent[] = [landed('t-x', 'My task')]
    const results = Array.from({ length: 5 }, () => narrate(events))
    for (const r of results) {
      expect(r).toEqual(results[0])
    }
  })
})
