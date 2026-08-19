import { describe, expect, it } from 'vitest'
import { buildSituationReport, countNeedsYou } from '../situation-report'

describe('buildSituationReport', () => {
  it('summarises the current task, worker, and attention state without a provider', async () => {
    const report = await buildSituationReport({
      listTasks: async () => [
        { status: 'queued' },
        { status: 'running' },
        { status: 'blocked' },
        { status: 'failed' },
      ],
      getSemaphoreSnapshot: () => ({ inUse: 2, limit: 5 }),
      listActionQueue: async () => [{}, {}],
    })

    expect(report).toBe(
      'Situation: 1 queued task, 1 running task, 1 blocked task, and 1 failed task. Workers: 2 of 5 active. 2 items need attention.',
    )
  })

  it('does not count draft-proposal rows in the attention count', async () => {
    const report = await buildSituationReport({
      listTasks: async () => [],
      getSemaphoreSnapshot: () => ({ inUse: 0, limit: 0 }),
      listActionQueue: async () => [
        { kind: 'failed' },
        { kind: 'draft-proposal' },
        { kind: 'draft-proposal' },
        { kind: 'stale-queued' },
      ],
    })

    expect(report).toContain('2 items need attention.')
    expect(report).not.toContain('4 items')
  })

  // Every zero in this report has one cause when dispatch is paused. Reporting
  // them without saying so reads as "idle and healthy" rather than "frozen".
  it('names the pause so the zeros are explained', async () => {
    const report = await buildSituationReport({
      listTasks: async () => [],
      getSemaphoreSnapshot: () => ({ inUse: 0, limit: 14 }),
      listActionQueue: async () => [],
      getDispatchState: () => ({ paused: true, reason: 'storm' }),
    })

    expect(report).toContain('0 queued tasks')
    expect(report).toContain('Dispatch is paused by the signature-storm breaker')
    expect(report).toContain('no new work is being dispatched')
  })

  it('says nothing about dispatch when it is running', async () => {
    const report = await buildSituationReport({
      listTasks: async () => [],
      getSemaphoreSnapshot: () => ({ inUse: 0, limit: 14 }),
      listActionQueue: async () => [],
      getDispatchState: () => ({ paused: false, reason: null }),
    })

    expect(report).not.toContain('Dispatch')
    expect(report.endsWith('need attention.')).toBe(true)
  })

  // `getDispatchState` is optional, so a caller that never wires it up must
  // degrade to the pre-pause-clause report rather than throwing or guessing.
  it('omits the pause clause when the dispatch source is not wired up', async () => {
    const report = await buildSituationReport({
      listTasks: async () => [],
      getSemaphoreSnapshot: () => ({ inUse: 0, limit: 14 }),
      listActionQueue: async () => [],
    })

    expect(report).not.toContain('Dispatch')
    expect(report.endsWith('need attention.')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// countNeedsYou — the single canonical "needs you" count shared by every UI
// surface (triage badge, sidebar badge, chat greeting, situation card). This
// fixture — 5 individual 'failed' rows + 9 'awaiting-human' rows (a kind
// that collapses into a single cluster row on the triage page once it
// exceeds CLUSTER_THRESHOLD=5) + 20 'draft-proposal' rows — mirrors the
// fixture used in ui/src/entities/actionQueue/needsYouParity.test.tsx so a
// backend regression and a frontend regression assert against the identical
// expected integer (14), proving the two implementations agree.
// ---------------------------------------------------------------------------

describe('countNeedsYou', () => {
  const sharedFixture = [
    ...Array.from({ length: 5 }, () => ({ kind: 'failed' })),
    ...Array.from({ length: 9 }, () => ({ kind: 'awaiting-human' })),
    ...Array.from({ length: 20 }, () => ({ kind: 'draft-proposal' })),
  ]

  it('excludes draft-proposal rows and counts everything else, unclustered', () => {
    expect(countNeedsYou(sharedFixture)).toBe(14)
  })

  it('feeds buildSituationReport the same number', async () => {
    const report = await buildSituationReport({
      listTasks: async () => [],
      getSemaphoreSnapshot: () => ({ inUse: 0, limit: 0 }),
      listActionQueue: async () => sharedFixture,
    })
    expect(report).toContain('14 items need attention.')
  })

  // Complementary fixture: ONE task (shared entityId) holding three
  // independently-derived condition rows (failed + recovery-abandoned +
  // gate-broken) — the ADR-0057 scenario that used to inflate every "needs
  // you" surface to 3 for what is really one task needing attention. Mirrors
  // ui/src/entities/actionQueue/needsYouParity.test.tsx's `groupedFixture`
  // and clusterRows.test.ts's `liveTripleForOneTask`. `sharedFixture` above
  // never exercises this path — every one of its rows lacks an entityId.
  it('dedups several condition rows sharing one entityId to a single subject', () => {
    const groupedFixture = [
      { kind: 'failed', entityId: 'mars-shared-001' },
      { kind: 'recovery-abandoned', entityId: 'mars-shared-001' },
      { kind: 'gate-broken', entityId: 'mars-shared-001' },
    ]

    expect(countNeedsYou(groupedFixture)).toBe(1)
  })
})
