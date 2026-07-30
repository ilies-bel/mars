import type { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpus, loadavg, platform } from 'node:os'
import { promisify } from 'node:util'
import type { Semaphore } from '../../core/daemon/server.js'
import { setSemLimit } from '../../core/daemon/server.js'
import { createThread, appendMessage } from '../../core/lib/chat-store.js'

const execFileAsync = promisify(execFile)

/**
 * Steward autonomous runtime-knob tuning.
 *
 * Three lanes, all autonomous (no validation action-queue item is raised —
 * ADR-0077):
 *
 *  - **bump** — a sustained implement-queue backlog raises the implement
 *    semaphore cap, bounded at 2× baseline. Gated on both host signals.
 *  - **shed** — host pressure *lowers* the cap, bounded at {@link MIN_CAP}.
 *  - **recover** — once pressure clears, the cap climbs back to
 *    `baselineCap` one worker at a time.
 *
 * The shed lane exists because backlog on its own is a misleading signal.
 * Tasks that fail fast (an API outage, a saturated host) drain the queue
 * slower than it fills, so the backlog grows — and reading that as "add more
 * workers" raises load, slows every in-flight run further, and grows the
 * backlog again. That positive feedback loop is what the gates on the bump
 * lane and the shed lane together break.
 *
 * The recover lane exists because shed-without-recover is a one-way ratchet.
 * A single transient spike would otherwise pin the cap at its floor forever
 * on any host whose idle load never drops below the bump ceiling (observed
 * 2026-07-30: cap rode 4 → 1 and could not climb back).
 *
 * ## Why two host signals
 *
 * Load average alone conflates two conditions with different correct
 * responses. On Darwin and Linux it counts processes in uninterruptible
 * sleep, so a host thrashing on swap reports the same number as a host that
 * is genuinely CPU-saturated. Observed 2026-07-30: load average 140 on 10
 * cores while aggregate user CPU was only ~150% — the machine was paging,
 * not computing, and every verify suite was holding 1-2 GB of PGlite.
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
  /** Override for testing — defaults to real chat-store writes. */
  writeChatAck?: (text: string) => Promise<void>
  /**
   * Override for testing — defaults to the host's 1-minute load average
   * divided by its core count. Must be injected in tests, otherwise the
   * result depends on whatever else is running on the machine.
   */
  readLoadPerCore?: () => number
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
 * Refuse to add workers once 1-minute load per core reaches this. Slightly
 * above 1.0 so a fully-but-not-over-committed host can still scale up.
 */
const LOAD_BUMP_CEILING = 1.5

/**
 * Shed workers once 1-minute load per core reaches this. Well above the bump
 * ceiling so the two lanes cannot oscillate against each other.
 */
const LOAD_SHED_TRIGGER = 4

/**
 * Restore shed capacity once load per core falls below this. Sits strictly
 * between the bump ceiling and the shed trigger: high enough that a normally
 * busy host recovers, low enough that restoring one worker cannot plausibly
 * push load straight back over {@link LOAD_SHED_TRIGGER} and re-shed.
 */
const LOAD_RECOVER_CEILING = 2.5

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
 * {@link PAGING_ACTIVE_PPS}: unlike load, paging is not a matter of degree —
 * a host either is or is not swapping, and any sustained swapping while
 * running memory-heavy jobs is already the failure.
 */
const PAGING_SHED_TRIGGER = PAGING_ACTIVE_PPS

/** How often the shed and recover lanes sample host pressure. */
const SHED_CHECK_MS = 15_000

/** Never shed below one worker — `setSemLimit` rejects a limit under 1. */
const MIN_CAP = 1

