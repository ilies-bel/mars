/**
 * Observation distillation — token-efficient compression of verify/tool output.
 *
 * Preserves lines that carry failure signal verbatim; collapses consecutive
 * "passing/noisy" lines (PASS, ok, ✓, [info]) into a single count summary
 * with an inline reference so the reader can expand to the full artifact.
 *
 * Deterministic: no I/O, no wall-clock, no randomness.
 */

export interface DistillInput {
  /** Raw text to distill (e.g. verify output, tool stdout+stderr). */
  text: string
  /** Opaque reference to the full artifact (path or artifact id). */
  ref: string
  /** Optional label for the content kind (e.g. "verify", "test", "install"). */
  kind?: string
}

export interface DistillOutput {
  /** Distilled text with passing blocks collapsed to count summaries. */
  text: string
  /** Byte length of the original input (UTF-8). */
  originalBytes: number
  /** Byte length of the distilled output (UTF-8). */
  distilledBytes: number
  /** Count of individual lines preserved verbatim (not summarised). */
  keptLines: number
}

/**
 * Lines produced by passing test runners and informational loggers.
 * Consecutive runs of these are collapsed into a single count summary.
 *
 * Pattern is anchored to the start of the line (`^`) so a line that
 * merely _contains_ "PASS" or "ok" mid-sentence is not collapsed.
 */
const PASSING_LINE_RE = /^(?:PASS|ok|✓|\[info\])/

/**
 * Distil raw verify/tool output into a compact, signal-preserving string.
 *
 * Algorithm:
 * 1. Split on newlines.
 * 2. Accumulate consecutive "passing" lines; flush each run as one summary
 *    token: `[... N passing lines — see log: <ref> ...]`.
 * 3. All other lines (FAIL, Error:, stack frames, empty lines, unknown
 *    content) pass through verbatim — no filtering, no truncation.
 * 4. Rejoin with newlines and compute byte lengths.
 */
export function distillObservation(input: DistillInput): DistillOutput {
  const { text, ref } = input
  const originalBytes = Buffer.byteLength(text, 'utf8')

  const rawLines = text.split('\n')
  const outputParts: string[] = []
  let passingStreak = 0
  let keptLines = 0

  const flushStreak = (): void => {
    if (passingStreak > 0) {
      outputParts.push(`[... ${passingStreak} passing lines — see log: ${ref} ...]`)
      passingStreak = 0
    }
  }

  for (const line of rawLines) {
    if (PASSING_LINE_RE.test(line)) {
      passingStreak++
    } else {
      flushStreak()
      outputParts.push(line)
      keptLines++
    }
  }
  flushStreak()

  const distilledText = outputParts.join('\n')
  const distilledBytes = Buffer.byteLength(distilledText, 'utf8')

  return { text: distilledText, originalBytes, distilledBytes, keptLines }
}
