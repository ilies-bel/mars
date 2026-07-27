/**
 * Stall diagnostics — captures diagnostic state from a coder session before
 * the hard timeout kills it, so operators see WHY the coder stalled, not just
 * that it exceeded the time bound.
 *
 * Slice 5 of 6 for PRD d23b2704.
 */

/**
 * A bounded ring buffer that keeps the last N lines pushed into it.
 * Used to capture the tail of a stream (stderr/pty output) without
 * unbounded memory growth.
 */
export class RingBuffer {
  private readonly buf: string[]
  private pos = 0
  private full = false

  constructor(readonly capacity: number) {
    this.buf = new Array<string>(capacity)
  }

  push(line: string): void {
    this.buf[this.pos] = line
    this.pos = (this.pos + 1) % this.capacity
    if (this.pos === 0) this.full = true
  }

  toArray(): string[] {
    if (!this.full) return this.buf.slice(0, this.pos)
    return [...this.buf.slice(this.pos), ...this.buf.slice(0, this.pos)]
  }
}

export interface StallDiagnostics {
  stderrTail: string[]
  exitCode: number | null
  doneSignalState: string
  providerLastActivityAt: string | null
  elapsedMs: number
}

export interface StallDiagnosticsInput {
  outputTail: RingBuffer
  exitCode: number | null
  doneSignalFired: boolean
  startedAtMs: number
  nowMs?: number
}

export const collectStallDiagnostics = (
  input: StallDiagnosticsInput,
): StallDiagnostics => {
  const now = input.nowMs ?? Date.now()
  return {
    stderrTail: input.outputTail.toArray(),
    exitCode: input.exitCode,
    doneSignalState: input.doneSignalFired ? 'fired' : 'not-fired',
    providerLastActivityAt: null,
    elapsedMs: now - input.startedAtMs,
  }
}
