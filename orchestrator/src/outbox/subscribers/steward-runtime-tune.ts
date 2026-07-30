import type { EventEmitter } from 'node:events'
import { cpus, loadavg } from 'node:os'
import type { Semaphore } from '../../core/daemon/server.js'
import { setSemLimit } from '../../core/daemon/server.js'
import { createThread, appendMessage } from '../../core/lib/chat-store.js'

/**
 * Steward autonomous runtime-knob tuning.
 *
 * Two opposing lanes, both autonomous (no validation action-queue item is
 * raised — ADR-0077):
 *
 *  - **bump** — a sustained implement-queue backlog raises the implement
 *    semaphore cap, bounded at 2× baseline.
 *  - **shed** — sustained host load *lowers* the cap, bounded at
 *    {@link MIN_CAP}.
 *
 * The shed lane exists because backlog on its own is a misleading signal.
 * Tasks that fail fast (an API outage, a saturated host) drain the queue
 * slower than it fills, so the backlog grows — and reading that as "add more
 * workers" raises load, slows every in-flight run further, and grows the
 * backlog again. That positive feedback loop is what the load gate on the
 * bump lane and the shed lane together break.
 *
 * Lowering a cap never kills in-flight work: `setSemLimit` only moves the
 * ceiling, so `acquire` simply stops handing out slots until `inUse` falls
 * below the new limit.
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

/** How often the shed lane samples load. */
const SHED_CHECK_MS = 15_000

/** Never shed below one worker — `setSemLimit` rejects a limit under 1. */
const MIN_CAP = 1

const defaultReadLoadPerCore = (): number => {
  const cores = cpus().length
  const [oneMinute] = loadavg()
  if (oneMinute === undefined || cores < 1) return 0
  return oneMinute / cores
}

async function defaultWriteChatAck(text: string): Promise<void> {
  const thread = await createThread('Steward: runtime tuning')
  await appendMessage(thread.id, 'assistant', text, undefined, {
    kind: 'acknowledgment',
  })
}

/**
 * Wire both tuning lanes. Returns a disposer that stops the shed timer;
 * callers that run for the lifetime of the daemon may ignore it.
 */
export function startStewardRuntimeTune(
  deps: StewardRuntimeTuneDeps,
): () => void {
  const { bus, implementSem, baselineCap, log } = deps
  const writeChatAck = deps.writeChatAck ?? defaultWriteChatAck
  const readLoadPerCore = deps.readLoadPerCore ?? defaultReadLoadPerCore
  const maxCap = baselineCap * 2

  bus.on('kpi.backlog.degraded', (payload: { pending: number; cap: number; sustainedMs: number }) => {
    void (async () => {
      const oldCap = implementSem.limit
      if (oldCap >= maxCap) {
        log(`[steward-tune] implement cap already at max (${maxCap}), skipping`)
        return
      }

      // Backlog alone does not justify more workers — check the host first.
      const load = readLoadPerCore()
      if (load >= LOAD_BUMP_CEILING) {
        log(
          `[steward-tune] backlog degraded (${payload.pending} pending) but load/core ` +
            `${load.toFixed(2)} >= ${LOAD_BUMP_CEILING}; holding implement cap at ${oldCap}`,
        )
        return
      }

      const newCap = Math.min(Math.ceil(oldCap * BUMP_FACTOR), maxCap)
      if (newCap === oldCap) return

      setSemLimit(implementSem, newCap)
      log(`[steward-tune] bumped implement cap ${oldCap} → ${newCap} (backlog: ${payload.pending} pending, sustained ${Math.round(payload.sustainedMs / 1000)}s)`)

      const text = `I bumped implement workers from ${oldCap} to ${newCap} because backlog held above ${Math.round(payload.cap * 0.75)} for ${Math.round(payload.sustainedMs / 1000)}s.`
      try {
        await writeChatAck(text)
      } catch (err) {
        log(`[steward-tune] chat ack failed: ${(err as Error).message}`)
      }
    })()
  })

  const shedTimer = setInterval(() => {
    void (async () => {
      const load = readLoadPerCore()
      if (load < LOAD_SHED_TRIGGER) return

      const oldCap = implementSem.limit
      if (oldCap <= MIN_CAP) return

      const newCap = Math.max(MIN_CAP, Math.floor(oldCap * SHED_FACTOR))
      if (newCap === oldCap) return

      setSemLimit(implementSem, newCap)
      log(
        `[steward-tune] shed implement cap ${oldCap} → ${newCap} ` +
          `(load/core ${load.toFixed(2)} >= ${LOAD_SHED_TRIGGER})`,
      )

      const text = `I reduced implement workers from ${oldCap} to ${newCap} because host load reached ${load.toFixed(1)} per core.`
      try {
        await writeChatAck(text)
      } catch (err) {
        log(`[steward-tune] chat ack failed: ${(err as Error).message}`)
      }
    })()
  }, SHED_CHECK_MS)
  // Do not hold the process open for a tuning timer.
  if (typeof shedTimer.unref === 'function') shedTimer.unref()

  return () => clearInterval(shedTimer)
}
