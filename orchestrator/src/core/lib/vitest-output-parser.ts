/**
 * Parser for vitest test runner stdout/stderr output.
 *
 * Provides a pure function to extract the relative file paths of failing
 * tests from raw process output captured by the verify step.  Used by the
 * baseline-probe logic in {@link handleTaskFailureWithFixTask} to target
 * exactly the failing files when probing the integration branch.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*\x07|\x1B[@-Z\\-_]/g

const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')

/**
 * Extract deduplicated relative test file paths from vitest stdout/stderr.
 *
 * Recognises two output shapes produced by vitest reporters:
 *   1. `FAIL  src/path/to/file.test.ts` — primary FAIL marker line emitted by
 *      the default and verbose reporters when a suite or test fails.
 *   2. `❯ src/path/to/file.test.ts (Nms)` — arrow-prefixed file summary line
 *      produced by some vitest reporter modes.
 *
 * FAIL summary lines (`FAIL Files  2 failed`, `FAIL Tests  1 failed`) do NOT
 * match because the word after FAIL does not end in `.test.ts(x)`.
 *
 * Returns an empty array when no recognisable pattern is found.  Callers
 * treat an empty result as "unparseable output" and skip the baseline probe
 * entirely — no error, no log noise.
 */
export function extractFailingTestFiles(output: string): string[] {
  const seen = new Set<string>()
  const lines = stripAnsi(output).split(/\r?\n/)

  for (const line of lines) {
    // Pattern 1: FAIL  src/path/to/file.test.ts > suite > test name
    // [^\s>]+ stops at the first space or '>' so the captured group is the
    // bare file path, never a test name fragment.
    const failMatch = line.match(/\bFAIL\s+([^\s>]+\.test\.tsx?)/)
    if (failMatch) {
      seen.add(failMatch[1])
      continue
    }

    // Pattern 2: ❯ src/path/to/file.test.ts (12ms)
    // [^\s(]+ stops at whitespace or '(' to exclude the timing annotation.
    const arrowMatch = line.match(/❯\s+([^\s(]+\.test\.tsx?)/)
    if (arrowMatch) {
      seen.add(arrowMatch[1])
    }
  }

  return Array.from(seen)
}
