/**
 * Parser for the `commandOutput` string recorded in the `step_ended` trace
 * event payload of a verify step.
 *
 * The format is produced by `review.ts`:
 *
 *   === <name> (pass|fail) [<tier>] <N>ms exit=<N|killed> ===
 *   $ cmd args
 *   <output>
 *
 *   === <name2> (pass|fail) [<tier>] <N>ms exit=<N> ===
 *   ...
 *
 *   === gate failure diagnostics ===
 *   --- diagnostics: <name> ---
 *   cmd: ...
 *   ...
 *
 *   === gate outcomes ===
 *   [{"name": "...", "tier": "...", "passed": true, "exitCode": 0, "duration": 123}]
 *
 * The `gate outcomes` JSON block is the most reliable structured source and
 * is parsed eagerly. The per-section output (between `=== ... ===` headers) is
 * also extracted so callers can surface excerpts to operators.
 */

/** One gate's entry in the structured `gate outcomes` JSON block. */
export interface VerifyGateOutcome {
  name: string
  tier: string
  passed: boolean
  exitCode: number | null
  duration?: number
}

/** One gate's section parsed from the free-text `=== name (pass|fail) ... ===` headers. */
export interface VerifyGateSectionOutput {
  name: string
  passed: boolean
  /** The section body (everything between this header and the next). */
  output: string
}

export interface ParsedVerifyOutput {
  /**
   * Structured gate outcomes from the JSON block. `null` when the block is
   * absent or unparseable (e.g. the output was truncated before the JSON).
   */
  gateOutcomes: VerifyGateOutcome[] | null
  /** All gate sections found in the free-text part. */
  sections: VerifyGateSectionOutput[]
  /**
   * Subset of {@link sections} where `passed === false`.
   * Empty when all gates passed.
   */
  failingSections: VerifyGateSectionOutput[]
}

// Matches: `=== <name> (pass|fail) [optional-tier] [optional Nms] [optional exit=N|killed] ===`
// The `(.+?)` lazy-matches the name so `pass` or `fail` in the name won't
// be consumed — valid names use alphanumeric chars, colons and hyphens.
// The format produced by review.ts is:
//   === <name> (pass|fail) [tier] <N>ms exit=<N|killed> ===
// Note the LITERAL parentheses around pass/fail — \( and \) are required.
const GATE_HEADER_RE =
  /^=== (.+?) \((pass|fail)\)(?:\s\[[^\]]+\])?(?:\s\d+ms)?(?:\sexit=(?:\d+|killed))? ===$/

// Names for the special (non-gate) sections we skip.
const SKIP_SECTION_NAMES = new Set(['gate outcomes', 'gate failure diagnostics'])

/**
 * Parse a `commandOutput` string into structured gate results.
 *
 * Never throws — malformed or truncated input degrades gracefully:
 * - Missing or unparseable `gate outcomes` JSON → `gateOutcomes: null`
 * - Truncated section output → partial text preserved up to the cut
 */
export function parseVerifyOutput(commandOutput: string): ParsedVerifyOutput {
  const lines = commandOutput.split('\n')

  const sections: VerifyGateSectionOutput[] = []
  let gateOutcomes: VerifyGateOutcome[] | null = null

  let currentName: string | null = null
  let currentPassed = false
  let currentBodyLines: string[] = []
  let inGateOutcomes = false
  let gateOutcomesLines: string[] = []
  let skipCurrentSection = false

  const flushSection = (): void => {
    if (currentName !== null && !skipCurrentSection) {
      sections.push({
        name: currentName,
        passed: currentPassed,
        output: currentBodyLines.join('\n').trim(),
      })
    }
  }

  for (const line of lines) {
    const m = line.match(GATE_HEADER_RE)
    if (m) {
      flushSection()
      const name = m[1]
      if (SKIP_SECTION_NAMES.has(name)) {
        // Treat as a separator — stop any previous section and skip this one.
        currentName = null
        currentBodyLines = []
        skipCurrentSection = false
        inGateOutcomes = false
        continue
      }
      currentName = name
      currentPassed = m[2] === 'pass'
      currentBodyLines = []
      skipCurrentSection = false
      inGateOutcomes = false
      continue
    }

    // Special block: `=== gate outcomes ===` (no pass/fail badge)
    if (line === '=== gate outcomes ===') {
      flushSection()
      currentName = null
      currentBodyLines = []
      skipCurrentSection = false
      inGateOutcomes = true
      continue
    }

    // Special block: `=== gate failure diagnostics ===` (no pass/fail badge)
    if (line === '=== gate failure diagnostics ===') {
      flushSection()
      currentName = null
      currentBodyLines = []
      skipCurrentSection = true
      inGateOutcomes = false
      continue
    }

    if (inGateOutcomes) {
      gateOutcomesLines.push(line)
    } else if (currentName !== null && !skipCurrentSection) {
      currentBodyLines.push(line)
    }
  }

  // Flush the last open section.
  flushSection()

  // Parse the `gate outcomes` JSON block.
  const rawJson = gateOutcomesLines.join('\n').trim()
  if (rawJson.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawJson)
      if (Array.isArray(parsed)) {
        gateOutcomes = parsed as VerifyGateOutcome[]
      }
    } catch {
      // Truncated or malformed JSON — leave gateOutcomes as null.
    }
  }

  const failingSections = sections.filter((s) => !s.passed)
  return { gateOutcomes, sections, failingSections }
}

/**
 * Produce a short human-readable summary of a parsed verify result for
 * display in CLI `mars show` output or an action-queue alert.
 *
 * - All gates passed → `null` (caller renders nothing)
 * - 1 failing gate → `"typecheck failed (exit 1)"`
 * - N failing gates → `"typecheck, test failed (exit 1, exit 1)"`
 */
export function verifyFailureLine(parsed: ParsedVerifyOutput): string | null {
  // Prefer the structured gate outcomes block when present.
  const outcomes = parsed.gateOutcomes
  const failing =
    outcomes !== null
      ? outcomes.filter((g) => !g.passed)
      : parsed.failingSections.map((s) => ({
          name: s.name,
          passed: false,
          exitCode: null as number | null,
        }))

  if (failing.length === 0) return null

  const names = failing.map((g) => g.name).join(', ')
  const exits = failing
    .map((g) => (g.exitCode !== null ? `exit ${g.exitCode}` : null))
    .filter(Boolean)
  const exitSuffix = exits.length > 0 ? ` (${exits.join(', ')})` : ''
  return `${names} failed${exitSuffix}`
}
