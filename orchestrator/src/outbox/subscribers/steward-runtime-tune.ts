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
 * The backlog lane can raise capacity, while the host-pressure lanes shed and
 * restore it. Lowering a semaphore limit never kills in-flight work: it only
 * stops new admissions until use falls below the new ceiling.
 */
export interface StewardRuntimeTuneDeps {
  bus: EventEmitter
  implementSem: Semaphore
  baselineCap: number
  log: (line: string) => void
  /** Override for testing — defaults to real chat-store writes. */
  writeChatAck?: (text: string) => Promise<void>
  /** Override for testing — defaults to 1-minute load divided by core count. */
  readLoadPerCore?: () => number
  /**
   * Override for testing — returns cumulative pages swapped in plus out since
   * boot. Consecutive values are differenced to derive a paging rate. Return
   * null when the counter cannot be read.
   */
  readPagingCounter?: () => Promise<number | null>
}

const BUMP_FACTOR = 1.33
const SHED_FACTOR = 0.67
const LOAD_BUMP_CEILING = 1.5
const LOAD_SHED_TRIGGER = 4
const LOAD_RECOVER_CEILING = 2.5

/** Paging above this rate is sustained enough to begin shedding capacity. */
const PAGING_SHED_TRIGGER = 500

/**
 * Restore only after paging is well below the shed trigger. This deliberately
 * does not derive from {@link PAGING_SHED_TRIGGER}: it is the lower half of
 * the paging hysteresis band.
 */
const PAGING_RECOVER_CEILING = 150

/** One burst is not enough evidence to shed on a bursty paging signal. */
const PAGING_SHED_SAMPLES = 2

/** Require 45 seconds of clean host pressure before each recovery step. */
const CLEAN_RECOVER_SAMPLES = 3

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
 * Cumulative pages swapped in and out since boot. Activity is a useful memory
 * pressure signal because it drops when a thrash ends; swap occupancy does
 * not, since pages can remain parked in swap long after recovery.
 */
const defaultReadPagingCounter = async (): Promise<number | null> => {
  try {
    if (platform() === 'darwin') {
      const { stdout } = await execFileAsync('vm_stat', [], { timeout: 5_000 })
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
    // An unreadable signal must not be reported as pressure.
  }
  return null
}

async function defaultWriteChatAck(text: string): Promise<void> {
  const thread = await createThread('Steward: runtime tuning')
  await appendMessage(thread.id, 'assistant', text, undefined, {
    kind: 'acknowledgment',
  })
}

/** Wire the autonomous tuning lanes and return a sampling-timer disposer. */
export function startStewardRuntimeTune(
  deps: StewardRuntimeTuneDeps,
): () => void {
  const { bus, implementSem, baselineCap, log } = deps
  const writeChatAck = deps.writeChatAck ?? defaultWriteChatAck
  const readLoadPerCore = deps.readLoadPerCore ?? defaultReadLoadPerCore
  const readPagingCounter = deps.readPagingCounter ?? defaultReadPagingCounter
  const maxCap = baselineCap * 2

  let previousPaging: { counter: number; atMs: number } | null = null
  let pagingPps = 0
  let pagingShedSamples = 0
  let cleanRecoverSamples = 0

  const samplePaging = async (): Promise<void> => {
    const counter = await readPagingCounter()
    const atMs = Date.now()
    if (counter === null) {
      pagingPps = 0
      previousPaging = null
      return
    }
    if (previousPaging !== null && atMs > previousPaging.atMs) {
      const deltaPages = counter - previousPaging.counter
      const deltaSeconds = (atMs - previousPaging.atMs) / 1000
      pagingPps = deltaPages >= 0 ? deltaPages / deltaSeconds : 0
    }
    previousPaging = { counter, atMs }
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

      const load = readLoadPerCore()
      if (load >= LOAD_BUMP_CEILING || pagingPps >= PAGING_RECOVER_CEILING) {
        const reason = load >= LOAD_BUMP_CEILING
          ? `load/core ${load.toFixed(2)} >= ${LOAD_BUMP_CEILING}`
          : `paging ${Math.round(pagingPps)} pages/s >= ${PAGING_RECOVER_CEILING}`
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
    await samplePaging()
    const load = readLoadPerCore()
    const oldCap = implementSem.limit
    const shedOnLoad = load >= LOAD_SHED_TRIGGER
    const shedOnPaging = pagingPps >= PAGING_SHED_TRIGGER

    if (shedOnLoad || shedOnPaging) {
      cleanRecoverSamples = 0
      pagingShedSamples = shedOnPaging ? pagingShedSamples + 1 : 0

      // CPU saturation sheds immediately; paging needs a second consecutive
      // breach so one burst cannot move the cap.
      if (!shedOnLoad && pagingShedSamples < PAGING_SHED_SAMPLES) return
      if (oldCap <= MIN_CAP) return

      const newCap = Math.max(MIN_CAP, Math.floor(oldCap * SHED_FACTOR))
      if (newCap === oldCap) return

      setSemLimit(implementSem, newCap)
      const detail = shedOnPaging
        ? `paging ${Math.round(pagingPps)} pages/s >= ${PAGING_SHED_TRIGGER}`
        : `load/core ${load.toFixed(2)} >= ${LOAD_SHED_TRIGGER}`
      log(`[steward-tune] shed implement cap ${oldCap} → ${newCap} (${detail})`)
      const because = shedOnPaging
        ? `the host was swapping at ${Math.round(pagingPps)} pages/s`
        : `host load reached ${load.toFixed(1)} per core`
      await ack(`I reduced implement workers from ${oldCap} to ${newCap} because ${because}.`)
      return
    }

    pagingShedSamples = 0
    if (oldCap >= baselineCap) {
      cleanRecoverSamples = 0
      return
    }

    if (load >= LOAD_RECOVER_CEILING || pagingPps >= PAGING_RECOVER_CEILING) {
      cleanRecoverSamples = 0
      return
    }

    cleanRecoverSamples += 1
    if (cleanRecoverSamples < CLEAN_RECOVER_SAMPLES) return
    cleanRecoverSamples = 0

    const newCap = Math.min(baselineCap, oldCap + 1)
    if (newCap === oldCap) return

    setSemLimit(implementSem, newCap)
    log(
      `[steward-tune] recovered implement cap ${oldCap} → ${newCap} ` +
        `(load/core ${load.toFixed(2)} < ${LOAD_RECOVER_CEILING}, ` +
        `paging ${Math.round(pagingPps)} pages/s < ${PAGING_RECOVER_CEILING}, baseline ${baselineCap})`,
    )
    await ack(`I restored implement workers from ${oldCap} to ${newCap} because host pressure cleared.`)
  }

  // The first read establishes a paging baseline and still lets a load spike
  // shed immediately, rather than leaving a full cap for one timer interval.
  void sample()

  const sampleTimer = setInterval(() => {
    void sample()
  }, SHED_CHECK_MS)
  if (typeof sampleTimer.unref === 'function') sampleTimer.unref()

  return () => clearInterval(sampleTimer)
}
