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
 * Swap utilisation is the honest memory signal here. `os.freemem()` is not:
 * macOS reports most RAM as non-free even when healthy (measured 0.45 GB
 * "free" of 64 GB total on a host with 44 GB genuinely available), so a
 * threshold on it would shed continuously on an idle machine. A healthy host
 * barely touches swap, which makes a high swap fraction both specific and
 * hard to misread.
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
   * Override for testing — defaults to the host's swap utilisation as a
   * fraction in [0, 1]. Must be injected in tests: the default shells out to
   * `sysctl` on Darwin and reads `/proc/meminfo` on Linux, neither of which
   * belongs in a unit test.
   */
  readSwapPressure?: () => Promise<number>
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

/** Refuse to add workers once swap utilisation reaches this fraction. */
const SWAP_BUMP_CEILING = 0.5

/**
 * Shed workers once swap utilisation reaches this fraction. A host this deep
 * into swap is paging on every allocation; admitting another 1-2 GB verify
 * suite makes every in-flight run slower.
 */
const SWAP_SHED_TRIGGER = 0.8

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
 * Swap utilisation in [0, 1]. Returns 0 when the figure cannot be determined
 * (unknown platform, missing `sysctl`, no swap configured) so an unreadable
 * signal never trips a shed on its own.
 */
const defaultReadSwapPressure = async (): Promise<number> => {
  try {
    if (platform() === 'darwin') {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'vm.swapusage'], {
        timeout: 5_000,
      })
      // "total = 20480.00M  used = 19331.88M  free = 1148.12M  (encrypted)"
      const total = /total\s*=\s*([\d.]+)M/.exec(stdout)?.[1]
      const used = /used\s*=\s*([\d.]+)M/.exec(stdout)?.[1]
      if (total === undefined || used === undefined) return 0
      const totalM = Number(total)
      if (!Number.isFinite(totalM) || totalM <= 0) return 0
      return Number(used) / totalM
    }

    if (platform() === 'linux') {
      const meminfo = await readFile('/proc/meminfo', 'utf8')
      const total = /SwapTotal:\s+(\d+) kB/.exec(meminfo)?.[1]
      const free = /SwapFree:\s+(\d+) kB/.exec(meminfo)?.[1]
      if (total === undefined || free === undefined) return 0
      const totalKb = Number(total)
      if (!Number.isFinite(totalKb) || totalKb <= 0) return 0
      return (totalKb - Number(free)) / totalKb
    }
  } catch {
    // An unreadable signal must not be reported as pressure.
    return 0
  }
  return 0
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
  const readSwapPressure = deps.readSwapPressure ?? defaultReadSwapPressure
  const maxCap = baselineCap * 2

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
      const swap = await readSwapPressure()
      if (load >= LOAD_BUMP_CEILING || swap >= SWAP_BUMP_CEILING) {
        const reason =
          load >= LOAD_BUMP_CEILING
            ? `load/core ${load.toFixed(2)} >= ${LOAD_BUMP_CEILING}`
            : `swap ${(swap * 100).toFixed(0)}% >= ${SWAP_BUMP_CEILING * 100}%`
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

  const sampleTimer = setInterval(() => {
    void (async () => {
      const load = readLoadPerCore()
      const swap = await readSwapPressure()
      const oldCap = implementSem.limit

      // ── shed ──────────────────────────────────────────────────────────
      const shedOnLoad = load >= LOAD_SHED_TRIGGER
      const shedOnSwap = swap >= SWAP_SHED_TRIGGER
      if (shedOnLoad || shedOnSwap) {
        if (oldCap <= MIN_CAP) return

        const newCap = Math.max(MIN_CAP, Math.floor(oldCap * SHED_FACTOR))
        if (newCap === oldCap) return

        setSemLimit(implementSem, newCap)
        const detail = shedOnSwap
          ? `swap ${(swap * 100).toFixed(0)}% >= ${SWAP_SHED_TRIGGER * 100}%`
          : `load/core ${load.toFixed(2)} >= ${LOAD_SHED_TRIGGER}`
        log(`[steward-tune] shed implement cap ${oldCap} → ${newCap} (${detail})`)

        // Name the resource that actually tripped, so the operator does not
        // go looking at CPU when the machine is out of memory.
        const because = shedOnSwap
          ? `swap reached ${(swap * 100).toFixed(0)}%`
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
      if (load >= LOAD_RECOVER_CEILING || swap >= SWAP_BUMP_CEILING) return

      const newCap = Math.min(baselineCap, oldCap + 1)
      if (newCap === oldCap) return

      setSemLimit(implementSem, newCap)
      log(
        `[steward-tune] recovered implement cap ${oldCap} → ${newCap} ` +
          `(load/core ${load.toFixed(2)} < ${LOAD_RECOVER_CEILING}, ` +
          `swap ${(swap * 100).toFixed(0)}% < ${SWAP_BUMP_CEILING * 100}%, baseline ${baselineCap})`,
      )
      await ack(
        `I restored implement workers from ${oldCap} to ${newCap} because host pressure cleared.`,
      )
    })()
  }, SHED_CHECK_MS)
  // Do not hold the process open for a tuning timer.
  if (typeof sampleTimer.unref === 'function') sampleTimer.unref()

  return () => clearInterval(sampleTimer)
}
