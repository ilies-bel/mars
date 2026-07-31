/**
 * Machine-pressure sampling — how much CPU capacity is left, and how much of
 * the load is MARS's own.
 *
 * ## Why load average is the wrong signal
 *
 * The autotuner used to throttle on raw `os.loadavg()[0] / cpuCount` against a
 * 1.5 ceiling. Profiling a machine whose implement cap had been pinned at 1
 * showed why that is unusable:
 *
 *   - the 1-minute load average peaked around 275 on 10 cores, yet the CPU was
 *     48.8 % user / 32.5 % sys / **19.1 % idle** — there was capacity to spare;
 *   - the single biggest consumer was a corporate endpoint-security agent at
 *     155 % CPU, with `fseventsd` at 51 % and Spotlight indexing ~40 worktrees
 *     of `node_modules`. Mars's own processes were a minority of the total.
 *
 * Load average counts runnable AND uninterruptibly-blocked threads, so a
 * filesystem-event storm inflates it without consuming CPU. On a machine with
 * an always-on security scanner the 1.5-per-core ceiling is never satisfiable,
 * so the cap stays pinned forever regardless of what Mars does — and no amount
 * of orphan reaping helps, because the load was never Mars's to begin with.
 *
 * This module therefore measures two things directly:
 *
 *   1. **Idle CPU percentage**, sampled as a delta of `os.cpus()` cumulative
 *      tick counters over a short window. A direct statement of available
 *      capacity, immune to the blocked-thread distortion.
 *   2. **Mars's own CPU share**, sampled as a delta of cumulative process CPU
 *      time (`ps -o time=`) across the daemon's process tree. NOT `ps %cpu`,
 *      which is a lifetime average and says nothing about the present moment.
 *
 * Platform note (macOS): `ps -o time=` prints `[[dd-]hh:]mm:ss.ss`.
 */

import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface MachinePressure {
  /** Logical core count. */
  cores: number
  /** Instantaneous idle CPU, 0–100, sampled over `sampleMs`. */
  idlePercent: number
  /** CPU-seconds per second consumed by the daemon's process tree ("cores"). */
  marsCores: number
  /** `marsCores / cores * 100`. */
  marsSharePercent: number
  /** Busy CPU that is NOT Mars's, 0–100. Other software's problem, not ours. */
  foreignBusyPercent: number
  /** Number of processes in the daemon's tree at the end of the window. */
  marsProcessCount: number
  /** The sampling window actually used. */
  sampleMs: number
}

interface CpuTicks {
  idle: number
  total: number
}

const readCpuTicks = (): CpuTicks => {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

/**
 * Parse a `ps -o time=` cumulative CPU-time field: `[[dd-]hh:]mm:ss[.ff]`.
 * Returns seconds, or `null` when the field is unparseable.
 */
export const parseCpuTimeSeconds = (raw: string): number | null => {
  const m = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return null
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const minutes = Number(m[3])
  const seconds = Number(m[4])
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

export interface ProcSample {
  pid: number
  ppid: number
  /** Cumulative CPU time consumed by this process, in seconds. */
  cpuSeconds: number
}

/** Parse `ps -A -o pid=,ppid=,time=` output. Malformed lines are dropped. */
export const parseProcTable = (stdout: string): readonly ProcSample[] => {
  const rows: ProcSample[] = []
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/)
    if (!m) continue
    const cpuSeconds = parseCpuTimeSeconds(m[3])
    if (cpuSeconds === null) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSeconds })
  }
  return rows
}

/** Every pid reachable from `rootPid` through the ppid graph, including it. */
export const collectTree = (
  rows: readonly ProcSample[],
  rootPid: number,
): ReadonlySet<number> => {
  const childrenOf = new Map<number, number[]>()
  for (const r of rows) {
    const list = childrenOf.get(r.ppid)
    if (list) list.push(r.pid)
    else childrenOf.set(r.ppid, [r.pid])
  }
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return seen
}

