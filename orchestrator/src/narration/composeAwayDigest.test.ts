import { describe, it, expect } from 'vitest'
import { composeAwayDigest } from './composeAwayDigest.js'
import type { NarrationEvent } from './types.js'

// ─── event builders ───────────────────────────────────────────────────────────

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

// ─── fake loader ──────────────────────────────────────────────────────────────

const fakeLoader = (events: NarrationEvent[]) =>
  (_fromTs: number, _toTs: number): Promise<NarrationEvent[]> =>
    Promise.resolve(events)

// ─── empty span ───────────────────────────────────────────────────────────────

describe('composeAwayDigest() — empty span', () => {
  it('returns null when the span has no events', async () => {
    const result = await composeAwayDigest(1000, 2000, { loadEvents: fakeLoader([]) })
    expect(result).toBeNull()
  })

  it('delegates to the loader with the given fromTs and toTs', async () => {
    const calls: Array<[number, number]> = []
    const trackingLoader = (from: number, to: number): Promise<NarrationEvent[]> => {
      calls.push([from, to])
      return Promise.resolve([])
    }

    await composeAwayDigest(1000, 2000, { loadEvents: trackingLoader })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([1000, 2000])
  })
})

// ─── landed-only span ─────────────────────────────────────────────────────────

describe('composeAwayDigest() — span with only successful work', () => {
  it('returns a digest with landed count > 0', async () => {
    const events = [landed('t1', 'Add metrics'), landed('t2', 'Migrate schema')]
    const result = await composeAwayDigest(0, 9999, { loadEvents: fakeLoader(events) })

    expect(result).not.toBeNull()
    expect(result!.counts.landed).toBe(2)
    expect(result!.counts['stumbled-recovered']).toBe(0)
    expect(result!.counts['needs-you']).toBe(0)
  })

  it('includes one narration line per landed arc', async () => {
    const events = [landed('t1', 'Add metrics'), landed('t2', 'Migrate schema')]
    const result = await composeAwayDigest(0, 9999, { loadEvents: fakeLoader(events) })

    expect(result!.lines).toHaveLength(2)
    expect(result!.lines[0].arcShape).toBe('landed')
    expect(result!.lines[1].arcShape).toBe('landed')
  })
})

// ─── mixed span ───────────────────────────────────────────────────────────────

describe('composeAwayDigest() — mixed span', () => {
  it('populates all three counts when the span has all arc-shapes', async () => {
    const events = [
      landed('t-done', 'Ship the feature'),
      stumbled('t-fail', 'Fix the thing'),
      recovered('fix-t-fail', 'Recovery title', 't-fail'),
      needsYou('t-blocked', 'Upgrade dependency'),
    ]

    const result = await composeAwayDigest(0, 9999, { loadEvents: fakeLoader(events) })

    expect(result).not.toBeNull()
    expect(result!.counts.landed).toBe(1)
    expect(result!.counts['stumbled-recovered']).toBe(1)
    expect(result!.counts['needs-you']).toBe(1)
  })

  it('produces a line for each arc in the span', async () => {
    const events = [
      landed('t-done', 'Ship the feature'),
      stumbled('t-fail', 'Fix the thing'),
      recovered('fix-t-fail', 'Recovery title', 't-fail'),
      needsYou('t-blocked', 'Upgrade dependency'),
    ]

    const result = await composeAwayDigest(0, 9999, { loadEvents: fakeLoader(events) })

    expect(result!.lines).toHaveLength(3)

    const byTaskId = Object.fromEntries(result!.lines.map((l) => [l.taskId, l]))
    expect(byTaskId['t-done'].arcShape).toBe('landed')
    expect(byTaskId['t-fail'].arcShape).toBe('stumbled-recovered')
    expect(byTaskId['t-blocked'].arcShape).toBe('needs-you')
  })

  it('counts each stumbled-without-recovery arc as needs-you', async () => {
    const events = [
      landed('t-done', 'Ship the feature'),
      stumbled('t-fail-unrecovered', 'Failing task'),
      needsYou('t-blocked', 'Needs operator'),
    ]

    const result = await composeAwayDigest(0, 9999, { loadEvents: fakeLoader(events) })

    expect(result).not.toBeNull()
    expect(result!.counts.landed).toBe(1)
    expect(result!.counts['stumbled-recovered']).toBe(0)
    expect(result!.counts['needs-you']).toBe(2)
  })
})

// ─── null narration ───────────────────────────────────────────────────────────

describe('composeAwayDigest() — null when narrator has nothing to say', () => {
  it('returns null and does not produce a digest when narrator returns null', async () => {
    // An empty event list is the canonical case where narrate() returns null.
    const result = await composeAwayDigest(500, 1500, { loadEvents: fakeLoader([]) })
    expect(result).toBeNull()
  })
})
