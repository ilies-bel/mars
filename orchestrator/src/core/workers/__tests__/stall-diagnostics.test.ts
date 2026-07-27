import { describe, it, expect } from 'vitest'
import { RingBuffer, collectStallDiagnostics } from '../stall-diagnostics'

describe('RingBuffer', () => {
  it('returns lines in insertion order when not full', () => {
    const buf = new RingBuffer(5)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    expect(buf.toArray()).toEqual(['a', 'b', 'c'])
  })

  it('wraps around and drops oldest lines when full', () => {
    const buf = new RingBuffer(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    buf.push('e')
    expect(buf.toArray()).toEqual(['c', 'd', 'e'])
  })

  it('returns empty array when nothing pushed', () => {
    const buf = new RingBuffer(5)
    expect(buf.toArray()).toEqual([])
  })

  it('handles capacity of 1', () => {
    const buf = new RingBuffer(1)
    buf.push('a')
    buf.push('b')
    expect(buf.toArray()).toEqual(['b'])
  })
})

describe('collectStallDiagnostics', () => {
  it('captures stderr tail and computes elapsed time', () => {
    const ring = new RingBuffer(200)
    ring.push('line 1')
    ring.push('Error: something went wrong')
    ring.push('at Module._compile (node:internal/modules/cjs/loader:1234:14)')

    const diag = collectStallDiagnostics({
      outputTail: ring,
      exitCode: null,
      doneSignalFired: false,
      startedAtMs: 1000,
      nowMs: 61_000,
    })

    expect(diag.stderrTail).toEqual([
      'line 1',
      'Error: something went wrong',
      'at Module._compile (node:internal/modules/cjs/loader:1234:14)',
    ])
    expect(diag.exitCode).toBeNull()
    expect(diag.doneSignalState).toBe('not-fired')
    expect(diag.elapsedMs).toBe(60_000)
  })

  it('reports done-signal as fired when it was', () => {
    const ring = new RingBuffer(10)
    const diag = collectStallDiagnostics({
      outputTail: ring,
      exitCode: 0,
      doneSignalFired: true,
      startedAtMs: 0,
      nowMs: 5000,
    })

    expect(diag.doneSignalState).toBe('fired')
    expect(diag.exitCode).toBe(0)
  })

  it('reports exit code when process exited', () => {
    const ring = new RingBuffer(10)
    ring.push('segfault')
    const diag = collectStallDiagnostics({
      outputTail: ring,
      exitCode: 137,
      doneSignalFired: false,
      startedAtMs: 0,
      nowMs: 120_000,
    })

    expect(diag.exitCode).toBe(137)
    expect(diag.stderrTail).toEqual(['segfault'])
    expect(diag.elapsedMs).toBe(120_000)
  })
})