/**
 * CPU-seconds consumed by `tree` between two process-table samples.
 *
 * A pid present in both samples contributes its delta. A pid that appears only
 * in the second sample started inside the window, so its whole cumulative time
 * was consumed in it. A pid that disappeared is ignored — undercounting a
 * process that already exited is the conservative direction (it frees capacity,
 * it does not consume it).
 */
export const treeCpuDeltaSeconds = (
  before: readonly ProcSample[],
  after: readonly ProcSample[],
  tree: ReadonlySet<number>,
): number => {
  const beforeByPid = new Map(before.map((r) => [r.pid, r.cpuSeconds]))
  let delta = 0
  for (const r of after) {
    if (!tree.has(r.pid)) continue
    const prior = beforeByPid.get(r.pid)
    delta += prior === undefined ? r.cpuSeconds : Math.max(0, r.cpuSeconds - prior)
  }
  return delta
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const readProcTable = async (): Promise<readonly ProcSample[]> => {
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,time='], {
      maxBuffer: 8 * 1024 * 1024,
    })
    return parseProcTable(stdout)
  } catch {
    return []
  }
}

export interface SamplePressureOptions {
  /** Sampling window. Longer is steadier; 1 s is enough to be instantaneous. */
  sampleMs?: number
  /** Root of the tree attributed to Mars. Defaults to this process. */
  rootPid?: number
  // ── injected for tests ────────────────────────────────────────────────────
  readTicks?: () => CpuTicks
  readProcs?: () => Promise<readonly ProcSample[]>
  wait?: (ms: number) => Promise<void>
}

export const DEFAULT_SAMPLE_MS = Number(process.env.MARS_PRESSURE_SAMPLE_MS ?? 1_000)

/**
 * Take one machine-pressure sample. Never throws: on any sampling failure the
 * result reports full idle and zero Mars share, which makes the autotuner
 * permissive rather than deadlocking it — the failure mode we are fixing.
 */
export const samplePressure = async (
  opts: SamplePressureOptions = {},
): Promise<MachinePressure> => {
  const sampleMs = opts.sampleMs ?? DEFAULT_SAMPLE_MS
  const readTicks = opts.readTicks ?? readCpuTicks
  const readProcs = opts.readProcs ?? readProcTable
  const wait = opts.wait ?? sleep
  const rootPid = opts.rootPid ?? process.pid
  const cores = Math.max(1, cpus().length)

  const ticks0 = readTicks()
  const procs0 = await readProcs()
  await wait(sampleMs)
  const ticks1 = readTicks()
  const procs1 = await readProcs()

  const totalDelta = ticks1.total - ticks0.total
  const idleDelta = ticks1.idle - ticks0.idle
  const idlePercent =
    totalDelta > 0 ? Math.min(100, Math.max(0, (idleDelta / totalDelta) * 100)) : 100

  const tree = collectTree(procs1, rootPid)
  const cpuSeconds = treeCpuDeltaSeconds(procs0, procs1, tree)
  const windowSeconds = sampleMs / 1_000
  const marsCores = windowSeconds > 0 ? cpuSeconds / windowSeconds : 0
  const marsSharePercent = Math.min(100, Math.max(0, (marsCores / cores) * 100))
  const busyPercent = 100 - idlePercent
  const foreignBusyPercent = Math.max(0, busyPercent - marsSharePercent)

  return {
    cores,
    idlePercent,
    marsCores,
    marsSharePercent,
    foreignBusyPercent,
    marsProcessCount: tree.size,
    sampleMs,
  }
}

/** One-line rendering of a sample, for the `[steward-tune]` decision log. */
export const formatPressure = (p: MachinePressure): string =>
  `${p.idlePercent.toFixed(1)}% idle; mars tree ${p.marsCores.toFixed(2)}/${p.cores} cores ` +
  `(${p.marsSharePercent.toFixed(1)}%, ${p.marsProcessCount} proc); ` +
  `other software ${p.foreignBusyPercent.toFixed(1)}%`
