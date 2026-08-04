import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { makeSem } from '../../core/daemon/semaphore.js'
import {
  startStewardRuntimeTune,
  decideCapHold,
  IDLE_FLOOR_PERCENT,
  MARS_SHARE_CEILING_PERCENT,
} from './steward-runtime-tune.js'
import type { OrphanSweepSummary } from '../../core/lib/orphan-reaper.js'
import type { MachinePressure } from '../../core/lib/machine-pressure.js'
import type { AutonomyLevel } from '../../core/daemon/config.js'

const summary = (reaped: number): OrphanSweepSummary => ({
  scanned: reaped,
  reaped,
  skipped: 0,
  details: [],
})

/** A 10-core box. `idle` and `marsShare` are the only knobs a test needs. */
const pressure = (idlePercent: number, marsSharePercent = 5): MachinePressure => ({
  cores: 10,
  idlePercent,
  marsCores: (marsSharePercent / 100) * 10,
  marsSharePercent,
  foreignBusyPercent: Math.max(0, 100 - idlePercent - marsSharePercent),
  marsProcessCount: 4,
  sampleMs: 1_000,
})

type Ack = ReturnType<typeof vi.fn> & ((input: unknown) => Promise<void>)
const ackSpy = (): Ack => vi.fn().mockResolvedValue(undefined) as Ack