const defaultReadLoadPerCore = (): number => {
  const cores = cpus().length
  const [oneMinute] = loadavg()
  if (oneMinute === undefined || cores < 1) return 0
  return oneMinute / cores
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

async function defaultWriteChatAck(text: string): Promise<void> {
  const thread = await createThread('Steward: runtime tuning')
  await appendMessage(thread.id, 'assistant', text, undefined, {
    kind: 'acknowledgment',
  })
}

/**
 * Wire all three tuning lanes. Returns a disposer that stops the sampling
 * timer; callers that run for the lifetime of the daemon may ignore it.
 */
export function startStewardRuntimeTune(
  deps: StewardRuntimeTuneDeps,
): () => void {
  const { bus, implementSem, baselineCap, log } = deps
  const writeChatAck = deps.writeChatAck ?? defaultWriteChatAck
  const readLoadPerCore = deps.readLoadPerCore ?? defaultReadLoadPerCore
  const readPagingCounter = deps.readPagingCounter ?? defaultReadPagingCounter
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

  const ack = async (text: string): Promise<void> => {
    try {
      await writeChatAck(text)
    } catch (err) {
      log(`[steward-tune] chat ack failed: ${(err as Error).message}`)
    }
  }

  bus.on('kpi.backlog.degraded', (payload: { pending: number; cap: number; sustainedMs: number }) => {
    void (async () => {
      const oldCap = implementSem.limit
      if (oldCap >= maxCap) {
        log(`[steward-tune] implement cap already at max (${maxCap}), skipping`)
        return
      }

      // Backlog alone does not justify more workers — check the host first.
      const load = readLoadPerCore()
      if (load >= LOAD_BUMP_CEILING || pagingPps >= PAGING_ACTIVE_PPS) {
        const reason =
          load >= LOAD_BUMP_CEILING
            ? `load/core ${load.toFixed(2)} >= ${LOAD_BUMP_CEILING}`
            : `paging ${Math.round(pagingPps)} pages/s >= ${PAGING_ACTIVE_PPS}`
        log(
          `[steward-tune] backlog degraded (${payload.pending} pending) but ${reason}; ` +
            `holding implement cap at ${oldCap}`,
        )
        return
      }

      const newCap = Math.min(Math.ceil(oldCap * BUMP_FACTOR), maxCap)
      if (newCap === oldCap) return

      setSemLimit(implementSem, newCap)
      log(`[steward-tune] bumped implement cap ${oldCap} → ${newCap} (backlog: ${payload.pending} pending, sustained ${Math.round(payload.sustainedMs / 1000)}s)`)

      await ack(
        `I bumped implement workers from ${oldCap} to ${newCap} because backlog held above ${Math.round(payload.cap * 0.75)} for ${Math.round(payload.sustainedMs / 1000)}s.`,
      )
    })()
  })

  const sample = async (): Promise<void> => {
    {
      await samplePaging()
      const load = readLoadPerCore()
      const oldCap = implementSem.limit

      // ── shed ──────────────────────────────────────────────────────────
      const shedOnLoad = load >= LOAD_SHED_TRIGGER
      const shedOnSwap = pagingPps >= PAGING_SHED_TRIGGER
      if (shedOnLoad || shedOnSwap) {
        if (oldCap <= MIN_CAP) return

        const newCap = Math.max(MIN_CAP, Math.floor(oldCap * SHED_FACTOR))
        if (newCap === oldCap) return

        setSemLimit(implementSem, newCap)
        const detail = shedOnSwap
          ? `paging ${Math.round(pagingPps)} pages/s >= ${PAGING_SHED_TRIGGER}`
          : `load/core ${load.toFixed(2)} >= ${LOAD_SHED_TRIGGER}`
        log(`[steward-tune] shed implement cap ${oldCap} → ${newCap} (${detail})`)

        // Name the resource that actually tripped, so the operator does not
        // go looking at CPU when the machine is out of memory.
        const because = shedOnSwap
          ? `the host was swapping at ${Math.round(pagingPps)} pages/s`
          : `host load reached ${load.toFixed(1)} per core`
        await ack(
          `I reduced implement workers from ${oldCap} to ${newCap} because ${because}.`,
        )
        return
      }

      // ── recover ───────────────────────────────────────────────────────
      // Only undo a previous shed; growth above baseline stays the bump
      // lane's job, gated on backlog.
      if (oldCap >= baselineCap) return
      if (load >= LOAD_RECOVER_CEILING || pagingPps >= PAGING_ACTIVE_PPS) return

      const newCap = Math.min(baselineCap, oldCap + 1)
      if (newCap === oldCap) return

      setSemLimit(implementSem, newCap)
      log(
        `[steward-tune] recovered implement cap ${oldCap} → ${newCap} ` +
          `(load/core ${load.toFixed(2)} < ${LOAD_RECOVER_CEILING}, ` +
          `paging ${Math.round(pagingPps)} pages/s < ${PAGING_ACTIVE_PPS}, baseline ${baselineCap})`,
      )
      await ack(
        `I restored implement workers from ${oldCap} to ${newCap} because host pressure cleared.`,
      )
    }
  }

  // Sample once immediately rather than waiting a full interval. A daemon
  // restart brings the cap up at `baselineCap` and the dispatcher starts
  // claiming slots straight away, so deferring the first sample leaves a
  // window where a host already under pressure admits a full complement of
  // work (observed 2026-07-30: a restart onto a 97%-swap host dispatched 3
  // implement jobs before the first shed). This narrows that window to the
  // cost of one pressure read; it does not close it entirely, since the read
  // is async and the dispatcher may still win the race.
  void sample()

  const sampleTimer = setInterval(() => {
    void sample()
  }, SHED_CHECK_MS)
  // Do not hold the process open for a tuning timer.
  if (typeof sampleTimer.unref === 'function') sampleTimer.unref()

  return () => clearInterval(sampleTimer)
}
