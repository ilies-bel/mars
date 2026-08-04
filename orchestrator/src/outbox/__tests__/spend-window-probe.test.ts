import { beforeEach, describe, expect, it } from 'vitest'
import { type DbClient } from '../../core/lib/db.js'
import { getTestDb } from '../../../test/db-fixture.js'
import { insertUsageSnapshot } from '../../core/lib/usage-snapshot-store.js'
import { probeSpendWindow } from '../spend-control-inputs.js'

describe('probeSpendWindow', () => {
  let client: DbClient

  beforeEach(async () => {
    client = await getTestDb()
  })

  it('returns zero pressure when no windowTokens is configured', async () => {
    const result = await probeSpendWindow(client, false)
    expect(result).toEqual({ usedPct: 0, wasPaused: false })
  })

  it('returns zero pressure when usage_snapshots is empty', async () => {
    const result = await probeSpendWindow(client, false, { windowTokens: 1_000_000 })
    expect(result).toEqual({ usedPct: 0, wasPaused: false })
  })

  it('computes usedPct from the latest snapshot against windowTokens', async () => {
    // 500k input + 500k output = 1M total; ceiling = 2M → 50%
    await insertUsageSnapshot(
      {
        capturedAt: new Date().toISOString(),
        inputTokens: 500_000,
        outputTokens: 500_000,
        windowKind: 'rolling',
        rawJson: {},
      },
      client,
    )

    const result = await probeSpendWindow(client, false, { windowTokens: 2_000_000 })
    expect(result.usedPct).toBeCloseTo(50, 1)
    expect(result.wasPaused).toBe(false)
  })

  it('caps usedPct at 100 when tokens exceed the ceiling', async () => {
    await insertUsageSnapshot(
      {
        capturedAt: new Date().toISOString(),
        inputTokens: 3_000_000,
        outputTokens: 0,
        windowKind: 'rolling',
        rawJson: {},
      },
      client,
    )

    const result = await probeSpendWindow(client, false, { windowTokens: 1_000_000 })
    expect(result.usedPct).toBe(100)
  })

  it('threads wasPaused through to the returned SpendWindow', async () => {
    const result = await probeSpendWindow(client, true, { windowTokens: 1_000_000 })
    expect(result.wasPaused).toBe(true)
  })

  it('uses the latest snapshot when multiple rows exist', async () => {
    const now = Date.now()
    const older = new Date(now - 120_000).toISOString()
    const newer = new Date(now - 10_000).toISOString()

    await insertUsageSnapshot(
      { capturedAt: older, inputTokens: 100, outputTokens: 0, windowKind: 'rolling', rawJson: {} },
      client,
    )
    await insertUsageSnapshot(
      { capturedAt: newer, inputTokens: 900_000, outputTokens: 100_000, windowKind: 'rolling', rawJson: {} },
      client,
    )

    const result = await probeSpendWindow(client, false, { windowTokens: 1_000_000 })
    // Latest snapshot has 900k + 100k = 1M → 100%
    expect(result.usedPct).toBe(100)
  })
})
