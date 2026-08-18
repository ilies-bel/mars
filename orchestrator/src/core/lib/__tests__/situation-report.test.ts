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
})