describe('steward-runtime-tune', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.()
    vi.useRealTimers()
  })

  /**
   * `pressures` drives the CPU guard on the bump lane — a single sample is
   * returned forever, an array is consumed one reading per call so a test can
   * model "before the reap / after the reap".
   *
   * `pagingPps` is the paging rate the stubbed counter should imply. The
   * subscriber differences consecutive readings against the wall clock, so
   * the stub advances a monotonic counter by `pagingPps` per simulated second
   * and the test drives time with fake timers. Both host readers MUST be
   * injected — the real ones shell out to `ps` and `vm_stat`.
   */
  const setup = (
    cap = 12,
    overrides: {
      pressures?: MachinePressure | readonly MachinePressure[]
      sweepReaped?: number
      pagingPps?: number
      baselineCap?: number
      autonomyLevel?: AutonomyLevel
      readAutonomyLevel?: () => AutonomyLevel
    } = {},
  ) => {
    const bus = new EventEmitter()
    const implementSem = makeSem(cap)
    const log = vi.fn()
    const writeChatAck = ackSpy()
    const recordCapDecision = vi.fn()
    const runOrphanSweep = vi
      .fn()
      .mockResolvedValue(summary(overrides.sweepReaped ?? 0))
    const source = overrides.pressures ?? pressure(60)
    const queue = Array.isArray(source) ? [...source] : [source as MachinePressure]
    const readPressure = vi.fn(async () =>
      queue.length > 1 ? (queue.shift() as MachinePressure) : queue[0],
    )
    const pagingPps = overrides.pagingPps ?? 0
    const startMs = Date.now()
    const readPagingCounter = vi.fn(async () =>
      Math.round(((Date.now() - startMs) / 1000) * pagingPps),
    )
    const recordLedger = vi.fn().mockResolvedValue('ledger-1')
    const readAutonomyLevel =
      overrides.readAutonomyLevel ?? vi.fn(() => overrides.autonomyLevel ?? 'tell')
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: overrides.baselineCap ?? cap,
      log,
      repoRoot: '/repo',
      getInFlightTaskIds: () => new Set<string>(),
      recordCapDecision,
      postConversationNotice: writeChatAck,
      runOrphanSweep,
      readPressure,
      readPagingCounter,
      readAutonomyLevel,
      recordLedger,
    })
    disposers.push(stop)
    return {
      bus,
      implementSem,
      log,
      postConversationNotice: writeChatAck,
      writeChatAck,
      recordCapDecision,
      runOrphanSweep,
      readPressure,
      readPagingCounter,
      readAutonomyLevel,
      recordLedger,
    }
  }

  /**
   * Advance far enough for the subscriber to take two paging samples, which
   * is the minimum needed to compute a rate at all. One interval past the
   * start-up sample.
   */
  const primePaging = async () => {
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
  }

  describe('the autonomy lever', () => {
    it('stops tuning entirely once the operator turns the lever off', async () => {
      const { bus, implementSem, writeChatAck, recordLedger } = setup(12, {
        autonomyLevel: 'off',
      })

      bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 65_000 })
      await vi.waitFor(() => expect(implementSem.limit).toBe(12))

      // Not merely silenced: the behaviour itself is off. A Notice the
      // operator cannot act on would be worse than no Notice at all.
      expect(writeChatAck).not.toHaveBeenCalled()
      expect(recordLedger).not.toHaveBeenCalled()
    })

    it('stops shedding too, not just bumping', async () => {
      vi.useFakeTimers()
      const { implementSem, writeChatAck } = setup(12, {
        pagingPps: 5_000,
        autonomyLevel: 'off',
      })

      await primePaging()

      expect(implementSem.limit).toBe(12)
      expect(writeChatAck).not.toHaveBeenCalled()
    })

    it('treats ask as tell: a runtime knob has nobody to ask at 3am', async () => {
      const { bus, implementSem } = setup(12, { autonomyLevel: 'ask' })

      bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 65_000 })
      await vi.waitFor(() => expect(implementSem.limit).toBe(16))
    })

    it('re-reads the lever per decision, so the chip takes effect without a restart', async () => {
      let level: AutonomyLevel = 'tell'
      const { bus, implementSem } = setup(12, { readAutonomyLevel: () => level })

      bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 65_000 })
      await vi.waitFor(() => expect(implementSem.limit).toBe(16))

      level = 'off'
      bus.emit('kpi.backlog.degraded', { pending: 20, cap: 16, sustainedMs: 65_000 })
      await vi.waitFor(() => expect(implementSem.limit).toBe(16))
    })

    it('keeps protecting the host when the lever is unreadable', async () => {
      const { bus, implementSem, log } = setup(12, {
        readAutonomyLevel: () => {
          throw new Error('daemon.json lever is invalid')
        },
      })

      bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 65_000 })
      await vi.waitFor(() => expect(implementSem.limit).toBe(16))
      expect(log.mock.calls.flat().join('\n')).toContain('autonomy level unreadable')
    })
  })

  describe('the intervention ledger', () => {
    it('records a bump as durable evidence', async () => {
      const { bus, recordLedger } = setup(12)

      bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 65_000 })
      await vi.waitFor(() => expect(recordLedger).toHaveBeenCalledTimes(1))

      expect(recordLedger.mock.calls[0]![0]).toMatchObject({
        targetKind: 'daemon-cap',
        targetId: 'implement',
        targetVersion: '12',
        recipeId: 'steward-runtime-tune/bump',
        outcome: 'implement cap 12 → 16',
      })
      expect(recordLedger.mock.calls[0]![0].rationale).toContain('15 pending')
    })

    it('records a shed under its own lane', async () => {
      vi.useFakeTimers()
      const { recordLedger } = setup(12, { pagingPps: 5_000 })

      await primePaging()
      await vi.waitFor(() => expect(recordLedger).toHaveBeenCalledTimes(1))

      expect(recordLedger.mock.calls[0]![0]).toMatchObject({
        recipeId: 'steward-runtime-tune/shed',
        outcome: 'implement cap 12 → 8',
      })
    })

    it('still announces the change when the ledger write fails', async () => {
      const { bus, implementSem, writeChatAck, recordLedger, log } = setup(12)
      recordLedger.mockRejectedValue(new Error('disk full'))

      bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 65_000 })
      await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

      expect(implementSem.limit).toBe(16)
      expect(log.mock.calls.flat().join('\n')).toContain('ledger write failed')
    })
  })

  it('bumps implement cap on kpi.backlog.degraded', async () => {
    const { bus, implementSem, writeChatAck } = setup(12)
    expect(implementSem.limit).toBe(12)

    bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 65_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(implementSem.limit).toBe(16) // ceil(12 * 1.33) = 16
    expect(writeChatAck.mock.calls[0]![0]).toMatchObject({
      kind: 'steward.worker-bumped',
      payload: { from: 12, to: 16 },
    })
  })

  it('caps at 2× baseline', async () => {
    const { bus, implementSem, writeChatAck } = setup(10)
    // Manually set limit close to the 2× cap
    implementSem.limit = 19

    bus.emit('kpi.backlog.degraded', { pending: 20, cap: 19, sustainedMs: 70_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(implementSem.limit).toBe(20) // min(ceil(19*1.33)=26, 2*10=20) = 20
  })

  it('skips when already at max cap', async () => {
    const { bus, implementSem, log, writeChatAck } = setup(10)
    implementSem.limit = 20 // already at 2× baseline

    bus.emit('kpi.backlog.degraded', { pending: 25, cap: 20, sustainedMs: 80_000 })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(implementSem.limit).toBe(20)
    expect(writeChatAck).not.toHaveBeenCalled()
  })

  it('posts exactly one typed conversation Notice', async () => {
    const { bus, writeChatAck } = setup(12)

    bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(writeChatAck).toHaveBeenCalledWith({
      kind: 'steward.worker-bumped',
      payload: { from: 12, to: 16, pending: 15, threshold: 9, sustainedSeconds: 60 },
      priority: 'routine',
    })
  })

  it('does not raise a validation action-queue item', async () => {
    const { bus, writeChatAck } = setup(12)

    bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    // writeChatAck is called with kind='acknowledgment' (not 'validation')
    // The subscriber never raises an action-queue item — it calls writeChatAck only
    expect(writeChatAck).toHaveBeenCalledTimes(1)
  })

  // ── CPU guard on the bump lane ────────────────────────────────────────────
  //
  // The guard reads idle CPU and Mars's own share. Load average is not an
  // input anywhere in the subscriber, so there is nothing here to stub for it.

  it('does not sweep for orphans when there is capacity to spare', async () => {
    const { bus, writeChatAck, runOrphanSweep } = setup(12, { pressures: pressure(60) })

    bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(runOrphanSweep).not.toHaveBeenCalled()
  })

  it('raises the cap on a machine other software has loaded, as long as CPU is idle', async () => {
    // The profiled incident: load average ~275 on 10 cores, but 19.1% idle and
    // Mars a minority of the CPU. Load average is not consulted at all.
    const { bus, implementSem, log, writeChatAck, runOrphanSweep } = setup(12, {
      pressures: pressure(19.1, 12),
    })

    bus.emit('kpi.backlog.degraded', { pending: 50, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(runOrphanSweep).not.toHaveBeenCalled()
    expect(implementSem.limit).toBe(16)
    const line = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(line).toContain('capacity available')
    // The attribution must be visible: most of the busy CPU is not Mars's.
    expect(line).toContain('other software')
  })

  it('holds when the machine is genuinely out of CPU and the sweep reaps nothing', async () => {
    const { bus, implementSem, log, writeChatAck, runOrphanSweep, recordCapDecision } =
      setup(12, { pressures: pressure(2, 30), sweepReaped: 0 })

    bus.emit('kpi.backlog.degraded', { pending: 50, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(runOrphanSweep).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(implementSem.limit).toBe(12)
    expect(writeChatAck).not.toHaveBeenCalled()
    const line = log.mock.calls.map((c) => String(c[0])).join('\n')
    // The held decision must be explainable: backlog, every pressure input,
    // and the reap outcome.
    expect(line).toContain('holding implement cap at 12')
    expect(line).toContain('50 pending')
    expect(line).toContain('2.0% idle')
    expect(line).toContain('mars tree')
    expect(line).toContain('reaped 0 group(s)')
    expect(recordCapDecision).toHaveBeenCalledTimes(1)
  })

  it('holds when Mars itself is saturating the box', async () => {
    const { bus, implementSem, log } = setup(12, { pressures: pressure(40, 92) })

    bus.emit('kpi.backlog.degraded', { pending: 50, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(implementSem.limit).toBe(12)
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'mars already uses 92.0%',
    )
  })

  it('breaks the deadlock: reaps on the hold path, then re-samples and raises', async () => {
    const { bus, implementSem, log, writeChatAck, runOrphanSweep, readPressure } = setup(
      12,
      {
        // First sample: no idle CPU. After the reap the orphans' CPU is gone
        // from the very next sample — unlike a 1-minute load average.
        pressures: [pressure(3, 70), pressure(45, 20)],
        sweepReaped: 3,
      },
    )

    bus.emit('kpi.backlog.degraded', { pending: 50, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(runOrphanSweep).toHaveBeenCalledTimes(1)
    expect(readPressure).toHaveBeenCalledTimes(2)
    expect(implementSem.limit).toBe(16)
    const line = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(line).toContain('reaped 3 group(s)')
    expect(line).toContain('45.0% idle')
  })

  it('does not re-sample when the sweep reaped nothing', async () => {
    const { bus, log, readPressure } = setup(12, {
      pressures: pressure(3, 30),
      sweepReaped: 0,
    })

    bus.emit('kpi.backlog.degraded', { pending: 50, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(readPressure).toHaveBeenCalledTimes(1)
  })

  it('a failing sweep does not crash the tuner and still holds', async () => {
    const bus = new EventEmitter()
    const implementSem = makeSem(12)
    const log = vi.fn()
    const writeChatAck = ackSpy()
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: 12,
      log,
      repoRoot: '/repo',
      getInFlightTaskIds: () => new Set<string>(),
      postConversationNotice: writeChatAck,
      runOrphanSweep: () => Promise.reject(new Error('pgrep exploded')),
      readPressure: () => Promise.resolve(pressure(1, 40)),
      readPagingCounter: async () => 0,
    })
    disposers.push(stop)

    bus.emit('kpi.backlog.degraded', { pending: 50, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(implementSem.limit).toBe(12)
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'orphan sweep failed: pgrep exploded',
    )
  })

  // ── paging pressure ───────────────────────────────────────────────────────
  //
  // Memory pressure is a separate failure from a busy CPU, and it is the one
  // signal that still moves the cap *down*. These cover it on its own, with
  // the CPU guard held at a comfortable 60% idle throughout.
  //
  // Note these need TWO samples before any paging rate exists — a rate cannot
  // be observed from a single reading of a cumulative counter.

  it('sheds on paging activity even while CPU is idle', async () => {
    vi.useFakeTimers()
    const { implementSem, log } = setup(12, { pagingPps: 5_000 })

    await primePaging()

    expect(implementSem.limit).toBe(8) // floor(12 * 0.67)
    expect(log.mock.calls.flat().join(' ')).toMatch(/shed implement cap .*\(paging 5000 pages\/s >= 500\)/)
  })

  it('names paging as the resource that tripped the shed', async () => {
    vi.useFakeTimers()
    const { writeChatAck } = setup(12, { pagingPps: 5_000 })

    await primePaging()

    expect(writeChatAck.mock.calls[0]![0]).toMatchObject({
      kind: 'steward.worker-reduced',
      payload: { from: 12, to: 8, pagingPps: 5000 },
    })
  })

  it('sheds repeatedly while paging continues, never below 1', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(12, { pagingPps: 5_000 })

    // Ten sampling intervals — far more than needed to reach the floor.
    await vi.advanceTimersByTimeAsync(15_000 * 10)

    expect(implementSem.limit).toBe(1)
  })

  it('does not shed while the host is not paging', async () => {
    vi.useFakeTimers()
    const { implementSem, writeChatAck } = setup(12, { pagingPps: 0 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(12)
    expect(writeChatAck).not.toHaveBeenCalled()
  })

  it('refuses to bump while the host is paging, even when CPU and backlog allow it', async () => {
    vi.useFakeTimers()
    const { bus, implementSem, log, writeChatAck } = setup(12, { pagingPps: 5_000 })

    // Establishing the rate also sheds 12 → 8, which legitimately acks. Clear
    // both spies so the assertions below are about the bump lane only.
    await primePaging()
    log.mockClear()
    writeChatAck.mockClear()

    bus.emit('kpi.backlog.degraded', { pending: 400, cap: 12, sustainedMs: 90_000 })
    await vi.advanceTimersByTimeAsync(0)

    expect(implementSem.limit).toBe(8) // unchanged by the bump lane
    expect(writeChatAck).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join(' ')).toMatch(/paging 5000 pages\/s >= 500/)
  })

  it('treats an unreadable paging counter as no pressure', async () => {
    vi.useFakeTimers()
    // The default reader returns null when it cannot determine paging; that
    // must never shed on its own, otherwise an unknown host tanks throughput.
    const bus = new EventEmitter()
    const implementSem = makeSem(12)
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: 12,
      log: vi.fn(),
      repoRoot: '/repo',
      getInFlightTaskIds: () => new Set<string>(),
      postConversationNotice: ackSpy(),
      readPressure: () => Promise.resolve(pressure(60)),
      readPagingCounter: async () => null,
    })
    disposers.push(stop)

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(12)
  })

  it('does not shed on a high swap occupancy that is not actively paging', async () => {
    vi.useFakeTimers()
    // The regression this whole signal change exists for: measured 2026-07-30,
    // swap sat at 91% occupancy with the counters completely static twenty
    // minutes after the thrash ended. A static counter is zero pressure, and
    // the cap must be free to recover.
    const { implementSem } = setup(1, { pagingPps: 0, baselineCap: 4 })

    await primePaging()

    expect(implementSem.limit).toBeGreaterThan(1)
  })

  it('starts sampling immediately, so one interval is enough to shed', async () => {
    vi.useFakeTimers()
    // Mirrors a daemon restart onto an already-thrashing host: the cap comes
    // up at baseline and the dispatcher starts claiming slots at once. Paging
    // is a rate, so the earliest possible shed is one interval after the first
    // reading — deferring that first reading a full interval would double the
    // window in which a thrashing host admits a full complement of work.
    const { implementSem, log, readPagingCounter } = setup(12, { pagingPps: 5_000 })

    await vi.advanceTimersByTimeAsync(0)
    expect(readPagingCounter).toHaveBeenCalledTimes(1) // the start-up sample
    expect(implementSem.limit).toBe(12) // no rate yet from a single reading

    await vi.advanceTimersByTimeAsync(15_000)

    expect(implementSem.limit).toBe(8)
    expect(log.mock.calls.flat().join(' ')).toMatch(/shed implement cap 12 → 8/)
  })

  it('stops sampling after the disposer runs', async () => {
    vi.useFakeTimers()
    const bus = new EventEmitter()
    const implementSem = makeSem(12)
    const readPagingCounter = vi.fn(async () => 0)
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: 12,
      log: vi.fn(),
      repoRoot: '/repo',
      getInFlightTaskIds: () => new Set<string>(),
      postConversationNotice: ackSpy(),
      readPressure: () => Promise.resolve(pressure(60)),
      readPagingCounter,
    })

    // The immediate start-up sample already ran; what the disposer must stop
    // is every *subsequent* one.
    await vi.advanceTimersByTimeAsync(0)
    const callsBeforeStop = readPagingCounter.mock.calls.length
    expect(callsBeforeStop).toBe(1)

    stop()
    await vi.advanceTimersByTimeAsync(15_000 * 3)

    expect(readPagingCounter.mock.calls.length).toBe(callsBeforeStop)
  })

  // ── recover lane ──────────────────────────────────────────────────────────

  it('climbs back to baseline one worker at a time once pressure clears', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, { pagingPps: 0, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(0) // start-up sample
    expect(implementSem.limit).toBe(2)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(implementSem.limit).toBe(3)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(implementSem.limit).toBe(4)
  })

  it('stops recovering exactly at baseline, never above it', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, { pagingPps: 0, baselineCap: 3 })

    await vi.advanceTimersByTimeAsync(15_000 * 10)

    expect(implementSem.limit).toBe(3)
  })

  it('does not recover while the host is still paging', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, { pagingPps: 5_000, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(1)
  })

  it('does not recover a cap that is already at or above baseline', async () => {
    vi.useFakeTimers()
    const { implementSem, writeChatAck } = setup(4, { pagingPps: 0, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(4)
    expect(writeChatAck).not.toHaveBeenCalled()
  })

  it('sheds then recovers when paging spikes and stops', async () => {
    vi.useFakeTimers()
    const bus = new EventEmitter()
    const implementSem = makeSem(4)
    let pps = 5_000
    let counter = 0
    let lastMs = Date.now()
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: 4,
      log: vi.fn(),
      repoRoot: '/repo',
      getInFlightTaskIds: () => new Set<string>(),
      postConversationNotice: ackSpy(),
      readPressure: () => Promise.resolve(pressure(60)),
      readPagingCounter: async () => {
        const now = Date.now()
        counter += ((now - lastMs) / 1000) * pps
        lastMs = now
        return Math.round(counter)
      },
    })
    disposers.push(stop)

    // Thrash: 4 → 2 → 1, then held at the floor.
    await vi.advanceTimersByTimeAsync(15_000 * 5)
    expect(implementSem.limit).toBe(1)

    // Paging stops. Occupancy would still be high on a real host — the point
    // of using a rate is that recovery no longer waits on it, and no human
    // has to notice any of this happened.
    pps = 0
    await vi.advanceTimersByTimeAsync(15_000 * 6)
    expect(implementSem.limit).toBe(4)
  })
})

describe('decideCapHold', () => {
  const thresholds = {
    idleFloorPercent: IDLE_FLOOR_PERCENT,
    marsShareCeilingPercent: MARS_SHARE_CEILING_PERCENT,
  }

  it('raises when CPU is idle, however loaded the box looks by other measures', () => {
    const d = decideCapHold({ pressure: pressure(19.1, 12), ...thresholds })
    expect(d.hold).toBe(false)
    expect(d.reason).toBe('capacity-available')
  })

  it('holds below the idle floor whoever is consuming the CPU', () => {
    const d = decideCapHold({ pressure: pressure(2, 1), ...thresholds })
    expect(d.hold).toBe(true)
    expect(d.reason).toBe('machine-saturated')
    expect(d.explanation).toContain('2.0% idle')
  })

  it("holds when Mars's own share is at the ceiling", () => {
    const d = decideCapHold({
      pressure: pressure(40, MARS_SHARE_CEILING_PERCENT),
      ...thresholds,
    })
    expect(d.hold).toBe(true)
    expect(d.reason).toBe('mars-saturated')
  })

  it('the idle floor wins over the Mars-share ceiling', () => {
    expect(decideCapHold({ pressure: pressure(1, 99), ...thresholds }).reason).toBe(
      'machine-saturated',
    )
  })

  it('treats exactly-at-floor idle as available', () => {
    expect(
      decideCapHold({ pressure: pressure(IDLE_FLOOR_PERCENT, 5), ...thresholds }).hold,
    ).toBe(false)
  })

  it('always explains itself with the numbers behind the verdict', () => {
    for (const p of [pressure(60, 5), pressure(2, 1), pressure(40, 99)]) {
      expect(decideCapHold({ pressure: p, ...thresholds }).explanation.length).toBeGreaterThan(
        0,
      )
    }
  })
})
