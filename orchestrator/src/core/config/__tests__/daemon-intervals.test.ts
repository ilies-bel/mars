/**
 * Tests for `../daemon-intervals.ts`: the config-loader chokepoint for the
 * `MARS_*_MS` cadence knobs `drains.ts` / `scheduler.ts` / `sweeps.ts` used
 * to read out of `process.env` directly (the `env-reads` arch guard's NEW
 * sites after those three files were split out of `server.ts`).
 *
 * Each resolver is an injectable `(env = process.env) => value` function —
 * same shape as `resolveControlLevers` in `../levers.ts` — so a consumer can
 * be tested without touching the real process env.
 */
import { describe, expect, it } from 'vitest'
import {
  resolveCodeCheckpointIntervalMs,
  resolveDrainIntervalsMs,
  resolveIntegrationBranch,
  resolveNpmViewTimeoutMs,
  resolveSchedulerIntervalsMs,
  resolveSweepIntervalsMs,
} from '../daemon-intervals'

describe('resolveDrainIntervalsMs', () => {
  it('defaults every drain to its documented cadence when env is empty', () => {
    const intervals = resolveDrainIntervalsMs({})

    expect(intervals).toEqual({
      alertDismisser: 30_000,
      actionQueueRepopulator: 30_000,
      blockerResolution: 30_000,
      recoverySpawner: 30_000,
      recoveryAbandoned: 30_000,
      subthreadCloser: 30_000,
      archivePrompter: 30_000,
      recipeConversationNotice: 30_000,
      failureConversationNotice: 1_000,
      arcVerifier: 30_000,
      archiveEntries: 30_000,
      worktreeReclaim: 10 * 60 * 1_000,
      gateFixSteward: 30_000,
    })
  })

  it('lets a MARS_*_DRAIN_MS env var override its own knob only', () => {
    const intervals = resolveDrainIntervalsMs({
      MARS_ALERT_DRAIN_MS: '5000',
      MARS_GATE_FIX_STEWARD_DRAIN_MS: '9000',
    })

    expect(intervals.alertDismisser).toBe(5_000)
    expect(intervals.gateFixSteward).toBe(9_000)
    expect(intervals.archiveEntries).toBe(30_000)
  })
})

describe('resolveSchedulerIntervalsMs', () => {
  it('defaults both scheduler timers to 30s when env is empty', () => {
    expect(resolveSchedulerIntervalsMs({})).toEqual({
      pollFallback: 30_000,
      queuedDispatchSweep: 30_000,
    })
  })

  it('reads MARS_DRAIN_POLL_MS and MARS_QUEUED_DISPATCH_SWEEP_MS independently', () => {
    const intervals = resolveSchedulerIntervalsMs({
      MARS_DRAIN_POLL_MS: '60000',
      MARS_QUEUED_DISPATCH_SWEEP_MS: '25',
    })

    expect(intervals.pollFallback).toBe(60_000)
    expect(intervals.queuedDispatchSweep).toBe(25)
  })
})

describe('resolveSweepIntervalsMs', () => {
  it('defaults every sweep cadence to its documented value when env is empty', () => {
    expect(resolveSweepIntervalsMs({})).toEqual({
      committerLifetime: 45 * 60_000,
      staleSweep: 5 * 60_000,
      orphanSweep: 5 * 60_000,
      observabilityWatchdog: 5 * 60_000,
      dbBusyWatchdog: 30_000,
      outboxPrune: 60_000,
      observabilitySweep: 60 * 60_000,
      kpiSnapshot: 60 * 60_000,
      noticeSweep: 60 * 60_000,
      backlogCheck: 10_000,
      backlogSustain: 60_000,
      reflectDetector: 5 * 60_000,
      phantomWatchdog: 5 * 60_000,
    })
  })

  it('overrides MARS_COMMITTER_LIFETIME_MS and MARS_PHANTOM_WATCHDOG_MS independently', () => {
    const intervals = resolveSweepIntervalsMs({
      MARS_COMMITTER_LIFETIME_MS: '120000',
      MARS_PHANTOM_WATCHDOG_MS: '15000',
    })

    expect(intervals.committerLifetime).toBe(120_000)
    expect(intervals.phantomWatchdog).toBe(15_000)
    expect(intervals.staleSweep).toBe(5 * 60_000)
  })
})

describe('resolveIntegrationBranch', () => {
  it('defaults to "main" when INTEGRATION_BRANCH is unset', () => {
    expect(resolveIntegrationBranch({})).toBe('main')
  })

  it('follows an explicit INTEGRATION_BRANCH override', () => {
    expect(resolveIntegrationBranch({ INTEGRATION_BRANCH: 'release' })).toBe('release')
  })
})

describe('resolveCodeCheckpointIntervalMs', () => {
  it('defaults to three minutes when MARS_CODE_CHECKPOINT_INTERVAL_MS is unset', () => {
    expect(resolveCodeCheckpointIntervalMs({})).toBe(3 * 60 * 1_000)
  })

  it('follows an explicit MARS_CODE_CHECKPOINT_INTERVAL_MS override', () => {
    expect(resolveCodeCheckpointIntervalMs({ MARS_CODE_CHECKPOINT_INTERVAL_MS: '5000' })).toBe(5_000)
  })
})

describe('resolveNpmViewTimeoutMs', () => {
  it('defaults to 15s when MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS is unset', () => {
    expect(resolveNpmViewTimeoutMs({})).toBe(15_000)
  })

  it('follows an explicit MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS override', () => {
    expect(resolveNpmViewTimeoutMs({ MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS: '3000' })).toBe(3_000)
  })

  /**
   * This resolver deliberately does NOT share {@link resolveDrainIntervalsMs}'s
   * `Number(env[x] ?? fallback)` shape. It bounds a network call the baseline
   * repairer blocks on, so a garbage override must land on the default rather
   * than on `NaN` — `NaN` would silently remove the bound entirely.
   */
  it('falls back to the default rather than NaN on a non-numeric override', () => {
    expect(resolveNpmViewTimeoutMs({ MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS: 'soon' })).toBe(
      15_000,
    )
  })

  it('treats a zero override as unset, since a 0ms timeout would abort every lookup', () => {
    expect(resolveNpmViewTimeoutMs({ MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS: '0' })).toBe(15_000)
  })
})
