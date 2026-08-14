/**
 * distill-observation — compact noisy CLI output for embedding in worker prompts.
 *
 * Raw verify output (vitest runs, tsc, etc.) can be 200 000+ characters of
 * progress bars, module-loading noise, and timing lines that carry no signal
 * for a coder who needs to fix a failure. This module extracts the signal
 * lines and discards the noise, keeping the digest well under 10 000 chars
 * for typical runs.
 *
 * Design constraints:
 * - Pure and synchronous — no I/O, no async, no side effects.
 * - Never throws — returns the original text on any unexpected input.
 * - Pass-through for short inputs (≤ PASSTHROUGH_BYTES): distillation cost
 *   is only paid when the raw text is large enough to warrant it.
 */

export type ObservationKind = 'verify' | 'generic'

export interface DistillInput {
  /** Raw text to distill (e.g. full verify command output). */
  text: string
  /** Stable reference used to locate the full log, embedded in the prompt. */
  ref: string
  /** Hint for the kind of content being distilled. */
  kind: ObservationKind
}

export interface DistillResult {
  /** Distilled text ready to embed in a worker prompt. */
  text: string
  /** Same ref passed in — threaded through for convenience. */
  ref: string
  /** Byte count of the original input. */
  originalBytes: number
  /** Byte count of the distilled output. */
  distilledBytes: number
}

/**
 * Inputs shorter than this threshold are returned unchanged — distillation
 * is only worth the complexity when the raw text is large.
 */
const PASSTHROUGH_BYTES = 4_000

/**
 * Hard cap on the distilled output.  Prevents a pathological failure (e.g.
 * 50 000 lines of "Error: X") from producing a prompt that is only slightly
 * smaller than the original.
 */
const OUTPUT_CAP_BYTES = 8_000

/**
 * Signal-line patterns for verify output. A line matches if it contains one
 * of these substrings (checked case-sensitively unless marked).
 *
 * Ordered from highest to lowest signal strength so the priority-keep logic
 * can short-circuit early.
 */
const SIGNAL_PATTERNS: readonly RegExp[] = [
  // Vitest / jest failure markers
  /\bFAIL\b/,
  /\bFAILED\b/,
  // Error class names / stack frames
  /\bError:/,
  /\bAssertionError\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  // TypeScript diagnostics
  /\berror TS\d+:/,
  // Vitest expect diff blocks
  /^[+-] /,
  /Expected|Received/,
  // Test / suite names in failure context
  /^ {2,}[×✗✕●]/u,
  // "at " stack frames (but only the relevant first few)
  /^\s+at /,
  // Vitest summary line
  /Tests\s+\d+\s+(failed|passed)/i,
  /Test Files\s+\d+\s+(failed|passed)/i,
  // tsc summary
  /Found \d+ error/,
  // Generic "command exited with" lines from the harness
  /exited with (code|status) \d+/i,
  // npm/pnpm run error lines
  /^npm ERR!/,
  /^error:/i,
]

/**
 * Noise-line patterns — lines matching any of these are dropped even when
 * they otherwise contain signal (e.g. a progress-bar line that also has "✓").
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  // Vitest progress spinner / checkmark lines for PASSING tests
  /^\s*✓\s/u,
  /^\s*✔\s/u,
  // Percentage / spinner characters
  /^\s*[⠀-⣿]/u, // Braille spinner
  // Pure timing lines
  /^\s*Duration:\s+[\d.]+/,
  /^\s*Slowest\s+tests?:/i,
  // Module loading / transform lines (vitest verbose --reporter=verbose)
  /^\s*transformed\s+\d+/i,
  /^\s*optimized\s+\d+/i,
  /^\s*\d+\s+module(s)?\s+transform/i,
  // Empty separator lines (runs of just whitespace or box-drawing chars)
  /^[\s─-╿]*$/u,
  // Node module paths in isolation (not a stack frame, just a load event)
  /^\s*node_modules\//,
  // Vitest "↳" rerun lines
  /^\s*↳/u,
  // Pure blank / whitespace-only lines (separate from box-drawing above)
  /^\s*$/,
  // Percent progress bars: " 42% | ..."
  /^\s*\d+%\s*[|│]/,
]

/**
 * Whether a line is pure noise that should always be dropped.
 */
function isNoiseLine(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line))
}

/**
 * Whether a line carries signal worth keeping (and is not pure noise).
 */
function isSignalLine(line: string): boolean {
  if (isNoiseLine(line)) return false
  return SIGNAL_PATTERNS.some((re) => re.test(line))
}

/**
 * Distill `text` for a 'verify'-kind observation.
 *
 * Strategy:
 * 1. Walk every line.
 * 2. Keep lines that match a SIGNAL pattern and don't match NOISE.
 * 3. After a signal block, keep up to MAX_CONTEXT_LINES_AFTER non-signal,
 *    non-noise, non-empty lines (diff context, stack continuation, etc.).
 * 4. Cap total output at OUTPUT_CAP_BYTES, appending a truncation notice.
 */
function distillVerify(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let contextLinesRemaining = 0
  const MAX_CONTEXT_LINES_AFTER = 4

  for (const line of lines) {
    if (isSignalLine(line)) {
      kept.push(line)
      contextLinesRemaining = MAX_CONTEXT_LINES_AFTER
    } else if (
      contextLinesRemaining > 0 &&
      !isNoiseLine(line) &&
      line.trim().length > 0
    ) {
      kept.push(line)
      contextLinesRemaining--
    } else {
      contextLinesRemaining = 0
    }
  }

  if (kept.length === 0) {
    // Fallback: last N lines of the raw text are almost always the summary.
    return lines.slice(-30).join('\n')
  }

  let result = kept.join('\n')
  const enc = Buffer.byteLength(result, 'utf8')
  if (enc > OUTPUT_CAP_BYTES) {
    // Truncate from the front (early lines are usually noise; the summary is at
    // the end) and add a header note so the coder knows it was truncated.
    const truncated = result.slice(result.length - OUTPUT_CAP_BYTES)
    result = `[distilled — truncated to last ${OUTPUT_CAP_BYTES} bytes; see <verify_full_log_ref> for full log]\n${truncated}`
  }
  return result
}

/**
 * Distill a noisy CLI observation into a compact summary suitable for
 * embedding in a worker prompt.
 *
 * Returns the original text when:
 * - `text` is at or below `PASSTHROUGH_BYTES` (no distillation needed), or
 * - distillation would not save space (distilled ≥ original).
 */
export function distillObservation(input: DistillInput): DistillResult {
  const { text, ref, kind } = input
  const originalBytes = Buffer.byteLength(text, 'utf8')

  if (originalBytes <= PASSTHROUGH_BYTES) {
    return { text, ref, originalBytes, distilledBytes: originalBytes }
  }

  let distilled: string
  try {
    distilled = kind === 'verify' ? distillVerify(text) : text.slice(0, OUTPUT_CAP_BYTES)
  } catch {
    // Distillation must never break the caller — fall back to the original.
    distilled = text
  }

  const distilledBytes = Buffer.byteLength(distilled, 'utf8')

  // Only substitute when distillation actually saves space.
  if (distilledBytes >= originalBytes) {
    return { text, ref, originalBytes, distilledBytes: originalBytes }
  }

  return { text: distilled, ref, originalBytes, distilledBytes }
}
