import { describe, it, expect } from 'vitest'
import {
  collectTree,
  formatPressure,
  parseCpuTimeSeconds,
  parseProcTable,
  samplePressure,
  treeCpuDeltaSeconds,
  type ProcSample,
} from '../machine-pressure'

describe('parseCpuTimeSeconds (macOS `ps -o time=` is `[[dd-]hh:]mm:ss[.ff]`)', () => {
  it('parses mm:ss.ff', () => {
    expect(parseCpuTimeSeconds('37:51.47')).toBeCloseTo(37 * 60 + 51.47, 5)
  })

  it('parses an unbounded minutes field (macOS prints 612:39.27, not 10:12:39)', () => {
    expect(parseCpuTimeSeconds('612:39.27')).toBeCloseTo(612 * 60 + 39.27, 5)
  })

  it('parses hh:mm:ss and dd-hh:mm:ss', () => {
    expect(parseCpuTimeSeconds('1:02:03')).toBe(3_723)
    expect(parseCpuTimeSeconds('2-01:00:00')).toBe(2 * 86_400 + 3_600)
  })

  it('returns null for unparseable input', () => {
    expect(parseCpuTimeSeconds('')).toBeNull()
    expect(parseCpuTimeSeconds('-')).toBeNull()
    expect(parseCpuTimeSeconds('abc')).toBeNull()
  })
})

describe('parseProcTable', () => {
  it('parses a ps -A -o pid=,ppid=,time= table', () => {
    const rows = parseProcTable(
      ['    1     0  37:51.47', '  337     1  24:50.20', '  341     1 612:39.27'].join('\n'),
    )
    expect(rows.map((r) => r.pid)).toEqual([1, 337, 341])
    expect(rows[2].cpuSeconds).toBeCloseTo(612 * 60 + 39.27, 5)
  })

  it('drops blank and malformed rows', () => {
    expect(parseProcTable('\n  \nnot a row\n1 2 ??\n')).toEqual([])
  })
})

describe('collectTree', () => {
  const rows: ProcSample[] = [
    { pid: 1, ppid: 0, cpuSeconds: 0 },
    { pid: 100, ppid: 1, cpuSeconds: 0 }, // the daemon
    { pid: 200, ppid: 100, cpuSeconds: 0 }, // a coder
    { pid: 300, ppid: 200, cpuSeconds: 0 }, // vitest under the coder
    { pid: 400, ppid: 1, cpuSeconds: 0 }, // unrelated (security scanner)
  ]

  it('collects the root and every descendant', () => {
    expect([...collectTree(rows, 100)].sort((a, b) => a - b)).toEqual([100, 200, 300])
  })

  it('excludes unrelated processes', () => {
    expect(collectTree(rows, 100).has(400)).toBe(false)
  })

  it('returns just the root when it has no children', () => {
    expect([...collectTree(rows, 400)]).toEqual([400])
  })

  it('does not loop on a cyclic ppid graph', () => {
    const cyclic: ProcSample[] = [
      { pid: 10, ppid: 11, cpuSeconds: 0 },
      { pid: 11, ppid: 10, cpuSeconds: 0 },
    ]
    expect(collectTree(cyclic, 10).size).toBe(2)
  })
})

describe('treeCpuDeltaSeconds', () => {
  const tree = new Set([100, 200])

  it('sums the delta for processes present in both samples', () => {
    const before: ProcSample[] = [
      { pid: 100, ppid: 1, cpuSeconds: 10 },
      { pid: 200, ppid: 100, cpuSeconds: 5 },
    ]
    const after: ProcSample[] = [
      { pid: 100, ppid: 1, cpuSeconds: 10.5 },
      { pid: 200, ppid: 100, cpuSeconds: 6.5 },
    ]
    expect(treeCpuDeltaSeconds(before, after, tree)).toBeCloseTo(2, 5)
  })

  it('counts the whole cumulative time of a process that started inside the window', () => {
    const after: ProcSample[] = [{ pid: 200, ppid: 100, cpuSeconds: 3 }]
    expect(treeCpuDeltaSeconds([], after, tree)).toBe(3)
  })

  it('ignores processes outside the tree', () => {
    const after: ProcSample[] = [{ pid: 999, ppid: 1, cpuSeconds: 500 }]
    expect(treeCpuDeltaSeconds([], after, tree)).toBe(0)
  })

  it('never returns a negative delta when a counter appears to go backwards', () => {
    const before: ProcSample[] = [{ pid: 100, ppid: 1, cpuSeconds: 10 }]
    const after: ProcSample[] = [{ pid: 100, ppid: 1, cpuSeconds: 4 }]
    expect(treeCpuDeltaSeconds(before, after, tree)).toBe(0)
  })
})

describe('samplePressure', () => {
  // Fixture ticks: 10 cores' worth of counters, expressed as one aggregate.
  const ticks = (idle: number, total: number) => ({ idle, total })

  const run = async (over: {
    idleDelta: number
    totalDelta: number
    marsDelta: number
  }) => {
    let call = 0
    const before: ProcSample[] = [
      { pid: 1, ppid: 0, cpuSeconds: 0 },
      { pid: 100, ppid: 1, cpuSeconds: 0 },
      { pid: 200, ppid: 100, cpuSeconds: 0 },
      { pid: 900, ppid: 1, cpuSeconds: 0 }, // the security scanner
    ]
    const after: ProcSample[] = [
      { pid: 1, ppid: 0, cpuSeconds: 0 },
      { pid: 100, ppid: 1, cpuSeconds: 0 },
      { pid: 200, ppid: 100, cpuSeconds: over.marsDelta },
      { pid: 900, ppid: 1, cpuSeconds: 900 },
    ]
    return samplePressure({
      sampleMs: 1_000,
      rootPid: 100,
      wait: () => Promise.resolve(),
      readTicks: () => (call++ === 0 ? ticks(0, 0) : ticks(over.idleDelta, over.totalDelta)),
      readProcs: async () => (call <= 1 ? before : after),
    })
  }

  it('reports idle percentage from the tick delta, not from load average', async () => {
    const p = await run({ idleDelta: 191, totalDelta: 1_000, marsDelta: 0 })
    expect(p.idlePercent).toBeCloseTo(19.1, 5)
  })

  it("attributes only the daemon's own tree to Mars", async () => {
    // 900 CPU-seconds of scanner in the window must not count as Mars's.
    const p = await run({ idleDelta: 191, totalDelta: 1_000, marsDelta: 2 })
    expect(p.marsCores).toBeCloseTo(2, 5)
    expect(p.marsSharePercent).toBeCloseTo((2 / p.cores) * 100, 5)
  })

  it('reports the rest of the busy CPU as other software', async () => {
    const p = await run({ idleDelta: 191, totalDelta: 1_000, marsDelta: 0 })
    expect(p.foreignBusyPercent).toBeCloseTo(80.9, 5)
  })

  it('is permissive rather than deadlocking when sampling yields nothing', async () => {
    const p = await samplePressure({
      sampleMs: 1_000,
      rootPid: 100,
      wait: () => Promise.resolve(),
      readTicks: () => ({ idle: 0, total: 0 }),
      readProcs: async () => [],
    })
    expect(p.idlePercent).toBe(100)
    expect(p.marsCores).toBe(0)
  })

  it('renders every input on one line for the decision log', async () => {
    const p = await run({ idleDelta: 191, totalDelta: 1_000, marsDelta: 2 })
    const line = formatPressure(p)
    expect(line).toContain('19.1% idle')
    expect(line).toContain('mars tree')
    expect(line).toContain('other software')
  })
})
