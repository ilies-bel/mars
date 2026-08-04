import type { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { promisify } from 'node:util'
import { setSemLimit, type Semaphore } from '../../core/daemon/semaphore.js'
import {
  postConversationNotice,
  type ConversationNoticeInput,
} from '../../core/lib/conversation-delivery.js'
import {
  sweepOrphans,
  formatSweepSummary,
  type OrphanSweepSummary,
} from '../../core/lib/orphan-reaper.js'
import {
  formatPressure,
  samplePressure,
  type MachinePressure,
} from '../../core/lib/machine-pressure.js'
import { readLeverAutonomyLevel, type AutonomyLevel } from '../../core/daemon/config.js'
import { STEWARD_RUNTIME_TUNE_LEVER } from '../../core/lib/conversation-copy.js'
import {
  recordStewardIntervention,
  type StewardLedgerEntry,
} from '../../core/steward-ledger.js'

const execFileAsync = promisify(execFile)

/**
 * Steward autonomous runtime-knob tuning.
 *
 * Three lanes, all autonomous (no validation action-queue item is raised —
 * ADR-0077):
 *
 *  - **bump** — a sustained implement-queue backlog raises the implement
 *    semaphore cap, bounded at 2× baseline. Gated on CPU capacity and on
 *    paging.
 *  - **shed** — sustained paging *lowers* the cap, bounded at {@link MIN_CAP}.
 *  - **recover** — once paging clears, the cap climbs back to `baselineCap`
 *    one worker at a time.
 *
 * The shed lane exists because backlog on its own is a misleading signal.
 * Tasks that fail fast (an API outage, a saturated host) drain the queue
 * slower than it fills, so the backlog grows — and reading that as "add more
 * workers" raises pressure, slows every in-flight run further, and grows the
 * backlog again. That positive feedback loop is what the gate on the bump
 * lane and the shed lane together break.
 *
 * The recover lane exists because shed-without-recover is a one-way ratchet.
 * A single transient spike would otherwise pin the cap at its floor forever
 * (observed 2026-07-30: cap rode 4 → 1 and could not climb back).
 *
 * ## The CPU guard, and why load average is not part of it
 *
 * Raising the cap on a machine that is genuinely out of CPU only makes things
 * worse, so the tuner holds when capacity is exhausted. The signal it uses to
 * decide that matters enormously.
 *
 * The original guard compared raw `loadavg()[0] / cores` against 1.5. On a
 * profiled machine whose cap had been pinned at 1, that number peaked around
 * 275 on 10 cores while the CPU was 48.8 % user / 32.5 % sys / **19.1 % idle**
 * — there was capacity to spare. The load was dominated by a corporate
 * endpoint-security agent (155 % CPU), `fseventsd` (51 %) and Spotlight
 * indexing ~40 worktrees of `node_modules`; Mars's own processes were a
 * minority. Against an always-on security scanner a 1.5-per-core ceiling is
 * never satisfiable, so the cap stayed pinned forever — and reaping orphans
 * could not fix it, because most of the load was never Mars's to begin with.
 *
 * Load average is therefore consulted nowhere in this file. The CPU guard
 * throttles on two direct measurements instead
 * (see `core/lib/machine-pressure.ts`):
 *
 *   - **idle CPU %** — a safety floor. Below {@link IDLE_FLOOR_PERCENT} the
 *     machine really is out of capacity and we hold no matter whose load it is.
 *   - **Mars's own CPU share** — above {@link MARS_SHARE_CEILING_PERCENT} of
 *     the box, Mars is saturating it itself and more workers will not help.
 *
 * Other software's CPU is reported but never, on its own, a reason to throttle.
 *
 * Before holding, the tuner sweeps for orphaned verify subprocesses (leaked
 * test runners reparented to init). If the sweep reaps anything it re-samples
 * and re-decides on the fresh numbers — the reaped CPU is gone immediately,
 * unlike a 1-minute load average, so the second sample is honest. Every input
 * to the decision is printed on the `[steward-tune]` line: a held cap must be
 * explainable, and must never look authoritative while resting on noise from
 * other software.
 *
 * The CPU guard gates *growth* only; it deliberately does not drive the shed
 * lane. On a box whose idle CPU is depressed by software Mars does not own, a
 * CPU-driven shed is exactly the one-way ratchet that pinned the cap at 1 in
 * the first place, and `baselineCap` is the value the operator configured.
 * Refusing to grow is the right response to a busy CPU; shrinking is not.
 *
 * ## Why paging still drives the shed and recover lanes
 *
 * Memory pressure is a different failure with a different correct response.
 * Observed 2026-07-30: the host was paging while every verify suite held
 * 1-2 GB of PGlite. Unlike a merely busy CPU, a thrashing host makes
 * in-flight work arbitrarily slower and admission control is the only lever
 * available, so the shed lane stays — on the memory signal alone.
 *
 * The honest memory signal is the *rate* of paging — neither how much swap is
 * occupied nor `os.freemem()`.
 *
 * `os.freemem()` is out because macOS reports most RAM as non-free even when
 * healthy (measured 0.45 GB "free" of 64 GB total), so a threshold on it
 * sheds continuously on an idle machine.
 *
 * Swap *occupancy* is out because it is a high-water mark, not a pressure
 * reading: pages stay parked in swap until something touches them again.
 * Measured 2026-07-30, twenty minutes after a thrash had ended — occupancy
 * 91% with Swapins and Swapouts both completely static across a 5-second
 * window. Gating on occupancy pins the cap at its floor on a machine that has
 * fully recovered, which is the same one-way ratchet the recover lane exists
 * to prevent.
 *
 * Swap *activity* — the delta in `vm_stat`'s Swapins + Swapouts counters
 * between samples — drops to zero the moment thrashing stops. That is exactly
 * the property both the shed and the recover lane need.
 *
 * Lowering a cap never kills in-flight work: `setSemLimit` only moves the
 * ceiling, so `acquire` simply stops handing out slots until `inUse` falls
 * below the new limit. This means the lanes bound *admission*, not
 * consumption — they prevent the next spiral, they cannot end one already
 * under way.
 */
export interface StewardRuntimeTuneDeps {
  bus: EventEmitter
  implementSem: Semaphore
  baselineCap: number
  log: (line: string) => void
  /** Repo root, used to scope the orphan sweep to this repo's worktrees. */
  repoRoot: string
  /** Live in-flight task ids — their verify subprocesses are healthy. */
  getInFlightTaskIds: () => ReadonlySet<string>
  /**
   * Called whenever the tuner changes (or declines to change) the implement
   * cap, with a one-line operator-facing reason — or `null` once the cap is
   * back in agreement with the configured value. Surfaced by
   * `mars daemon status` as the effective-cap explanation.
   */
  recordCapDecision?: (reason: string | null) => void
  /** Override for testing — defaults to durable conversation Notice delivery. */
  postConversationNotice?: (input: ConversationNoticeInput) => Promise<unknown>
  /** Override for testing — defaults to the real orphan sweep. */
  runOrphanSweep?: () => Promise<OrphanSweepSummary>
  /** Override for testing — defaults to the real machine-pressure sample. */
  readPressure?: () => Promise<MachinePressure>
  /**
   * Override for testing — defaults to reading
   * {@link STEWARD_RUNTIME_TUNE_LEVER} from daemon.json.
   */
  readAutonomyLevel?: () => AutonomyLevel
  /** Override for testing — defaults to the durable Steward ledger. */
  recordLedger?: (entry: StewardLedgerEntry) => Promise<unknown>
  /**
   * Override for testing — returns the host's *cumulative* count of pages
   * swapped in plus out since boot. The subscriber differences consecutive
   * samples to get a rate; a monotonic counter is all this needs to return.
   *
   * Must be injected in tests: the default shells out to `vm_stat` on Darwin
   * and reads `/proc/vmstat` on Linux, neither of which belongs in a unit
   * test. Return `null` when the figure cannot be determined.
   */
  readPagingCounter?: () => Promise<number | null>
}

const BUMP_FACTOR = 1.33
const SHED_FACTOR = 0.67

/**
 * Safety floor. Below this much idle CPU the machine is genuinely out of
 * capacity and the tuner holds regardless of who is consuming it. Kept low
 * precisely so that other software's load does not throttle Mars: the
 * profiled "overloaded" machine still had 19 % idle.
 */
export const IDLE_FLOOR_PERCENT = Number(process.env.MARS_TUNE_IDLE_FLOOR_PCT ?? 10)

/**
 * Ceiling on Mars's OWN share of the box. Above this, more implement workers
 * cannot help — Mars is already the thing saturating the machine.
 */
export const MARS_SHARE_CEILING_PERCENT = Number(
  process.env.MARS_TUNE_SELF_SHARE_CEILING_PCT ?? 85,
)

/**
 * Pages swapped per second above which the host counts as actively paging.
 * Darwin pages are 16 KiB on Apple Silicon, so 500 pages/s is roughly 8 MB/s
 * of swap traffic — well clear of incidental activity, well below a thrash
 * (the 2026-07-30 incident sustained orders of magnitude more), and it falls
 * to a hard zero once thrashing stops.
 */
const PAGING_ACTIVE_PPS = 500

/**
 * Shed once paging reaches this rate. Deliberately the same threshold as
 * {@link PAGING_ACTIVE_PPS}: paging is not a matter of degree — a host either
 * is or is not swapping, and any sustained swapping while running
 * memory-heavy jobs is already the failure.
 */
const PAGING_SHED_TRIGGER = PAGING_ACTIVE_PPS

/** How often the shed and recover lanes sample paging. */
const SHED_CHECK_MS = 15_000

/** Never shed below one worker — `setSemLimit` rejects a limit under 1. */
const MIN_CAP = 1

export interface CapHoldDecision {
  hold: boolean
  reason: 'capacity-available' | 'machine-saturated' | 'mars-saturated' | 'host-paging'
  /** Operator-facing justification, including the numbers behind it. */
  explanation: string
}

/**
 * Decide whether to hold the implement cap, given one machine-pressure sample.
 *
 * Pure, so the rule that broke the production deadlock is unit-testable:
 *
 * 1. idle below the floor → hold. The box really has no capacity left.
 * 2. Mars's own share above the ceiling → hold. More workers will not help.
 * 3. otherwise → raise, EVEN IF the system load average is enormous. Load
 *    average is not consulted anywhere: on the profiled machine it was ~275
 *    while 19 % of the CPU sat idle, because it counts blocked threads from a
 *    filesystem-event storm that Mars neither caused nor can fix.
 *
 * Paging is not an input here — it is a rate, so it cannot be read from a
 * single sample. {@link startStewardRuntimeTune} applies it as an additional
 * hold condition ahead of this one.
 */
export const decideCapHold = (input: {
  pressure: MachinePressure
  idleFloorPercent: number
  marsShareCeilingPercent: number
}): CapHoldDecision => {
  const { pressure: p } = input
  if (p.idlePercent < input.idleFloorPercent) {
    return {
      hold: true,
      reason: 'machine-saturated',
      explanation: `${p.idlePercent.toFixed(1)}% idle is below the ${input.idleFloorPercent}% floor`,
    }
  }
  if (p.marsSharePercent >= input.marsShareCeilingPercent) {
    return {
      hold: true,
      reason: 'mars-saturated',
      explanation: `mars already uses ${p.marsSharePercent.toFixed(1)}% of the machine (ceiling ${input.marsShareCeilingPercent}%)`,
    }
  }
  return {
    hold: false,
    reason: 'capacity-available',
    explanation: `${p.idlePercent.toFixed(1)}% idle and mars at ${p.marsSharePercent.toFixed(1)}% — capacity available`,
  }
}

/**
 * Cumulative pages swapped in + out since boot, or `null` when the figure
 * cannot be determined (unknown platform, missing `vm_stat`, no swap). A
 * `null` is treated as "no pressure known" by the caller so an unreadable
 * signal never trips a shed on its own.
 */
const defaultReadPagingCounter = async (): Promise<number | null> => {
  try {
    if (platform() === 'darwin') {
      const { stdout } = await execFileAsync('vm_stat', [], { timeout: 5_000 })
      // "Swapins:    1358806." / "Swapouts:   2657790."
      const ins = /Swapins:\s+(\d+)/.exec(stdout)?.[1]
      const outs = /Swapouts:\s+(\d+)/.exec(stdout)?.[1]
      if (ins === undefined || outs === undefined) return null
      return Number(ins) + Number(outs)
    }

    if (platform() === 'linux') {
      const vmstat = await readFile('/proc/vmstat', 'utf8')
      const ins = /^pswpin (\d+)$/m.exec(vmstat)?.[1]
      const outs = /^pswpout (\d+)$/m.exec(vmstat)?.[1]
      if (ins === undefined || outs === undefined) return null
      return Number(ins) + Number(outs)
    }
  } catch {
    return null
  }
  return null
}

/**
 * Wire all three tuning lanes. Returns a disposer that stops the sampling
 * timer; callers that run for the lifetime of the daemon may ignore it.
 */
export function startStewardRuntimeTune(deps: StewardRuntimeTuneDeps): () => void {
  const { bus, implementSem, baselineCap, log } = deps
  const postNotice = deps.postConversationNotice ?? postConversationNotice
  const readPressure = deps.readPressure ?? ((): Promise<MachinePressure> => samplePressure())
  const readPagingCounter = deps.readPagingCounter ?? defaultReadPagingCounter
  const recordCapDecision = deps.recordCapDecision ?? ((): void => {})
  const readAutonomyLevel =
    deps.readAutonomyLevel ?? ((): AutonomyLevel => readLeverAutonomyLevel(STEWARD_RUNTIME_TUNE_LEVER))
  const recordLedger = deps.recordLedger ?? recordStewardIntervention
  const runOrphanSweep =
    deps.runOrphanSweep ??
    ((): Promise<OrphanSweepSummary> =>
      sweepOrphans({
        repoRoot: deps.repoRoot,
        inFlightTaskIds: deps.getInFlightTaskIds(),
        log,
      }))
  const maxCap = baselineCap * 2

  // Paging is a rate, so it takes two samples to observe. `prev` holds the
  // last counter reading; `pagingPps` is the most recent computed rate, which
  // the bump lane reads because it fires on bus events rather than on the
  // sampling interval.
  let prev: { counter: number; atMs: number } | null = null
  let pagingPps = 0

  /**
   * Fold a fresh counter reading into {@link pagingPps}. The first reading
   * only establishes a baseline — there is no rate until there are two
   * points, and reporting 0 in the meantime is the safe direction (it cannot
   * cause a spurious shed).
   */
  const samplePaging = async (): Promise<void> => {
    const counter = await readPagingCounter()
    const atMs = Date.now()
    if (counter === null) {
      pagingPps = 0
      prev = null
      return
    }
    if (prev !== null && atMs > prev.atMs) {
      const deltaPages = counter - prev.counter
      const deltaSec = (atMs - prev.atMs) / 1000
      // A negative delta means the counter reset (reboot); treat as no data.
      pagingPps = deltaPages >= 0 ? deltaPages / deltaSec : 0
    }
    prev = { counter, atMs }
  }

  /**
   * The operator's standing answer on whether Mars may move this knob.
   *
   * Read per decision rather than captured at startup, so tapping "Stop doing
   * this automatically" on the Notice takes effect on the next lane without a
   * daemon restart — the message and the off-switch have to be the same
   * object for that chip to mean anything.
   *
   * Only `off` is meaningful here. A runtime knob has nowhere to ask: there is
   * no operator in the loop at 3am when the host starts swapping, so `ask`
   * behaves as `tell` rather than silently pinning the cap forever.
   */
  const mayTune = (): boolean => {
    try {
      return readAutonomyLevel() !== 'off'
    } catch (err) {
      // A malformed lever must not disable host protection. Shedding on a
      // thrashing machine is the safe direction; refusing to would not be.
      log(`[steward-tune] autonomy level unreadable, tuning on: ${(err as Error).message}`)
      return true
    }
  }

  const ack = async (input: Extract<ConversationNoticeInput, { kind: string }>): Promise<void> => {
    try {
      await postNotice(input)
    } catch (err) {
      log(`[steward-tune] conversation Notice failed: ${(err as Error).message}`)
    }
  }

  /**
   * Record a cap change as durable evidence. The conversation Notice is what
   * the operator reads now; the ledger is what answers "when did Mars start
   * doing this, and how often?" weeks later.
   */
  const ledger = async (
    lane: string,
    from: number,
    to: number,
    rationale: string,
  ): Promise<void> => {
    try {
      await recordLedger({
        targetKind: 'daemon-cap',
        targetId: 'implement',
        targetVersion: String(from),
        recipeId: `steward-runtime-tune/${lane}`,
        rationale,
        outcome: `implement cap ${from} → ${to}`,
      })
    } catch (err) {
      log(`[steward-tune] ledger write failed: ${(err as Error).message}`)
    }
  }

  /**
   * The bump lane's full verdict. Paging outranks the CPU guard: a thrashing
   * host is the wrong place to admit more memory-heavy workers however much
   * idle CPU it reports, and unlike CPU the memory pressure is Mars's own
   * verify suites doing it.
   */
  const verdictFor = (pressure: MachinePressure): CapHoldDecision => {
    if (pagingPps >= PAGING_ACTIVE_PPS) {
      return {
        hold: true,
        reason: 'host-paging',
        explanation: `paging ${Math.round(pagingPps)} pages/s >= ${PAGING_ACTIVE_PPS}`,
      }
    }
    return decideCapHold({
      pressure,
      idleFloorPercent: IDLE_FLOOR_PERCENT,
      marsShareCeilingPercent: MARS_SHARE_CEILING_PERCENT,
    })
  }

  bus.on('kpi.backlog.degraded', (payload: { pending: number; cap: number; sustainedMs: number }) => {
    void (async () => {
      if (!mayTune()) {
        log('[steward-tune] backlog degraded but autotuning is off; leaving the cap alone')
        return
      }
      const oldCap = implementSem.limit
      if (oldCap >= maxCap) {
        log(`[steward-tune] implement cap already at max (${maxCap}), skipping`)
        return
      }

      const newCap = Math.min(Math.ceil(oldCap * BUMP_FACTOR), maxCap)
      if (newCap === oldCap) return

      // ── Capacity guard, with an orphan sweep on the hold path ────────────
      let pressure = await readPressure()
      let decision = verdictFor(pressure)
      let sweepNote = 'no sweep needed'
      if (decision.hold) {
        // Before holding, reap leaked verify subprocesses — they are the one
        // part of the load Mars can actually do something about — then decide
        // again on a FRESH sample. Unlike a 1-minute load average, the reaped
        // CPU is gone from the very next sample, so this re-read is honest.
        try {
          const summary = await runOrphanSweep()
          sweepNote = `orphan sweep: ${formatSweepSummary(summary)}`
          if (summary.reaped > 0) {
            pressure = await readPressure()
            decision = verdictFor(pressure)
          }
        } catch (err) {
          sweepNote = `orphan sweep failed: ${(err as Error).message}`
        }
      }

      // Every input to the decision is printed. A held cap must never look
      // authoritative while resting on a number that is mostly other
      // software's noise.
      const evidence = `${formatPressure(pressure)}; paging ${Math.round(pagingPps)} pages/s; ${sweepNote}`
      if (decision.hold) {
        const reason = `holding implement cap at ${oldCap}: ${decision.explanation} [${evidence}]`
        log(`[steward-tune] backlog degraded (${payload.pending} pending) but ${reason}`)
        recordCapDecision(reason)
        return
      }

      setSemLimit(implementSem, newCap)
      log(
        `[steward-tune] bumped implement cap ${oldCap} → ${newCap} (backlog: ${payload.pending} pending, sustained ${Math.round(payload.sustainedMs / 1000)}s; ${decision.explanation}; ${evidence})`,
      )
      recordCapDecision(
        `steward autotune raised implement ${oldCap} → ${newCap} on sustained backlog (${decision.explanation})`,
      )
      await ledger(
        'bump',
        oldCap,
        newCap,
        `sustained backlog: ${payload.pending} pending for ${Math.round(payload.sustainedMs / 1000)}s (${decision.explanation}; ${evidence})`,
      )

      await ack({
        kind: 'steward.worker-bumped',
        payload: {
          from: oldCap,
          to: newCap,
          pending: payload.pending,
          threshold: Math.round(payload.cap * 0.75),
          sustainedSeconds: Math.round(payload.sustainedMs / 1000),
        },
        priority: 'routine',
      })
    })()
  })

  const sample = async (): Promise<void> => {
    await samplePaging()
    if (!mayTune()) return
    const oldCap = implementSem.limit

    // ── shed ──────────────────────────────────────────────────────────────
    if (pagingPps >= PAGING_SHED_TRIGGER) {
      if (oldCap <= MIN_CAP) return

      const newCap = Math.max(MIN_CAP, Math.floor(oldCap * SHED_FACTOR))
      if (newCap === oldCap) return

      setSemLimit(implementSem, newCap)
      const detail = `paging ${Math.round(pagingPps)} pages/s >= ${PAGING_SHED_TRIGGER}`
      log(`[steward-tune] shed implement cap ${oldCap} → ${newCap} (${detail})`)
      recordCapDecision(`steward autotune shed implement ${oldCap} → ${newCap} (${detail})`)
      await ledger('shed', oldCap, newCap, detail)

      // Name the resource that actually tripped, so the operator does not go
      // looking at CPU when the machine is out of memory.
      await ack({
        kind: 'steward.worker-reduced',
        payload: { from: oldCap, to: newCap, pagingPps: Math.round(pagingPps) },
        priority: 'routine',
      })
      return
    }

    // ── recover ───────────────────────────────────────────────────────────
    // Only undo a previous shed; growth above baseline stays the bump lane's
    // job, gated on backlog and the CPU guard.
    if (oldCap >= baselineCap) return

    const newCap = Math.min(baselineCap, oldCap + 1)
    if (newCap === oldCap) return

    setSemLimit(implementSem, newCap)
    log(
      `[steward-tune] recovered implement cap ${oldCap} → ${newCap} ` +
        `(paging ${Math.round(pagingPps)} pages/s < ${PAGING_ACTIVE_PPS}, baseline ${baselineCap})`,
    )
    recordCapDecision(
      newCap >= baselineCap
        ? null
        : `steward autotune restored implement ${oldCap} → ${newCap} after paging cleared`,
    )
    await ledger(
      'recover',
      oldCap,
      newCap,
      `paging ${Math.round(pagingPps)} pages/s < ${PAGING_ACTIVE_PPS}, baseline ${baselineCap}`,
    )
    await ack({
      kind: 'steward.worker-restored',
      payload: { from: oldCap, to: newCap },
      priority: 'routine',
    })
  }

  // Sample once immediately rather than waiting a full interval. Paging is a
  // rate, so no shed is possible until two readings exist — taking the first
  // at start-up rather than an interval later means a host that is already
  // thrashing when the daemon comes up is throttled after one interval rather
  // than two, and a cap that came up below baseline starts climbing back at
  // once (observed 2026-07-30: a restart onto a thrashing host dispatched 3
  // implement jobs before the first shed). This narrows that window; it does
  // not close it, since the read is async and the dispatcher may still win
  // the race.
  void sample()

  const sampleTimer = setInterval(() => {
    void sample()
  }, SHED_CHECK_MS)
  // Do not hold the process open for a tuning timer.
  if (typeof sampleTimer.unref === 'function') sampleTimer.unref()

  return () => clearInterval(sampleTimer)
}
