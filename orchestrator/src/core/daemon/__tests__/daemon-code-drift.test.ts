/**
 * Tests for the level-triggered `daemon-code-drift` action-queue row.
 *
 * `daemon-code-drift` is a CONDITION_KINDS entry (action-queue-kinds.ts): per
 * ADR-0057/ADR-0094 it is derived on every read from live daemon state
 * (`deriveDaemonCodeDriftConditions` in `view/derived-conditions.ts`) and is
 * never stored as an `action_queue_items` row. Production code confirms this
 * — `server.ts`'s dev-staleness interval only logs on drift now ("Drift is
 * now surfaced as a derived condition on every action-queue read ... no
 * stored row needed"); nothing calls `raiseActionQueueItem` with this kind
 * any more.
 *
 * This file used to raise/list/supersede stored rows directly. That premise
 * is dead: `raiseActionQueueItem` still accepts the kind (it doesn't reject
 * condition kinds), but the row it inserts is deleted by the very next
 * `ensureSchema` pass (pg-schema.ts's condition-kind startup cleanup runs
 * for this exact kind), so `listActionQueueItems`/`getActionQueueItem` can
 * never observe it — confirmed empirically, not just by reading the source.
 * The tests below instead exercise the actual live mechanism: the
 * `createConditionItemsSource` factory reading injected `getCodeDrift` state.
 */

import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../lib/db.js'
import { createConditionItemsSource } from '../view/derived-conditions.js'

/** Never touched: with `kinds` restricted to daemon-code-drift, the source's
 * other per-kind derivations short-circuit before reaching the DB. */
const unusedClient: DbClient = {
  execute: () => Promise.reject(new Error('unexpected DB access in daemon-code-drift test')),
  batch: () => Promise.reject(new Error('unexpected DB access in daemon-code-drift test')),
  close: () => Promise.resolve(),
}

const KINDS = new Set(['daemon-code-drift'])

describe('daemon-code-drift derived condition', () => {
  it('derives exactly one row when sourceSha and currentSha differ', async () => {
    const source = createConditionItemsSource({
      getClient: () => unusedClient,
      getCodeDrift: () => ({
        sourceSha: 'abc1234abc1234abc1234abc1234abc1234abc1',
        currentSha: 'def5678def5678def5678def5678def5678def5',
        dependencyDrift: false,
      }),
    })

    const rows = await source.derive({ kinds: KINDS })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('daemon-code-drift')
    expect(rows[0]?.priority).toBe('high')
    expect(rows[0]?.title).toContain('abc1234')
    expect(rows[0]?.title).toContain('def5678')
  })

  it('is idempotent: the same drift state derives the same row id on every read', async () => {
    const source = createConditionItemsSource({
      getClient: () => unusedClient,
      getCodeDrift: () => ({
        sourceSha: 'abc1234abc1234abc1234abc1234abc1234abc1',
        currentSha: 'def5678def5678def5678def5678def5678def5',
        dependencyDrift: false,
      }),
    })

    const first = await source.derive({ kinds: KINDS })
    const second = await source.derive({ kinds: KINDS })
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0]?.id).toBe(first[0]?.id)
  })

  it('derives no row once currentSha catches up to sourceSha (post-restart)', async () => {
    const source = createConditionItemsSource({
      getClient: () => unusedClient,
      getCodeDrift: () => ({
        sourceSha: 'abc1234abc1234abc1234abc1234abc1234abc1',
        currentSha: 'abc1234abc1234abc1234abc1234abc1234abc1',
        dependencyDrift: false,
      }),
    })

    const rows = await source.derive({ kinds: KINDS })
    expect(rows).toHaveLength(0)
  })

  it('derives no row when there is no drift state at all (baseline)', async () => {
    const source = createConditionItemsSource({
      getClient: () => unusedClient,
      // No getCodeDrift dep supplied — mirrors a daemon build that never
      // wired up drift detection.
    })

    const rows = await source.derive({ kinds: KINDS })
    expect(rows).toHaveLength(0)
  })

  it('a fresh drift pair after the old one clears derives a different row id', async () => {
    let drift = {
      sourceSha: 'abc1234abc1234abc1234abc1234abc1234abc1',
      currentSha: 'def5678def5678def5678def5678def5678def5',
      dependencyDrift: false,
    }
    const source = createConditionItemsSource({
      getClient: () => unusedClient,
      getCodeDrift: () => drift,
    })

    const before = await source.derive({ kinds: KINDS })
    expect(before).toHaveLength(1)
    const oldId = before[0]?.id

    // "Daemon restart" — new sourceSha, new drift detected later.
    drift = {
      sourceSha: 'def5678def5678def5678def5678def5678def5',
      currentSha: 'ghi9012ghi9012ghi9012ghi9012ghi9012ghi9',
      dependencyDrift: false,
    }
    const after = await source.derive({ kinds: KINDS })
    expect(after).toHaveLength(1)
    expect(after[0]?.id).not.toBe(oldId)
  })
})
